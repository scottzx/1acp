import assert from "node:assert/strict";
import { test } from "node:test";
import { modeStateFromConfigOptions } from "../src/acp/mode-support.js";

test("modeStateFromConfigOptions parses the mode select option", () => {
  assert.deepEqual(
    modeStateFromConfigOptions([
      { id: "model", type: "select", category: "model", currentValue: "opus", options: [] },
      {
        id: "mode",
        type: "select",
        category: "mode",
        currentValue: "default",
        options: [
          { value: "default", name: "Always Ask", description: "Prompts for permission" },
          { value: "acceptEdits", name: "Accept Edits" },
          { value: "plan", name: "Plan Mode" },
        ],
      },
    ]),
    {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Always Ask", description: "Prompts for permission" },
        { id: "acceptEdits", name: "Accept Edits" },
        { id: "plan", name: "Plan Mode" },
      ],
    },
  );
});

test("modeStateFromConfigOptions skips malformed entries and tolerates missing currentValue", () => {
  assert.deepEqual(
    modeStateFromConfigOptions([
      {
        id: "mode",
        type: "select",
        options: [{ value: "read-only", name: "Read-only" }, { value: 42 }, "junk"],
      },
    ]),
    {
      availableModes: [{ id: "read-only", name: "Read-only" }],
    },
  );
});

test("modeStateFromConfigOptions returns undefined without a mode option", () => {
  assert.equal(modeStateFromConfigOptions(undefined), undefined);
  assert.equal(modeStateFromConfigOptions("nope"), undefined);
  assert.equal(
    modeStateFromConfigOptions([
      { id: "model", type: "select", category: "model", currentValue: "opus", options: [] },
    ]),
    undefined,
  );
});
