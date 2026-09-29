import assert from "node:assert/strict";
import { test } from "node:test";
import { configOptionsFromConfigOptions } from "../src/acp/config-option-support.js";

test("configOptionsFromConfigOptions surfaces non-mode selects and flattens model groups", () => {
  assert.deepEqual(
    configOptionsFromConfigOptions([
      // The mode select is surfaced via `modes` instead — skipped here.
      {
        id: "mode",
        type: "select",
        category: "mode",
        currentValue: "default",
        options: [{ value: "default", name: "Ask" }],
      },
      // A grouped model list flattens to a single choice array.
      {
        id: "model",
        type: "select",
        category: "model",
        name: "Model",
        currentValue: "opus",
        options: [
          {
            group: "anthropic",
            name: "Anthropic",
            options: [
              { value: "opus", name: "Opus", description: "Most capable" },
              { value: "sonnet", name: "Sonnet" },
            ],
          },
        ],
      },
      // A flat effort select with no name falls back to its id.
      {
        id: "effort",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ]),
    [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "opus",
        options: [
          { value: "opus", name: "Opus", description: "Most capable" },
          { value: "sonnet", name: "Sonnet" },
        ],
      },
      {
        id: "effort",
        name: "effort",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
  );
});

test("configOptionsFromConfigOptions returns undefined when nothing renders", () => {
  assert.equal(configOptionsFromConfigOptions(undefined), undefined);
  assert.equal(configOptionsFromConfigOptions("nope"), undefined);
  // A select with no valid choices is dropped, not surfaced empty.
  assert.equal(
    configOptionsFromConfigOptions([
      { id: "model", type: "select", options: ["junk", { value: 3 }] },
    ]),
    undefined,
  );
  // Non-select options are ignored.
  assert.equal(
    configOptionsFromConfigOptions([{ id: "toggle", type: "boolean", currentValue: "on" }]),
    undefined,
  );
});
