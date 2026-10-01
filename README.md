# 1ACP workspace

One published package, `@1agents/acp-service`, contains the runtime, CLI, service and DSH plugin. The upstream runtime and DSH plugin remain private source modules in one repository with one pnpm lockfile. Runtime and service remain reusable outside DSH; the DSH plugin communicates with the service through ACP JSON-RPC, while a managed child process loads the service when a local endpoint needs starting.

| Directory             | npm package            | Responsibility                                                               |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `packages/runtime`    | Private workspace only | Upstream agent runtime and CLI, embedded in the service                      |
| `packages/service`    | `@1agents/acp-service` | Local harness discovery, ACP JSON-RPC WebSocket service and session recovery |
| `packages/dsh-plugin` | private source module | DSH session presets, native commands, model selection and interactions       |

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

Build runtime, then service, then the private DSH source module; `pnpm build` also embeds the DSH host entry, browser bundle and patch into the service. Consumers can import `@1agents/acp-service/runtime`, `@1agents/acp-service/flows` and `@1agents/acp-service/agent-registry`, or use the unified `acp-service` CLI. The DSH development links supply types only; the Host provides those services at runtime.

```sh
# Run from the DSH checkout; the plugin starts or reuses its local service:
pnpm dsh plugin --profile web add /absolute/path/1acp/packages/service
pnpm dsh web --no-open
```

Agent binaries, authentication, service state and DSH session bindings remain outside this repository. Moving the checkout does not migrate or delete session data.

## Package releases

Only `@1agents/acp-service` is published. Version 0.5 includes the runtime, CLI, service and DSH plugin in one tarball. Runtime and DSH source modules stay private; there is one public version to bump and one package to publish.

```sh
# Ordinary CLI installation:
npm install -g @1agents/acp-service
acp-service --help
# DSH installation (run from its checkout):
pnpm dsh plugin --profile web add @1agents/acp-service
```

The CLI uses the package's `bin`; DSH selects its `dsh.bundle.patch` and activates the package-root Cordis entry. The root preserves service API exports and lazily loads plugin code when DSH invokes `apply`. DSH scans only package-root rows for browser metadata, so the patch deliberately loads the root, rather than `/dsh`. `/service` offers the service API; `/dsh`, `/dsh/preset` and `/dsh/imports` offer typed plugin APIs. Installing the package does not start a service or require DSH dependencies.

Push CI builds each source module once and packs the unified release package once, after service and plugin checks. Runtime integration tests run in four disjoint lanes; remaining tests, viewer, coverage and Python Autoreview run independently. Fixed-ref DSH build outputs are cached by ref, lockfile, OS, architecture and Node version. CI installs the tarball outside the workspace and verifies the CLI, runtime flows and service, then uses the real DSH profile reader, Cordis Loader and client registry to check plugin startup, browser discovery and cleanup.

Run the root **Release** workflow on `main`. It locates successful push CI for the exact commit, waits if that CI is running, and downloads its single existing tarball. The optional `ci_run_id` pins the source run; SHA, repository, workflow, branch and success are verified. Release performs no install, build or test. If matching CI is absent or artifacts have expired, run CI first.

Release checks artifact SHA/checksum, manifests, dependencies, runtime and DSH entrypoints, then publishes via `NPM_TOKEN`. Retry Release on the same commit after a publish or registry error: it reuses the CI tarball and skips an already published version only after verifying its contents and permissions. Registry propagation retries are bounded to eight attempts with five-second intervals. Changed published contents require a version bump.

For local packaging, build first, then run `pnpm run pack` from this root. Packing checks existing outputs and never rebuilds them. To verify the resulting package:

```sh
node scripts/smoke-service-package.mjs release/1agents-acp-service-0.5.0.tgz /absolute/path/DSH
```

### Migrate a DSH profile

The former `@1agents/dsh-acp` package stops receiving independent releases. With DSH stopped, remove the old bundle before installing the unified one:

```sh
pnpm dsh plugin --profile web remove @1agents/dsh-acp
pnpm dsh plugin --profile web add @1agents/acp-service
```

Restart DSH after migration. Plugin IDs, preset IDs, binding paths and service state remain the same; existing sessions retain their identity. Update any custom plugin rows from `@1agents/dsh-acp` to `@1agents/acp-service`, presets to `@1agents/acp-service/dsh/preset`, and native-session imports to `@1agents/acp-service/dsh/imports`. Do not enable both old and new bundles together. Preserve custom row configuration when replacing its package name.

## Repository migration

This repository preserves the original runtime history and merges the complete service and plugin histories without squashing. `git log --all` includes their original commits. The canonical checkout is `services/1acp`; the former service/plugin checkouts are local backups only.

`1agents_app/modules/1acp` remains a pinned consumer submodule of this repository. Its runtime is now under `packages/runtime`; package build tooling and adapter discovery use that path. Push this repository's referenced commit before sharing the updated consumer submodule pointer.

See each package README for its protocol, configuration and usage details.
