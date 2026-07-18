/**
 * Live behavior proof for Grok client extension methods
 * (`_x.ai/ask_user_question`, `_x.ai/exit_plan_mode`).
 *
 * Run (requires `grok` on PATH):
 *   pnpm exec tsx scripts/grok-ext-live-proof.mts
 *
 * Writes PASS/FAIL artifacts under docs/proof-2026-07-18-grok-ext-methods/.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AcpClient } from "../src/acp/client.ts";

const outDir = process.env.PROOF_DIR || path.join(process.cwd(), "docs/proof-2026-07-18-grok-ext-methods");
fs.mkdirSync(outDir, { recursive: true });

type Event = { t: string; kind: string; data?: unknown };
const events: Event[] = [];
const log = (kind: string, data?: unknown) => {
  const row = { t: new Date().toISOString(), kind, data };
  events.push(row);
  console.log(`[${kind}]`, typeof data === "string" ? data : JSON.stringify(data)?.slice(0, 500));
};

async function withClient(
  label: string,
  opts: {
    onAskUserQuestion?: ConstructorParameters<typeof AcpClient>[0]["onAskUserQuestion"];
    onExitPlanMode?: ConstructorParameters<typeof AcpClient>[0]["onExitPlanMode"];
  },
  run: (client: AcpClient, sessionId: string, cwd: string) => Promise<void>,
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `acpx-proof-${label}-`));
  const client = new AcpClient({
    agentCommand: "grok agent stdio",
    cwd,
    permissionMode: "approve-all",
    suppressSdkConsoleErrors: true,
    onAskUserQuestion: opts.onAskUserQuestion,
    onExitPlanMode: opts.onExitPlanMode,
    onSessionUpdate: (n) => {
      const u = n.update as any;
      if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
        log(`${label}.tool`, {
          update: u.sessionUpdate,
          title: u.title,
          status: u.status,
          toolCallId: u.toolCallId,
          rawOutput: u.rawOutput,
          content: u.content,
        });
      }
    },
  });

  try {
    await client.start();
    const created = await client.createSession(cwd);
    log(`${label}.session`, created.sessionId);
    await run(client, created.sessionId, cwd);
  } finally {
    await client.close().catch(() => {});
  }
}

async function proofAskUser() {
  let sawReq: unknown;
  let completed = false;
  await withClient(
    "ask_user",
    {
      onAskUserQuestion: async (req) => {
        sawReq = req;
        log("ask_user.request", req);
        const answers: Record<string, string> = {};
        for (const q of req.questions) {
          answers[q.question] = q.options[0]?.label ?? "Other";
        }
        log("ask_user.response", { outcome: "accepted", answers });
        return { outcome: "accepted", answers };
      },
    },
    async (client, sessionId) => {
      const result = await Promise.race([
        client.prompt(
          sessionId,
          "Call ask_user_question exactly once with one question 'Pick a color?' and options Red / Blue. No other tools.",
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 90s")), 90000)),
      ]);
      log("ask_user.prompt_result", result);
    },
  );

  // Success criteria from session updates
  const okTool = events.some(
    (e) =>
      e.kind === "ask_user.tool" &&
      JSON.stringify(e.data).includes("UserAnswered") &&
      JSON.stringify(e.data).includes("Red"),
  );
  const okReq = Boolean(sawReq);
  log("ask_user.verdict", { okReq, okTool, sawReq: Boolean(sawReq) });
  if (!okReq || !okTool) {
    throw new Error(`ask_user proof failed: okReq=${okReq} okTool=${okTool}`);
  }
}

async function proofExitPlan(outcome: "approved" | "abandoned" | "rejected") {
  let sawReq: unknown;
  await withClient(
    `exit_plan_${outcome}`,
    {
      onExitPlanMode: async (req) => {
        sawReq = req;
        log(`exit_plan.request`, {
          sessionId: req.sessionId,
          toolCallId: req.toolCallId,
          planContentPreview: req.planContent.slice(0, 300),
          planLen: req.planContent.length,
        });
        const response =
          outcome === "approved"
            ? { outcome: "approved" as const }
            : outcome === "abandoned"
              ? { outcome: "abandoned" as const }
              : { outcome: "rejected" as const, comments: "Need more detail on step 2" };
        log(`exit_plan.response`, response);
        return response;
      },
    },
    async (client, sessionId) => {
      try {
        await client.setSessionMode(sessionId, "plan");
        log("exit_plan.mode", "plan");
      } catch (e) {
        log("exit_plan.mode_skip", String(e));
      }
      const result = await Promise.race([
        client.prompt(
          sessionId,
          "Write a short 3-bullet plan to the plan file, then call exit_plan_mode to present it. Do not call ask_user_question. Minimal plan only.",
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 120s")), 120000)),
      ]);
      log("exit_plan.prompt_result", result);
    },
  );

  const toolJson = events
    .filter((e) => e.kind.startsWith("exit_plan") && e.kind.endsWith(".tool"))
    .map((e) => JSON.stringify(e.data))
    .join("\n");

  const okReq = Boolean(sawReq);
  let okTool = false;
  if (outcome === "approved") {
    okTool = toolJson.includes("PlanReady") || toolJson.includes("approved") || toolJson.includes("start coding");
  } else if (outcome === "abandoned") {
    okTool =
      toolJson.includes("abandon") ||
      toolJson.includes("Plan mode has been disabled") ||
      toolJson.includes("Abandon");
  } else {
    okTool =
      toolJson.includes("revise") ||
      toolJson.includes("changes they would like") ||
      toolJson.includes("Request changes") ||
      toolJson.includes("does not want to exit");
  }

  log(`exit_plan_${outcome}.verdict`, { okReq, okTool });
  if (!okReq || !okTool) {
    throw new Error(`exit_plan ${outcome} proof failed: okReq=${okReq} okTool=${okTool}`);
  }
}

async function main() {
  log("env", {
    which_grok: process.env.PATH?.includes("grok") ? "path has grok?" : "check",
    node: process.version,
    cwd: process.cwd(),
  });

  const failures: string[] = [];

  try {
    await proofAskUser();
  } catch (e) {
    failures.push(`ask_user: ${e}`);
    log("ask_user.error", String(e));
  }

  for (const outcome of ["approved", "rejected", "abandoned"] as const) {
    try {
      await proofExitPlan(outcome);
    } catch (e) {
      failures.push(`exit_plan_${outcome}: ${e}`);
      log(`exit_plan_${outcome}.error`, String(e));
    }
  }

  const transcriptPath = path.join(outDir, "live-transcript.jsonl");
  fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const summary = {
    when: new Date().toISOString(),
    failures,
    pass: failures.length === 0,
    eventCount: events.length,
    transcript: path.relative(process.cwd(), transcriptPath),
    highlights: events
      .filter((e) => e.kind.endsWith(".verdict") || e.kind.endsWith(".request") || e.kind.endsWith(".response"))
      .map((e) => ({ kind: e.kind, data: e.data })),
  };
  fs.writeFileSync(path.join(outDir, "SUMMARY.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "README.md"),
    `# Live proof: Grok client extensions (${summary.when})

## Result: **${summary.pass ? "PASS" : "FAIL"}**

Agent: \`grok agent stdio\` via \`AcpClient\` on branch \`feat/grok-client-ext-methods\`.

### Checks

| Scenario | Status |
| --- | --- |
| ask_user_question accepted | ${failures.some((f) => f.startsWith("ask_user")) ? "FAIL" : "PASS"} |
| exit_plan_mode approved | ${failures.some((f) => f.includes("approved")) ? "FAIL" : "PASS"} |
| exit_plan_mode rejected | ${failures.some((f) => f.includes("rejected")) ? "FAIL" : "PASS"} |
| exit_plan_mode abandoned | ${failures.some((f) => f.includes("abandoned")) ? "FAIL" : "PASS"} |

### Artifacts

- \`live-transcript.jsonl\` — full event log
- \`SUMMARY.json\` — machine-readable summary

### Failures

${failures.length ? failures.map((f) => `- ${f}`).join("\n") : "_none_"}
`,
  );

  console.log("\n==== SUMMARY ====");
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
