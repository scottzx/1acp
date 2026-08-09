# DeepSeek Build authentication investigation

- **Symptom:** `deepseek-build` fails before spawn with `AUTH_REQUIRED` because `DEEPSEEK_API_KEY` is empty.
- **Root cause:** The running 1acp process has no `DEEPSEEK_API_KEY`. The variable is also absent from the macOS launch environment, login shell, project `.env`, and active acpx config locations. No parent application env file in this checkout defines it.
- **Evidence:** Running the built CLI with `DEEPSEEK_API_KEY` explicitly removed reproduces the same pre-spawn failure. The fake-agent integration test passes when the variable is supplied.
- **Fix:** DeepSeek credential resolution now falls back to the exact `deepseek-api` entry in `~/.1agents/providers.json` after checking session and parent `DEEPSEEK_API_KEY` values.
- **Regression test:** `test/integration.test.ts` verifies the DeepSeek launch profile with a supplied key; `test/client.test.ts` verifies providers-file fallback, exact provider selection, and missing, malformed, or blank values.
- **Status:** DONE.
