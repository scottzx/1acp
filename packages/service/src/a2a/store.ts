import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Message, Role, Task, TaskPushNotificationConfig, TaskState } from '@a2a-js/sdk';
import {
  InMemoryTaskStore, resolveUserScope, ServerCallContext,
  type PushNotificationStore, type StoredPushNotificationConfig, type TaskStore,
} from '@a2a-js/sdk/server';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type { A2ATarget } from './types.js';

interface Scope { tenant: string; owner: string }
type Kind = 'task' | 'push' | 'target';
interface Envelope { version: 1; kind: Kind; scope: Scope; id: string; value: unknown }
interface CachedTask { scope: Scope; task: Task }
interface Lock { pid: number; token: string }

const terminalStates = new Set([
  TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED,
]);
const maxRecordSize = 32 * 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid A2A ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.includes('\0')) {
    throw new Error(`Invalid A2A ${label}: expected a${allowEmpty ? '' : ' non-empty'} string`);
  }
  return value;
}

function scopeOf(context: ServerCallContext): Scope {
  return { tenant: text(context.tenant ?? '', 'tenant', true), owner: text(resolveUserScope(context), 'owner') };
}

function key(scope: Scope, id: string): string {
  return JSON.stringify([scope.tenant, scope.owner, id]);
}

function fileName(kind: Kind, scope: Scope, id: string): string {
  const hash = createHash('sha256').update(JSON.stringify([kind, scope.tenant, scope.owner, id])).digest('hex');
  return `${kind}-${hash}.json`;
}

function contextOf(scope: Scope): ServerCallContext {
  return new ServerCallContext({
    tenant: scope.tenant || undefined,
    user: { isAuthenticated: true, userName: scope.owner },
  });
}

function parseTask(value: unknown): Task {
  const source = record(value, 'task');
  text(source.id, 'task ID');
  text(source.contextId, 'context ID');
  const status = record(source.status, 'task status');
  if (status.timestamp !== undefined && (
    typeof status.timestamp !== 'string' || !Number.isFinite(Date.parse(status.timestamp))
  )) throw new Error('Invalid A2A task status timestamp');
  for (const field of ['history', 'artifacts'] as const) {
    if (source[field] !== undefined && !Array.isArray(source[field])) {
      throw new Error(`Invalid A2A task ${field}`);
    }
  }
  const task = Task.fromJSON(source);
  if (!task.status || task.status.state < 0 || task.status.state > TaskState.TASK_STATE_AUTH_REQUIRED) {
    throw new Error('Invalid A2A task state');
  }
  for (const message of task.history) {
    text(message.messageId, 'message ID');
    if (message.role !== Role.ROLE_USER && message.role !== Role.ROLE_AGENT) {
      throw new Error('Invalid A2A history message role');
    }
  }
  for (const artifact of task.artifacts) text(artifact.artifactId, 'artifact ID');
  return task;
}

function parseTarget(value: unknown): A2ATarget {
  const source = record(value, 'target');
  const sessionId = text(source.sessionId, 'session ID');
  const cwd = text(source.cwd, 'working directory');
  if (!isAbsolute(cwd)) throw new Error('Invalid A2A working directory: expected an absolute path');
  const agentPreset = source.agentPreset === undefined ? undefined : text(source.agentPreset, 'agent preset');
  return { sessionId, cwd, ...(agentPreset === undefined ? {} : { agentPreset }) };
}

function validatePushUrl(value: unknown): string {
  const url = text(value, 'push URL');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid A2A push URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('A2A push URL must use HTTP(S) without embedded credentials');
  }
  return url;
}

function parsePush(value: unknown, taskId: string, scope: Scope): StoredPushNotificationConfig[] {
  if (!Array.isArray(value)) throw new Error('Invalid A2A push configurations');
  const ids = new Set<string>();
  return value.map(entry => {
    const source = record(entry, 'push configuration');
    if (source.wireVersion !== '1.0' && source.wireVersion !== '0.3') {
      throw new Error('Invalid A2A push wire version');
    }
    const wire = record(source.config, 'push configuration');
    text(wire.id, 'push configuration ID');
    if (text(wire.taskId, 'push task ID') !== taskId) throw new Error('A2A push task ID mismatch');
    if (wire.tenant !== undefined && text(wire.tenant, 'push tenant', true) !== scope.tenant) {
      throw new Error('A2A push tenant mismatch');
    }
    validatePushUrl(wire.url);
    if (wire.token !== undefined) text(wire.token, 'push token', true);
    if (wire.authentication !== undefined) {
      const authentication = record(wire.authentication, 'push authentication');
      if (authentication.scheme !== undefined) text(authentication.scheme, 'push authentication scheme', true);
      if (authentication.credentials !== undefined) text(authentication.credentials, 'push authentication credentials', true);
    }
    const config = TaskPushNotificationConfig.fromJSON(wire);
    if (ids.has(config.id)) throw new Error('Duplicate A2A push configuration ID');
    ids.add(config.id);
    return { config, wireVersion: source.wireVersion };
  });
}

/**
 * A single-process, durable store shared by A2A transports and DSH hosts.
 * Resource IDs never become paths; each record is keyed by tenant and SDK owner.
 * The exclusive lock rejects a second live instance using the same directory.
 */
export class FileA2AStore {
  readonly taskStore: TaskStore;
  readonly pushStore: PushNotificationStore;
  private readonly directory: string;
  private readonly lock: Lock = { pid: process.pid, token: randomUUID() };
  private readonly memory = new InMemoryTaskStore();
  private readonly tasks = new Map<string, CachedTask>();
  private readonly pushes = new Map<string, StoredPushNotificationConfig[]>();
  private readonly targets = new Map<string, A2ATarget>();
  private readonly ready: Promise<unknown>;
  private closed = false;

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A2A storage directory must be a real directory');
    chmodSync(this.directory, 0o700);
    this.acquireLock();
    try {
      const loads: Promise<void>[] = [];
      for (const name of readdirSync(this.directory)) {
        if (!/^(task|push|target)-[a-f0-9]{64}\.json$/.test(name)) continue;
        const envelope = this.readEnvelope(name);
        const { kind, scope, id, value } = envelope;
        if (kind === 'task') {
          const task = parseTask(value);
          if (task.id !== id) throw new Error('A2A stored task ID mismatch');
          this.tasks.set(key(scope, id), { scope, task });
          loads.push(this.memory.save(task, contextOf(scope)));
        } else if (kind === 'push') {
          this.pushes.set(key(scope, id), parsePush(value, id, scope));
        } else {
          this.targets.set(key(scope, id), parseTarget(value));
        }
      }
      this.ready = Promise.all(loads);
    } catch (error) {
      this.close();
      throw error;
    }

    this.taskStore = {
      save: async (task, context) => {
        this.assertOpen();
        const scope = scopeOf(context);
        // Roundtrip through JSON as well as the SDK codec so cached metadata
        // cannot retain references owned by the caller or non-JSON values.
        const normalized = parseTask(JSON.parse(JSON.stringify(Task.toJSON(task))));
        this.writeEnvelope('task', scope, normalized.id, Task.toJSON(normalized));
        this.tasks.set(key(scope, normalized.id), { scope, task: normalized });
        await this.ready;
        await this.memory.save(normalized, context);
      },
      load: async (id, context) => {
        this.assertOpen();
        text(id, 'task ID');
        scopeOf(context);
        await this.ready;
        return this.memory.load(id, context);
      },
      list: async (params, context) => {
        this.assertOpen();
        scopeOf(context);
        await this.ready;
        const result = await this.memory.list(params, context);
        // SDK pagination/filtering stays authoritative; its current list omits
        // historyLength, which the protocol also applies to each returned task.
        if (params.historyLength !== undefined) {
          if (!Number.isInteger(params.historyLength) || params.historyLength < 0) {
            throw new RequestMalformedError('historyLength must be a non-negative integer');
          }
          for (const task of result.tasks) {
            task.history = params.historyLength === 0 ? [] : task.history.slice(-params.historyLength);
          }
        }
        return result;
      },
    };

    this.pushStore = {
      save: async (taskId, context, supplied) => {
        this.assertOpen();
        text(taskId, 'task ID');
        const scope = scopeOf(context);
        if (supplied.taskId && supplied.taskId !== taskId) throw new RequestMalformedError('Push task ID mismatch');
        if (supplied.tenant && supplied.tenant !== scope.tenant) throw new RequestMalformedError('Push tenant mismatch');
        try { validatePushUrl(supplied.url); } catch (error) {
          throw new RequestMalformedError((error as Error).message);
        }
        const wireVersion = context.requestedVersion;
        if (wireVersion !== '1.0' && wireVersion !== '0.3') {
          throw new RequestMalformedError('Unsupported push wire version');
        }
        if (!supplied.id) supplied.id = randomUUID();
        const config = TaskPushNotificationConfig.fromJSON(TaskPushNotificationConfig.toJSON({
          ...supplied, taskId, tenant: scope.tenant,
        }));
        const current = [...(this.pushes.get(key(scope, taskId)) ?? [])].filter(entry => entry.config.id !== config.id);
        current.push({ config, wireVersion });
        const serialized = current.map(entry => ({
          config: TaskPushNotificationConfig.toJSON(entry.config), wireVersion: entry.wireVersion,
        }));
        const entries = parsePush(serialized, taskId, scope);
        this.writeEnvelope('push', scope, taskId, serialized);
        this.pushes.set(key(scope, taskId), entries);
      },
      load: async (taskId, context) => this.loadPush(taskId, context).map(entry => entry.config),
      loadWithMetadata: async (taskId, context) => this.loadPush(taskId, context),
      delete: async (taskId, context, configId) => {
        this.assertOpen();
        text(taskId, 'task ID');
        const scope = scopeOf(context);
        // Match the SDK default: omitted configId refers to the task ID.
        const entries = (this.pushes.get(key(scope, taskId)) ?? [])
          .filter(entry => entry.config.id !== (configId ?? taskId));
        this.writeEnvelope('push', scope, taskId, entries.map(entry => ({
          config: TaskPushNotificationConfig.toJSON(entry.config), wireVersion: entry.wireVersion,
        })));
        this.pushes.set(key(scope, taskId), entries);
      },
    };
  }

  loadTarget(contextId: string, context: ServerCallContext): A2ATarget | undefined {
    this.assertOpen();
    text(contextId, 'context ID');
    const target = this.targets.get(key(scopeOf(context), contextId));
    return target && structuredClone(target);
  }

  saveTarget(contextId: string, target: A2ATarget, context: ServerCallContext): void {
    this.assertOpen();
    text(contextId, 'context ID');
    const scope = scopeOf(context);
    const normalized = parseTarget(target);
    this.writeEnvelope('target', scope, contextId, normalized);
    this.targets.set(key(scope, contextId), normalized);
  }

  /** Persist failure for interrupted executions. A restart never reruns work. */
  async recoverInterrupted(): Promise<void> {
    this.assertOpen();
    await this.ready;
    for (const { scope, task } of [...this.tasks.values()]) {
      if (task.status && terminalStates.has(task.status.state)) continue;
      const message = Message.fromJSON({
        messageId: randomUUID(), contextId: task.contextId, taskId: task.id,
        role: 'ROLE_AGENT',
        parts: [{ text: 'Execution was interrupted by an A2A service restart and was not restarted.' }],
      });
      await this.taskStore.save({
        ...task,
        status: { state: TaskState.TASK_STATE_FAILED, timestamp: new Date().toISOString(), message },
        history: [...task.history, message],
      }, contextOf(scope));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // The owner filename is unique to this instance. Never unlink a shared
    // lock path: another process may have acquired it since our last check.
    const path = this.ownerPath();
    try {
      const lock = this.readJson(path) as Lock;
      if (lock.token === this.lock.token && lock.pid === this.lock.pid) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.removeEmptyLockDirectory();
  }

  private loadPush(taskId: string, context: ServerCallContext): StoredPushNotificationConfig[] {
    this.assertOpen();
    text(taskId, 'task ID');
    return structuredClone(this.pushes.get(key(scopeOf(context), taskId)) ?? []);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('A2A store is closed');
  }

  private acquireLock(): void {
    const path = join(this.directory, '.lock');
    for (let attempt = 0; attempt < 32; attempt++) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = lstatSync(path);
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Legacy or invalid A2A .lock file; verify no instance is running before removing it');
          }
          const names = readdirSync(path);
          for (const name of names) {
            const lock = record(this.readJson(join(path, name)), 'storage lock');
            if (!Number.isInteger(lock.pid) || (lock.pid as number) <= 0 ||
              typeof lock.token !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(lock.token) ||
              name !== `owner-${lock.pid}-${lock.token}.json`) {
              throw new Error('Invalid A2A storage lock; inspect the storage directory before removing it');
            }
            let dead = false;
            try { process.kill(lock.pid as number, 0); } catch (cause) {
              dead = (cause as NodeJS.ErrnoException).code === 'ESRCH';
            }
            if (!dead) throw new Error('A2A storage directory is already in use by another instance');
          }
          // Only remove the unique filenames observed above. A new live owner
          // can never share them, so a delayed contender cannot delete its lock.
          for (const name of names) {
            try { unlinkSync(join(path, name)); } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
            }
          }
          this.removeEmptyLockDirectory();
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
        continue;
      }

      try {
        const fd = openSync(this.ownerPath(), 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(this.lock)); fsyncSync(fd); } finally { closeSync(fd); }
        // A competing recovery can replace an empty directory between mkdir
        // and marker creation. If both contenders wrote into that replacement,
        // only the sole remaining owner may return a successfully held lock.
        const names = readdirSync(path);
        if (names.length !== 1 || names[0] !== this.ownerName()) {
          throw new Error('A2A storage directory is already in use by another instance');
        }
        return;
      } catch (error) {
        try { unlinkSync(this.ownerPath()); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
        this.removeEmptyLockDirectory();
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('Could not acquire A2A storage lock');
  }

  private ownerName(): string { return `owner-${this.lock.pid}-${this.lock.token}.json`; }
  private ownerPath(): string { return join(this.directory, '.lock', this.ownerName()); }

  private removeEmptyLockDirectory(): void {
    try { rmdirSync(join(this.directory, '.lock')); } catch (error) {
      // A live marker makes rmdir fail; never recursively remove a lock directory.
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }

  private readJson(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxRecordSize) throw new Error('Invalid A2A storage file');
      return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    } finally { closeSync(fd); }
  }

  private readEnvelope(name: string): Envelope {
    const path = join(this.directory, name);
    const source = record(this.readJson(path), 'storage record');
    if (source.version !== 1 || !['task', 'push', 'target'].includes(source.kind as string)) {
      throw new Error('Invalid A2A storage record version or kind');
    }
    const rawScope = record(source.scope, 'stored scope');
    const scope = { tenant: text(rawScope.tenant, 'stored tenant', true), owner: text(rawScope.owner, 'stored owner') };
    const id = text(source.id, 'stored resource ID');
    const kind = source.kind as Kind;
    if (fileName(kind, scope, id) !== name) throw new Error('A2A storage record filename does not match its scope');
    chmodSync(path, 0o600);
    return { version: 1, kind, scope, id, value: source.value };
  }

  private writeEnvelope(kind: Kind, scope: Scope, id: string, value: unknown): void {
    const envelope: Envelope = { version: 1, kind, scope, id, value };
    const data = JSON.stringify(envelope) + '\n';
    if (Buffer.byteLength(data) > maxRecordSize) throw new Error('A2A storage record is too large');
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    const destination = join(this.directory, fileName(kind, scope, id));
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Nothing to remove after rename. */ }
      throw error;
    }
  }
}
