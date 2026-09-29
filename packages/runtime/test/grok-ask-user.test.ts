import assert from "node:assert/strict";
import test from "node:test";
import {
  GROK_ASK_USER_QUESTION_METHOD,
  acceptedAskUserResponse,
  cancelledAskUserResponse,
  chatAboutThisAskUserResponse,
  isGrokAskUserQuestionMethod,
  normalizeHostAskUserResponse,
  parseGrokAskUserQuestionRequest,
  skipInterviewAskUserResponse,
} from "../src/acp/grok-ask-user.js";

test("isGrokAskUserQuestionMethod accepts wire method names", () => {
  assert.equal(isGrokAskUserQuestionMethod(GROK_ASK_USER_QUESTION_METHOD), true);
  assert.equal(isGrokAskUserQuestionMethod("x.ai/ask_user_question"), true);
  assert.equal(isGrokAskUserQuestionMethod("session/request_permission"), false);
});

test("parseGrokAskUserQuestionRequest accepts live Grok wire params", () => {
  const parsed = parseGrokAskUserQuestionRequest({
    sessionId: "sess-1",
    toolCallId: "call-1",
    questions: [
      {
        question: "Pick a color?",
        options: [
          { label: "Red", description: "Choose red" },
          { label: "Blue", description: "Choose blue" },
        ],
        multiSelect: null,
      },
    ],
    mode: "default",
  });

  assert.equal(parsed?.sessionId, "sess-1");
  assert.equal(parsed?.toolCallId, "call-1");
  assert.equal(parsed?.mode, "default");
  assert.equal(parsed?.questions.length, 1);
  assert.equal(parsed?.questions[0]?.question, "Pick a color?");
  assert.equal(parsed?.questions[0]?.multiSelect, null);
  assert.equal(parsed?.questions[0]?.options[0]?.label, "Red");
  assert.equal(parsed?.questions[0]?.options[1]?.label, "Blue");
});

test("parseGrokAskUserQuestionRequest accepts multi_select alias from tool schema", () => {
  const parsed = parseGrokAskUserQuestionRequest({
    sessionId: "sess-1",
    toolCallId: "call-1",
    questions: [
      {
        question: "Which colors?",
        options: [
          { label: "Red", description: "r" },
          { label: "Blue", description: "b" },
        ],
        multi_select: true,
      },
    ],
  });
  assert.equal(parsed?.questions[0]?.multiSelect, true);
});

test("parseGrokAskUserQuestionRequest rejects malformed payloads", () => {
  assert.equal(parseGrokAskUserQuestionRequest({}), undefined);
  assert.equal(
    parseGrokAskUserQuestionRequest({
      sessionId: "s",
      toolCallId: "t",
      questions: [{ question: "Q?", options: [] }],
    }),
    undefined,
  );
});

test("accepted response uses question text keys and StringOrVec values", () => {
  assert.deepEqual(
    acceptedAskUserResponse({
      "Pick a color?": "Red",
      "Which colors?": ["Red", "Blue"],
    }),
    {
      outcome: "accepted",
      answers: {
        "Pick a color?": "Red",
        "Which colors?": ["Red", "Blue"],
      },
    },
  );
});

test("unit response variants match Grok adjacent-tag wire format", () => {
  assert.deepEqual(skipInterviewAskUserResponse(), { outcome: "skip_interview" });
  assert.deepEqual(chatAboutThisAskUserResponse(), { outcome: "chat_about_this" });
  assert.deepEqual(cancelledAskUserResponse(), { outcome: "cancelled" });
});

test("normalizeHostAskUserResponse accepts full response or bare answers map", () => {
  assert.deepEqual(normalizeHostAskUserResponse({ "Q?": "A" }), {
    outcome: "accepted",
    answers: { "Q?": "A" },
  });
  assert.deepEqual(
    normalizeHostAskUserResponse({
      outcome: "accepted",
      answers: { "Q?": ["A", "B"] },
      partial_answers: true,
    }),
    {
      outcome: "accepted",
      answers: { "Q?": ["A", "B"] },
      partial_answers: true,
    },
  );
  assert.deepEqual(normalizeHostAskUserResponse({ outcome: "skip_interview" }), {
    outcome: "skip_interview",
  });
  assert.deepEqual(normalizeHostAskUserResponse({ outcome: "nope" as "cancelled" }), {
    outcome: "cancelled",
  });
  assert.equal(normalizeHostAskUserResponse(undefined), undefined);
});
