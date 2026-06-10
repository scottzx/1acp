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

// Map of currently initializing sessions: sessionId -> Promise<handle>
const initializingSessions = new Map();

// Map of pending permission requests
// requestId -> { resolve, reject, timer }
const pendingPermissions = new Map();
let nextRequestId = 1;

// ----------------------------------------------------
// History Adapters — per-agent native storage readers
// ----------------------------------------------------
// Each adapter returns an array of structured items that the frontend
// maps 1:1 onto ChatItem kinds. An empty array means "no history found"
// (e.g. brand-new session, file missing, or agent type not yet supported)
// — the UI treats that as the empty state, not an error.
//
// Item shape (one of):
//   { kind: "user",           text: string,             createdAt?: string }
//   { kind: "assistant_text", text: string,             createdAt?: string }
//   { kind: "thinking",       text: string,             createdAt?: string }
//   { kind: "tool_use",       toolName, input, toolCallId?, createdAt? }
//   { kind: "tool_result",    toolCallId, content, isError, createdAt? }

const historyAdapters = {};

/**
 * Default stub for agent types that don't have a native storage reader yet.
 * Returning [] lets the UI show the empty hint without an error bubble.
 */
async function defaultHistoryAdapter() {
  return [];
}

/**
 * Push a text-bearing item, merging into the previous one of the same kind
 * so a multi-block assistant turn (e.g. several consecutive text deltas) shows
 * up as a single bubble rather than a wall of small ones.
 */
function pushMerged(items, next) {
  const last = items[items.length - 1];
  const mergeable = new Set(["user", "assistant_text", "thinking"]);
  if (last && mergeable.has(last.kind) && last.kind === next.kind) {
    last.text = last.text ? `${last.text}\n${next.text}` : next.text;
    return;
  }
  items.push(next);
}

function flattenToolResultContent(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return String(content);
}

/**
 * Claude Code stores session history as JSONL under
 *   ~/.claude/projects/<slugified-cwd>/<ccSessionId>.jsonl
 * The slug is the absolute path with every char outside [A-Za-z0-9._-]
 * replaced by '-'. See docs/ai_collaborative_workbench_design.md §3.1.
 */
async function loadClaudeCodeHistory(ctx) {
  const { acpSessionId, workspacePath } = ctx;
  if (!acpSessionId || !workspacePath) {
    return [];
  }
  const slug = workspacePath.replace(/[^A-Za-z0-9._-]/g, "-");
  const jsonlPath = path.join(os.homedir(), ".claude", "projects", slug, `${acpSessionId}.jsonl`);

  let raw;
  try {
    raw = await fs.promises.readFile(jsonlPath, "utf8");
  } catch {
    // File missing or unreadable — treat as "no history yet".
    return [];
  }

  const items = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") {
      continue;
    }

    const createdAt = typeof ev.timestamp === "string" ? ev.timestamp : undefined;
    const msg = ev.message;
    if (!msg) {
      continue;
    }

    if (ev.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content) {
          pushMerged(items, { kind: "user", text: content, createdAt });
        }
        continue;
      }
      if (!Array.isArray(content)) {
        continue;
      }

      const textParts = [];
      for (const b of content) {
        if (!b || typeof b !== "object") {
          continue;
        }
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "tool_result") {
          if (textParts.length) {
            pushMerged(items, { kind: "user", text: textParts.join("\n"), createdAt });
            textParts.length = 0;
          }
          items.push({
            kind: "tool_result",
            toolCallId: b.tool_use_id,
            content: flattenToolResultContent(b.content),
            isError: !!b.is_error,
            createdAt,
          });
        }
      }
      if (textParts.length) {
        pushMerged(items, { kind: "user", text: textParts.join("\n"), createdAt });
      }
    } else if (ev.type === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== "object") {
          continue;
        }
        if (b.type === "text" && typeof b.text === "string") {
          pushMerged(items, { kind: "assistant_text", text: b.text, createdAt });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          pushMerged(items, { kind: "thinking", text: b.thinking, createdAt });
        } else if (b.type === "tool_use") {
          items.push({
            kind: "tool_use",
            toolName: b.name || "tool",
            input: b.input ?? {},
            toolCallId: b.id,
            createdAt,
          });
        }
      }
    }
    // Skip queue-operation, attachment, last-prompt, system, etc. for v1.
  }
  return items;
}

/**
 * Convert an acpx runtime SessionRecord (its `messages` field) into the
 * same item shape produced by the agent-native adapters. The acpx schema
 * differs from Claude Code's: User/Agent content blocks use {Text, Thinking,
 * ToolUse} rather than {type, text, thinking, tool_use}, and tool_result
 * blocks are runtime-only (never persisted).
 */
function extractFromRuntimeRecord(record) {
  const items = [];
  if (!record || !Array.isArray(record.messages)) {
    return items;
  }
  for (const msg of record.messages) {
    if (msg.User && Array.isArray(msg.User.content)) {
      const parts = [];
      for (const c of msg.User.content) {
        if (c && c.Text !== undefined) {
          parts.push(c.Text);
        }
      }
      if (parts.length) {
        pushMerged(items, { kind: "user", text: parts.join("\n") });
      }
    } else if (msg.Agent && Array.isArray(msg.Agent.content)) {
      for (const c of msg.Agent.content) {
        if (!c || typeof c !== "object") {
          continue;
        }
        if (c.Text !== undefined) {
          pushMerged(items, { kind: "assistant_text", text: c.Text });
        } else if (c.Thinking) {
          const text = c.Thinking.text || "";
          if (text) {
            pushMerged(items, { kind: "thinking", text });
          }
        } else if (c.ToolUse) {
          items.push({
            kind: "tool_use",
            toolName: c.ToolUse.name || "tool",
            input: c.ToolUse.input ?? c.ToolUse.raw_input ?? {},
            toolCallId: c.ToolUse.id,
          });
        }
      }
    }
  }
  return items;
}

historyAdapters.claudecode = loadClaudeCodeHistory;
for (const t of [
  "codex",
  "acp",
  "gemini",
  "cursor",
  "devin",
  "iflow",
  "kimi",
  "opencode",
  "pi",
  "qoder",
  "tmux",
]) {
  historyAdapters[t] = defaultHistoryAdapter;
}

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
          const { workspacePath, agentType, systemContext, resumeSessionId, acpSessionId } =
            payload;
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

          // Prefer the explicit resumeSessionId (the agent-side UUID
          // recorded in the 1agents index); fall back to acpSessionId
          // for older clients. Empty string means "start a fresh session".
          const resumeId = (resumeSessionId || acpSessionId || "").trim();

          console.log(
            `[acpx-server] Initializing session. Agent: ${agentType}, Cwd: ${normalizedPath}, ResumeSessionId: ${resumeId || "<none>"}`,
          );

          const sessionPromise = runtime.ensureSession({
            sessionKey: sessionId,
            agent: agentType,
            mode: "persistent",
            cwd: normalizedPath,
            resumeSessionId: resumeId || undefined,
            sessionOptions,
          });
          initializingSessions.set(sessionId, sessionPromise);

          try {
            const handle = await sessionPromise;
            activeSessions.set(sessionId, { handle, activeTurn: null, ws });

            ws.send(
              JSON.stringify({
                event: "session_ready",
                sessionId,
                agentSessionId: handle.agentSessionId || handle.backendSessionId,
              }),
            );
          } finally {
            initializingSessions.delete(sessionId);
          }
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

          // If the session is currently initializing, wait for it to be ready
          if (initializingSessions.has(sessionId)) {
            try {
              await initializingSessions.get(sessionId);
            } catch (err) {
              console.warn(
                `[acpx-server] Awaiting initializing session ${sessionId} failed:`,
                err.message,
              );
            }
          }

          const session = activeSessions.get(sessionId);
          const agentType = payload.agentType || session?.handle?.agent;
          // The agent-side session id is the runtime's own field — it's the
          // canonical ACP id (e.g. Claude Code's UUID) that names the JSONL
          // on disk. We prefer it over anything in the payload so the
          // history is bound to the actual agent process, not whatever the
          // cc-connect / IM side happens to be tracking.
          const acpSessionId =
            session?.handle?.agentSessionId ||
            session?.handle?.backendSessionId ||
            payload.acpSessionId;
          const workspacePath = session?.handle?.cwd;

          // Fast path: in-process runtime session store.
          let items = [];
          if (session) {
            try {
              const record = await runtime.options.sessionStore.load(
                session.handle.acpxRecordId || sessionId,
              );
              items = extractFromRuntimeRecord(record);
            } catch (err) {
              console.warn(
                `[acpx-server] Runtime store load failed for ${sessionId}; falling back to native adapter:`,
                err.message,
              );
            }
          }

          // Fallback: agent-type native storage (e.g. Claude Code's JSONL).
          // An empty result is a normal "no history yet" outcome — the UI
          // shows the empty hint, not an error.
          if (items.length === 0) {
            const adapter = historyAdapters[agentType] || defaultHistoryAdapter;
            try {
              items = await adapter({ agentType, acpSessionId, workspacePath });
              console.log(
                `[acpx-server] History adapter for ${agentType} returned ${items.length} item(s) for ${sessionId} (acp=${acpSessionId || "<none>"})`,
              );
            } catch (err) {
              console.warn(
                `[acpx-server] History adapter for ${agentType} failed for ${sessionId}:`,
                err.message,
              );
              items = [];
            }
          }

          ws.send(
            JSON.stringify({
              event: "history_response",
              sessionId,
              items,
            }),
          );
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
