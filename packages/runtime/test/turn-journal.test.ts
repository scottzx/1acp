import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTurnJournal } from "../src/runtime.js";
import { withTempDir } from "./runtime-test-helpers.js";

test("Turn journal persists queued, running, and terminal state as a replayable snapshot", async () => {
  await withTempDir("acpx-turn-journal-", async (stateDir) => {
    const journal = createTurnJournal({ stateDir });
    const queued = await journal.record({
      sessionId: "session-1",
      turnId: "turn-1",
      clientRequestId: "request-1",
      status: "queued",
      promptText: "first prompt",
      agentType: "codex",
      occurredAt: "2026-07-30T00:00:00.000Z",
    });
    assert.equal(queued.created, true);
    assert.equal(queued.turn.lastEventSeq, 1);

    const running = await journal.record({
      sessionId: "session-1",
      turnId: "turn-1",
      clientRequestId: "request-1",
      status: "running",
      promptText: "first prompt",
      occurredAt: "2026-07-30T00:00:01.000Z",
    });
    assert.equal(running.turn.status, "running");
    assert.equal(running.turn.startedAt, "2026-07-30T00:00:01.000Z");

    await journal.record({
      sessionId: "session-1",
      turnId: "turn-2",
      clientRequestId: "request-2",
      status: "queued",
      promptText: "second prompt",
      occurredAt: "2026-07-30T00:00:02.000Z",
    });
    let snapshot = await journal.snapshot("session-1");
    assert.equal(snapshot.active?.turnId, "turn-1");
    assert.deepEqual(
      snapshot.queued.map((turn) => turn.turnId),
      ["turn-2"],
    );

    const completed = await journal.record({
      sessionId: "session-1",
      turnId: "turn-1",
      clientRequestId: "request-1",
      status: "completed",
      promptText: "first prompt",
      finalAnswer: "finished",
      stopReason: "end_turn",
      terminalSource: "live_runtime",
      occurredAt: "2026-07-30T00:00:03.000Z",
    });
    assert.equal(completed.turn.completedAt, "2026-07-30T00:00:03.000Z");

    snapshot = await createTurnJournal({ stateDir }).snapshot("session-1");
    assert.equal(snapshot.sequence, 4);
    assert.equal(snapshot.turns[0]?.finalAnswer, "finished");
    assert.equal(snapshot.turns[0]?.status, "completed");
    assert.equal(snapshot.queued[0]?.turnId, "turn-2");

    const journalPath = path.join(stateDir, "sessions", "session-1.turns.ndjson");
    assert.equal((await fs.readFile(journalPath, "utf8")).trim().split("\n").length, 4);
  });
});

test("Turn journal makes client request retries idempotent and rejects changed prompts", async () => {
  await withTempDir("acpx-turn-idempotency-", async (stateDir) => {
    const journal = createTurnJournal({ stateDir });
    const first = await journal.record({
      sessionId: "session-1",
      turnId: "request-1",
      clientRequestId: "request-1",
      status: "running",
      promptText: "same prompt",
    });
    const retry = await journal.record({
      sessionId: "session-1",
      turnId: "request-1",
      clientRequestId: "request-1",
      status: "running",
      promptText: "same prompt",
    });
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.changed, false);
    assert.equal((await journal.snapshot("session-1")).sequence, 1);

    const retryWithFreshCandidateId = await journal.record({
      sessionId: "session-1",
      turnId: "server-generated-retry-candidate",
      clientRequestId: "request-1",
      status: "running",
      promptText: "same prompt",
    });
    assert.equal(retryWithFreshCandidateId.turn.turnId, "request-1");
    assert.equal(retryWithFreshCandidateId.created, false);

    await assert.rejects(
      journal.record({
        sessionId: "session-1",
        turnId: "request-1",
        clientRequestId: "request-1",
        status: "running",
        promptText: "changed prompt",
      }),
      /idempotency conflict/,
    );
  });
});

test("Turn journal accepts a terminal runtime fact when earlier notifications were lost", async () => {
  await withTempDir("acpx-turn-reconcile-", async (stateDir) => {
    const journal = createTurnJournal({ stateDir });
    const result = await journal.record({
      sessionId: "session-1",
      turnId: "turn-lost-events",
      status: "failed",
      promptText: "recovered prompt",
      errorCode: "runtime_error",
      terminalSource: "reconciled_runtime_record",
    });
    assert.equal(result.turn.status, "failed");
    assert.equal(result.turn.lastEventSeq, 1);
    assert.equal((await journal.snapshot("session-1")).active, undefined);
  });
});

test("Turn journal appends a recoverable event after a torn final line", async () => {
  await withTempDir("acpx-turn-torn-write-", async (stateDir) => {
    const sessionsDir = path.join(stateDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "session-1.turns.ndjson"),
      '{"schema":"acpx.turn.v1","sequence":99',
      "utf8",
    );

    const journal = createTurnJournal({ stateDir });
    await journal.record({
      sessionId: "session-1",
      turnId: "turn-after-torn-line",
      status: "running",
      promptText: "continue safely",
    });

    const snapshot = await createTurnJournal({ stateDir }).snapshot("session-1");
    assert.equal(snapshot.active?.turnId, "turn-after-torn-line");
    assert.equal(snapshot.sequence, 1);
  });
});
