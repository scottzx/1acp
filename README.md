# 1ACP workspace

Three independently versioned packages share one repository and one pnpm lockfile. Runtime and service remain reusable outside DSH; the DSH plugin communicates with the service through ACP JSON-RPC, without importing its implementation.

| Directory | npm package | Responsibility |
| --- | --- | --- |
| `packages/runtime` | `@scottzx/1acp` | Agent runtime and CLI |
| `packages/service` | `@1agents/acp-service` | Local harness discovery, ACP JSON-RPC WebSocket service and session recovery |
| `packages/dsh-plugin` | `@1agents/dsh-acp` | DSH session presets, native commands, model selection and interactions |

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

The service resolves `@scottzx/1acp` directly from the workspace. Build runtime before service. The DSH development links supply types only; the Host provides those services at runtime.

```sh
pnpm start:service serve --host 127.0.0.1 --port 36812 --no-report
# Run from the DSH checkout:
pnpm dsh plugin --profile web add /absolute/path/1acp/packages/dsh-plugin
pnpm dsh web --no-open
```

Agent binaries, authentication, service state and DSH session bindings remain outside this repository. Moving the checkout does not migrate or delete session data.

## Package releases

Package names and versions remain independent. Use `pnpm --filter <package-name> pack` or `pnpm --filter <package-name> publish`; pnpm converts the service's `workspace:^` dependency into the runtime's version range. Publish a required runtime version before the service that depends on it. The DSH plugin is public and declares the DSH bundle installation metadata.

The former single-package workflows are retained inside their package directories as historical references and are not active GitHub workflows. Root CI validates the runtime, service and DSH plugin. The former package-local Husky hook is not installed at the workspace root; run the documented checks before committing. The root Release workflow publishes the validated tarballs using the repository’s `NPM_TOKEN` secret; it accepts one package or the complete dependency chain. Versions come from each package manifest. A retry skips an already published version only when its tarball integrity matches; changed contents require a version bump.

## Repository migration

This repository preserves the original runtime history and merges the complete service and plugin histories without squashing. `git log --all` includes their original commits. The canonical checkout is `services/1acp`; the former service/plugin checkouts are local backups only.

`1agents_app/modules/1acp` remains a pinned consumer submodule of this repository. Its runtime is now under `packages/runtime`; package build tooling and adapter discovery use that path. Push this repository's referenced commit before sharing the updated consumer submodule pointer.

See each package README for its protocol, configuration and usage details.
