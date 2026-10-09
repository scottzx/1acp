# Marketplace artifact verification — 2026-10-09

The public install target is **`@1agents/acp-service@0.6.0`**. The repository root is a private development workspace; `packages/dsh-plugin` is an internal source module. Marketplace entries should identify `packages/service` and install the published npm package or its identical GitHub Release tarball.

## Artifact

- npm tarball: <https://registry.npmjs.org/@1agents/acp-service/-/acp-service-0.6.0.tgz>
- SHA-256: `c9092fd7bd29f18beebfe38e58105b671bb7166bddc6795825feac885249bee1`
- Published source commit: `5e3fb147f185c083e51b21d6497752cba55a60c8`
- Existing CI baseline: DSH `21638c56315ae6a2b552d6091945d3144c9af32e`, whose CLI manifest declares `0.1.7-rc.2`.

## Installed artifact smoke

Downloaded the npm tarball, then ran the repository's existing smoke script outside the workspace:

```sh
node scripts/smoke-service-package.mjs /absolute/path/acp-service-0.6.0.tgz /absolute/path/DSH
```

Result: **passed**. All 32 installed-package tests passed. The additional DSH smoke passed the real profile patch reader, Cordis Loader, browser module registration/serving, service health, A2A routes and service shutdown. Installation used `--ignore-scripts` as defined by the existing smoke script.

This run used a locally built DSH working tree based on `21638c5`, with local changes and manifests declaring `0.2.0-rc.1`. It is additional integration evidence, not a claim of compatibility with every released DSH version.

## Fresh interactive profile

Created a new temporary `DSH_HOME`, a new `market-verify` profile from the shipped `web` template, and a separate `ACP_STATE_DIR`. No existing profile, plugin inventory or conversation history was reused.

```sh
dsh --profile market-verify --from-default-profile web --dump-config
dsh plugin --profile market-verify add @1agents/acp-service@0.6.0 --registry=https://registry.npmjs.org
dsh --profile market-verify --host 127.0.0.1 --port 36822 --no-open
```

The local checkout was launched through its CLI source entry, equivalent to the commands above. Its package manager used pnpm `11.27.1`.

Observed behavior:

1. First install reported `ERR_PNPM_IGNORED_BUILDS` for transitive `esbuild@0.28.2`. Approved only `esbuild` in this temporary profile's `pnpm-workspace.yaml`, then repeated the install successfully.
2. The partial first install left the package present but disabled. Enabled `@1agents/acp-service` from DSH's Plugins page; the profile bundle list then included that exact package name.
3. The plugin started its own ACP service; `/health` returned `status: ok` and `service: acp-service`.
4. The preset picker displayed discovered Claude Code, Codex, Cursor Agent, Grok and Pi entries. Discovery alone does not prove each Agent is authenticated.
5. Selected **ACP · Codex**. The installed `codex-acp` adapter connected to the native Codex executable and returned its model and configuration capabilities. The UI displayed native model **6.1 Sol** and ACP settings. No model prompt was sent during this UI check.
6. Stopping the temporary DSH process disposed the owned service.

Two unmodified browser screenshots from this profile are stored in `packages/service/assets/` and declared by `packages/service/screenshots.json`. They show the local DSH build label and contain no account credentials or private conversations.

## Per-market acceptance check

After each market accepts an entry, verify its public search result, repository/subpath and exact npm package name. Then install the target advertised by that market in another fresh profile and check loading again. A submitted form or open registry PR is not an accepted listing and cannot yet pass this check.
