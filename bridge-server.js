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

// Map of Agent UUID -> Client Session ID (for permission callbacks)
const agentSessionToClientSession = new Map();

function registerAgentSessionMapping(sessionId, handle) {
  if (!handle) {
    return;
  }
  if (handle.backendSessionId) {
    agentSessionToClientSession.set(handle.backendSessionId, sessionId);
  }
  if (handle.agentSessionId) {
    agentSessionToClientSession.set(handle.agentSessionId, sessionId);
  }
}

function unregisterAgentSessionMapping(handle) {
  if (!handle) {
    return;
  }
  if (handle.backendSessionId) {
    agentSessionToClientSession.delete(handle.backendSessionId);
  }
  if (handle.agentSessionId) {
    agentSessionToClientSession.delete(handle.agentSessionId);
  }
}

// ----------------------------------------------------
// Permission helpers
// ----------------------------------------------------

// Mirror of backend/internal/agent/handler.go isValidPermissionMode — keep
// in sync so the wire shape on both sides agrees.
function isValidPermissionMode(mode) {
  return mode === "approve-reads" || mode === "approve-all" || mode === "deny-all";
}

// Map the client-supplied `behavior` string to an ACP decision outcome.
// Accepts the full ACP set (the 4 kinds + cancel) and the legacy
// allow/deny shorthand from pre-multi-button frontends. Unknown values
// fall back to reject_once: an unfamiliar behavior must not widen
// permissions.
function normalizePermissionOutcome(behavior) {
  switch (behavior) {
    case "allow_once":
    case "allow_always":
    case "reject_once":
    case "reject_always":
    case "cancel":
      return behavior;
    case "allow":
      return "allow_once";
    case "deny":
      return "reject_once";
    default:
      console.warn(
        `[acpx-server] Unknown permission behavior "${behavior}" — defaulting to reject_once`,
      );
      return "reject_once";
  }
}

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
            toolName: b.name || b.tool_name || b.toolName || "tool",
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
            toolName: c.ToolUse.name || c.ToolUse.tool_name || c.ToolUse.toolName || "tool",
            input: c.ToolUse.input ?? c.ToolUse.raw_input ?? {},
            toolCallId: c.ToolUse.id,
          });
        }
      }

      if (msg.Agent.tool_results && typeof msg.Agent.tool_results === "object") {
        for (const res of Object.values(msg.Agent.tool_results)) {
          if (!res || typeof res !== "object") {
            continue;
          }
          let textContent = "";
          if (res.output !== undefined && res.output !== null) {
            textContent = typeof res.output === "string" ? res.output : JSON.stringify(res.output);
          } else if (res.content) {
            if (typeof res.content.Text === "string") {
              textContent = res.content.Text;
            } else if (res.content.Image) {
              textContent = `[Image: ${res.content.Image.source}]`;
            }
          }
          items.push({
            kind: "tool_result",
            toolCallId: res.tool_use_id,
            toolName: res.tool_name || res.toolName || res.name || "tool",
            content: textContent,
            isError: !!res.is_error,
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
          const {
            workspacePath,
            agentType,
            systemContext,
            resumeSessionId,
            acpSessionId,
            permissionMode,
          } = payload;
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

          // Normalize the per-session permission policy. Empty / invalid
          // payload values fall back to the runtime-level default so this
          // never accidentally widens permissions.
          const seededMode = isValidPermissionMode(permissionMode) ? permissionMode : null;

          const existingSession = activeSessions.get(sessionId);
          if (existingSession) {
            console.log(`[acpx-server] Reconnecting to existing session: ${sessionId}`);
            existingSession.ws = ws;
            // Only seed the in-memory mode from the store when nothing is
            // set yet. Never overwrite a live mode with a (possibly stale)
            // store value — that would let a PATCH that hasn't completed
            // yet downgrade the user's just-toggled choice.
            if (seededMode && !existingSession.permissionMode) {
              existingSession.permissionMode = seededMode;
            }
            registerAgentSessionMapping(sessionId, existingSession.handle);
            ws.send(
              JSON.stringify({
                event: "session_ready",
                sessionId,
                agentSessionId:
                  existingSession.handle.agentSessionId || existingSession.handle.backendSessionId,
              }),
            );
            break;
          }

          if (initializingSessions.has(sessionId)) {
            console.log(
              `[acpx-server] Session ${sessionId} is currently initializing, awaiting...`,
            );
            try {
              const handle = await initializingSessions.get(sessionId);
              const sess = activeSessions.get(sessionId);
              if (sess) {
                sess.ws = ws;
                if (seededMode) {
                  sess.permissionMode = seededMode;
                }
              }
              registerAgentSessionMapping(sessionId, handle);
              ws.send(
                JSON.stringify({
                  event: "session_ready",
                  sessionId,
                  agentSessionId: handle.agentSessionId || handle.backendSessionId,
                }),
              );
            } catch (err) {
              sendError(ws, sessionId, "INITIALIZATION_FAILED", err.message);
            }
            break;
          }

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
            activeSessions.set(sessionId, {
              handle,
              activeTurn: null,
              promptQueue: [],
              ws,
              // permissionMode is per-session and overrides the runtime
              // default in handlePermissionRequestCallback. The Composer's
              // mode toggle later updates this via set_permission_mode.
              // Default to approve-reads when the store has nothing (e.g.
              // brand-new session) so the mode check at line ~925 never
              // has to special-case null/undefined.
              permissionMode: seededMode ?? "approve-reads",
            });
            registerAgentSessionMapping(sessionId, handle);

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

          if (session.activeTurn || session.promptQueue.length > 0) {
            // Another prompt is already executing or waiting. Append to the
            // per-session queue and ack the sender — the active turn's
            // finally block will drain this when it finishes.
            const queuedRequestId = `queued_${Date.now()}_${session.promptQueue.length}`;
            session.promptQueue.push({
              text,
              queuedRequestId,
              ws,
            });
            ws.send(
              JSON.stringify({
                event: "prompt_queued",
                sessionId,
                requestId: queuedRequestId,
                queuePosition: session.promptQueue.length,
                text,
              }),
            );
            console.log(
              `[acpx-server] Prompt queued for session ${sessionId} (queue depth=${session.promptQueue.length})`,
            );
            return;
          }

          runPromptTurn(session, sessionId, { text });
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

          // Accept the full ACP decision set plus the legacy two-button
          // shorthand from older clients. Anything unrecognized falls back
          // to reject_once — better to deny than to misforward intent.
          const outcome = normalizePermissionOutcome(behavior);
          pending.resolve({ outcome });
          break;
        }

        case "set_permission_mode": {
          // Per-session override for the bridge-server's permission
          // gate. Applied immediately so the next permission request
          // bypasses the user prompt without a turn boundary. The Go
          // side already persisted the choice via PATCH; this WS action
          // is only about the in-memory gate.
          //
          // Field is `permissionMode` (not `mode`) to match the JSON
          // tag on Go's WsMessage.PermissionMode — Go strips unknown
          // fields during the bridge's ReadJSON → WriteJSON forward,
          // so any other name silently arrives empty here.
          const { permissionMode: mode } = payload;
          if (!sessionId || !mode) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId and permissionMode are required");
            return;
          }
          if (!isValidPermissionMode(mode)) {
            sendError(
              ws,
              sessionId,
              "INVALID_PARAMS",
              "permissionMode must be approve-reads, approve-all, or deny-all",
            );
            return;
          }
          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }
          session.permissionMode = mode;
          console.log(`[acpx-server] permission mode for ${sessionId} set to ${mode}`);
          // Push the mode down to the live ACP session so the runtime's
          // own fast-path (filesystem.ts permissionGate, permissions.ts)
          // honors it on the very next tool call. Without this, the
          // runtime continues to use whatever permissionMode it was
          // created with — a stale "approve-reads" lets writes through
          // regardless of the user's toggle, and an "approve-all"
          // makes deny-all a no-op.
          try {
            await runtime.setMode({ handle: session.handle, mode });
            console.log(
              `[acpx-server] runtime.setMode pushed ${mode} to ACP session for ${sessionId}`,
            );
          } catch (err) {
            console.warn(
              `[acpx-server] runtime.setMode failed for ${sessionId} (in-memory mode still ${mode}):`,
              err.message,
            );
          }
          ws.send(
            JSON.stringify({
              event: "permission_mode_changed",
              sessionId,
              permissionMode: mode,
            }),
          );
          break;
        }

        case "cancel_queued": {
          if (!sessionId || !payload.requestId) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId and requestId are required");
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }

          const idx = session.promptQueue.findIndex(
            (item) => item.queuedRequestId === payload.requestId,
          );
          if (idx === -1) {
            sendError(
              ws,
              sessionId,
              "QUEUED_PROMPT_NOT_FOUND",
              "No queued prompt matches that requestId",
            );
            return;
          }
          const [removed] = session.promptQueue.splice(idx, 1);
          sendPromptCancelled(removed.ws, sessionId, removed.queuedRequestId);
          console.log(
            `[acpx-server] Cancelled queued prompt ${removed.queuedRequestId} for session ${sessionId} (queue depth=${session.promptQueue.length})`,
          );
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
            unregisterAgentSessionMapping(session.handle);
            try {
              if (session.activeTurn) {
                await session.activeTurn.cancel({ reason: "Session closed" });
              }
              cancelSessionQueue(session, sessionId);
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

// Send a prompt_cancelled event to the ws that originally submitted the
// queued prompt. ws may be stale (e.g. client reconnected) — the send is
// allowed to fail silently in that case.
function sendPromptCancelled(ws, sessionId, requestId) {
  if (!ws || ws.readyState !== 1 /* OPEN */) {
    return;
  }
  ws.send(
    JSON.stringify({
      event: "prompt_cancelled",
      sessionId,
      requestId,
    }),
  );
}

// Cancel every prompt still sitting in the session's queue, notifying the
// originating ws for each one. The active turn is left untouched — callers
// handle the active-turn cancel separately so they can attach their own
// reason ("User cancelled via UI" vs "Session closed" vs "Clean shutdown").
function cancelSessionQueue(session, sessionId) {
  if (!session?.promptQueue) {
    return;
  }
  for (const item of session.promptQueue) {
    sendPromptCancelled(item.ws, sessionId, item.queuedRequestId);
  }
  session.promptQueue.length = 0;
}

// Start (or continue) running a prompt on the given session and chain into
// the next queued prompt when this turn completes. Extracted from
// case "prompt" so the queue-drain in the finally block can re-enter it
// without duplicating the event-consumption logic.
function runPromptTurn(session, sessionId, promptItem) {
  const requestId = `turn_${Date.now()}`;
  const turn = runtime.startTurn({
    handle: session.handle,
    text: promptItem.text,
    mode: "prompt",
    requestId,
  });

  session.activeTurn = turn;

  (async () => {
    try {
      for await (const event of turn.events) {
        const currentSession = activeSessions.get(sessionId);
        const targetWs = currentSession ? currentSession.ws : null;
        if (!targetWs || targetWs.readyState !== 1 /* OPEN */) {
          console.warn(`[acpx-server] ws is not open, skipping event: ${event.type}`);
          continue;
        }

        // event types: text_delta, status, tool_call, error
        if (event.type === "text_delta") {
          targetWs.send(
            JSON.stringify({
              event: "text_delta",
              sessionId,
              text: event.text,
              type: event.stream || "output", // 'thought' or 'output'
            }),
          );
        } else if (event.type === "tool_call") {
          console.log(
            "[acpx-server] Real-time tool_call event received:",
            JSON.stringify(event, null, 2),
          );
          // Forward rawInput as-is. During streaming the runtime may
          // emit a tool_call event before rawInput is populated; in
          // that case `arguments` is omitted on the wire and the
          // client skips rendering the placeholder card.
          targetWs.send(
            JSON.stringify({
              event: "tool_call",
              sessionId,
              toolName: event.toolName || event.title || event.text || "tool",
              toolCallId: event.toolCallId,
              ...(event.rawInput !== undefined ? { arguments: event.rawInput } : {}),
            }),
          );
          if (
            event.rawOutput !== undefined ||
            event.status === "success" ||
            event.status === "failed"
          ) {
            let textContent = "";
            if (event.rawOutput !== undefined && event.rawOutput !== null) {
              textContent =
                typeof event.rawOutput === "string"
                  ? event.rawOutput
                  : JSON.stringify(event.rawOutput);
            }
            targetWs.send(
              JSON.stringify({
                event: "tool_result",
                sessionId,
                toolCallId: event.toolCallId,
                toolName: event.toolName || event.title || event.text || "tool",
                text: textContent,
                isError: event.status === "failed",
              }),
            );
          }
        } else if (event.type === "error") {
          targetWs.send(
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

      const currentSession = activeSessions.get(sessionId);
      const targetWs = currentSession ? currentSession.ws : null;
      if (targetWs && targetWs.readyState === 1 /* OPEN */) {
        if (result.status === "failed") {
          targetWs.send(
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
            const status = await runtime.getStatus({ handle: currentSession.handle });
            summary = status.summary || summary;
          } catch {
            // Fallback
          }

          targetWs.send(
            JSON.stringify({
              event: "done",
              sessionId,
              summary,
            }),
          );
        }
      }
    } catch (err) {
      console.error(`[acpx-server] Error executing turn:`, err);
      const currentSession = activeSessions.get(sessionId);
      const targetWs = currentSession ? currentSession.ws : null;
      if (targetWs && targetWs.readyState === 1 /* OPEN */) {
        targetWs.send(
          JSON.stringify({
            event: "error",
            sessionId,
            message: err.message,
          }),
        );
      }
    } finally {
      const currentSession = activeSessions.get(sessionId);
      if (currentSession) {
        currentSession.activeTurn = null;
        if (currentSession.promptQueue.length > 0) {
          const next = currentSession.promptQueue.shift();
          runPromptTurn(currentSession, sessionId, next);
        }
      }
    }
  })();
}

// ----------------------------------------------------
// Permission Request Handling Callback
// ----------------------------------------------------
async function handlePermissionRequestCallback(req, ctx) {
  const { sessionId } = req;
  const clientSessionId = agentSessionToClientSession.get(sessionId) || sessionId;
  const session = activeSessions.get(clientSessionId);
  if (!session) {
    console.warn(
      `[acpx-server] Permission requested for unknown session: ${sessionId} (mapped clientSessionId: ${clientSessionId})`,
    );
    return { outcome: "reject_once" };
  }

  // Debug breadcrumb so the mode-vs-actual check is observable from the
  // bridge-server log without needing to attach a debugger. Logged on
  // every callback, not just the prompt-emitting branches, so you can
  // see auto-allow/reject decisions alongside the manual-prompt ones.
  console.log(
    `[acpx-server] permission check for ${req.raw.toolCall.title}:`,
    `mode=${session.permissionMode}, requestId=${req.raw.toolCall.toolCallId}`,
  );

  // Per-session mode shortcut — gates the prompt without round-tripping
  // through the UI. approve-reads falls through to the normal flow
  // (1acp internally auto-allows read/search; everything else prompts).
  // approve-all and deny-all are blanket decisions for the entire
  // session until the user toggles the mode again.
  if (session.permissionMode === "approve-all") {
    console.log(
      `[acpx-server] permission mode=approve-all → auto allow_once for ${req.raw.toolCall.title}`,
    );
    return { outcome: "allow_once" };
  }
  if (session.permissionMode === "deny-all") {
    console.log(
      `[acpx-server] permission mode=deny-all → auto reject_once for ${req.raw.toolCall.title}`,
    );
    return { outcome: "reject_once" };
  }

  const requestId = `perm_${nextRequestId++}`;
  console.log(
    `[acpx-server] Intercepted permission request: ${req.raw.toolCall.title}. RequestId: ${requestId} for client session: ${clientSessionId}`,
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
            sessionId: clientSessionId,
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
        sessionId: clientSessionId,
        requestId,
        toolCallId: req.raw.toolCall.toolCallId,
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
      unregisterAgentSessionMapping(session.handle);
      if (session.activeTurn) {
        promises.push(session.activeTurn.cancel({ reason: "Clean shutdown" }));
      }
      cancelSessionQueue(session, sessionId);
      promises.push(runtime.close({ handle: session.handle, reason: "Clean shutdown" }));
    } catch (e) {
      console.error(`[acpx-server] Cleanup error for session ${sessionId}:`, e);
    }
  }
  await Promise.all(promises);
  activeSessions.clear();
  agentSessionToClientSession.clear();
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
