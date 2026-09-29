# @1agents/acp-service

ACP Agent Runtime Service for Codex, Grok Build, Claude Code and other Agents supported by `@scottzx/1acp`. Version 0.2 uses **ACP v1 JSON-RPC 2.0 over WebSocket**. Each connection selects one Agent; each session keeps that Agent and its workspace when reconnected.

## Run

Requires Node.js 22.13 or later and `@scottzx/1acp ^0.15.1`. The runtime's per-session launch argv and transient credentials APIs are required by Provider Profiles. The npm registry currently contains only 0.14.0; publish 0.15.1 before a clean registry installation of this service. For local development before that release, build and pack `1agents_app/modules/1acp`, then run `npm install --no-save --package-lock=false /absolute/path/scottzx-1acp-0.15.1.tgz` in this service directory. This installs the actual package artifact without replacing the declared registry dependency with a machine-local path.

```sh
npm install
npm run build
node dist/bin/acp-service.js serve --host 127.0.0.1 --port 36812 --no-report
```

The default port is 36812. Without `--no-report`, the service reports to the local DreamMate node. Agent executables and their authentication must be available to the service process. `ACP_STATE_DIR` overrides the default `~/.1agents/acpx-state` directory for runtime records, turn journals and ACP replay data.

```ts
import { serveAcpService } from '@1agents/acp-service';
const service = await serveAcpService({ host: '127.0.0.1', port: 36812, report: false });
// Later: await service.close();
```

HTTP endpoints:

- `GET /health`: service health and active session/task counts.
- `GET /manifest`: DreamMate service discovery, ACP version, custom transport and Agent endpoint paths. Profiles listed here describe registered launch configurations, not a successful installation/authentication probe.
- `GET /services`: current service/session counts.

## ACP connections

Connect to `ws://127.0.0.1:36812/agents/codex`, `/agents/grok-build`, `/agents/claude`, or another registered Agent name. `/` selects Codex. Each WebSocket text message contains one UTF-8 JSON-RPC object. Batch messages and the former `action/event` envelopes are rejected. WebSocket is a custom transport permitted by ACP, not the standard stdio transport.

Initialize before sending session requests:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
```

Create a session using an absolute existing directory:

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/absolute/project","mcpServers":[]}}
```

Use the **returned service session ID** for subsequent requests. Native Agent IDs are distinct and may appear in `_meta["1agents"].agentSessionId`; they must not replace the service ID.

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"returned-session-id","prompt":[{"type":"text","text":"Explain this project"}]}}
```

Output arrives as `session/update` notifications. The prompt request receives its response only when the turn settles, with a standard `stopReason`. Runtime failures return JSON-RPC errors. `session/cancel` is a notification; cancellation settles the original prompt request.

| Method | Behavior |
| --- | --- |
| `session/new` | Creates a new persistent session with a server-generated ID. |
| `session/load` | Attaches an existing session and replays its complete recorded ACP conversation before responding. |
| `session/resume` | Attaches without replaying conversation history. |
| `session/prompt` | Runs a turn; ordinary overlapping prompts are rejected as busy. |
| `session/cancel` | Cancels the current turn; has no RPC response. |
| `session/close` | Cancels work and releases live resources while retaining persistent history. |
| `session/list` | Lists this endpoint's bound, resumable sessions, optionally filtered by cwd. Returns the complete list without a next cursor. |
| `session/delete` | Closes live resources and tombstones the service session so it cannot be resumed or listed. Runtime history retention follows the runtime's deletion behavior. |
| `session/set_mode` | Selects an advertised native Agent mode. |
| `session/set_config_option` | Changes an advertised native option and returns the resulting configuration options. |
| `session/request_permission` | Server-to-client request; the client returns an advertised option ID or a cancelled outcome. |

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

| Extension | Purpose |
| --- | --- |
| `_1agents/session/import` | Explicitly resumes a pre-migration native session ID and returns a new service session ID. |
| `_1agents/session/history` | Returns the runtime/native history projection used by existing chat views. |
| `_1agents/session/permission_mode` | Changes the service permission policy, independently of native Agent mode. |
| `_1agents/session/cancel_queued` | Cancels a queued managed request by its durable request ID. |
| `_1agents/session/fork` | Uses the runtime's optional fork capability. Imported/forked native history is not advertised as complete ACP replay. |
| `_1agents/session/authenticate`, `_1agents/session/logout` | Native session authentication controls. |
| `_1agents/sessions/close_all` | Closes all managed sessions. |
| `_1agents/session/meta` | Notification containing native models, modes and other UI capabilities. |
| `_1agents/events/<name>` | Application notifications such as `turn_sync`, `turn_state`, `turn_terminal`, `history_response`, `session_taken_over`, background tasks and interaction timeouts. |
| `_x.ai/ask_user_question`, `_x.ai/exit_plan_mode` | Server-to-client requests preserving Grok-specific questionnaire/plan semantics. Clients answer with the corresponding JSON-RPC result. |

Nonstandard metadata is namespaced; standard `session/update` content is still available without knowing the application view fields. `responsePolicy: "summary"` suppresses incremental conversation output while preserving the replay log and live permission/questions. The final prompt response carries the summary in `_meta["1agents"]`, and opted-in clients receive `turn_complete`. Managed turn IDs, idempotency keys and queue state are application extensions, not replacements for JSON-RPC request IDs.

## Upgrade from 0.1

Upgrade the service and 1agents Go client together. Old `action/event` WebSocket clients are not supported by 0.2. The Go `internal/acpwire` client converts existing chat view messages to standard ACP and negotiated extensions; frontend view state can remain unchanged. It stores the returned service session ID for future reconnects and explicitly imports older native IDs when needed.

The npm `@1agents/acp-bridge` package is now a small launcher depending on `@1agents/acp-service ^0.2.0`. Release in order: `@scottzx/1acp 0.15.1`, `@1agents/acp-service 0.2.0`, then the dependent launcher. Install from the monorepo root with `pnpm install --frozen-lockfile`; the service uses `workspace:^` for the runtime, and pnpm converts it to a version range during packing. Development supervision locates `services/1acp/packages/service`; package filling must not overwrite the launcher with the former server implementation.

## Verify

```sh
npm run typecheck
npm test
```

Tests use the official ACP SDK over real WebSockets, cover session lifecycle and permission reconnects, and drive the installed 1acp runtime through a deterministic external stdio Agent. They require no model API key. Existing real-provider smoke tests in the 1agents backend remain opt-in.
