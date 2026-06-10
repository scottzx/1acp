import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { createAcpRuntime, createRuntimeStore, createAgentRegistry } from "./src/runtime.js";

// ----------------------------------------------------
// Configurations
// ----------------------------------------------------
const PORT = process.env.ACPX_PORT ? Number.parseInt(process.env.ACPX_PORT, 10) : 38082;
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".1agents", "acpx-state");

console.log(`[acpx-server] Starting server on port ${PORT}...`);

// Ensure state dir exists
fs.mkdirSync(DEFAULT_STATE_DIR, { recursive: true });

// Setup session runtime manager options
const runtime = createAcpRuntime({
  cwd: process.cwd(),
  sessionStore: createRuntimeStore({ stateDir: DEFAULT_STATE_DIR }),
  agentRegistry: createAgentRegistry(),
  permissionMode: "approve-reads", // default, will be overridden by session or client options
  onPermissionRequest: handlePermissionRequestCallback,
});

// Map of active session handles and turn contexts
// sessionId -> { handle, activeTurn }
const activeSessions = new Map();

// Map of pending permission requests
// requestId -> { resolve, reject, timer }
const pendingPermissions = new Map();
let nextRequestId = 1;

// ----------------------------------------------------
// WebSocket Server Setup
// ----------------------------------------------------
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  console.log("[acpx-server] Go backend client connected.");

  ws.on("message", async (messageData) => {
    let payload;
    try {
      payload = JSON.parse(messageData.toString());
    } catch {
      sendError(ws, null, "INVALID_JSON", "Failed to parse JSON payload");
      return;
    }

    const { action, sessionId } = payload;
    if (!action) {
      sendError(ws, sessionId, "MISSING_ACTION", "Action field is required");
      return;
    }

    console.log(`[acpx-server] Received action: ${action} for session: ${sessionId}`);

    try {
      switch (action) {
        case "ensure_session": {
          const { workspacePath, agentType, systemContext } = payload;
          if (!sessionId || !workspacePath || !agentType) {
            sendError(
              ws,
              sessionId,
              "INVALID_PARAMS",
              "sessionId, workspacePath, and agentType are required",
            );
            return;
          }

          // Path normalization: resolve symlinks and absolute path
          let normalizedPath = workspacePath;
          try {
            normalizedPath = fs.realpathSync(workspacePath);
          } catch (e) {
            console.warn(
              `[acpx-server] Path normalization failed for ${workspacePath}:`,
              e.message,
            );
          }

          const sessionOptions = {};
          if (systemContext) {
            sessionOptions.systemPrompt = systemContext;
          }

          console.log(
            `[acpx-server] Initializing session. Agent: ${agentType}, Cwd: ${normalizedPath}`,
          );

          const handle = await runtime.ensureSession({
            sessionKey: sessionId,
            agent: agentType,
            mode: "persistent",
            cwd: normalizedPath,
            sessionOptions,
          });

          activeSessions.set(sessionId, { handle, activeTurn: null, ws });

          ws.send(
            JSON.stringify({
              event: "session_ready",
              sessionId,
            }),
          );
          break;
        }

        case "prompt": {
          const { text } = payload;
          if (!sessionId || text === undefined) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId and text are required");
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }

          if (session.activeTurn) {
            sendError(
              ws,
              sessionId,
              "TURN_IN_PROGRESS",
              "Another prompt is already executing in this session",
            );
            return;
          }

          const requestId = `turn_${Date.now()}`;
          const turn = runtime.startTurn({
            handle: session.handle,
            text,
            mode: "prompt",
            requestId,
          });

          session.activeTurn = turn;

          // Consume the turn events stream asynchronously
          (async () => {
            try {
              for await (const event of turn.events) {
                // event types: text_delta, status, tool_call, error
                if (event.type === "text_delta") {
                  ws.send(
                    JSON.stringify({
                      event: "text_delta",
                      sessionId,
                      text: event.text,
                      type: event.stream || "output", // 'thought' or 'output'
                    }),
                  );
                } else if (event.type === "tool_call") {
                  ws.send(
                    JSON.stringify({
                      event: "tool_call",
                      sessionId,
                      toolName: event.title || event.text || "tool",
                      arguments: event.rawInput || {},
                    }),
                  );
                } else if (event.type === "error") {
                  ws.send(
                    JSON.stringify({
                      event: "error",
                      sessionId,
                      message: event.message,
                    }),
                  );
                }
              }

              // Await the final turn result
              const result = await turn.result;
              console.log(
                `[acpx-server] Turn finished for session: ${sessionId}. Status: ${result.status}`,
              );

              if (result.status === "failed") {
                ws.send(
                  JSON.stringify({
                    event: "error",
                    sessionId,
                    message: result.error?.message || "Turn execution failed",
                  }),
                );
              } else {
                // Retrieve status summary for ending message
                let summary = "Execution completed successfully.";
                try {
                  const status = await runtime.getStatus({ handle: session.handle });
                  summary = status.summary || summary;
                } catch {
                  // Fallback
                }

                ws.send(
                  JSON.stringify({
                    event: "done",
                    sessionId,
                    summary,
                  }),
                );
              }
            } catch (err) {
              console.error(`[acpx-server] Error executing turn:`, err);
              ws.send(
                JSON.stringify({
                  event: "error",
                  sessionId,
                  message: err.message,
                }),
              );
            } finally {
              session.activeTurn = null;
            }
          })();
          break;
        }

        case "respond_permission": {
          const { requestId, behavior } = payload;
          if (!sessionId || !requestId || !behavior) {
            sendError(
              ws,
              sessionId,
              "INVALID_PARAMS",
              "sessionId, requestId, and behavior are required",
            );
            return;
          }

          const pending = pendingPermissions.get(requestId);
          if (!pending) {
            sendError(
              ws,
              sessionId,
              "PERMISSION_NOT_FOUND",
              "No pending permission request matches this ID",
            );
            return;
          }

          console.log(`[acpx-server] Permission response received: ${behavior} for ${requestId}`);
          clearTimeout(pending.timer);
          pendingPermissions.delete(requestId);

          if (behavior === "allow") {
            pending.resolve({ outcome: "allow_once" });
          } else {
            pending.resolve({ outcome: "reject_once" });
          }
          break;
        }

        case "cancel": {
          if (!sessionId) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId is required");
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }

          if (session.activeTurn) {
            console.log(`[acpx-server] Cancelling active turn for session: ${sessionId}`);
            await session.activeTurn.cancel({ reason: "User cancelled via UI" });
          } else {
            console.log(`[acpx-server] No active turn to cancel for session: ${sessionId}`);
          }
          break;
        }

        case "get_history": {
          if (!sessionId) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId is required");
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }

          // Try to load historical messages
          try {
            const record = await runtime.options.sessionStore.load(
              session.handle.acpxRecordId || sessionId,
            );
            const messages = [];

            if (record && record.messages) {
              for (const msg of record.messages) {
                if (msg.User) {
                  const texts = msg.User.content
                    .filter((c) => c.Text !== undefined)
                    .map((c) => c.Text);
                  messages.push({ role: "user", text: texts.join("\n") });
                } else if (msg.Agent) {
                  const texts = msg.Agent.content
                    .filter((c) => c.Text !== undefined)
                    .map((c) => c.Text);
                  messages.push({ role: "agent", text: texts.join("\n") });
                }
              }
            }

            ws.send(
              JSON.stringify({
                event: "history_response",
                sessionId,
                messages,
              }),
            );
          } catch (err) {
            console.error(`[acpx-server] Failed to load history for ${sessionId}:`, err);
            sendError(ws, sessionId, "HISTORY_FAILED", err.message);
          }
          break;
        }

        case "close_session": {
          if (!sessionId) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId is required");
            return;
          }

          const session = activeSessions.get(sessionId);
          if (session) {
            console.log(`[acpx-server] Closing session: ${sessionId}`);
            try {
              if (session.activeTurn) {
                await session.activeTurn.cancel({ reason: "Session closed" });
              }
              await runtime.close({ handle: session.handle, reason: "Session closed by request" });
            } catch (err) {
              console.error(`[acpx-server] Error closing runtime handle:`, err);
            }
            activeSessions.delete(sessionId);
          }
          break;
        }

        case "close_all_sessions": {
          console.log("[acpx-server] Closing all sessions by request...");
          await killAllManagedAgents();
          ws.send(JSON.stringify({ event: "all_sessions_closed" }));
          break;
        }

        default:
          sendError(ws, sessionId, "UNKNOWN_ACTION", `Action ${action} is not supported`);
      }
    } catch (err) {
      console.error(`[acpx-server] Action execution failed:`, err);
      sendError(ws, sessionId, "ACTION_FAILED", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[acpx-server] Go backend client disconnected.");
  });
});

// Helper for sending error events
function sendError(ws, sessionId, errorCode, message) {
  ws.send(
    JSON.stringify({
      event: "error",
      sessionId,
      code: errorCode,
      message,
    }),
  );
}

// ----------------------------------------------------
// Permission Request Handling Callback
// ----------------------------------------------------
async function handlePermissionRequestCallback(req, ctx) {
  const { sessionId } = req;
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.warn(`[acpx-server] Permission requested for unknown session: ${sessionId}`);
    return { outcome: "reject_once" };
  }

  const requestId = `perm_${nextRequestId++}`;
  console.log(
    `[acpx-server] Intercepted permission request: ${req.raw.toolCall.title}. RequestId: ${requestId}`,
  );

  return new Promise((resolve, reject) => {
    // Timeout handler: 5 minutes auto-deny
    const timer = setTimeout(
      () => {
        console.warn(`[acpx-server] Permission request ${requestId} timed out. Auto-denying.`);
        pendingPermissions.delete(requestId);
        resolve({ outcome: "reject_once" });

        // Notify Go backend of the timeout
        session.ws.send(
          JSON.stringify({
            event: "permission_timeout",
            sessionId,
            requestId,
            message: `Permission request for "${req.raw.toolCall.title}" auto-denied after 5min timeout.`,
          }),
        );
      },
      5 * 60 * 1000,
    );

    // Save pending info
    pendingPermissions.set(requestId, { resolve, reject, timer });

    // Handle AbortSignal from runtime (e.g. if the turn is cancelled)
    ctx.signal.addEventListener(
      "abort",
      () => {
        console.log(`[acpx-server] Permission request ${requestId} aborted by runtime.`);
        clearTimeout(timer);
        pendingPermissions.delete(requestId);
        resolve({ outcome: "cancel" });
      },
      { once: true },
    );

    // Send permission request to client
    session.ws.send(
      JSON.stringify({
        event: "permission_request",
        sessionId,
        requestId,
        toolName: req.raw.toolCall.title || "Unknown Tool",
        arguments: req.raw.toolCall.rawInput || {},
      }),
    );
  });
}

// ----------------------------------------------------
// Subprocess Cleanup / Orphan Prevention
// ----------------------------------------------------
async function killAllManagedAgents() {
  console.log("[acpx-server] Cleaning up all active sessions and child processes...");
  const promises = [];
  for (const [sessionId, session] of activeSessions.entries()) {
    try {
      if (session.activeTurn) {
        promises.push(session.activeTurn.cancel({ reason: "Clean shutdown" }));
      }
      promises.push(runtime.close({ handle: session.handle, reason: "Clean shutdown" }));
    } catch (e) {
      console.error(`[acpx-server] Cleanup error for session ${sessionId}:`, e);
    }
  }
  await Promise.all(promises);
  activeSessions.clear();
}

// 1. Parent process stdin close check (Double protection)
process.stdin.resume();
process.stdin.on("end", async () => {
  console.error("[acpx-server] Parent process standard input closed. Shutting down...");
  await killAllManagedAgents();
  process.exit(0);
});

process.stdin.on("close", async () => {
  console.error("[acpx-server] Parent process standard input closed. Shutting down...");
  await killAllManagedAgents();
  process.exit(0);
});

// 2. Process termination signal handlers
process.on("SIGINT", async () => {
  console.log("[acpx-server] Received SIGINT. Terminating...");
  await killAllManagedAgents();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[acpx-server] Received SIGTERM. Terminating...");
  await killAllManagedAgents();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("[acpx-server] Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[acpx-server] Unhandled Rejection at:", promise, "reason:", reason);
});
