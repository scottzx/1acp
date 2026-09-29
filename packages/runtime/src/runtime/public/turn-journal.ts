import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type AcpTurnJournalStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type AcpTurnJournalTurn = {
  id: string;
  turnId: string;
  sessionId: string;
  clientRequestId: string;
  status: AcpTurnJournalStatus;
  promptText: string;
  requestFingerprint: string;
  agentType?: string;
  finalAnswer?: string;
  errorCode?: string;
  errorText?: string;
  runtimeRecordId?: string;
  runtimeRequestId?: string;
  promptMessageId?: string;
  stopReason?: string;
  terminalSource?: string;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type AcpTurnJournalSnapshot = {
  sessionId: string;
  sequence: number;
  active?: AcpTurnJournalTurn;
  queued: AcpTurnJournalTurn[];
  turns: AcpTurnJournalTurn[];
};

export type AcpTurnJournalMutation = {
  sessionId: string;
  turnId: string;
  clientRequestId?: string;
  status: AcpTurnJournalStatus;
  promptText?: string;
  requestFingerprint?: string;
  agentType?: string;
  finalAnswer?: string;
  errorCode?: string;
  errorText?: string;
  runtimeRecordId?: string;
  runtimeRequestId?: string;
  promptMessageId?: string;
  stopReason?: string;
  terminalSource?: string;
  occurredAt?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AcpTurnJournalRecordResult = {
  turn: AcpTurnJournalTurn;
  created: boolean;
  changed: boolean;
};

type PersistedTurnJournalEvent = {
  schema: "acpx.turn.v1";
  sequence: number;
  session_id: string;
  turn_id: string;
  client_request_id: string;
  status: AcpTurnJournalStatus;
  prompt_text: string;
  request_fingerprint: string;
  agent_type?: string;
  final_answer?: string;
  error_code?: string;
  error_text?: string;
  runtime_record_id?: string;
  runtime_request_id?: string;
  prompt_message_id?: string;
  stop_reason?: string;
  terminal_source?: string;
  occurred_at: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
};

type JournalState = {
  sequence: number;
  byTurnId: Map<string, AcpTurnJournalTurn>;
  byClientRequestId: Map<string, AcpTurnJournalTurn>;
};

const TERMINAL_STATUSES = new Set<AcpTurnJournalStatus>(["completed", "failed", "cancelled"]);

function isTerminal(status: AcpTurnJournalStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function fingerprintPrompt(promptText: string): string {
  return createHash("sha256").update(promptText).digest("hex");
}

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function validTransition(
  previous: AcpTurnJournalStatus | undefined,
  next: AcpTurnJournalStatus,
): boolean {
  if (!previous || previous === next) {
    return true;
  }
  if (previous === "queued") {
    return next === "running" || isTerminal(next);
  }
  if (previous === "running") {
    return isTerminal(next);
  }
  return false;
}

function parseStatus(value: unknown): AcpTurnJournalStatus | undefined {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseEvent(value: unknown): PersistedTurnJournalEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  const status = parseStatus(event.status);
  if (
    event.schema !== "acpx.turn.v1" ||
    typeof event.sequence !== "number" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence <= 0 ||
    typeof event.session_id !== "string" ||
    typeof event.turn_id !== "string" ||
    typeof event.client_request_id !== "string" ||
    !status ||
    typeof event.prompt_text !== "string" ||
    typeof event.request_fingerprint !== "string" ||
    typeof event.occurred_at !== "string" ||
    typeof event.created_at !== "string"
  ) {
    return undefined;
  }
  return {
    schema: "acpx.turn.v1",
    sequence: event.sequence,
    session_id: event.session_id,
    turn_id: event.turn_id,
    client_request_id: event.client_request_id,
    status,
    prompt_text: event.prompt_text,
    request_fingerprint: event.request_fingerprint,
    agent_type: optionalString(event.agent_type),
    final_answer: optionalString(event.final_answer),
    error_code: optionalString(event.error_code),
    error_text: optionalString(event.error_text),
    runtime_record_id: optionalString(event.runtime_record_id),
    runtime_request_id: optionalString(event.runtime_request_id),
    prompt_message_id: optionalString(event.prompt_message_id),
    stop_reason: optionalString(event.stop_reason),
    terminal_source: optionalString(event.terminal_source),
    occurred_at: event.occurred_at,
    created_at: event.created_at,
    started_at: optionalString(event.started_at),
    completed_at: optionalString(event.completed_at),
  };
}

function applyEvent(state: JournalState, event: PersistedTurnJournalEvent): void {
  const previous = state.byTurnId.get(event.turn_id);
  const turn: AcpTurnJournalTurn = {
    id: event.turn_id,
    turnId: event.turn_id,
    sessionId: event.session_id,
    clientRequestId: event.client_request_id,
    status: event.status,
    promptText: event.prompt_text,
    requestFingerprint: event.request_fingerprint,
    agentType: event.agent_type ?? previous?.agentType,
    finalAnswer: event.final_answer ?? previous?.finalAnswer,
    errorCode: event.error_code,
    errorText: event.error_text,
    runtimeRecordId: event.runtime_record_id ?? previous?.runtimeRecordId,
    runtimeRequestId: event.runtime_request_id ?? previous?.runtimeRequestId,
    promptMessageId: event.prompt_message_id ?? previous?.promptMessageId,
    stopReason: event.stop_reason ?? previous?.stopReason,
    terminalSource: event.terminal_source ?? previous?.terminalSource,
    lastEventSeq: event.sequence,
    createdAt: event.created_at,
    updatedAt: event.occurred_at,
    startedAt: event.started_at ?? previous?.startedAt,
    completedAt: event.completed_at ?? previous?.completedAt,
  };
  state.sequence = Math.max(state.sequence, event.sequence);
  state.byTurnId.set(turn.turnId, turn);
  state.byClientRequestId.set(turn.clientRequestId, turn);
}

function emptyState(): JournalState {
  return {
    sequence: 0,
    byTurnId: new Map(),
    byClientRequestId: new Map(),
  };
}

function sameMutation(turn: AcpTurnJournalTurn, input: AcpTurnJournalMutation): boolean {
  return (
    turn.status === input.status &&
    (input.finalAnswer === undefined || turn.finalAnswer === input.finalAnswer) &&
    (input.errorCode === undefined || turn.errorCode === input.errorCode) &&
    (input.errorText === undefined || turn.errorText === input.errorText) &&
    (input.stopReason === undefined || turn.stopReason === input.stopReason) &&
    (input.runtimeRequestId === undefined || turn.runtimeRequestId === input.runtimeRequestId) &&
    (input.promptMessageId === undefined || turn.promptMessageId === input.promptMessageId)
  );
}

export class AcpTurnJournal {
  private readonly stateDir: string;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(options: { stateDir: string }) {
    this.stateDir = path.resolve(options.stateDir);
  }

  private filePath(sessionId: string): string {
    return path.join(this.stateDir, "sessions", `${safeSessionId(sessionId)}.turns.ndjson`);
  }

  private async readState(sessionId: string): Promise<JournalState> {
    const state = emptyState();
    let payload: string;
    try {
      payload = await fs.readFile(this.filePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return state;
      }
      throw error;
    }
    for (const line of payload.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = parseEvent(JSON.parse(line) as unknown);
        if (event && event.session_id === sessionId) {
          applyEvent(state, event);
        }
      } catch {
        // A malformed final line must not make earlier durable Turn facts unreadable.
      }
    }
    return state;
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.chains.set(sessionId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release?.();
      if (this.chains.get(sessionId) === queued) {
        this.chains.delete(sessionId);
      }
    }
  }

  async record(input: AcpTurnJournalMutation): Promise<AcpTurnJournalRecordResult> {
    return await this.withSessionLock(input.sessionId, async () => {
      const state = await this.readState(input.sessionId);
      const clientRequestId = input.clientRequestId || input.turnId;
      const promptText = input.promptText ?? "";
      const byRequest = state.byClientRequestId.get(clientRequestId);
      const previous = state.byTurnId.get(input.turnId);
      const requestFingerprint =
        input.requestFingerprint ||
        (previous?.promptText === promptText ? previous.requestFingerprint : undefined) ||
        fingerprintPrompt(promptText);
      if (byRequest && byRequest.turnId !== input.turnId) {
        if (byRequest.requestFingerprint !== requestFingerprint) {
          throw new Error(`Turn idempotency conflict for request ${clientRequestId}`);
        }
        return { turn: byRequest, created: false, changed: false };
      }

      if (
        previous &&
        previous.requestFingerprint &&
        requestFingerprint &&
        previous.requestFingerprint !== requestFingerprint
      ) {
        throw new Error(`Turn idempotency conflict for ${input.turnId}`);
      }
      if (!validTransition(previous?.status, input.status)) {
        throw new Error(`Invalid Turn transition ${previous?.status} -> ${input.status}`);
      }
      if (previous && sameMutation(previous, input)) {
        return { turn: previous, created: false, changed: false };
      }

      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const createdAt = previous?.createdAt ?? occurredAt;
      const startedAt =
        input.startedAt ??
        previous?.startedAt ??
        (input.status === "running" ? occurredAt : undefined);
      const completedAt =
        input.completedAt ??
        previous?.completedAt ??
        (isTerminal(input.status) ? occurredAt : undefined);
      const event: PersistedTurnJournalEvent = {
        schema: "acpx.turn.v1",
        sequence: state.sequence + 1,
        session_id: input.sessionId,
        turn_id: input.turnId,
        client_request_id: clientRequestId,
        status: input.status,
        prompt_text: previous?.promptText || promptText,
        request_fingerprint: previous?.requestFingerprint || requestFingerprint,
        agent_type: input.agentType ?? previous?.agentType,
        final_answer: input.finalAnswer ?? previous?.finalAnswer,
        error_code: input.errorCode,
        error_text: input.errorText,
        runtime_record_id: input.runtimeRecordId ?? previous?.runtimeRecordId,
        runtime_request_id: input.runtimeRequestId ?? previous?.runtimeRequestId,
        prompt_message_id: input.promptMessageId ?? previous?.promptMessageId,
        stop_reason: input.stopReason ?? previous?.stopReason,
        terminal_source: input.terminalSource ?? previous?.terminalSource,
        occurred_at: occurredAt,
        created_at: createdAt,
        started_at: startedAt,
        completed_at: completedAt,
      };

      const journalPath = this.filePath(input.sessionId);
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      const file = await fs.open(journalPath, "a+");
      try {
        const stats = await file.stat();
        if (stats.size > 0) {
          const trailing = Buffer.alloc(1);
          await file.read(trailing, 0, 1, stats.size - 1);
          if (trailing[0] !== 0x0a) {
            await file.write("\n");
          }
        }
        await file.write(`${JSON.stringify(event)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      applyEvent(state, event);
      return {
        turn: state.byTurnId.get(input.turnId)!,
        created: previous === undefined,
        changed: true,
      };
    });
  }

  async snapshot(sessionId: string): Promise<AcpTurnJournalSnapshot> {
    return await this.withSessionLock(sessionId, async () => {
      const state = await this.readState(sessionId);
      const turns = [...state.byTurnId.values()].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.lastEventSeq - right.lastEventSeq,
      );
      return {
        sessionId,
        sequence: state.sequence,
        active: turns.find((turn) => turn.status === "running"),
        queued: turns.filter((turn) => turn.status === "queued"),
        turns,
      };
    });
  }
}

export function createTurnJournal(options: { stateDir: string }): AcpTurnJournal {
  return new AcpTurnJournal(options);
}
