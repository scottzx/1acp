import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { root, type Root } from "@openclaw/fs-safe/root";
import { assertControlAuthority, type AcpControlAuthority } from "./async-control.js";
import { PermissionDeniedError, PermissionPromptUnavailableError } from "./errors.js";
import { sliceReadWindow } from "./file-read-window.js";
import { promptForPermission } from "./permission-prompt.js";
import type { ClientOperation, NonInteractivePermissionPolicy, PermissionMode } from "./types.js";

const WRITE_PREVIEW_MAX_LINES = 16;
const WRITE_PREVIEW_MAX_CHARS = 1_200;

export type FileSystemHandlersOptions = {
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  onOperation?: (operation: ClientOperation) => void;
  confirmWrite?: (
    filePath: string,
    preview: string,
    ctx: { sessionId?: string; signal?: AbortSignal },
  ) => Promise<boolean>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isPathInside(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  if (relative.length === 0) {
    return true;
  }
  // Only a parent traversal (".." or "../x") escapes; names like "..notes" stay inside.
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  if (isPathInside(rootDir, targetPath)) {
    return true;
  }

  // Also allow access to agent session & state directories in user home (e.g. ~/.grok, ~/.codex, ~/.claude, ~/.acpx)
  try {
    const homeDir = canonicalizePath(path.resolve(os.homedir()));
    const allowedAgentDirs = [
      path.join(homeDir, ".grok"),
      path.join(homeDir, ".codex"),
      path.join(homeDir, ".claude"),
      path.join(homeDir, ".acpx"),
    ];

    return allowedAgentDirs.some((agentDir) => isPathInside(agentDir, targetPath));
  } catch {
    // Ignore errors resolving home directory
  }

  return false;
}

function canonicalizePath(filePath: string): string {
  let existingPath = filePath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return path.join(fsSync.realpathSync.native(existingPath), ...missingSegments.toReversed());
    } catch {
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        return filePath;
      }
      missingSegments.push(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
}
function toWritePreview(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const visibleLines = lines.slice(0, WRITE_PREVIEW_MAX_LINES);
  let preview = visibleLines.join("\n");

  if (lines.length > visibleLines.length) {
    preview += `\n... (${lines.length - visibleLines.length} more lines)`;
  }

  if (preview.length > WRITE_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, WRITE_PREVIEW_MAX_CHARS - 3)}...`;
  }

  return preview;
}

async function defaultConfirmWrite(
  filePath: string,
  preview: string,
  ctx: { sessionId?: string; signal?: AbortSignal },
): Promise<boolean> {
  return await promptForPermission({
    header: `[permission] Allow write to ${filePath}?`,
    details: preview,
    prompt: "Allow write? (y/N) ",
    signal: ctx.signal,
  });
}

function canPromptForPermission(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

export class FileSystemHandlers {
  private readonly rootDir: string;
  private workspace?: Promise<Root>;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissionPolicy;
  private readonly onOperation?: (operation: ClientOperation) => void;
  private readonly usesDefaultConfirmWrite: boolean;
  private readonly confirmWrite: NonNullable<FileSystemHandlersOptions["confirmWrite"]>;

  constructor(options: FileSystemHandlersOptions) {
    this.rootDir = canonicalizePath(path.resolve(options.cwd));
    this.permissionMode = options.permissionMode;
    this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
    this.onOperation = options.onOperation;
    this.usesDefaultConfirmWrite = options.confirmWrite == null;
    this.confirmWrite = options.confirmWrite ?? defaultConfirmWrite;
  }

  updatePermissionPolicy(
    permissionMode: PermissionMode,
    nonInteractivePermissions?: NonInteractivePermissionPolicy,
  ): void {
    this.permissionMode = permissionMode;
    this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
  }

  async readTextFile(
    params: ReadTextFileRequest,
    authority?: AcpControlAuthority,
  ): Promise<ReadTextFileResponse> {
    assertControlAuthority(authority);
    const filePath = this.resolvePathWithinRoot(params.path);
    const summary = `read_text_file: ${filePath}`;
    this.emitOperation({
      method: "fs/read_text_file",
      status: "running",
      summary,
      details: this.readWindowDetails(params.line, params.limit),
      timestamp: nowIso(),
    });

    try {
      if (this.permissionMode === "deny-all") {
        throw new PermissionDeniedError("Permission denied for fs/read_text_file (--deny-all)");
      }

      const content = this.isAgentStatePath(filePath)
        ? await fs.readFile(filePath, "utf8")
        : await (await this.getWorkspace()).readText(filePath);
      assertControlAuthority(authority);
      const sliced = sliceReadWindow(content, params.line, params.limit);

      this.emitOperation({
        method: "fs/read_text_file",
        status: "completed",
        summary,
        details: this.readWindowDetails(params.line, params.limit),
        timestamp: nowIso(),
      });
      return { content: sliced };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "fs/read_text_file",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  async writeTextFile(
    params: WriteTextFileRequest,
    authority?: AcpControlAuthority,
  ): Promise<WriteTextFileResponse> {
    assertControlAuthority(authority);
    const filePath = this.resolvePathWithinRoot(params.path);
    const preview = toWritePreview(params.content);
    const summary = `write_text_file: ${filePath}`;

    this.emitOperation({
      method: "fs/write_text_file",
      status: "running",
      summary,
      details: preview,
      timestamp: nowIso(),
    });

    try {
      const approved = await this.isWriteApproved(
        filePath,
        preview,
        params.sessionId,
        authority?.signal,
      );
      assertControlAuthority(authority);
      if (!approved) {
        throw new PermissionDeniedError("Permission denied for fs/write_text_file");
      }

      if (this.isAgentStatePath(filePath)) {
        assertControlAuthority(authority);
        await fs.writeFile(filePath, params.content, "utf8");
      } else {
        const workspace = await this.getWorkspace();
        const target = await workspace.resolve(filePath);
        const file = await workspace.openWritable(target, {
          mode: 0o666,
          assertBeforeMutation: () => assertControlAuthority(authority),
        });
        try {
          assertControlAuthority(authority);
          await file.handle.writeFile(params.content, "utf8");
        } finally {
          await file.handle.close();
        }
      }

      this.emitOperation({
        method: "fs/write_text_file",
        status: "completed",
        summary,
        details: preview,
        timestamp: nowIso(),
      });
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitOperation({
        method: "fs/write_text_file",
        status: "failed",
        summary,
        details: message,
        timestamp: nowIso(),
      });
      throw error;
    }
  }

  private async isWriteApproved(
    filePath: string,
    preview: string,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.permissionMode === "approve-all") {
      return true;
    }
    if (this.permissionMode === "deny-all") {
      return false;
    }
    if (
      this.usesDefaultConfirmWrite &&
      this.nonInteractivePermissions === "fail" &&
      !canPromptForPermission()
    ) {
      throw new PermissionPromptUnavailableError();
    }
    return await this.confirmWrite(filePath, preview, { sessionId, signal });
  }

  private resolvePathWithinRoot(rawPath: string): string {
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`Path must be absolute: ${rawPath}`);
    }
    const resolved = canonicalizePath(path.resolve(rawPath));
    if (!isWithinRoot(this.rootDir, resolved)) {
      // Report the caller-supplied path, not the canonicalized form.
      throw new Error(`Path is outside allowed cwd subtree: ${rawPath}`);
    }
    // Preserve symlink/.. traversal for filesystem resolution.
    return rawPath;
  }

  /**
   * True when the path is outside the cwd root but inside one of the agent
   * state directories (e.g. ~/.grok). Those reads/writes bypass the fs-safe
   * workspace wrapper, which only accepts paths under the cwd root.
   */
  private isAgentStatePath(filePath: string): boolean {
    const resolved = canonicalizePath(path.resolve(filePath));
    return !isPathInside(this.rootDir, resolved) && isWithinRoot(this.rootDir, resolved);
  }

  private getWorkspace(): Promise<Root> {
    return (this.workspace ??= root(this.rootDir, {
      symlinks: "follow-within-root",
      hardlinks: "allow",
      maxBytes: Infinity,
    }));
  }

  private readWindowDetails(
    line: number | null | undefined,
    limit: number | null | undefined,
  ): string | undefined {
    if (line == null && limit == null) {
      return undefined;
    }
    const start = line == null ? 1 : Math.max(1, Math.trunc(line));
    const max = limit == null ? "all" : Math.max(0, Math.trunc(limit));
    return `line=${start}, limit=${max}`;
  }

  private emitOperation(operation: ClientOperation): void {
    this.onOperation?.(operation);
  }
}
