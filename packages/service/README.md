# @1agents/acp-service

ACP Agent Runtime Service for Codex, Grok Build, Claude Code and other Agents supported by its embedded 1ACP runtime. Version 0.2 uses **ACP v1 JSON-RPC 2.0 over WebSocket**. Each connection selects one Agent; each session keeps that Agent and its workspace when reconnected.

## Bundled usage skill

[ACP Service skill](skills/acp-service/SKILL.md) is distributed in this npm package and maintained with the source. It covers entry-point selection, ACP CLI/WebSocket sessions, DSH presets and native model controls, A2A delegation, task queries and the durable completion inbox. Detailed examples are included in its `references/` directory.

```sh
acp-service --skill list
acp-service --skill show acp-service
acp-service --skill export acp-service > acp-service-skill.tar
# Install the complete skill in the current project when wanted:
acp-service --skill install acp-service --agent codex --scope repo
```

The existing embedded `acpx` runtime skill remains available. The new skill and its references can also be read directly from `skills/acp-service/` after installation. A source build containing these files must be installed before using them; an older published package may not include this skill or the A2A gateway.

## Run

Requires Node.js 22.13 or later. Version 0.5 includes the 1ACP runtime, CLI, service, DSH plugin, browser controls, skills and licenses; installing a separate `@scottzx/1acp` package is unnecessary. The runtime and service retain their respective ACP SDK versions.

The runtime's per-session launch argv and transient credentials APIs support Provider Profiles. Public runtime APIs and flow authoring are available as `@1agents/acp-service/runtime` and `@1agents/acp-service/flows`. The `acp-service` command forwards runtime commands alongside its `serve` command.

Run from the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @scottzx/1acp build
pnpm --filter @1agents/acp-service build
pnpm start:service serve --host 127.0.0.1 --port 36812 --no-report
```

The default port is 36812. Without `--no-report`, the service reports to the local DreamMate node. Agent executables and their authentication must be available to the service process. `ACP_STATE_DIR` overrides the default `~/.1agents/acpx-state` directory for runtime records, turn journals and ACP replay data.

For npm-backed agents, the service first uses an adapter package installed in its package search roots, then the runtime's adapter executable on PATH or in user-local binary directories. JavaScript adapters run with the service's Node interpreter. Only when an adapter is absent does launch fall back to npx; discovery itself never downloads packages. Installing the native `codex` CLI does not replace installing the `codex-acp` adapter.

If startup reports npm `ENOTEMPTY` inside `_npx`, upgrade npm and move the affected cache directory aside once no installation is using it, then retry. The diagnostic preserves npm's failing path. This error concerns npm's cache directory replacement rather than macOS device permissions.

The standalone HTTP/WebSocket service does not read standard input and keeps running when it is closed or redirected from `/dev/null`. Stop the service with `SIGINT` or `SIGTERM`; both clean up managed Agent sessions before exiting.

```ts
import { serveAcpService } from "@1agents/acp-service";
const service = await serveAcpService({ host: "127.0.0.1", port: 36812, report: false });
// Later: await service.close();
```

HTTP endpoints:

- `GET /health`: service health and active session/task counts.
- `GET /manifest`: DreamMate service discovery, ACP version, custom transport and Agent endpoint paths. Profiles listed here describe registered launch configurations, not a successful installation/authentication probe.
- `GET /services`: current service/session counts.

## DSH installation

The same npm package can be installed as a DSH bundle:

```sh
pnpm dsh plugin --profile web add @1agents/acp-service
```

DSH reads the package's bundle patch and browser metadata; the CLI uses its `bin` entry. There is no installation-time mode switch, and both uses can coexist. The package root retains the service API and exposes Cordis metadata plus a lazy `apply`; merely importing it starts no plugin or process. `/service` is the service API, while `/dsh`, `/dsh/preset` and `/dsh/imports` provide the typed plugin interfaces. DSH host dependencies are supplied by DSH rather than installed with the CLI.

The plugin starts or reuses a local service when activated. See [DSH plugin usage](vendor/dsh/README.md) for presets, browser controls, configuration and lifecycle. Before migrating, stop DSH and remove `@1agents/dsh-acp`, then add the unified package; keep session bindings and preserve custom row configuration. Plugin and preset IDs are unchanged.

## DSH A2A

The DSH plugin can expose an **A2A 1.0 JSON-RPC** agent using `@a2a-js/sdk@1.3.0`. The shared implementation is exported from `@1agents/acp-service/a2a`; it accepts an `A2ABackend` and starts no listener itself. This release mounts it on DSH's web server. The standalone `acp-service serve` command continues to expose ACP.

A2A is enabled by adding `a2a` to the existing `oneagents-acp` row's configuration. Set `DSH_A2A_TOKEN` in the DSH host's environment before startup, then restart DSH:

```yaml
config:
  serviceMode: auto
  serviceUrl: http://127.0.0.1:36812
  a2a:
    enabled: true
    publicUrl: http://100.125.201.118:3080
    defaultCwd: /home/scott/projects
    defaultAgentPreset: oneagents-acp-codex
    workspaces:
      demo: /home/scott/projects/demo
    pushNotificationOrigins:
      - http://100.100.100.100:9000
```

The example URLs and directories must match your execution host and notification receiver. `publicUrl` is the externally reachable DSH origin. `tokenEnv` can select a different environment variable; `token` can be configured directly. A missing bearer token rejects activation. Omitting `a2a`, or setting `enabled: false`, leaves A2A disabled. DSH's UI login credential does not authenticate A2A calls.

`GET /.well-known/agent-card.json` provides public discovery. Authenticated clients POST to `/a2a` with `Authorization: Bearer ...`, `A2A-Version: 1.0` and an A2A JSON request. `path` can change the JSON-RPC route. Only protocol 1.0 is advertised; v0.3 requests receive a version error.

Submit a text task and return after its DSH session has been created or restored, without waiting for the turn:

```json
{
  "jsonrpc": "2.0",
  "id": "submit-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-001",
      "role": "ROLE_USER",
      "parts": [{ "text": "检查这个项目的测试失败原因", "mediaType": "text/plain" }]
    },
    "configuration": { "returnImmediately": true },
    "metadata": { "1agents": { "workspace": "demo", "agentPreset": "oneagents-acp-codex" } }
  }
}
```

The standard response contains `result.task.id`, `result.task.contextId` and `result.task.metadata["1agents"]` with `sessionId`, canonical `cwd` and resolved `agentPreset`. Task IDs and DSH session IDs are distinct. Session preparation failures return a failed Task. The default `returnImmediately: false` waits for a terminal or input-required state.

Use `metadata["1agents"].cwd` for an absolute existing directory **on the DSH host**, or `workspace` for a configured alias. Supplying both is rejected. Omit location and preset to use host defaults, allowing a fixed-role agent to accept tasks without a project selector. A new context creates a new DSH session; the same directory alone never selects an old session. Retain `message.contextId` for later tasks in that session; cwd and preset cannot change within a saved context. A completed Task cannot be reopened. A Task requiring input can be continued with its `taskId` and a new `messageId`. Active Task follow-up messages are rejected; independent tasks in the same context queue as separate DSH turns.

| Method | Behavior |
| --- | --- |
| `GetTask`, params `{ "id": "task-id" }` | Current persisted status, history and artifacts. |
| `ListTasks` | Scoped filtering, pagination and history selection. |
| `SubscribeToTask`, params `{ "id": "task-id" }` | SSE beginning with the current Task, followed by status/artifact updates. Terminal tasks are queried instead. |
| `SendStreamingMessage` | Submit and observe through SSE; execution and persistence continue after disconnect. |
| `CancelTask`, params `{ "id": "task-id" }` | Remove this task's queued prompt or cancel its claimed DSH turn. Other queued prompts remain. |
| `Create/Get/List/DeleteTaskPushNotificationConfig(s)` | Standard webhook configuration lifecycle. The List method is `ListTaskPushNotificationConfigs`; the other three use the singular form. |

For completion notifications, add a receiver whose origin appears in `pushNotificationOrigins`, then include a standard v1 configuration in the send request:

```json
{
  "returnImmediately": true,
  "taskPushNotificationConfig": {
    "url": "http://100.100.100.100:9000/a2a-events",
    "authentication": { "scheme": "Bearer", "credentials": "receiver-token" }
  }
}
```

The receiver gets A2A `StreamResponse` JSON (`application/a2a+json`), including `task`, `artifactUpdate` and `statusUpdate`. Completion is `statusUpdate.status.state: "TASK_STATE_COMPLETED"`; errors and cancellation use their corresponding standard states. Delivery is ordered per scoped task, has a five-second timeout and refuses redirects. Slow or unavailable receivers do not delay task acceptance or execution. Delivery is best effort without retry or a durable outbox; consumers can reconcile with `GetTask`. An empty origin list disables push notifications. The calling system owns waking its main agent after receiving a callback.

Tasks, callback configurations and context-to-session mappings live under `<DSH_HOME>/plugins/1agents-acp/a2a` by default (`a2a.stateDirectory` overrides it). Records are scoped by tenant and authenticated host credential, written atomically with restricted permissions, and protected against two live owners of the same directory. The `.lock` directory contains a unique process-owner record; dead owners can be reclaimed without deleting a newly acquired owner's lock. A legacy `.lock` file is rejected and must only be removed after verifying no instance is running. After a host restart, completed results remain queryable, interrupted nonterminal tasks become `TASK_STATE_FAILED`, and a new task with the saved `contextId` restores its DSH session. Interrupted work is never automatically replayed. Plugin unload removes both routes and cancels its own active or queued turns.

Verification covers the official A2A client over real HTTP, SSE, callbacks, disconnection and restart, durable storage, and keyless DSH session execution. Run `pnpm --filter @1agents/acp-service test:only` and `pnpm --filter @1agents/dsh-acp test:only` after building. The optional real DSH loop test uses `DSH_SOURCE=/absolute/path/DSH`; package smoke tests verify the installed tarball's shared export and embedded plugin.

## ACP connections

Connect to `ws://127.0.0.1:36812/agents/codex`, `/agents/grok-build`, `/agents/claude`, or another registered Agent name. `/` selects Codex. Each WebSocket text message contains one UTF-8 JSON-RPC object. Batch messages and the former `action/event` envelopes are rejected. WebSocket is a custom transport permitted by ACP, not the standard stdio transport.

Initialize before sending session requests:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocolVersion": 1, "clientCapabilities": {} }
}
```

Create a session using an absolute existing directory:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": { "cwd": "/absolute/project", "mcpServers": [] }
}
```

Use the **returned service session ID** for subsequent requests. Native Agent IDs are distinct and may appear in `_meta["1agents"].agentSessionId`; they must not replace the service ID.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "returned-session-id",
    "prompt": [{ "type": "text", "text": "Explain this project" }]
  }
}
```

Output arrives as `session/update` notifications. The prompt request receives its response only when the turn settles, with a standard `stopReason`. Runtime failures return JSON-RPC errors. `session/cancel` is a notification; cancellation settles the original prompt request.

| Method                       | Behavior                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/new`                | Creates a new persistent session with a server-generated ID.                                                                                                   |
| `session/load`               | Attaches an existing session and replays its complete recorded ACP conversation before responding.                                                             |
| `session/resume`             | Attaches without replaying conversation history.                                                                                                               |
| `session/prompt`             | Runs a turn; ordinary overlapping prompts are rejected as busy.                                                                                                |
| `session/cancel`             | Cancels the current turn; has no RPC response.                                                                                                                 |
| `session/close`              | Cancels work and releases live resources while retaining persistent history.                                                                                   |
| `session/list`               | Lists this endpoint's bound, resumable sessions, optionally filtered by cwd. Returns the complete list without a next cursor.                                  |
| `session/delete`             | Closes live resources and tombstones the service session so it cannot be resumed or listed. Runtime history retention follows the runtime's deletion behavior. |
| `session/set_mode`           | Selects an advertised native Agent mode.                                                                                                                       |
| `session/set_config_option`  | Changes an advertised native option and returns the resulting configuration options.                                                                           |
| `session/request_permission` | Server-to-client request; the client returns an advertised option ID or a cancelled outcome.                                                                   |

Methods and content remain subject to the selected Agent's capabilities. The installed runtime supports text followed by image/audio attachments. Resource blocks and text interleaved after attachments are rejected explicitly rather than reordered. Modes/configuration are returned from the Agent, not synthesized as universal choices. Session creation and loading return the original ACP config options, including select tags and grouped choices; loading also republishes the current advertised slash commands even when the runtime emits no new command event.

The service currently advertises no connection authentication methods. Native Agent authentication remains owned by its runtime configuration and the negotiated session authentication extension.

## Reconnection and history

A dropped WebSocket does not stop the Agent turn. Reinitialize the new connection and call `session/resume` or `session/load` with the same service ID and workspace. A live session has one controlling connection; a new owner displaces the old connection for that session only. SDK stream cancellation and socket closure may arrive in either order; transport cleanup closes the readable stream at most once.

Pending permissions, Grok questionnaires and plan confirmations stay with the session. They are sent as new RPC requests on the new connection, linked internally to the original one-shot operation. Their existing deadlines remain in effect. Late replies from old connections, duplicate replies, expired requests and already-cancelled operations cannot resolve them again.

A prompt RPC interrupted by a transport loss cannot receive its old response on a new connection. Standard clients reload history; 1agents clients additionally reconcile the persistent turn journal through negotiated notifications. Runtime turns continue writing the ACP replay log even while no socket is connected.

ACP bindings and append-only updates live under `ACP_STATE_DIR/acp`. A service restart restores runtime records and recorded history; it does not recreate vanished JavaScript approval promises. The existing turn journal records interrupted running/queued turns according to runtime recovery policy. An incomplete final log record is reported as an error rather than silently treated as complete history.

Sessions imported from older/native records can resume and use the application history extension. They cannot claim complete `session/load` replay when no complete ACP log exists; that method returns an explicit error for those sessions.

## Negotiated 1agents extensions

Clients opt in using `clientCapabilities._meta["1agents"] = { "version": 1 }` during initialization. The server advertises its extension version under `agentCapabilities._meta["1agents"]`. Plain ACP clients can create, prompt, approve tools, cancel and resume without these extensions.

Custom launch/session options are carried only in `_meta["1agents"]`, including `systemContext`, `permissionMode`, `responsePolicy`, explicitly supplied child `env`, and the trusted provider-profile `launch` descriptor. Launch argv/environment validation and transient credential handling are preserved from the 1agents provider-profile integration. Credentials are not copied into ACP bindings or transcript metadata.

| Extension                                                  | Purpose                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_1agents/session/import`                                  | Explicitly resumes a pre-migration native session ID and returns a new service session ID.                                                                         |
| `_1agents/session/history`                                 | Returns the runtime/native history projection used by existing chat views.                                                                                         |
| `_1agents/session/permission_mode`                         | Changes the service permission policy, independently of native Agent mode.                                                                                         |
| `_1agents/session/cancel_queued`                           | Cancels a queued managed request by its durable request ID.                                                                                                        |
| `_1agents/session/fork`                                    | Uses the runtime's optional fork capability. Imported/forked native history is not advertised as complete ACP replay.                                              |
| `_1agents/session/authenticate`, `_1agents/session/logout` | Native session authentication controls.                                                                                                                            |
| `_1agents/sessions/close_all`                              | Closes all managed sessions.                                                                                                                                       |
| `_1agents/session/meta`                                    | Notification containing native models, modes and other UI capabilities.                                                                                            |
| `_1agents/events/<name>`                                   | Application notifications such as `turn_sync`, `turn_state`, `turn_terminal`, `history_response`, `session_taken_over`, background tasks and interaction timeouts. |
| `_x.ai/ask_user_question`, `_x.ai/exit_plan_mode`          | Server-to-client requests preserving Grok-specific questionnaire/plan semantics. Clients answer with the corresponding JSON-RPC result.                            |

Nonstandard metadata is namespaced; standard `session/update` content is still available without knowing the application view fields. `responsePolicy: "summary"` suppresses incremental conversation output while preserving the replay log and live permission/questions. The final prompt response carries the summary in `_meta["1agents"]`, and opted-in clients receive `turn_complete`. Managed turn IDs, idempotency keys and queue state are application extensions, not replacements for JSON-RPC request IDs.

## Upgrade from 0.1

Upgrade the service and 1agents Go client together. Old `action/event` WebSocket clients are not supported by 0.2. The Go `internal/acpwire` client converts existing chat view messages to standard ACP and negotiated extensions; frontend view state can remain unchanged. It stores the returned service session ID for future reconnects and explicitly imports older native IDs when needed.

The npm `@1agents/acp-bridge` launcher must use a dependency range that accepts service 0.5 to adopt this release. There is one public package; the DSH plugin is embedded and needs no separate release. Install from the workspace root with `pnpm install --frozen-lockfile`; build runtime, then service. Development supervision locates `services/1acp/packages/service`.

## Verify

```sh
npm run typecheck
npm test
```

Tests use the official ACP SDK over real WebSockets, cover session lifecycle and permission reconnects, and drive the installed 1acp runtime through a deterministic external stdio Agent. They require no model API key. Existing real-provider smoke tests in the 1agents backend remain opt-in.

## Local harness discovery

`GET /agents` returns `{ "agents": [...] }`, a fresh local filesystem inventory shared by DSH and 1agents_app. Each entry includes the canonical ACP registry `id`, display `label`, native CLI `installed`, and `chat_ready`. Legacy app fields (`type`, capabilities, cc-connect transport, integration status and install guidance) remain available; `claude` uses the legacy app type `claudecode`.

Discovery checks PATH, `~/.local/bin`, `~/.grok/bin`, and installed adapter package launch files. A registered native ACP command is ready when its executable exists. Adapter-backed harnesses are ready when the adapter is installed, or when their native CLI and `npx` are installed; the latter uses the runtime's existing adapter download behavior when a session launches. Having `npx` or `uvx` alone does not expose uninstalled harnesses. Scanning neither executes agents nor downloads packages, and readiness does not verify credentials or model access. Detection-only frameworks remain in the inventory with `chat_ready: false`.

The service launcher uses the same local command resolution, including absolute paths to user-local binaries. The catalog originates from 1agents_app's former Go detector; consumers no longer probe their own host or maintain separate detection tables. `discoverAgents()` is also exported for embedded service consumers and includes local executable paths; the HTTP response omits these paths.

## Remote DSH tools and completion inbox

The same package includes `acp-service a2a gateway --config /absolute/gateway.json` and exports `RemoteAgentGateway` / `serveA2AGateway` from `@1agents/acp-service/a2a`. The gateway calls the standard A2A 1.0 SendMessage, GetTask and CancelTask APIs. It registers seven HTTP methods with the local DreamMate node; an existing `dreammate_invoke` client can use them immediately without another MCP server.

Create a private configuration file (`chmod 600`):

```json
{
  "stateDirectory": "/absolute/private/a2a-state",
  "port": 36814,
  "remotes": {
    "wsl-dsh": { "url": "http://your-tailnet-host:3080", "token": "protected-DSH-A2A-token" }
  },
  "callback": {
    "host": "your-local-tailnet-IP",
    "port": 36815,
    "url": "http://your-local-tailnet-IP:36815/a2a-events",
    "token": "separate-protected-callback-token"
  }
}
```

The callback is optional; configure its exact origin in DSH `a2a.pushNotificationOrigins`. The tool listener binds only `127.0.0.1`; the separate authenticated callback listener exposes only the configured event path. Browser Origin requests cannot invoke local tools. Credentials stay in configuration, outside prompts and tool parameters. Local DreamMate clients are trusted; `originSessionId` is a routing identifier, not a remote authentication credential.

Discover `a2a-gateway`, inspect `remote_agent_spawn`, then call it with:

```json
{
  "remote": "wsl-dsh",
  "originSessionId": "stable-parent-session-id",
  "cwd": "/home/scott/project",
  "agentPreset": "oneagents-acp-codex",
  "prompt": "Read the project README and report its purpose. Do not change files."
}
```

The returned `taskId` is available before execution finishes. `cwd` is an existing absolute path **on WSL**. Every spawn creates a new A2A context / DSH session even when cwd matches. `remote_agent_message` takes the previous task ID and prompt, creates a new task in the same context, and keeps that DSH session. `remote_agent_get` / `remote_agent_cancel` take `remote`, `originSessionId`, and `taskId`. `remote_agent_list` and `remote_agent_inbox` take only `originSessionId`; after handling a notice, confirm it with `remote_agent_ack` and its `noticeId`.

CLI callers use the same methods: pipe a JSON parameters object to `acp-service a2a invoke remote_agent_spawn` (or any method above). The gateway runs independently of the caller. A durable inbox, stable notice IDs, restart reconciliation and GetTask polling recover completions when a push event is missed. Offline queries return the cached task with `stale: true`; loss of connectivity never becomes a fabricated task failure. An ambiguous failed SendMessage is not automatically resubmitted, since A2A message IDs alone do not guarantee exactly-once task admission.

To wake a main-agent host, configure `notificationTargets` as a map of trusted target names to `{ "url": "...", "token": "..." }` and pass a target name as `notificationTarget` to spawn. Completion or input-required notices carry `originSessionId`, `taskId`, `contextId`, state and result. Deliveries use bearer authentication and a stable `Idempotency-Key`, retry after a failed response or gateway restart, and remain in the inbox until acknowledged. The receiving host must persist/deduplicate the notice and inject it into the named parent session (for example Phonetic's `async_task_notice`). A successful HTTP response means the receiver accepted the notice, not that the main model ran. Codex's ordinary MCP tool connection alone does not implement that host adapter; this gateway does not claim automatic Codex turn wake-up.
