# DSH Web standard mode remains “Connecting to Agent…”

## Observed on 2026-10-22

- Mac scott-mac, DSH Web 127.0.0.1:3080, installed Harness 0.2.1-rc.2 (332895e).
- ACP runtime 0.8.1, health 127.0.0.1:36813/health returned ok.
- Authenticated page, session list, and model catalog returned HTTP 200.
- WebSocket $events, session/control, and session/follow returned readiness/baselines in 6–14 ms.
- Recent blank sessions were created with an ACP preset and then changed to standard. The current preset projection was standard; the creation header correctly retained the original preset.
- The exact Chinese loading text belongs to the ACP plugin. The API and model catalog were responsive.

## Root cause

The ACP client attached the same global reset() function to
agent-preset/selected(sessionId, agentPreset) and connection/reset. The
selection event arguments were ignored. It reset every cached ACP session,
read the old projection before the independent session stream caught up,
and could install a loading composer block for a session switching to
standard mode. The standard model-catalog path never cleared that block.
Sessions with only a pending request were omitted from reset, and late
successes/errors could publish obsolete ACP state.

## Fix

- Invalidate only the selected session, using the new preset carried by the event.
- Track per-session revisions; ignore stale request results.
- Cancel invalidated ACP GET requests and protect replacement requests from stale cleanup.
- Clear owned ACP input blocks when standard mode becomes active.
- Keep connection reset separate and include cached, pending, blocked, and subscribed sessions.
- Distinguish loading ordinary models from connecting an external Agent.

## Validation

The same regression suite against the original live bundle: 5 passed, 3 failed.
Against the candidate and the actual JavaScript served by port 3080: 8 passed, 0 failed.

Regression cases cover:
1. ACP to standard selection arriving before its projection.
2. A pending ACP failure arriving after switching to standard.
3. Changing one session without resetting another ACP session.
4. Existing model selection, writer contention, transcript rendering, and unload behavior.

The served asset revision after deployment was f1bcfbc8a4ff. The server
returned the complete patched runtime followed only by its source-map trailer.
DSH Web process PID 16553 remained running; no service restart was needed.
The package version remains 0.8.1; this is a local frontend hotfix, not an npm release.

## Deployment and rollback

Runtime:
    /Users/scott/.dsh/profiles/web/node_modules/@1agents/acp-service/vendor/dsh/client.js

Backup:
    /Users/scott/.local/state/1agents/dsh-fixes/20261022T032018Z-standard-mode/

This fix preserves the already-deployed assistant renderer compatibility
prefix from the earlier incident. It does not rebuild that renderer from
the older checkout. Preserve/port that earlier patch before a full package release.

An existing browser page may need a reload to discard its previous client state.
Direct visual verification of the user's existing browser was unavailable.
