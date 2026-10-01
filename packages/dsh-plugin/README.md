# @1agents/dsh-acp

An out-of-tree DeepSeek Harness plugin for persistent external ACP Agent sessions. It requires the local DSH plugin and preset APIs available in 0.1.7-rc.2 and installs acp-service 0.4 with its embedded runtime as a dependency. No DSH source files are modified.

## Use

Install the published bundles from your DSH checkout:

```sh
pnpm dsh plugin --profile web add @1agents/dsh-acp @1agents/session-reader
```

If pnpm pauses the first install for the transitive `esbuild` build script, set `allowBuilds: { esbuild: false }` in that profile's `pnpm-workspace.yaml` and repeat the install. Automatic ACP startup uses published JavaScript and works without running that install script.

The package declares `dsh.bundle.patch` and its browser entry, so installation selects the bundle automatically. Restart `pnpm dsh web` after updating packages. If you use an installed `dsh` executable, omit the leading `pnpm`. Replace `web` with `desktop` for the desktop profile.

The plugin starts its bundled ACP service on `127.0.0.1:36812` when no service is listening. An existing healthy ACP service is reused. Start DSH normally; no separate service command is needed. To manage the service yourself, set `serviceMode: external` and run:

```sh
npx --yes @1agents/acp-service@^0.4.0 serve --host 127.0.0.1 --port 36812 --no-report
```

The service requires each native Agent’s CLI and credentials. Installing the package alone starts no process; activating the plugin starts the service. For local development, install the built checkout with `pnpm dsh plugin --profile web add /absolute/path/1acp/packages/dsh-plugin`.

Choose a discovered **ACP · Agent** in the new-session Agent preset picker, choose a workspace, then send a message. ACP routes are not listed as ordinary DSH models, and the adapter rejects requests from ordinary presets, including previously saved ACP routes. Before the first turn, switching the Agent preset replaces the discovery connection and its native commands. Once a turn starts, the session keeps its remote Agent and workspace; start a new session to change Agent. Native Agent binaries and authentication belong to acp-service.

The bundle registers an ACP adapter through DSH's public streaming extension and routes the ACP presets to it. It sends newly admitted messages whose source is `user` to `session/prompt`, not to `subagent-acp`; there is no coordinating DeepSeek model call. DSH-generated workspace instructions and runtime-context messages are excluded. The external Agent owns its model, prompt, tools and native history, including any project instructions it discovers itself. DSH owns its UI and local user/assistant transcript. External tool progress appears in the thinking stream; it is never dispatched as a DSH tool call.

## Continue imported native sessions

With `@1agents/session-reader` installed, choose **在 DSH 中继续原会话** on a Claude, Codex or Grok history. The original workspace must still exist. The plugin restores the native session through acp-service's `_1agents/session/import`, creates DSH history under the matching ACP preset, and attaches it to that workspace. Importing sends no prompt. Subsequent messages go to the original Agent; imported messages are never resent, including an unfinished trailing user message. Unsupported sources stay readable in session-reader.

Imported bindings use `session/resume` because the service does not own a complete ACP replay of earlier native history. Existing ordinary ACP bindings continue using `session/load`. Endpoint, source provider and native ID identify an import; repeated admission reuses its DSH session without refreshing or replacing history. Old history-only DSH copies are not adopted. Original Agent history can continue changing outside DSH; the imported DSH history is a snapshot.

The service ID is saved before DSH creation. A failed local creation or workspace attachment can be retried after restart without importing again. Native restoration and authentication failures are reported, never replaced by a new empty session. If the transport is lost before the import response reaches the plugin, the plugin cannot know the service ID and does not automatically retry that RPC.

### Plugin service API

`ctx.oneagentsAcpSessions` is a Cordis service owned by this plugin; consumers may declare it optional so history browsing works without ACP. Its TypeScript declarations are exported from `@1agents/dsh-acp/imports`. Consumers call the service from the Host and must not instantiate it or write its binding files.

- `availability(provider)` returns `{ available, agent?, reason? }` without restoring a session. It checks configuration and the service inventory; successful native restoration remains the final capability/authentication check.
- `importSession({ provider, nativeSessionId, cwd, events })` accepts current DSH events starting at sequence zero. It returns `{ success: true, dshSessionId, workspace, workspaceId, agent, continuation: 'native' }` only after restoration, DSH creation and workspace attachment succeed.

Provider mapping is `claude → claude`, `codex → codex`, `grok → grok-build`. The service validates history through DSH before restoring a new native binding. No DSH Session format changes are required.

## Native commands and configuration

Opening an ACP session initializes or restores its remote session without sending a prompt. The plugin consumes `available_commands_update`, `config_option_update`, and mode updates. Advertised slash commands with names accepted by DSH (`[a-z][a-z0-9_-]*`) are registered in that session and forwarded verbatim through `session/prompt`, including their arguments. `/model` opens the model options advertised by the remote Agent. Choosing a model or reasoning setting uses `session/set_config_option`; choosing a mode uses `session/set_mode`. Unsupported options are not invented. Configuration changes are rejected while a turn runs.

The bundle disables the stock `ui-model-selection` row and supplies a session-aware model selector using DSH's existing UI slot and command contribution APIs. Ordinary sessions still select their DSH provider/model and reasoning effort; ACP sessions select only native Agent options. The Agent's additional options appear under **ACP 设置**. An idle ACP connection is retained so metadata updates and controls share the same session owner. The visible browser refreshes its capability snapshot every five seconds.

The bundle registers `oneagents-acp-*` presets with DSH's preset registry. Older filesystem presets remain untouched; DSH 0.1.7 uses registry declarations instead of scanning those files. ACP bindings are stored separately under `$DSH_HOME/plugins/1agents-acp/sessions`.

## Interactions and reconnection

ACP one-shot tool permissions use DSH's approval UI and policy. Grok questions and plan approval use its question UI. Persistent grants are not synthesized. Read operations follow acp-service's `approve-reads` policy; operations requiring permission are presented to the user.

Transport reconnects load the same service session and replay the current managed turn. Stable request IDs prevent duplicate execution, and update sequence numbers suppress duplicate output. A browser refresh leaves the Host request running. Stopping a DSH turn sends ACP cancellation. Provider errors fail the turn without automatic resubmission.

This plugin supports **text prompts**. Attachments and specialized external-tool cards are not implemented. Auxiliary DSH title/compaction calls cannot use this adapter; an advertised native compaction command runs in the external Agent. Existing standard-preset sessions that selected an old ACP route must choose a normal DSH model or start a new ACP-preset session.

## Configuration

The bundle's `oneagents-acp` row accepts `serviceUrl`, `serviceMode`, `serviceStartupTimeoutMs`, `serviceShutdownTimeoutMs`, `agents`, `stateDirectory`, `reconnectAttempts` and `reconnectDelayMs`. Change it through the profile's `cordis.patch.yml`, not the DSH repository. Use a new session after changing endpoint or workspace. When `agents` is omitted, plugin startup fetches `GET /agents` from acp-service and registers presets for entries with `chat_ready: true`, using their service-provided names. Discovery runs on the service host. Restart the plugin after installing or removing a harness. An explicit `agents` list bypasses discovery and preserves manual registry selection; `[]` registers no presets. Service startup, connection errors and invalid inventory responses fail plugin initialization instead of selecting fallback agents.

### Local service lifecycle

`serviceMode` defaults to `auto`. Only plain HTTP root URLs on `127.0.0.1`, `localhost` or `[::1]` can start a process. Remote URLs, HTTPS and URLs with a path or credentials remain external connections. `external` disables process management for every address. Use a stable nonzero port: native session bindings include the endpoint.

Before spawning, the plugin validates `/health`. Connection refusal permits startup; HTTP errors, authentication failures, timeouts and another application occupying the port fail explicitly. Startup waits for the child to listen and pass its health check before discovering Agent presets. `serviceStartupTimeoutMs` defaults to 15000 for each startup/health phase; `serviceShutdownTimeoutMs` defaults to 5000 before forced process exit.

Plugin disposal closes ACP connections before shutting down its owned service and awaiting process exit. Concurrent plugin instances in the same DSH process share an owned service until the last instance disposes. An existing service is never stopped. A worker also exits if its DSH parent crashes or is killed. If the worker itself crashes, requests fail through the normal ACP connection errors; restart the plugin to start a replacement. A service shared by separate DSH processes should be managed externally so stopping its owning DSH instance does not interrupt the others.

The child inherits DSH's environment, including native Agent configuration and credentials, and uses the service's existing state directory (`ACP_STATE_DIR` or `~/.1agents/acpx-state`). It starts with node reporting disabled. The plugin neither downloads executables at startup nor launches native Agents until a session needs one.

## Development and removal

Install dependencies from the repository root, then build from this plugin directory:

```sh
pnpm -w install --frozen-lockfile
node scripts/link-dsh-types.mjs /absolute/path/DSH
pnpm --filter @1agents/acp-service... build
pnpm test
```

The DSH checkout must already have its dependencies installed and declaration outputs built. Development type checking links its matching packages into `node_modules/@deepseek-ai`; generated JavaScript has no runtime imports of those packages and uses the Host's provided services. Tests cover real-WebSocket streaming, permissions, questions, cancellation, reconnection and saved bindings.

For manual service debugging on this machine, start it from `../service` with:

```sh
CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex \
npm_config_cache="$HOME/.dsh/plugins/1agents-acp/npm-cache" \
node dist/bin/acp-service.js serve --host 127.0.0.1 --port 36812 --no-report
```

For automatic startup, set these environment variables on the DSH process instead. `CODEX_PATH` selects the installed app's newer Codex runtime; the global CLI on this machine rejects its configured `gpt-6-astra` model. The separate npm cache avoids a broken pre-existing npx cache. Neither setting changes the global Codex configuration.

Remove using `pnpm dsh plugin --profile web remove @1agents/dsh-acp`, then restart DSH; removing the bundle also restores the stock model-selection row. The preset registrations are removed with the bundle. Keep binding files if sessions may be reattached later.
