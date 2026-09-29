/** Plugin-owned identities. DSH session files are never rewritten. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export interface Binding { agent: string; cwd: string; endpoint: string; sessionId: string }
export class State {
  constructor(readonly directory: string) {}
  private path(id: string) { return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json'); }
  get(id: string): Binding | undefined {
    try { return JSON.parse(readFileSync(this.path(id), 'utf8')) as Binding; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  save(id: string, binding: Binding): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id), temp = path + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  }
}
