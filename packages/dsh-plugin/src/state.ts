/** Plugin-owned identities. DSH session files are never rewritten. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export interface NativeImport {
  provider: string;
  nativeSessionId: string;
  /** Imported user messages must never be sent as fresh prompts. */
  messageIds: string[];
}
export interface Binding {
  agent: string; cwd: string; endpoint: string; sessionId: string;
  /** Absent on bindings created before native imports were supported. */
  restoreMethod?: 'session/load' | 'session/resume';
  imported?: NativeImport;
}
export class State {
  constructor(readonly directory: string) {}
  private path(id: string) { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json'); }
  get(id: string): Binding | undefined {
    try { return decodeBinding(JSON.parse(readFileSync(this.path(id), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  save(id: string, binding: Binding): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id), temp = path + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  }
}

/** Validate plugin-owned JSON while accepting legacy bindings without an explicit restore method. */
function decodeBinding(value: unknown): Binding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ACP binding');
  const binding = value as Record<string, unknown>;
  if (['agent', 'cwd', 'endpoint', 'sessionId'].some(key => typeof binding[key] !== 'string' || !binding[key])) throw new Error('Invalid ACP binding identity');
  if (binding.restoreMethod !== undefined && binding.restoreMethod !== 'session/load' && binding.restoreMethod !== 'session/resume') throw new Error('Invalid ACP restore method');
  if (binding.imported !== undefined) {
    if (!binding.imported || typeof binding.imported !== 'object' || Array.isArray(binding.imported)) throw new Error('Invalid ACP native import');
    const imported = binding.imported as Record<string, unknown>;
    if (typeof imported.provider !== 'string' || typeof imported.nativeSessionId !== 'string'
      || !Array.isArray(imported.messageIds) || !imported.messageIds.every(id => typeof id === 'string')
      || binding.restoreMethod !== 'session/resume') throw new Error('Invalid ACP native import');
  }
  return value as Binding;
}
