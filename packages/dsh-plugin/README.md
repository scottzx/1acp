# @1agents/dsh-acp

An out-of-tree DeepSeek Harness plugin for persistent external ACP Agent sessions. It requires the local DSH plugin and preset APIs available in 0.1.7-rc.2 and acp-service 0.2. No DSH source files are modified.

## Use

Install the built checkout with `pnpm dsh plugin --profile web add /absolute/path/dsh-acp-plugin` from your DSH checkout, then restart `pnpm dsh web`. Start acp-service separately on `127.0.0.1:36812`.

Choose **ACP · Codex** or **ACP · Grok** in the new-session Agent preset picker, choose a workspace, then send a message. ACP routes are not listed as ordinary DSH models, and the adapter rejects requests from ordinary presets, including previously saved ACP routes. An active session keeps its remote Agent and workspace; start a new session to change Agent. Native Agent binaries and authentication belong to acp-service.

The bundle registers an ACP adapter through DSH's public streaming extension and routes the ACP presets to it. It sends newly admitted messages whose source is `user` to `session/prompt`, not to `subagent-acp`; there is no coordinating DeepSeek model call. DSH-generated workspace instructions and runtime-context messages are excluded. The external Agent owns its model, prompt, tools and native history, including any project instructions it discovers itself. DSH owns its UI and local user/assistant transcript. External tool progress appears in the thinking stream; it is never dispatched as a DSH tool call.

## Native commands and configuration

Opening an ACP session initializes or restores its remote session without sending a prompt. The plugin consumes `available_commands_update`, `config_option_update`, and mode updates. Advertised slash commands with names accepted by DSH (`[a-z][a-z0-9_-]*`) are registered in that session and forwarded verbatim through `session/prompt`, including their arguments. `/model` opens the model options advertised by the remote Agent. Choosing a model or reasoning setting uses `session/set_config_option`; choosing a mode uses `session/set_mode`. Unsupported options are not invented. Configuration changes are rejected while a turn runs.

The bundle disables the stock `ui-model-selection` row and supplies a session-aware model selector using DSH's existing UI slot and command contribution APIs. Ordinary sessions still select their DSH provider/model and reasoning effort; ACP sessions select only native Agent options. The Agent's additional options appear under **ACP 设置**. An idle ACP connection is retained so metadata updates and controls share the same session owner. The visible browser refreshes its capability snapshot every five seconds.

The bundle registers `oneagents-acp-*` presets with DSH's preset registry. Older filesystem presets remain untouched; DSH 0.1.7 uses registry declarations instead of scanning those files. ACP bindings are stored separately under `$DSH_HOME/plugins/1agents-acp/sessions`.

## Interactions and reconnection

ACP one-shot tool permissions use DSH's approval UI and policy. Grok questions and plan approval use its question UI. Persistent grants are not synthesized. Read operations follow acp-service's `approve-reads` policy; operations requiring permission are presented to the user.

Transport reconnects load the same service session and replay the current managed turn. Stable request IDs prevent duplicate execution, and update sequence numbers suppress duplicate output. A browser refresh leaves the Host request running. Stopping a DSH turn sends ACP cancellation. Provider errors fail the turn without automatic resubmission.

This plugin supports **text prompts**. Attachments and specialized external-tool cards are not implemented. Auxiliary DSH title/compaction calls cannot use this adapter; an advertised native compaction command runs in the external Agent. Existing standard-preset sessions that selected an old ACP route must choose a normal DSH model or start a new ACP-preset session.

## Configuration

The bundle's `oneagents-acp` row accepts `serviceUrl`, `agents`, `stateDirectory`, `reconnectAttempts` and `reconnectDelayMs`. Change it through the profile's `cordis.patch.yml`, not the DSH repository. Use a new session after changing endpoint or workspace. The default bundle offers Codex and Grok Build; other registry names can be added explicitly.

## Development and removal

Build from this plugin directory:

```sh
npm ci
node scripts/link-dsh-types.mjs /absolute/path/DSH
npm test
```

The DSH checkout must already have its dependencies installed and declaration outputs built. Development type checking links its matching packages into `node_modules/@deepseek-ai`; generated JavaScript has no runtime imports of those packages and uses the Host's provided services. Tests cover real-WebSocket streaming, permissions, questions, cancellation, reconnection and saved bindings.

On this machine, start the service from `../acp-service` with:

```sh
CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex \
npm_config_cache="$HOME/.dsh/plugins/1agents-acp/npm-cache" \
node dist/bin/acp-service.js serve --host 127.0.0.1 --port 36812 --no-report
```

`CODEX_PATH` selects the installed app's newer Codex runtime; the global CLI on this machine rejects its configured `gpt-6-astra` model. The separate npm cache avoids a broken pre-existing npx cache. Neither setting changes the global Codex configuration.

Remove using `pnpm dsh plugin --profile web remove @1agents/dsh-acp`, then restart DSH; removing the bundle also restores the stock model-selection row. The preset registrations are removed with the bundle. Keep binding files if sessions may be reattached later.
