# Runtime-restarted Turn investigation

- **Symptom:** ChatUI displayed `1ACP restarted before the Turn reached a durable terminal state.` for a DeepSeek Build Turn.
- **Affected Turn:** The Turn started at 2026-08-09 15:57:05 +08:00 and was recovered as failed at 15:59:21.
- **Root cause:** A concurrent Antigravity-owned development process rebuilt the frontend at 15:58:52, rebuilt `build/1agents` at 15:59:12, and launched a new 1agents process at 15:59:14. Its bridge-server started at 15:59:16. The old bridge and in-memory active Turn were therefore lost during execution.
- **Recovery decision:** The persisted runtime result was still `running` and had no durable terminal marker. Startup reconciliation found a journaled active Turn but no in-memory `activeTurn`, so `bridge-server.js` applied the deliberate `runtime_restarted` recovery policy. It does not automatically replay prompts because tool calls can have non-idempotent external effects.
- **Evidence:** Process start times, build artifact mtimes, Turn journal sequences 9-10, and the persisted runtime `turn_results` entry align within the same restart window. The next `continue` Turn started at 15:59:36 and completed at 16:01:32.
- **Fix:** No runtime code change was made during diagnosis. Operationally, builds/restarts should drain or block while active Turns exist. A future product change could add a restart preflight/drain gate and surface the restart actor/reason in the receipt.
- **Status:** DONE_WITH_CONCERNS.
