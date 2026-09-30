import fs from "node:fs";
import path from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { readWindowsEnvValue, resolveWindowsCommand } from "../spawn-command-options.js";

function basenameToken(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(cmd|exe|bat)$/u, "");
}

export function isCodexAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  if (commandToken === "codex-acp") {
    return true;
  }
  return args.some((arg) => arg.includes("codex-acp"));
}

function configuredCodexPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return platform === "win32" ? readWindowsEnvValue(env, "CODEX_PATH") : env.CODEX_PATH;
}

function resolvePosixCodexExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory.trim()) {
      continue;
    }
    const candidate = path.resolve(directory, "codex");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH for an executable Codex entrypoint.
    }
  }

  return undefined;
}

export function resolveCodexExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configuredCodexPath(platform, env)?.trim()) {
    return undefined;
  }

  if (platform === "win32") {
    return resolveWindowsCommand("codex", env);
  }
  return resolvePosixCodexExecutable(env);
}

export function isLegacyZedCodexAcpInvocation(agentCommand: string): boolean {
  return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}

export function preferCodexPermissionRefusal(
  request: RequestPermissionRequest,
  agentName: string | undefined,
): RequestPermissionRequest {
  if (agentName !== "@agentclientprotocol/codex-acp") {
    return request;
  }
  const preferred = request.options.find(
    (option) =>
      option.kind === "reject_once" && ["decline", "reject_permissions"].includes(option.optionId),
  );
  return preferred
    ? {
        ...request,
        options: [preferred, ...request.options.filter((option) => option !== preferred)],
      }
    : request;
}

export function codexPermissionNotice(
  request: RequestPermissionRequest,
  response: RequestPermissionResponse,
  agentName: string | undefined,
): string | undefined {
  if (agentName !== "@agentclientprotocol/codex-acp") {
    return undefined;
  }
  if (response.outcome.outcome === "cancelled") {
    return "No matching permission option was available. The request was safely cancelled; Codex may end the current turn.";
  }
  const selectedId = response.outcome.optionId;
  const option = request.options.find((option) => option.optionId === selectedId);
  return option?.kind === "reject_once" && selectedId === "cancel"
    ? "Permission refused using Codex's cancellation option; this can end the current turn. The operation was not approved."
    : undefined;
}
