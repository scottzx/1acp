import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  SessionRecord,
} from "../../types.js";
import type { SessionAgentOptions } from "../engine/session-options.js";

export type { SessionAgentOptions, SystemPromptOption } from "../engine/session-options.js";

export type { AcpPermissionDecision, AcpPermissionRequest } from "../../types.js";

export type AcpRuntimePromptMode = "prompt" | "steer";

export type AcpRuntimeSessionMode = "persistent" | "oneshot";

export type AcpSessionUpdateTag =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "usage_update"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update"
  | "session_info_update"
  | "plan"
  | (string & {});

export type AcpRuntimeControl = "session/set_mode" | "session/set_config_option" | "session/status";

export type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

export type AcpRuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
  /**
   * Per-session agent options applied when a fresh ACP session is created.
   * Threaded into `_meta.systemPrompt` (and `_meta.claudeCode.options.*`)
   * on the underlying `session/new` request, and persisted onto the new
   * record. Ignored when an existing persistent session is reused — system
   * prompts are fixed at `newSession` time, so changing them requires a
   * different sessionKey or closing the prior record first.
   */
  sessionOptions?: SessionAgentOptions;
};

export type AcpRuntimeTurnAttachment = {
  /**
   * Media type for binary prompt attachments. The runtime currently maps
   * image/* and audio/* attachments to ACP prompt content blocks.
   */
  mediaType: string;
  data: string;
};

export type AcpRuntimeTurnInput = {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  configOptionKeys?: string[];
};

export type AcpRuntimeSessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
};

/**
 * One session mode the agent advertised (ACP `SessionMode`). `name` is the
 * agent-facing display label; ids differ across agents (Claude Code:
 * default/acceptEdits/plan/..., Codex: read-only/agent/...), so consumers
 * must render data-driven rather than assume a fixed id set.
 */
export type AcpRuntimeSessionModeInfo = {
  id: string;
  name: string;
  description?: string;
};

/**
 * Session-mode state extracted from the persisted record: the mode select
 * config option supplies `availableModes`; the last `current_mode_update`
 * (or the option's currentValue) supplies `currentModeId`.
 */
export type AcpRuntimeSessionModes = {
  currentModeId?: string;
  availableModes: AcpRuntimeSessionModeInfo[];
};

/**
 * Cumulative session cost as reported by the agent. Mirrors ACP's
 * `Cost`, but both fields are optional here because not every adapter
 * populates them on every event.
 */
export type AcpRuntimeUsageCost = {
  amount?: number;
  currency?: string;
};

/**
 * Per-turn token breakdown. Sourced from final prompt response usage or
 * `UsageUpdate._meta.usage` on adapters that populate it. All fields optional —
 * consumers should treat missing fields as "unknown", not "zero".
 */
export type AcpRuntimeUsageBreakdown = {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type AcpRuntimeConfigOptionChoice = {
  value: string;
  name: string;
  description?: string;
};

/**
 * A normalized ACP session config option (a `select` — model, reasoning
 * effort, etc.). `category` echoes the agent's grouping ("model" / "effort" /
 * "mode" / …) when present; the "mode" option is surfaced separately via
 * `modes`, so config-option consumers should skip it. Model option groups are
 * flattened into a single `options` list.
 */
export type AcpRuntimeConfigOption = {
  id: string;
  name: string;
  category?: string;
  currentValue?: string;
  options: AcpRuntimeConfigOptionChoice[];
};

export type AcpRuntimePlanEntryStatus = "pending" | "in_progress" | "completed";

/**
 * One entry of the agent's execution plan (ACP `PlanEntry`, emitted by
 * Claude Code's TodoWrite and Codex's plan updates). The agent re-sends the
 * FULL list on every update — consumers replace their plan wholesale, never
 * merge.
 */
export type AcpRuntimePlanEntry = {
  content: string;
  status: AcpRuntimePlanEntryStatus;
  priority?: "high" | "medium" | "low";
};

/**
 * Agent-advertised slash command. The runtime only surfaces enough to
 * drive a picker UI ("does the agent advertise /compact?"). The full
 * `AvailableCommandInput` schema from ACP is intentionally not plumbed
 * through.
 */
export type AcpRuntimeAvailableCommand = {
  name: string;
  description?: string;
  /** True/false when ACP advertised whether this command has an input schema. */
  hasInput?: boolean;
};

/**
 * Session-level usage roll-up surfaced through `getStatus()`. The
 * reducer persists the breakdowns onto the session record; this type
 * exposes them on the runtime contract.
 */
export type AcpRuntimeSessionUsage = {
  cumulative?: AcpRuntimeUsageBreakdown;
  /** Cumulative session cost when the agent reported it. */
  cost?: AcpRuntimeUsageCost;
  /** Keyed by user-message id, matching the persisted reducer state. */
  perRequest?: Record<string, AcpRuntimeUsageBreakdown>;
};

export type AcpRuntimeStatus = {
  summary?: string;
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
  models?: AcpRuntimeSessionModels;
  /**
   * Session modes the agent advertised, plus the current one. Parsed from
   * the persisted record's config options / current_mode_id; absent when
   * the agent never advertised a mode select (mode-less agents).
   */
  modes?: AcpRuntimeSessionModes;
  /**
   * Normalized session config options the agent advertised (model, reasoning
   * effort, …). The "mode" select is surfaced via `modes` instead and omitted
   * here. Absent when the agent advertised no non-mode config options.
   */
  configOptions?: AcpRuntimeConfigOption[];
  /** Token usage and cost from the persisted session record. */
  usage?: AcpRuntimeSessionUsage;
  /**
   * Commands the agent advertised via `available_commands_update`.
   * Sourced from the persisted record — older session files only
   * preserve `name`, so `description` and `hasInput` may be undefined
   * even when a more recent live event would have carried both.
   */
  availableCommands?: AcpRuntimeAvailableCommand[];
  details?: Record<string, unknown>;
};

export type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};

export type AcpRuntimeEvent =
  | {
      type: "text_delta";
      text: string;
      stream?: "output" | "thought";
      tag?: AcpSessionUpdateTag;
    }
  | {
      type: "status";
      text: string;
      tag?: AcpSessionUpdateTag;
      used?: number;
      size?: number;
      /** Populated on `usage_update` events when the agent reported a cost. */
      cost?: AcpRuntimeUsageCost;
      /**
       * Populated on `usage_update` events when the agent attached a
       * per-turn breakdown via `_meta.usage` (Claude Code does this; not
       * every adapter does).
       */
      breakdown?: AcpRuntimeUsageBreakdown;
      /**
       * Populated on `available_commands_update` events. The list is a
       * normalized view of the wire payload — names, descriptions, and
       * a `hasInput` flag derived from whether the agent advertised a
       * non-null `input` schema.
       */
      availableCommands?: AcpRuntimeAvailableCommand[];
      /**
       * Populated on `current_mode_update` events: the mode the agent
       * switched to (e.g. plan → default after ExitPlanMode). Consumers
       * that mirror mode state should treat this as authoritative.
       */
      currentModeId?: string;
      /**
       * Populated on `plan` events: the agent's full execution plan
       * (TodoWrite / Codex plan). The complete list on every update — the
       * host replaces its checklist wholesale.
       */
      planEntries?: AcpRuntimePlanEntry[];
    }
  | {
      type: "tool_call";
      text: string;
      tag?: AcpSessionUpdateTag;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: ToolKind;
      locations?: ToolCallLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: ToolCallContent[];
      toolName?: string;
    }
  /**
   * Compatibility terminal event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "done";
      stopReason?: string;
    }
  /**
   * Compatibility failure event emitted by runTurn(...). startTurn(...).events
   * does not emit terminal events; use AcpRuntimeTurn.result instead.
   */
  | {
      type: "error";
      message: string;
      code?: string;
      detailCode?: string;
      retryable?: boolean;
    };

export type AcpRuntimeTurnResultError = {
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};

export type AcpRuntimeTurnResult =
  | {
      status: "completed";
      stopReason?: string;
    }
  | {
      status: "cancelled";
      stopReason?: string;
    }
  | {
      status: "failed";
      error: AcpRuntimeTurnResultError;
    };

export interface AcpRuntimeTurn {
  readonly requestId: string;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
  closeStream(input?: { reason?: string }): Promise<void>;
}

export interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  logoutSession?(input: { handle: AcpRuntimeHandle }): Promise<void>;
  authenticateSession?(input: {
    handle: AcpRuntimeHandle;
    methodId: string;
    credentials?: Record<string, string>;
  }): Promise<void>;
  forkSession?(input: {
    handle: AcpRuntimeHandle;
    cwd?: string;
  }): Promise<{ sessionId: string; agentSessionId?: string }>;
  deleteSession?(input: { handle: AcpRuntimeHandle; sessionId: string }): Promise<void>;
  startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  /**
   * Compatibility adapter for consumers that expect terminal status in the
   * event stream. Prefer startTurn(...), which separates live events from the
   * terminal result.
   */
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<AcpRuntimeStatus>;
  setMode?(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
  setConfigOption?(input: { handle: AcpRuntimeHandle; key: string; value: string }): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    discardPersistentState?: boolean;
  }): Promise<void>;
}

export type AcpSessionRecord = SessionRecord;

export interface AcpSessionStore {
  load(sessionId: string): Promise<AcpSessionRecord | undefined>;
  save(record: AcpSessionRecord): Promise<void>;
}

export interface AcpAgentRegistry {
  resolve(agentName: string): string;
  list(): string[];
}

export type AcpRuntimeOptions = {
  cwd: string;
  sessionStore: AcpSessionStore;
  agentRegistry: AcpAgentRegistry;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  timeoutMs?: number;
  probeAgent?: string;
  verbose?: boolean;
  onPermissionRequest?: (
    req: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision | undefined>;
  /**
   * Fired after an OUT-OF-TURN session notification (one that arrived between
   * newSession and the first turn, e.g. available_commands_update) has been
   * folded into the persisted record. Lets a host push a fresh capability
   * snapshot immediately instead of waiting for the next turn/reconnect.
   * `sessionKey` is the ensureSession key (the persistent record id).
   */
  onOutOfTurnSessionUpdate?: (sessionKey: string) => void;
};

export type AcpFileSessionStoreOptions = {
  stateDir: string;
};
