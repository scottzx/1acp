# 1ACP workspace

Two published packages share one repository and one pnpm lockfile. The upstream runtime remains a private workspace package and ships inside the service. Runtime and service remain reusable outside DSH; the DSH plugin communicates with the service through ACP JSON-RPC, while a managed child process loads the service when a local endpoint needs starting.

| Directory             | npm package            | Responsibility                                                               |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `packages/runtime`    | Private workspace only | Upstream agent runtime and CLI, embedded in the service                      |
| `packages/service`    | `@1agents/acp-service` | Local harness discovery, ACP JSON-RPC WebSocket service and session recovery |
| `packages/dsh-plugin` | `@1agents/dsh-acp`     | DSH session presets, native commands, model selection and interactions       |

## Development

Use Node 24 and the pnpm version pinned in package.json. Install from this root; package-level npm lockfiles are replaced by the root pnpm lockfile.

```sh
pnpm install --frozen-lockfile
# DSH must already be installed and built, matching the plugin's supported API.
pnpm link:dsh /absolute/path/DSH
pnpm build
pnpm test:integration
# Includes the full runtime test suite:
pnpm test
```

Build runtime before service; the service build embeds its compiled output, skills and license. Consumers can import `@1agents/acp-service/runtime`, `@1agents/acp-service/flows` and `@1agents/acp-service/agent-registry`, or use the unified `acp-service` CLI. The DSH development links supply types only; the Host provides those services at runtime.

```sh
# Run from the DSH checkout; the plugin starts or reuses its local service:
pnpm dsh plugin --profile web add /absolute/path/1acp/packages/dsh-plugin
pnpm dsh web --no-open
```

Agent binaries, authentication, service state and DSH session bindings remain outside this repository. Moving the checkout does not migrate or delete session data.

## Package releases

Publish `@1agents/acp-service` before `@1agents/dsh-acp`. The runtime is private and is never packed or published separately. The service includes the runtime and its dependencies; the plugin uses `workspace:^`, which pnpm converts to the service's current version range when packing.

Push CI builds and packs each release package once. Runtime integration tests run in four disjoint lanes; the remaining tests, viewer test, coverage gate and Python Autoreview suite run independently. Fixed-ref DSH build outputs are cached by ref, lockfile, OS, architecture and Node version. CI also installs the service tarball outside the workspace to verify its CLI, public runtime exports and service startup.

Run the root **Release** workflow on `main`, selecting `all`, `service` or `dsh-plugin`. It locates successful push CI for the exact release commit, waits if that CI is still running, and downloads its existing tarballs. An optional `ci_run_id` pins the source run; SHA, repository, workflow, branch and success are verified. No build or test runs during Release. If no matching successful CI exists or its artifacts have expired, run CI first.

Release checks artifact SHA/checksums, manifests, dependencies and the embedded runtime before publishing via `NPM_TOKEN`. A plugin-only release also compares the published service contents with the service tarball from that CI run. Retry Release on the same commit after a publish or registry error: it reuses the CI tarballs and skips already published versions only after verifying their complete contents. Registry propagation retries are bounded to eight attempts with five-second intervals, rather than a fifteen-minute polling loop. Changed published contents require a version bump.

## Repository migration

This repository preserves the original runtime history and merges the complete service and plugin histories without squashing. `git log --all` includes their original commits. The canonical checkout is `services/1acp`; the former service/plugin checkouts are local backups only.

`1agents_app/modules/1acp` remains a pinned consumer submodule of this repository. Its runtime is now under `packages/runtime`; package build tooling and adapter discovery use that path. Push this repository's referenced commit before sharing the updated consumer submodule pointer.

See each package README for its protocol, configuration and usage details.
