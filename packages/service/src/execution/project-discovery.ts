/** Optional, metadata-only project role discovery. Never registers targets or starts agent work. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { roleSkillProfileSchema } from '../roles/skills.js';

const absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes('\0'), 'Expected an absolute local path');
export const projectDiscoveryConfigSchema = z.object({
  readerExecutable: z.string().min(1).max(4096).refine(value => !value.includes('\0')).default('1session'),
  allowedRoots: z.array(absolute).min(1).max(100), explicitRoots: z.array(absolute).max(1000).default([]),
  timeoutMs: z.number().int().min(100).max(120_000).default(15_000),
  maxProjects: z.number().int().min(1).max(1000).default(200),
}).strict();
const interval = z.number().int().min(60_000).max(86_400_000);
const settingsSchema = z.object({
  mode: z.enum(['manual', 'interval']),
  intervalMs: interval.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'interval' && value.intervalMs === undefined) {
    ctx.addIssue({ code: 'custom', message: 'intervalMs is required in interval mode', path: ['intervalMs'] });
  }
});
const empty = z.object({}).strict();
export const DISCOVERY_METHODS = {
  execution_project_scan: { description: '只读探查批准目录及可选 Session Reader 项目中的 .1agents 角色声明；不创建目标或任务。', parameters: z.toJSONSchema(empty) },
  execution_project_list: { description: '读取项目角色候选缓存，不执行扫描或模型。', parameters: z.toJSONSchema(empty) },
  execution_discovery_config_get: { description: '读取项目探查的手动/周期设置，不执行扫描。', parameters: z.toJSONSchema(empty) },
  execution_discovery_config_update: { description: '更新手动/周期探查设置；周期模式需显式指定 intervalMs，不唤醒主会话。', parameters: z.toJSONSchema(settingsSchema) },
};
const candidateSchema = z.object({ key: z.string(), projectRoot: absolute, roleDirectory: absolute, profilePath: absolute,
  roleId: z.string().optional(), roleVersion: z.string().optional(),
  skillRefs: z.array(z.object({ key: z.string(), name: z.string() }).strict()).optional(),
  status: z.enum(['candidate', 'invalid', 'missing', 'stale']), reasonCode: z.string().optional(), lastSeenAt: z.string().optional(),
}).strict();
const diagnosticSchema = z.object({ code: z.string(), path: z.string().optional() }).strict();
const snapshotSchema = z.object({ status: z.enum(['idle', 'complete', 'partial', 'error']), scannedAt: z.string().optional(),
  candidates: z.array(candidateSchema).max(20_000), diagnostics: z.array(diagnosticSchema).max(2000),
}).strict();
const stateSchema = z.object({ version: z.literal(1), config: settingsSchema, snapshot: snapshotSchema }).strict();
type State = z.output<typeof stateSchema>;
type Candidate = z.output<typeof candidateSchema>;
type Diagnostic = z.output<typeof diagnosticSchema>;
const within = (root: string, value: string): boolean => {
  const relative = path.relative(root, value);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const candidateKey = (root: string, roleId: string): string => createHash('sha256').update(JSON.stringify([root, roleId])).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const readerPageSchema = z.object({ projects: z.array(z.object({ workspace: absolute,
  workspaces: z.array(absolute).max(1000).optional(),
}).passthrough()).max(1000), hasMore: z.boolean(), nextPage: z.number().int().positive().optional() }).passthrough();

export class ProjectRoleDiscovery {
  private readonly file: string;
  private readonly config: z.output<typeof projectDiscoveryConfigSchema>;
  private state: State;
  private started = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<unknown>;
  private controller?: AbortController;

  constructor(options: { stateDirectory: string; config: z.input<typeof projectDiscoveryConfigSchema> }) {
    if (!path.isAbsolute(options.stateDirectory)) throw new Error('Discovery stateDirectory must be absolute');
    this.config = projectDiscoveryConfigSchema.parse(options.config);
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    this.file = path.join(realpathSync(options.stateDirectory), 'discovery.json');
    try {
      const info = lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Invalid discovery state file');
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load discovery state');
      this.state = { version: 1, config: { mode: 'manual' }, snapshot: { status: 'idle', candidates: [], diagnostics: [] } };
    }
  }

  private commit(next: State): void {
    stateSchema.parse(next);
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('Discovery snapshot exceeds byte limit');
    const temporary = `${this.file}.${randomUUID()}.tmp`, descriptor = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, this.file);
      const directory = openSync(path.dirname(this.file), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.state = next;
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  }
  private view(): unknown { return clone({ config: this.state.config, snapshot: this.state.snapshot }); }
  start(): void { if (!this.closed) { this.started = true; this.schedule(); } }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.closed || this.state.config.mode !== 'interval') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Scans write their own diagnostic snapshot. Persistence failures must also stay contained.
      void this.scan().catch(() => {}).finally(() => this.schedule());
    }, this.state.config.intervalMs!);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.active?.catch(() => {});
  }
  async invoke(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Project discovery is closed');
    if (method === 'execution_discovery_config_update') {
      const config = settingsSchema.parse(params);
      this.commit({ ...this.state, config }); this.schedule();
      return clone(config);
    }
    empty.parse(params);
    if (method === 'execution_discovery_config_get') return clone(this.state.config);
    if (method === 'execution_project_list') return this.view();
    if (method === 'execution_project_scan') return this.scan();
    throw new Error('Unknown project discovery method');
  }
  private scan(): Promise<unknown> {
    if (this.active) return this.active;
    if (this.closed) return Promise.reject(new Error('Project discovery is closed'));
    this.controller = new AbortController();
    this.active = this.collect(this.controller.signal).finally(() => { this.active = undefined; this.controller = undefined; });
    return this.active;
  }
  private async reader(scope: string, page: number, limit: number, timeoutMs: number, signal: AbortSignal): Promise<z.output<typeof readerPageSchema>> {
    const stdout = await new Promise<string>((resolve, reject) => {
      // execFile forwards its timeout killSignal, but some Node versions use SIGTERM for AbortSignal.
      // Explicitly kill the configured Reader on close, including Readers that ignore SIGTERM.
      const abort = () => { child.kill('SIGKILL'); };
      const child = execFile(this.config.readerExecutable, ['projects', '--scope', scope, '--page', String(page), '--limit', String(limit), '--json'],
        { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false, killSignal: 'SIGKILL' },
        (error, output) => {
          signal.removeEventListener('abort', abort);
          if (error) reject(new Error(signal.aborted ? 'reader_cancelled' : 'reader_failed')); else resolve(output);
        });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return readerPageSchema.parse(JSON.parse(stdout)); }
    catch { throw new Error('reader_invalid_output'); }
  }

  private async collect(signal: AbortSignal): Promise<unknown> {
    const diagnostics: Diagnostic[] = [], candidates = new Map<string, Candidate>(), now = new Date().toISOString();
    let diagnosticBytes = 0;
    const note = (code: string, value?: string) => {
      const item = { code, ...(value ? { path: value } : {}) }, bytes = Buffer.byteLength(JSON.stringify(item));
      if (diagnostics.length < 2000 && diagnosticBytes + bytes < 64 * 1024) { diagnostics.push(item); diagnosticBytes += bytes; }
    };
    const roots: string[] = [], paths = new Set<string>();
    let partial = false, readerSucceeded = false, projectCount = 0;
    for (const configured of this.config.allowedRoots) {
      try { const root = await realpath(configured); if (!(await lstat(root)).isDirectory()) throw new Error(); roots.push(root); paths.add(root); }
      catch { note('allowed_root_missing', configured); partial = true; }
    }
    const allowed = (value: string) => roots.some(root => within(root, value));
    for (const explicit of this.config.explicitRoots) paths.add(explicit);
    const readerDeadline = Date.now() + this.config.timeoutMs;
    const scopes = [...new Set(roots)];
    for (const [scopeIndex, scope] of scopes.entries()) {
      let page = 1;
      while (!signal.aborted && projectCount < this.config.maxProjects) {
        const remaining = readerDeadline - Date.now();
        if (remaining <= 0) { note('reader_timeout', scope); partial = true; break; }
        try {
          const limit = Math.min(50, this.config.maxProjects - projectCount);
          const result = await this.reader(scope, page, limit, remaining, signal);
          if (result.projects.length > limit) throw new Error('reader_invalid_output');
          readerSucceeded = true;
          projectCount += result.projects.length;
          for (const project of result.projects) for (const value of [project.workspace, ...project.workspaces ?? []]) {
            if (paths.size < this.config.maxProjects * 10 + this.config.explicitRoots.length + roots.length) paths.add(value);
            else { note('candidate_limit'); partial = true; }
          }
          if (!result.hasMore) break;
          if (!result.projects.length || (result.nextPage !== undefined && result.nextPage !== page + 1)) throw new Error('reader_invalid_pagination');
          if (projectCount >= this.config.maxProjects) { note('project_limit'); partial = true; break; }
          page++;
        } catch (error) {
          note((error as Error).message.startsWith('reader_') ? (error as Error).message : 'reader_failed', scope);
          partial = true; break;
        }
      }
      if (projectCount >= this.config.maxProjects) {
        if (scopeIndex < scopes.length - 1) { note('project_limit'); partial = true; }
        break;
      }
    }
    const visited = new Set<string>(), roleBudget = { count: 0, bytes: 0, limited: false };
    directories: for (const candidate of paths) {
      if (signal.aborted) break;
      // Native sessions can start inside runtime jobs; never traverse role caches as projects.
      const segments = path.resolve(candidate).split(path.sep), internal = segments.indexOf('.1agents');
      const base = internal < 0 ? candidate : segments.slice(0, internal).join(path.sep) || path.sep;
      let current: string;
      try {
        current = await realpath(base);
        // A plain alias can resolve into a cache/job even when its lexical path has no .1agents.
        const canonicalSegments = current.split(path.sep), canonicalInternal = canonicalSegments.indexOf('.1agents');
        if (canonicalInternal >= 0) current = canonicalSegments.slice(0, canonicalInternal).join(path.sep) || path.sep;
        if (!(await lstat(current)).isDirectory()) throw new Error();
      }
      catch { note('project_missing', base); continue; }
      if (!allowed(current)) { note('outside_allowed_roots', base); continue; }
      for (let depth = 0; depth < 32 && allowed(current) && !signal.aborted; depth++) {
        if (!visited.has(current)) {
          if (visited.size >= 20_000) { note('directory_limit'); partial = true; break directories; }
          visited.add(current);
          try { await this.readRoles(current, candidates, now, signal, roleBudget); }
          catch (error) {
            const code = (error as Error).message, exhausted = code === 'candidate_limit' || code === 'snapshot_limit';
            note(exhausted ? code : 'role_directory_unreadable', current); partial = true;
            if (exhausted) break directories;
          }
        }
        const parent = path.dirname(current);
        if (parent === current || !allowed(parent)) break;
        if (depth === 31) { note('ancestor_limit', current); partial = true; }
        current = parent;
      }
    }
    if (signal.aborted) { note('scan_cancelled'); partial = true; }
    // Bound complete snapshots too: individually valid large profiles can exceed a safe cache size.
    const retained = new Map<string, Candidate>();
    const size = (candidate: Candidate) => Buffer.byteLength(JSON.stringify(candidate)) + 1;
    let candidateBytes = 0;
    for (const old of this.state.snapshot.candidates) {
      const value: Candidate = { ...old, status: partial ? 'stale' : 'missing', reasonCode: partial ? 'scan_incomplete' : 'not_observed' };
      retained.set(old.key, value); candidateBytes += size(value);
    }
    let limited = roleBudget.limited || candidateBytes > 8 * 1024 * 1024;
    for (const [key, value] of candidates) {
      const old = retained.get(key), nextBytes = candidateBytes + size(value) - (old ? size(old) : 0);
      if ((!old && retained.size >= 20_000) || nextBytes > 8 * 1024 * 1024) {
        limited = true;
        continue;
      }
      retained.set(key, value); candidateBytes = nextBytes;
    }
    if (limited) {
      note('snapshot_limit'); partial = true;
      // On overflow keep the complete prior evidence, rather than evicting older candidates.
      if (this.state.snapshot.candidates.length) {
        retained.clear();
        for (const old of this.state.snapshot.candidates) retained.set(old.key, { ...old, status: 'stale' });
      }
    }
    if (partial && !limited) for (const [key, value] of retained) if (!candidates.has(key))
      retained.set(key, { ...value, status: 'stale', reasonCode: 'scan_incomplete' });
    const snapshot: State['snapshot'] = { scannedAt: now,
      status: partial ? (readerSucceeded || retained.size || visited.size ? 'partial' : 'error') : 'complete',
      candidates: [...retained.values()].sort((a, b) => a.projectRoot.localeCompare(b.projectRoot) || a.profilePath.localeCompare(b.profilePath)), diagnostics };
    this.commit({ ...this.state, snapshot });
    return this.view();
  }

  private async readRoles(projectRoot: string, result: Map<string, Candidate>, now: string, signal: AbortSignal, budget: { count: number; bytes: number; limited: boolean }): Promise<void> {
    const agentDirectory = path.join(projectRoot, '.1agents'), roles = path.join(agentDirectory, 'roles');
    for (const directory of [agentDirectory, roles]) {
      let info;
      try { info = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (info.isSymbolicLink() || !info.isDirectory() || !within(projectRoot, await realpath(directory))) throw new Error('Unsafe role directory');
    }
    const entries = await readdir(roles, { withFileTypes: true });
    if (entries.length > 1000) { budget.limited = true; throw new Error('candidate_limit'); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (signal.aborted) return;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (budget.count >= 10_000) { budget.limited = true; throw new Error('candidate_limit'); }
      budget.count++;
      const roleDirectory = path.join(roles, entry.name), profilePath = path.join(roleDirectory, 'profile.json');
      const base: Candidate = { key: candidateKey(projectRoot, entry.name), projectRoot, roleDirectory, profilePath, status: 'invalid', lastSeenAt: now };
      let candidate = base;
      try {
        if (entry.isSymbolicLink() || !(await lstat(roleDirectory)).isDirectory() || !within(projectRoot, await realpath(roleDirectory))) throw new Error('unsafe_role_path');
        const handle = await open(profilePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let profile;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 256 * 1024 || !within(projectRoot, await realpath(profilePath))) throw new Error('unsafe_profile');
          profile = roleSkillProfileSchema.parse(JSON.parse(await handle.readFile('utf8')));
        } finally { await handle.close(); }
        candidate = { ...base, key: candidateKey(projectRoot, profile.id), roleId: profile.id, roleVersion: profile.version,
          skillRefs: profile.skills.map(skill => ({ key: skill.key, name: skill.name })), status: 'candidate' };
      } catch (error) {
        candidate = { ...base, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid',
          reasonCode: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'profile_missing' : 'profile_invalid_or_unsafe' };
      }
      const existing = result.get(candidate.key);
      if (existing && existing.profilePath !== candidate.profilePath) candidate = { ...existing, status: 'invalid', reasonCode: 'duplicate_role_id' };
      const bytes = budget.bytes + Buffer.byteLength(JSON.stringify(candidate)) + 1 - (existing ? Buffer.byteLength(JSON.stringify(existing)) + 1 : 0);
      if (bytes > 8 * 1024 * 1024) { budget.limited = true; throw new Error('snapshot_limit'); }
      budget.bytes = bytes;
      result.set(candidate.key, candidate);
    }
  }
}
