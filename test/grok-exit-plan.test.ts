import assert from "node:assert/strict";
import test from "node:test";
import {
  GROK_EXIT_PLAN_MODE_METHOD,
  abandonedExitPlanResponse,
  approvedExitPlanResponse,
  isGrokExitPlanModeMethod,
  normalizeHostExitPlanResponse,
  parseGrokExitPlanModeRequest,
  rejectedExitPlanResponse,
} from "../src/acp/grok-exit-plan.js";

test("isGrokExitPlanModeMethod accepts wire method names", () => {
  assert.equal(isGrokExitPlanModeMethod(GROK_EXIT_PLAN_MODE_METHOD), true);
  assert.equal(isGrokExitPlanModeMethod("x.ai/exit_plan_mode"), true);
  assert.equal(isGrokExitPlanModeMethod("_x.ai/ask_user_question"), false);
});

test("parseGrokExitPlanModeRequest accepts live Grok wire params", () => {
  const parsed = parseGrokExitPlanModeRequest({
    sessionId: "sess-1",
    toolCallId: "call-1",
    planContent: "# Plan\n\n- step one\n",
  });
  assert.deepEqual(parsed, {
    sessionId: "sess-1",
    toolCallId: "call-1",
    planContent: "# Plan\n\n- step one\n",
  });
});

test("parseGrokExitPlanModeRequest accepts plan_content alias", () => {
  const parsed = parseGrokExitPlanModeRequest({
    sessionId: "s",
    toolCallId: "t",
    plan_content: "hello",
  });
  assert.equal(parsed?.planContent, "hello");
});

test("parseGrokExitPlanModeRequest rejects missing ids", () => {
  assert.equal(parseGrokExitPlanModeRequest({ planContent: "x" }), undefined);
});

test("response helpers match wire outcomes", () => {
  assert.deepEqual(approvedExitPlanResponse(), { outcome: "approved" });
  assert.deepEqual(approvedExitPlanResponse("add tests"), {
    outcome: "approved",
    comments: "add tests",
  });
  assert.deepEqual(rejectedExitPlanResponse("more detail"), {
    outcome: "rejected",
    comments: "more detail",
  });
  assert.deepEqual(abandonedExitPlanResponse(), { outcome: "abandoned" });
});

test("normalizeHostExitPlanResponse accepts bare outcome or full object", () => {
  assert.deepEqual(normalizeHostExitPlanResponse("approved"), { outcome: "approved" });
  assert.deepEqual(normalizeHostExitPlanResponse({ outcome: "rejected", comments: "n" }), {
    outcome: "rejected",
    comments: "n",
  });
  assert.deepEqual(normalizeHostExitPlanResponse({ outcome: "nope" as "abandoned" }), {
    outcome: "abandoned",
  });
  assert.equal(normalizeHostExitPlanResponse(undefined), undefined);
});
