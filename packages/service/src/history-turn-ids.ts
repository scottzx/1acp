export type HistoryTurnRef = {
  turnId: string;
  clientRequestId?: string;
  runtimeRequestId?: string;
  promptMessageId?: string;
  promptText?: string;
};

export type HistoryItem = {
  kind: string;
  turnId?: string;
  text?: string;
};

export type RuntimeTurnResult = {
  prompt_message_id?: string;
};

export type HistoryToolUse = {
  input?: unknown;
  raw_input?: string;
  kind?: string;
  locations?: Array<{ path?: string }>;
};

function hasStructuredPath(input: Record<string, unknown>): boolean {
  return [
    'path',
    'file_path',
    'filePath',
    'file',
    'target_file',
    'targetFile',
    'paths',
    'files',
  ].some((key) => {
    const value = input[key];
    return typeof value === 'string'
      ? value.trim().length > 0
      : Array.isArray(value) && value.length > 0;
  });
}

function parseRawInput(raw?: string): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw === '{}') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // raw_input is a display string
  }
  return undefined;
}

function parseObjectInput(tool: HistoryToolUse): Record<string, unknown> | undefined {
  if (tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)) {
    return { ...tool.input };
  }
  return parseRawInput(tool.raw_input);
}

function extractLocations(tool: HistoryToolUse): string[] {
  return (tool.locations ?? [])
    .map((location) => location.path?.trim())
    .filter((path): path is string => !!path);
}

/** Merge ACP locations into history input so Cursor's empty-input file tools keep their paths. */
export function historyToolInput(tool: HistoryToolUse): unknown {
  const input = parseObjectInput(tool);
  const paths = extractLocations(tool);
  if (paths.length === 0) return input ?? tool.input ?? {};
  const next = input ?? {};
  if (!hasStructuredPath(next)) {
    if (paths.length === 1) next.path = paths[0];
    else next.paths = paths;
  }
  return next;
}

/** Prefer a journal/runtime id that agent_turns can ResolveTurnID. */
export function resolvableTurnId(turn: HistoryTurnRef): string {
  return turn.turnId || turn.clientRequestId || turn.runtimeRequestId || turn.promptMessageId || '';
}

/**
 * Map a persisted User.id onto the turn_results key (runtime request id).
 * Keys are request ids; User.id may instead be prompt_message_id.
 */
export function resolveRuntimeTurnId(
  userId: string | undefined,
  turnResults: Record<string, RuntimeTurnResult | undefined>,
): string | undefined {
  if (!userId) return undefined;
  if (turnResults[userId]) return userId;
  for (const [requestId, result] of Object.entries(turnResults)) {
    if (result?.prompt_message_id === userId) return requestId;
  }
  return undefined;
}

/**
 * Copy a resolvable turnId onto every item in a user→assistant slice.
 * Already-stamped user items keep their id; unstamped users match journal
 * turns by prompt text, then unused turns in chronological order.
 */
export function stampHistoryTurnIds<T extends HistoryItem>(
  items: T[],
  turns: HistoryTurnRef[],
): T[] {
  if (items.length === 0) return items;

  const unused = turns.filter((turn) => resolvableTurnId(turn));
  let currentTurnId: string | undefined;
  let changed = false;
  const next = items.map((item) => {
    if (item.kind === 'user') {
      if (item.turnId) {
        currentTurnId = item.turnId;
        const index = unused.findIndex((turn) => turnOwnsHistoryId(turn, item.turnId));
        if (index >= 0) unused.splice(index, 1);
      } else {
        const byPrompt = unused.findIndex(
          (turn) => !!turn.promptText && turn.promptText === item.text,
        );
        const turn = byPrompt >= 0 ? unused.splice(byPrompt, 1)[0] : unused.shift();
        currentTurnId = turn ? resolvableTurnId(turn) : undefined;
      }
    }
    if (!currentTurnId || item.turnId) return item;
    changed = true;
    return { ...item, turnId: currentTurnId };
  });
  return changed ? next : items;
}

function turnOwnsHistoryId(turn: HistoryTurnRef, historyTurnId?: string): boolean {
  if (!historyTurnId) return false;
  return (
    turn.turnId === historyTurnId ||
    turn.clientRequestId === historyTurnId ||
    turn.runtimeRequestId === historyTurnId ||
    turn.promptMessageId === historyTurnId
  );
}
