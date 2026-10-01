import assert from "node:assert/strict";
import test from "node:test";
import { AgentStartupError } from "../src/errors.js";

test("npm npx cache conflicts receive a specific recovery hint without losing diagnostics", () => {
  const stderr =
    "npm error code ENOTEMPTY\nnpm error syscall rename\nnpm error path /Users/test/.npm/_npx/example/node_modules/@openai/codex-darwin-arm64";
  const cause = new Error("initialize failed");
  const error = new AgentStartupError({
    agentCommand: "npx adapter",
    exitCode: 190,
    signal: null,
    stderrSummary: stderr,
    cause,
  });
  assert.ok(error.message.includes(stderr));
  assert.match(error.message, /npx cache \(ENOTEMPTY\)/u);
  assert.match(error.message, /Upgrade npm/u);
  assert.doesNotMatch(error.message, /Privacy|System Settings|which <agent>/u);
  assert.equal(error.stderrSummary, stderr);
  assert.equal(error.exitCode, 190);
  assert.equal(error.detailCode, "AGENT_STARTUP_FAILED");
  assert.equal(error.cause, cause);
});

test("older npm diagnostics and Windows cache paths receive the same hint", () => {
  const error = new AgentStartupError({
    agentCommand: "npx adapter",
    exitCode: 1,
    signal: null,
    stderrSummary:
      "npm ERR! code ENOTEMPTY npm ERR! path C:\\cache\\_npx\\example\\node_modules\\adapter",
  });
  assert.match(error.message, /npx cache \(ENOTEMPTY\)/u);
});

test("unrelated startup failures do not suggest macOS permissions or cache cleanup", () => {
  for (const stderrSummary of [
    undefined,
    "authentication failed",
    "ENOTEMPTY /tmp/_npx/custom-agent",
    "npm error code ENOTEMPTY npm error path /project/node_modules/adapter",
    "npm error code EACCES npm error path /cache/_npx/adapter",
  ]) {
    const error = new AgentStartupError({
      agentCommand: "adapter",
      exitCode: null,
      signal: "SIGTERM",
      stderrSummary,
    });
    assert.equal(
      error.message,
      `ACP agent exited before initialize completed (exit=null, signal=SIGTERM)${stderrSummary ? `: ${stderrSummary}` : ""}`,
    );
  }
});
