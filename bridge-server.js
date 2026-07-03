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
// "总是允许" allowlists are project-level: one file per workspace, stored inside
// the project folder (see allowRulesFile). Shared by every session in that
// project and living on disk means a recorded rule survives idle-reap, resume
// and bridge restart — the very cases where the agent's own allowlist is lost.
const ALLOW_RULES_FILENAME = path.join(".1agents", "allow-rules.json");

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
// Tool display name helpers
// ----------------------------------------------------

// Map ACP tool-kind values to friendly display names used in the chat UI.
// This prevents agents like Codex from leaking the raw command string as
// the tool "name" — the command belongs in the arguments/summary row instead.
const TOOL_KIND_LABELS = {
  execute: "Bash",
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
  other: "Tool",
};

/**
 * Derive the best human-readable tool name to surface in the chat card header.
 *
 * Priority:
 *  1. event.toolName – explicitly set by claudeCode adapter via _meta
 *  2. TOOL_KIND_LABELS[event.kind] – semantic kind → friendly label (covers Codex)
 *  3. event.title – only when it looks like a proper name (no spaces, ≤40 chars)
 *  4. "Tool" fallback
 */
function resolveToolDisplayName(event) {
  if (event.toolName) {
    return event.toolName;
  }
  if (event.kind && TOOL_KIND_LABELS[event.kind]) {
    return TOOL_KIND_LABELS[event.kind];
  }
  const title = event.title || event.text || "";
  // Use title only when it looks like an identifier (no whitespace, reasonable length)
  if (title && !/\s/.test(title) && title.length <= 40) {
    return title;
  }
  return "Tool";
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

// ── "总是允许" persistent allowlist (project-level) ─────────────────────────
// A single click on 总是允许 records a "tool + argument prefix" rule for the
// whole project; future matching requests are auto-allowed without a card.
// Granularity is intentionally coarse-but-safe: command tools key on the first
// two command tokens (so every `git commit …` matches, but `git push …` still
// prompts); file tools key on the target path; anything else falls back to the
// tool name. Rules are read fresh from disk on each check (no in-memory cache),
// so concurrent sessions in the same project share them immediately and writes
// never clobber each other.

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") {
      return v;
    }
  }
  return null;
}

function permissionRuleKey(toolName, rawInput) {
  const name = toolName || "Tool";
  const input =
    typeof rawInput === "string"
      ? { command: rawInput }
      : rawInput && typeof rawInput === "object"
        ? rawInput
        : {};
  let sig = "";
  const command = firstString(input, ["command", "cmd", "script", "command_line", "commandLine"]);
  if (command) {
    // First two whitespace tokens → e.g. "git commit", "npm run".
    sig = command.trim().split(/\s+/).slice(0, 2).join(" ");
  } else {
    const targetPath = firstString(input, [
      "file_path",
      "filePath",
      "path",
      "abspath",
      "absolute_path",
    ]);
    if (targetPath) {
      sig = targetPath.trim();
    }
  }
  // A single space joins the two fields; tool names are whitespace-free
  // identifiers, so the first space is always the name|prefix boundary.
  return `${name} ${sig}`;
}

function allowRulesFile(workspacePath) {
  return path.join(workspacePath, ALLOW_RULES_FILENAME);
}

function loadAllowRules(workspacePath) {
  try {
    const arr = JSON.parse(fs.readFileSync(allowRulesFile(workspacePath), "utf8"));
    if (Array.isArray(arr)) {
      return new Set(arr.filter((x) => typeof x === "string"));
    }
  } catch {
    // Missing or corrupt file → no rules yet.
  }
  return new Set();
}

function isAllowRuleMatched(workspacePath, ruleKey) {
  if (!workspacePath) {
    return false;
  }
  return loadAllowRules(workspacePath).has(ruleKey);
}

// Union the new rule into the on-disk set (read-merge-write) so a concurrent
// session's rules are never clobbered. Returns true if it was newly added.
function addAllowRule(workspacePath, ruleKey) {
  if (!workspacePath || !ruleKey) {
    return false;
  }
  const rules = loadAllowRules(workspacePath);
  if (rules.has(ruleKey)) {
    return false;
  }
  rules.add(ruleKey);
  try {
    fs.mkdirSync(path.dirname(allowRulesFile(workspacePath)), { recursive: true });
    fs.writeFileSync(allowRulesFile(workspacePath), JSON.stringify([...rules]), "utf8");
  } catch (err) {
    console.warn(`[acpx-server] Failed to persist allow rule for ${workspacePath}:`, err.message);
  }
  return true;
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
            mcpServers,
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
            // {append} keeps the agent's own system prompt intact; a plain
            // string would REPLACE it entirely (see 1acp agent-command.ts
            // assignClaudeCodeSystemPrompt), which is never what a bridge
            // client supplying extra context wants.
            sessionOptions.systemPrompt = { append: systemContext };
          }
          // Per-session MCP servers (e.g. the AI Project Manager's
          // project-locked task tools). Merged with runtime-level servers in
          // the engine; only applies when this session's client is created.
          if (Array.isArray(mcpServers) && mcpServers.length > 0) {
            sessionOptions.mcpServers = mcpServers;
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
            // Re-deliver any permission requests that were in-flight when the
            // previous WebSocket dropped. The ACP runtime is still blocked
            // waiting for the response; re-sending the event lets the newly
            // connected client surface the prompt without a page reload.
            for (const pending of pendingPermissions.values()) {
              if (pending.sessionId === sessionId) {
                ws.send(JSON.stringify(pending.payload));
              }
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
            void sendSessionMeta(ws, sessionId, existingSession.handle);
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
              void sendSessionMeta(ws, sessionId, handle);
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
            void sendSessionMeta(ws, sessionId, handle);
          } finally {
            initializingSessions.delete(sessionId);
          }
          break;
        }

        case "prompt": {
          // attachments: optional [{ mediaType, data }] (base64) — forwarded
          // to runtime.startTurn, which maps image/* and audio/* onto ACP
          // content blocks. Other media types are rejected by the runtime.
          const { text, attachments } = payload;
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
              attachments,
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

          runPromptTurn(session, sessionId, { text, attachments });
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

          // "总是允许" → persist a project-level rule so future matching calls
          // skip the prompt (survives reap/resume/restart). We still forward
          // allow_always to the agent so its own allowlist records it too.
          if (outcome === "allow_always" && addAllowRule(pending.workspacePath, pending.ruleKey)) {
            console.log(
              `[acpx-server] Recorded allow_always rule (${pending.ruleKey}) for project ${pending.workspacePath}`,
            );
          }

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
          // The gate lives ENTIRELY in handlePermissionRequestCallback (plus
          // the project allow-rules file) — every permission request funnels
          // through it, so deny-all/approve-all take effect on the very next
          // tool call with no runtime involvement. Do NOT push these values
          // via runtime.setMode: that is ACP session/set_mode, whose ids are
          // the agent's NATIVE modes (default/plan/read-only/…). Adapters
          // reject foreign ids like "approve-reads", and once native modes
          // are user-visible the call would clobber the user's chosen mode
          // and corrupt the persisted desiredModeId.
          ws.send(
            JSON.stringify({
              event: "permission_mode_changed",
              sessionId,
              permissionMode: mode,
            }),
          );
          break;
        }

        case "set_session_mode": {
          // Switch the agent's NATIVE session mode (ACP session/set_mode) —
          // e.g. Claude Code's default/acceptEdits/plan or Codex's
          // read-only/agent. Distinct from set_permission_mode, which only
          // moves the bridge's own permission gate. runtime.setMode persists
          // desiredModeId and replays it onto fresh ACP sessions after
          // reap/resume, so the choice sticks across reconnects for free.
          const modeId = payload.payload?.modeId;
          if (!sessionId || !modeId) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId and payload.modeId are required");
            return;
          }
          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }
          try {
            await runtime.setMode({ handle: session.handle, mode: modeId });
            console.log(`[acpx-server] session mode for ${sessionId} set to ${modeId}`);
            ws.send(
              JSON.stringify({
                event: "mode_changed",
                sessionId,
                payload: { currentModeId: modeId },
              }),
            );
          } catch (err) {
            // Adapters validate against availableModes — surface the refusal
            // and resend the authoritative snapshot so an optimistic UI can
            // roll back to the real current mode.
            console.warn(
              `[acpx-server] set_session_mode ${modeId} failed for ${sessionId}:`,
              err.message,
            );
            sendError(ws, sessionId, "SET_MODE_FAILED", err.message);
            void sendSessionMeta(ws, sessionId, session.handle);
          }
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

        case "cancel_turn": {
          // Composer "停止": stop generating without tearing the session down.
          // Cancels the active turn and drops any queued prompts, but keeps
          // the session in activeSessions so the user can immediately continue
          // the conversation. (Full teardown is close_session, below.) The
          // cancelled turn settles with status "cancelled", so runPromptTurn
          // emits a normal `done` — no error is surfaced to the client.
          if (!sessionId) {
            sendError(ws, sessionId, "INVALID_PARAMS", "sessionId is required");
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session) {
            sendError(ws, sessionId, "SESSION_NOT_FOUND", "Session not initialized");
            return;
          }

          // Drop the queue first so the active turn's finally block doesn't
          // auto-start a queued prompt after we cancel it.
          cancelSessionQueue(session, sessionId);
          if (session.activeTurn) {
            try {
              await session.activeTurn.cancel({ reason: "Stopped by user" });
            } catch (err) {
              console.error(`[acpx-server] Error cancelling turn for ${sessionId}:`, err);
            }
          }
          console.log(`[acpx-server] Cancelled active turn for session: ${sessionId}`);
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
      // An AgentStartupError with exit 127 / "command not found" means the
      // agent's ACP adapter binary could not be launched — almost always
      // because the adapter package isn't installed for 1acp (the bare
      // `npx … codex-acp` fallback fell through to PATH). Surface an
      // actionable message instead of the opaque raw shell error.
      if (
        err?.detailCode === "AGENT_STARTUP_FAILED" &&
        (err.exitCode === 127 ||
          /command not found|ENOENT|not found/i.test(err.stderrSummary || err.message || ""))
      ) {
        const cmd = err.agentCommand || "the ACP adapter";
        sendError(
          ws,
          sessionId,
          "AGENT_ADAPTER_MISSING",
          `ACP adapter failed to launch (${cmd}). The adapter is not installed for 1acp. ` +
            `Run: cd modules/1acp && pnpm install, then restart 1agents. ` +
            `Underlying: ${err.stderrSummary || err.message}`,
        );
      } else {
        sendError(ws, sessionId, "ACTION_FAILED", err.message);
      }
    }
  });

  ws.on("close", () => {
    console.log("[acpx-server] Go backend client disconnected.");
  });
});

// Send the session's advertised capability snapshot (native modes, models,
// slash commands) right after session_ready. Structured data rides a single
// `payload` object — the Go relay forwards frames verbatim and never parses
// payload. Re-sent on every ensure_session, so a reconnecting client always
// converges on the authoritative state (modes are live-only, never in
// history). Failures are non-fatal: a mode-less agent just gets no picker.
async function sendSessionMeta(ws, sessionId, handle) {
  try {
    const status = await runtime.getStatus({ handle });
    const payload = {};
    if (status.modes) {
      payload.modes = status.modes;
    }
    if (status.models) {
      payload.models = status.models;
    }
    if (status.availableCommands) {
      payload.availableCommands = status.availableCommands;
    }
    if (Object.keys(payload).length === 0) {
      return;
    }
    if (ws.readyState !== 1 /* OPEN */) {
      return;
    }
    ws.send(JSON.stringify({ event: "session_meta", sessionId, payload }));
  } catch (err) {
    console.warn(`[acpx-server] sendSessionMeta failed for ${sessionId}:`, err.message);
  }
}

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
  const attachments = Array.isArray(promptItem.attachments)
    ? promptItem.attachments.filter(
        (a) => a && typeof a.mediaType === "string" && typeof a.data === "string",
      )
    : [];
  const turn = runtime.startTurn({
    handle: session.handle,
    text: promptItem.text,
    ...(attachments.length > 0 ? { attachments } : {}),
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
              toolName: resolveToolDisplayName(event),
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
                toolName: resolveToolDisplayName(event),
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
        } else if (
          event.type === "status" &&
          event.tag === "current_mode_update" &&
          event.currentModeId
        ) {
          // The agent switched its own native mode mid-turn (e.g. ExitPlanMode
          // flips plan → default). Mirror it so the client's mode picker
          // follows without a reconnect.
          targetWs.send(
            JSON.stringify({
              event: "mode_changed",
              sessionId,
              payload: { currentModeId: event.currentModeId },
            }),
          );
        } else if (
          event.type === "status" &&
          event.tag === "available_commands_update" &&
          Array.isArray(event.availableCommands)
        ) {
          // Live refresh of the slash-command list (rare mid-session; the
          // session_meta snapshot covers the common case at session start).
          targetWs.send(
            JSON.stringify({
              event: "available_commands_update",
              sessionId,
              payload: { availableCommands: event.availableCommands },
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
          // A user "停止" cancels the turn (status "cancelled"); a natural
          // finish is "completed". Both end with `done`, but the cancelled
          // one carries `stopped: true` so the Go side records the partial
          // reply without flipping the task to Completed (a manual stop must
          // not change task status).
          const stopped = result.status === "cancelled";

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
              ...(stopped ? { stopped: true } : {}),
            }),
          );
          // Refresh the capability snapshot: slash commands are advertised via
          // an out-of-turn notification the runtime only records while a turn's
          // event handlers are installed, so they first become available now.
          // Re-sending session_meta lights up the `/` palette after turn one.
          void sendSessionMeta(targetWs, sessionId, currentSession.handle);
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

  // Project-level "总是允许" allowlist: a prior allow_always for this
  // tool+prefix auto-approves without prompting again. Read fresh from the
  // project file so it survives reap/resume/restart and is shared across
  // sessions in the same project.
  const workspacePath = session.handle?.cwd;
  const ruleKey = permissionRuleKey(
    resolveToolDisplayName(req.raw.toolCall),
    req.raw.toolCall.rawInput,
  );
  if (isAllowRuleMatched(workspacePath, ruleKey)) {
    console.log(
      `[acpx-server] permission allowlisted (${ruleKey}) → auto allow_once for ${req.raw.toolCall.title}`,
    );
    return { outcome: "allow_once" };
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

    // Save pending info — include session and full payload so the reconnect
    // path can re-deliver the event to a new WebSocket without re-running
    // the permission logic.
    pendingPermissions.set(requestId, {
      resolve,
      reject,
      timer,
      sessionId: clientSessionId,
      // Captured at request time so an allow_always response records the exact
      // same rule against the same project file (no recomputation drift).
      ruleKey,
      workspacePath,
      payload: {
        event: "permission_request",
        sessionId: clientSessionId,
        requestId,
        toolCallId: req.raw.toolCall.toolCallId,
        toolName: resolveToolDisplayName(req.raw.toolCall),
        arguments: req.raw.toolCall.rawInput || {},
      },
    });

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
        toolName: resolveToolDisplayName(req.raw.toolCall),
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
