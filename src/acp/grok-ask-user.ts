import readline from "node:readline/promises";

/**
 * Grok Build ACP client extension: `_x.ai/ask_user_question`.
 *
 * Wire format reverse-engineered from Grok agent stdio (2026-07):
 * - Request is a 4-field object: sessionId, toolCallId, questions, mode.
 * - Response is adjacently tagged on `outcome`.
 */

export const GROK_ASK_USER_QUESTION_METHOD = "_x.ai/ask_user_question";

export type GrokAskUserOption = {
  label: string;
  description: string;
  preview?: string | null;
};

export type GrokAskUserQuestionItem = {
  question: string;
  options: GrokAskUserOption[];
  /** Wire uses camelCase `multiSelect` (tool JSON schema uses multi_select). */
  multiSelect?: boolean | null;
};

export type GrokAskUserQuestionRequest = {
  sessionId: string;
  toolCallId: string;
  questions: GrokAskUserQuestionItem[];
  mode?: string | null;
};

/** Answer value is serde untagged StringOrVec. */
export type GrokAskUserAnswerValue = string | string[];

export type GrokAskUserAnswers = Record<string, GrokAskUserAnswerValue>;

export type GrokAskUserQuestionResponse =
  | {
      outcome: "accepted";
      answers: GrokAskUserAnswers;
      partial_answers?: boolean | null;
    }
  | { outcome: "skip_interview" }
  | { outcome: "chat_about_this" }
  | { outcome: "cancelled" };

export function isGrokAskUserQuestionMethod(method: string): boolean {
  return method === GROK_ASK_USER_QUESTION_METHOD || method === "x.ai/ask_user_question";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseOption(value: unknown): GrokAskUserOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const label = readString(value.label);
  const description = readString(value.description);
  if (!label || description === undefined) {
    return undefined;
  }
  const preview = value.preview;
  return {
    label,
    description,
    preview: preview === undefined ? undefined : (preview as string | null),
  };
}

// oxlint-disable-next-line complexity -- validates a nested external wire payload.
function parseQuestionItem(value: unknown): GrokAskUserQuestionItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const question = readString(value.question);
  if (!question || !Array.isArray(value.options)) {
    return undefined;
  }
  const options = value.options
    .map((option) => parseOption(option))
    .filter((option): option is GrokAskUserOption => option !== undefined);
  if (options.length === 0) {
    return undefined;
  }
  // Prefer camelCase wire field; fall back to tool-schema snake_case.
  // Do not use `??` — wire frequently sends `multiSelect: null`.
  const multiSelectRaw =
    "multiSelect" in value
      ? value.multiSelect
      : "multi_select" in value
        ? value.multi_select
        : undefined;
  const multiSelect =
    multiSelectRaw === undefined
      ? undefined
      : multiSelectRaw === null
        ? null
        : Boolean(multiSelectRaw);
  return { question, options, multiSelect };
}

/**
 * Parse an ACP extMethod params object into a typed request.
 * Returns undefined when required fields are missing / malformed.
 */
export function parseGrokAskUserQuestionRequest(
  params: Record<string, unknown>,
): GrokAskUserQuestionRequest | undefined {
  const sessionId = readString(params.sessionId);
  const toolCallId = readString(params.toolCallId);
  if (!sessionId || !toolCallId || !Array.isArray(params.questions)) {
    return undefined;
  }
  const questions = params.questions
    .map((item) => parseQuestionItem(item))
    .filter((item): item is GrokAskUserQuestionItem => item !== undefined);
  if (questions.length === 0) {
    return undefined;
  }
  const mode = params.mode === undefined ? undefined : (params.mode as string | null);
  return { sessionId, toolCallId, questions, mode };
}

export function acceptedAskUserResponse(
  answers: GrokAskUserAnswers,
  options?: { partialAnswers?: boolean | null },
): GrokAskUserQuestionResponse {
  const response: GrokAskUserQuestionResponse = {
    outcome: "accepted",
    answers,
  };
  if (options && "partialAnswers" in options) {
    return { ...response, partial_answers: options.partialAnswers };
  }
  return response;
}

export function cancelledAskUserResponse(): GrokAskUserQuestionResponse {
  return { outcome: "cancelled" };
}

export function skipInterviewAskUserResponse(): GrokAskUserQuestionResponse {
  return { outcome: "skip_interview" };
}

export function chatAboutThisAskUserResponse(): GrokAskUserQuestionResponse {
  return { outcome: "chat_about_this" };
}

function isMultiSelect(question: GrokAskUserQuestionItem): boolean {
  return question.multiSelect === true;
}

function formatOptions(question: GrokAskUserQuestionItem): string {
  return question.options
    .map((option, index) => {
      const n = index + 1;
      const desc = option.description.trim() ? ` — ${option.description}` : "";
      return `  ${n}. ${option.label}${desc}`;
    })
    .join("\n");
}

function resolveChoice(
  question: GrokAskUserQuestionItem,
  raw: string,
): GrokAskUserAnswerValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  if (isMultiSelect(question)) {
    const parts = trimmed
      .split(/[,;\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const labels: string[] = [];
    for (const part of parts) {
      const label = resolveSingleChoice(question, part);
      if (!label) {
        return undefined;
      }
      if (!labels.includes(label)) {
        labels.push(label);
      }
    }
    return labels.length > 0 ? labels : undefined;
  }

  return resolveSingleChoice(question, trimmed);
}

function resolveSingleChoice(question: GrokAskUserQuestionItem, raw: string): string | undefined {
  const asNumber = Number.parseInt(raw, 10);
  if (Number.isFinite(asNumber) && String(asNumber) === raw) {
    const option = question.options[asNumber - 1];
    return option?.label;
  }
  const lower = raw.toLowerCase();
  const byLabel = question.options.find((option) => option.label.toLowerCase() === lower);
  if (byLabel) {
    return byLabel.label;
  }
  // Free-text "Other" answer — Grok always allows custom text.
  return raw;
}

/**
 * Interactive CLI prompt for Grok ask_user_question.
 * Non-TTY returns cancelled.
 */
// oxlint-disable-next-line complexity -- interactive outcome handling is intentionally linear.
export async function promptGrokAskUserQuestion(
  request: GrokAskUserQuestionRequest,
): Promise<GrokAskUserQuestionResponse> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return cancelledAskUserResponse();
  }

  process.stderr.write("\n[ask_user_question] The agent is asking for input.\n");
  process.stderr.write(
    "Enter option number(s), option label, free text, or: skip / chat / cancel\n\n",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answers: GrokAskUserAnswers = {};
    for (let i = 0; i < request.questions.length; i++) {
      const question = request.questions[i];
      const multi = isMultiSelect(question);
      process.stderr.write(`Q${i + 1}. ${question.question}\n`);
      process.stderr.write(`${formatOptions(question)}\n`);
      if (multi) {
        process.stderr.write("  (multi-select: comma-separated numbers/labels)\n");
      }

      let resolved: GrokAskUserAnswerValue | undefined;
      while (resolved === undefined) {
        const prompt = multi ? "Select option(s)> " : "Select option> ";
        const answer = (await rl.question(prompt)).trim();
        const lower = answer.toLowerCase();
        if (lower === "skip" || lower === "skip_interview") {
          return skipInterviewAskUserResponse();
        }
        if (lower === "chat" || lower === "chat_about_this") {
          return chatAboutThisAskUserResponse();
        }
        if (lower === "cancel" || lower === "cancelled") {
          return cancelledAskUserResponse();
        }
        resolved = resolveChoice(question, answer);
        if (resolved === undefined) {
          process.stderr.write("Invalid choice. Try again.\n");
        }
      }
      answers[question.question] = resolved;
      process.stderr.write("\n");
    }
    return acceptedAskUserResponse(answers);
  } finally {
    rl.close();
  }
}

/**
 * Convert a host-facing partial answer payload into a wire response.
 * Hosts may send either the full response object or a simple answers map.
 */
// oxlint-disable-next-line complexity -- normalizes every supported external response variant.
export function normalizeHostAskUserResponse(
  value: GrokAskUserQuestionResponse | GrokAskUserAnswers | undefined,
): GrokAskUserQuestionResponse | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value) && typeof value.outcome === "string") {
    const outcome = value.outcome;
    if (outcome === "accepted") {
      if (!isRecord(value.answers)) {
        return cancelledAskUserResponse();
      }
      return {
        outcome: "accepted",
        answers: value.answers,
        ...(value.partial_answers !== undefined
          ? { partial_answers: value.partial_answers as boolean | null }
          : {}),
      };
    }
    if (outcome === "skip_interview" || outcome === "chat_about_this" || outcome === "cancelled") {
      return { outcome };
    }
    return cancelledAskUserResponse();
  }
  if (isRecord(value)) {
    // Bare answers map → accepted
    return acceptedAskUserResponse(value);
  }
  return undefined;
}
