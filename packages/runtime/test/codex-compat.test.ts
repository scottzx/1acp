import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isCodexAcpCommand, resolveCodexExecutable } from "../src/acp/codex-compat.js";

test("isCodexAcpCommand recognizes direct and package-exec launches", () => {
  assert.equal(isCodexAcpCommand("codex-acp", []), true);
  assert.equal(
    isCodexAcpCommand(process.execPath, ["npm-cli.js", "exec", "--", "codex-acp"]),
    true,
  );
  assert.equal(isCodexAcpCommand("grok", ["agent", "stdio"]), false);
});

test("resolveCodexExecutable finds an executable Codex entrypoint on POSIX PATH", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-exe-"));
  const codexPath = path.join(tempDir, "codex");
  try {
    await fs.writeFile(codexPath, "#!/bin/sh\n");
    await fs.chmod(codexPath, 0o755);

    assert.equal(resolveCodexExecutable("darwin", { PATH: tempDir }), codexPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable skips non-executable POSIX PATH entries", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "codex"), "not executable\n");

    assert.equal(resolveCodexExecutable("darwin", { PATH: tempDir }), undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable preserves an explicit CODEX_PATH override", () => {
  assert.equal(
    resolveCodexExecutable("darwin", {
      PATH: "/usr/local/bin:/usr/bin",
      CODEX_PATH: "/custom/codex",
    }),
    undefined,
  );
});
