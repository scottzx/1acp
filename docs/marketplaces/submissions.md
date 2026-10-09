# DSH marketplace submissions

Updated: **2026-10-09**. Submission does not mean acceptance or public availability.

Public package: **`@1agents/acp-service@0.6.0`**. Source package: [`packages/service`](../../packages/service). The repository root and `packages/dsh-plugin` are private development modules, not the advertised installation targets.

## Published materials

- Repository topics: `dsh-plugin`, `deepseek-harness`, `acp`, `a2a`.
- About description, user installation guides, prerequisites and two real screenshots published in commit [`3275792`](https://github.com/scottzx/1acp/commit/327579286420ffc3e152e3e6ce006375daec4c42).
- [Release 0.6.0](https://github.com/scottzx/1acp/releases/tag/acp-service-v0.6.0), pinned to published source `5e3fb147f185c083e51b21d6497752cba55a60c8`.
- [Release tarball](https://github.com/scottzx/1acp/releases/download/acp-service-v0.6.0/1agents-acp-service-0.6.0.tgz) is identical to npm, with `SHA256SUMS` attached. SHA-256: `c9092fd7bd29f18beebfe38e58105b671bb7166bddc6795825feac885249bee1`.
- [Installation and loading verification](verification-2026-10-09.md): 32 installed-artifact tests and the real DSH profile/Loader/browser/service lifecycle smoke passed; a separate fresh interactive profile loaded the plugin and connected to native Codex capabilities.

## Submission status

| Channel | Submission / receipt | Current status | Remaining acceptance check |
| --- | --- | --- | --- |
| Canonical awesome → dsh-market | [PR #6950](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6950) | Open, official CI started; not merged or listed at the initial check | Wait for merge/feed refresh; search, inspect install target, install/load in a fresh profile |
| DSH Marketplace | [Form](https://dshmarketplace.dev/submit), [precheck evidence](evidence/1acp-marketplace-rate-limit-20261009.png) | **Not submitted**: GitHub rate limit still blocked repository inspection after one bounded retry | Retry after the rate limit clears, obtain a real receipt, then await review |
| DSH Plugin Store | [Form](https://dshpluginstore.com/submit), [receipt](evidence/1acp-pluginstore-receipt-20261009.png) | **Received**, 2026-10-09 17:52 Asia/Shanghai; manual review pending, no submission ID | Search after acceptance, verify npm name and fresh-profile install/load |
| DSH STORE | [Submission #1345](https://github.com/AI-Scarlett/DSH-Store/issues/1345) | [Precheck failed](https://github.com/AI-Scarlett/DSH-Store/actions/runs/37914061906): `SUBMISSION_SOURCE_HTTP`, HTTP 404 for the generated patch; security scan did not run. [Exact failure and artifact compatibility follow-up](https://github.com/AI-Scarlett/DSH-Store/issues/1345#issuecomment-6078641824) posted | Obtain a supported artifact validation route; do not advertise unbuilt GitHub installation |
| dsplugin | [Submission #333](https://github.com/vbarter/dsh-plugin-registry/issues/333), [bot PR #334](https://github.com/vbarter/dsh-plugin-registry/pull/334), [correction PR #335](https://github.com/vbarter/dsh-plugin-registry/pull/335) | Actual metadata fix submitted against `submission/333`: correct public package, subpath and npm install target; honest `not_validated` / `not_checked` / `not_tested` states retained | Merge correction #335 before bot PR #334; then verify the resulting public entry and fresh installation |
| dsh.pub | [Compatibility request #131](https://github.com/dsh-pub/dsh-pub/issues/131) | **Not a plugin submission**: requested monorepo + npm/Release support | Wait for a supported contract, then submit and validate |

Plugin Store search before submission returned zero matches for `1acp` ([evidence](evidence/1acp-pluginstore-search-before-20261009.png)). The initial canonical public feed also had no entry. No channel has yet been recorded as passing public-listing acceptance.

## Source-validation compatibility

The actual sources are committed, while release builds embed generated JavaScript and the bundle patch into the npm artifact:

| Published surface | Committed source |
| --- | --- |
| Public package manifest | `packages/service/package.json` |
| Public runtime entry | `packages/service/src/package.ts` |
| DSH bundle patch | `packages/dsh-plugin/cordis.patch.yml` |
| DSH host plugin | `packages/dsh-plugin/src/index.ts` |
| DSH browser entry | `packages/dsh-plugin/src/client.js` |
| Build mapping | `scripts/embed-dsh.mjs`, `scripts/embed-runtime.mjs`, `scripts/release-artifacts.mjs` |
| Component MIT licenses | `packages/runtime/LICENSE`, `packages/dsh-plugin/LICENSE` |

DSH STORE supports a subpackage path but expects the generated manifest paths to exist in Git. dsplugin currently discovers only the root manifest; its existing schema supports a custom install string, so PR #335 concretely fixes this entry's metadata and npm target without claiming registry validation. Full and lite catalogs were regenerated and checked to change only the target entry. dsh.pub's public submission JSON permits only `repository` and `schemaVersion`, forces the root directory, and requires committed runtime/browser/patch files. Thus adding topics alone cannot complete these three routes. Source-validation support and acceptance remain **pending**.

## Acceptance procedure

After each channel accepts or publishes the entry:

1. Search for `1acp` and `@1agents/acp-service` in its actual public catalog. Record the public detail URL and date.
2. Verify repository/subpath, package name and the advertised installation command. Prefer npm; the pinned Release tarball is the fallback. Report any command that points at the private workspace root or unbuilt GitHub sources.
3. Create a separate temporary `DSH_HOME`, `ACP_STATE_DIR` and fresh profile for that channel. Install exactly the advertised target, address only the specific pnpm script prompt if present, and confirm the bundle is enabled.
4. Check profile patch loading, Cordis/plugin activation, browser registration, service health and shutdown. Native capability discovery is separate from a paid model turn or proof of every Agent's credentials.
5. Mark that channel accepted only with evidence for search, correct install target and fresh-profile loading. Keep unmerged PRs, review queues, failed prechecks and compatibility requests explicitly pending.

An active thread follow-up checks every six hours. It stays quiet while nothing changes and reports acceptance, actionable maintainer feedback, a failure requiring action, or completed verification. Avoid duplicate submissions and repeated rate-limited requests.
