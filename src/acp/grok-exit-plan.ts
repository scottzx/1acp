import readline from "node:readline/promises";

/**
 * Grok Build ACP client extension: `_x.ai/exit_plan_mode`.
 *
 * Wire format reverse-engineered from Grok agent stdio (2026-07):
 * - Request: { sessionId, toolCallId, planContent } (3 fields)
 * - Response: adjacently tagged on `outcome`
 *     approved  → leave plan mode and start implementing
 *     rejected  → request changes / stay planning
 *     abandoned → quit plan mode entirely
 * - Optional `comments` freeform feedback (TUI: "Additional feedback")
 */

export const GROK_EXIT_PLAN_MODE_METHOD = "_x.ai/exit_plan_mode";

export type GrokExitPlanModeRequest = {
  sessionId: string;
  toolCallId: string;
  planContent: string;
};

export type GrokExitPlanOutcome = "approved" | "rejected" | "abandoned";

export type GrokExitPlanModeResponse = {
  outcome: GrokExitPlanOutcome;
  comments?: string | null;
};

export function isGrokExitPlanModeMethod(method: string): boolean {
  return method === GROK_EXIT_PLAN_MODE_METHOD || method === "x.ai/exit_plan_mode";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseGrokExitPlanModeRequest(
  params: Record<string, unknown>,
): GrokExitPlanModeRequest | undefined {
  const sessionId = readString(params.sessionId);
  const toolCallId = readString(params.toolCallId);
  // Wire uses camelCase planContent; accept snake_case fallback.
  const planContent = readString(params.planContent) ?? readString(params.plan_content) ?? "";
  if (!sessionId || !toolCallId) {
    return undefined;
  }
  return { sessionId, toolCallId, planContent };
}

export function approvedExitPlanResponse(comments?: string | null): GrokExitPlanModeResponse {
  return comments ? { outcome: "approved", comments } : { outcome: "approved" };
}

export function rejectedExitPlanResponse(comments?: string | null): GrokExitPlanModeResponse {
  return comments ? { outcome: "rejected", comments } : { outcome: "rejected" };
}

export function abandonedExitPlanResponse(): GrokExitPlanModeResponse {
  return { outcome: "abandoned" };
}

/**
 * Host may send a full response or a bare outcome string.
 */
// oxlint-disable-next-line complexity -- normalizes every supported external response variant.
export function normalizeHostExitPlanResponse(
  value: GrokExitPlanModeResponse | GrokExitPlanOutcome | undefined,
): GrokExitPlanModeResponse | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    if (value === "approved" || value === "rejected" || value === "abandoned") {
      return { outcome: value };
    }
    return abandonedExitPlanResponse();
  }
  if (!isRecord(value) || typeof value.outcome !== "string") {
    return undefined;
  }
  const outcome = value.outcome;
  if (outcome !== "approved" && outcome !== "rejected" && outcome !== "abandoned") {
    return abandonedExitPlanResponse();
  }
  const comments =
    value.comments === undefined
      ? undefined
      : value.comments === null
        ? null
        : String(value.comments);
  return comments !== undefined && comments !== null && comments.length > 0
    ? { outcome, comments }
    : { outcome };
}

/**
 * Interactive CLI prompt for plan approval. Non-TTY → abandoned.
 */
// oxlint-disable-next-line complexity -- interactive outcome handling is intentionally linear.
export async function promptGrokExitPlanMode(
  request: GrokExitPlanModeRequest,
): Promise<GrokExitPlanModeResponse> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return abandonedExitPlanResponse();
  }

  process.stderr.write("\n[exit_plan_mode] Plan approval required.\n");
  process.stderr.write("─".repeat(60) + "\n");
  const preview = request.planContent.trim() || "(empty plan)";
  const lines = preview.split("\n");
  const shown = lines.slice(0, 40).join("\n");
  process.stderr.write(shown + "\n");
  if (lines.length > 40) {
    process.stderr.write(`… (${lines.length - 40} more lines)\n`);
  }
  process.stderr.write("─".repeat(60) + "\n");
  process.stderr.write(
    "  a = approve (start implementing)\n" +
      "  r = request changes (stay in plan mode)\n" +
      "  q = quit / abandon plan mode\n\n",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    let decided: GrokExitPlanModeResponse | undefined;
    while (decided === undefined) {
      const answer = (await rl.question("Plan decision [a/r/q]> ")).trim().toLowerCase();
      if (answer === "a" || answer === "approve" || answer === "approved" || answer === "y") {
        const comments = (await rl.question("Optional comments (Enter to skip)> ")).trim();
        decided = approvedExitPlanResponse(comments || undefined);
      } else if (
        answer === "r" ||
        answer === "reject" ||
        answer === "rejected" ||
        answer === "changes"
      ) {
        const comments = (await rl.question("What should change?> ")).trim();
        decided = rejectedExitPlanResponse(comments || undefined);
      } else if (
        answer === "q" ||
        answer === "quit" ||
        answer === "abandon" ||
        answer === "abandoned"
      ) {
        decided = abandonedExitPlanResponse();
      } else {
        process.stderr.write("Invalid choice. Use a / r / q.\n");
      }
    }
    return decided;
  } finally {
    rl.close();
  }
}
