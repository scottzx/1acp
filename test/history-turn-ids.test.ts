import assert from "node:assert/strict";
import test from "node:test";
import {
  historyToolInput,
  resolveRuntimeTurnId,
  stampHistoryTurnIds,
  type HistoryTurnRef,
} from "../src/session/history-turn-ids.js";

test("resolveRuntimeTurnId uses the turn_results key or prompt_message_id", () => {
  const results = {
    "req-1": { prompt_message_id: "user-msg-1" },
  };
  assert.equal(resolveRuntimeTurnId("req-1", results), "req-1");
  assert.equal(resolveRuntimeTurnId("user-msg-1", results), "req-1");
  assert.equal(resolveRuntimeTurnId("orphan", results), undefined);
  assert.equal(resolveRuntimeTurnId(undefined, results), undefined);
});

test("stampHistoryTurnIds copies a resolvable id onto the rest of the turn", () => {
  const items = [
    { kind: "user", text: "edit a.ts" },
    { kind: "tool_use", toolName: "Write" },
    { kind: "assistant_text", text: "done" },
    { kind: "user", text: "delete a.ts" },
    { kind: "tool_use", toolName: "Bash" },
  ];
  const turns: HistoryTurnRef[] = [
    { turnId: "turn-1", promptText: "edit a.ts", clientRequestId: "req-1" },
    { turnId: "turn-2", promptText: "delete a.ts", runtimeRequestId: "rt-2" },
  ];
  const stamped = stampHistoryTurnIds(items, turns);
  assert.deepEqual(
    stamped.map((item) => item.turnId),
    ["turn-1", "turn-1", "turn-1", "turn-2", "turn-2"],
  );
});

test("stampHistoryTurnIds keeps an existing runtime turnId and fills the slice", () => {
  const items = [
    { kind: "user", text: "go", turnId: "req-9" },
    { kind: "tool_use" },
    { kind: "user", text: "next" },
    { kind: "assistant_text", text: "ok" },
  ];
  const turns: HistoryTurnRef[] = [
    { turnId: "host-1", clientRequestId: "req-9", promptText: "go" },
    { turnId: "host-2", promptText: "next" },
  ];
  const stamped = stampHistoryTurnIds(items, turns);
  assert.equal(stamped[0]?.turnId, "req-9");
  assert.equal(stamped[1]?.turnId, "req-9");
  assert.equal(stamped[2]?.turnId, "host-2");
  assert.equal(stamped[3]?.turnId, "host-2");
});

test("historyToolInput fills Cursor empty input from ACP locations", () => {
  assert.deepEqual(historyToolInput({ input: {}, locations: [{ path: "src/app.ts" }] }), {
    path: "src/app.ts",
  });
  assert.deepEqual(
    historyToolInput({
      input: {},
      locations: [{ path: "a.ts" }, { path: "b.ts" }],
    }),
    { paths: ["a.ts", "b.ts"] },
  );
  assert.deepEqual(
    historyToolInput({ input: { path: "kept.ts" }, locations: [{ path: "other.ts" }] }),
    { path: "kept.ts" },
  );
});

test("stampHistoryTurnIds falls back to chronological unused turns", () => {
  const items = [{ kind: "user", text: "prompt that was rewritten" }, { kind: "tool_use" }];
  const stamped = stampHistoryTurnIds(items, [{ turnId: "only-turn", promptText: "original" }]);
  assert.equal(stamped[0]?.turnId, "only-turn");
  assert.equal(stamped[1]?.turnId, "only-turn");
});
