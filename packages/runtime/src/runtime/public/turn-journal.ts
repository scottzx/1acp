import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const journalEventSchema = z.object({
  schema: z.literal("acpx.turn.v1"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  session_id: z.string(),
  turn_id: z.string(),
  client_request_id: z.string(),
  prompt_text: z.string(),
  request_fingerprint: z.string(),
  occurred_at: z.string(),
  created_at: z.string(),
  agent_type: z.unknown().optional().transform(optionalString),
  final_answer: z.unknown().optional().transform(optionalString),
  error_code: z.unknown().optional().transform(optionalString),
  error_text: z.unknown().optional().transform(optionalString),
  runtime_record_id: z.unknown().optional().transform(optionalString),
  runtime_request_id: z.unknown().optional().transform(optionalString),
  prompt_message_id: z.unknown().optional().transform(optionalString),
  stop_reason: z.unknown().optional().transform(optionalString),
  terminal_source: z.unknown().optional().transform(optionalString),
  started_at: z.unknown().optional().transform(optionalString),
  completed_at: z.unknown().optional().transform(optionalString),
});

function parseEvent(value: unknown): PersistedTurnJournalEvent | undefined {
  return journalEventSchema.safeParse(value).data;
}

function retainedValue<K extends keyof AcpTurnJournalTurn>(
  value: AcpTurnJournalTurn[K] | undefined,
  previous: AcpTurnJournalTurn | undefined,
  key: K,
): AcpTurnJournalTurn[K] | undefined {
  return value ?? previous?.[key];
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
    agentType: retainedValue(event.agent_type, previous, "agentType"),
    finalAnswer: retainedValue(event.final_answer, previous, "finalAnswer"),
    errorCode: event.error_code,
    errorText: event.error_text,
    runtimeRecordId: retainedValue(event.runtime_record_id, previous, "runtimeRecordId"),
    runtimeRequestId: retainedValue(event.runtime_request_id, previous, "runtimeRequestId"),
    promptMessageId: retainedValue(event.prompt_message_id, previous, "promptMessageId"),
    stopReason: retainedValue(event.stop_reason, previous, "stopReason"),
    terminalSource: retainedValue(event.terminal_source, previous, "terminalSource"),
    lastEventSeq: event.sequence,
    createdAt: event.created_at,
    updatedAt: event.occurred_at,
    startedAt: retainedValue(event.started_at, previous, "startedAt"),
    completedAt: retainedValue(event.completed_at, previous, "completedAt"),
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
  const fields = [
    "finalAnswer",
    "errorCode",
    "errorText",
    "stopReason",
    "runtimeRequestId",
    "promptMessageId",
  ] as const;
  return (
    turn.status === input.status &&
    fields.every((key) => input[key] === undefined || turn[key] === input[key])
  );
}

function validateMutation(
  previous: AcpTurnJournalTurn | undefined,
  input: AcpTurnJournalMutation,
  fingerprint: string,
): void {
  if (
    previous &&
    previous.requestFingerprint &&
    fingerprint &&
    previous.requestFingerprint !== fingerprint
  ) {
    throw new Error(`Turn idempotency conflict for ${input.turnId}`);
  }
  if (!validTransition(previous?.status, input.status)) {
    throw new Error(`Invalid Turn transition ${previous?.status} -> ${input.status}`);
  }
}

function mutationFingerprint(
  input: AcpTurnJournalMutation,
  previous: AcpTurnJournalTurn | undefined,
): string {
  const promptText = input.promptText ?? "";
  return (
    input.requestFingerprint ||
    (previous?.promptText === promptText ? previous.requestFingerprint : undefined) ||
    fingerprintPrompt(promptText)
  );
}

function transitionTime(
  value: string | undefined,
  previous: AcpTurnJournalTurn | undefined,
  key: "startedAt" | "completedAt",
  transition: boolean,
  occurredAt: string,
): string | undefined {
  return retainedValue(value, previous, key) ?? (transition ? occurredAt : undefined);
}

function mutationTimestamps(
  input: AcpTurnJournalMutation,
  previous: AcpTurnJournalTurn | undefined,
): Pick<PersistedTurnJournalEvent, "occurred_at" | "created_at" | "started_at" | "completed_at"> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    occurred_at: occurredAt,
    created_at: previous?.createdAt ?? occurredAt,
    started_at: transitionTime(
      input.startedAt,
      previous,
      "startedAt",
      input.status === "running",
      occurredAt,
    ),
    completed_at: transitionTime(
      input.completedAt,
      previous,
      "completedAt",
      isTerminal(input.status),
      occurredAt,
    ),
  };
}

function mutationEvent(
  input: AcpTurnJournalMutation,
  previous: AcpTurnJournalTurn | undefined,
  sequence: number,
  clientRequestId: string,
  requestFingerprint: string,
): PersistedTurnJournalEvent {
  return {
    schema: "acpx.turn.v1",
    sequence,
    session_id: input.sessionId,
    turn_id: input.turnId,
    client_request_id: clientRequestId,
    status: input.status,
    prompt_text: previous?.promptText || (input.promptText ?? ""),
    request_fingerprint: previous?.requestFingerprint || requestFingerprint,
    agent_type: retainedValue(input.agentType, previous, "agentType"),
    final_answer: retainedValue(input.finalAnswer, previous, "finalAnswer"),
    error_code: input.errorCode,
    error_text: input.errorText,
    runtime_record_id: retainedValue(input.runtimeRecordId, previous, "runtimeRecordId"),
    runtime_request_id: retainedValue(input.runtimeRequestId, previous, "runtimeRequestId"),
    prompt_message_id: retainedValue(input.promptMessageId, previous, "promptMessageId"),
    stop_reason: retainedValue(input.stopReason, previous, "stopReason"),
    terminal_source: retainedValue(input.terminalSource, previous, "terminalSource"),
    ...mutationTimestamps(input, previous),
  };
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

  private async appendEvent(sessionId: string, event: PersistedTurnJournalEvent): Promise<void> {
    const journalPath = this.filePath(sessionId);
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
  }

  async record(input: AcpTurnJournalMutation): Promise<AcpTurnJournalRecordResult> {
    return await this.withSessionLock(input.sessionId, async () => {
      const state = await this.readState(input.sessionId);
      const clientRequestId = input.clientRequestId || input.turnId;
      const byRequest = state.byClientRequestId.get(clientRequestId);
      const previous = state.byTurnId.get(input.turnId);
      const requestFingerprint = mutationFingerprint(input, previous);
      if (byRequest && byRequest.turnId !== input.turnId) {
        if (byRequest.requestFingerprint !== requestFingerprint) {
          throw new Error(`Turn idempotency conflict for request ${clientRequestId}`);
        }
        return { turn: byRequest, created: false, changed: false };
      }

      validateMutation(previous, input, requestFingerprint);
      if (previous && sameMutation(previous, input)) {
        return { turn: previous, created: false, changed: false };
      }

      const event = mutationEvent(
        input,
        previous,
        state.sequence + 1,
        clientRequestId,
        requestFingerprint,
      );
      await this.appendEvent(input.sessionId, event);
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
      const turns = [...state.byTurnId.values()].toSorted(
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
