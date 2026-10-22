/** Explicit cache administration; task execution uses the same resolver in its host. */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveRoleSkills } from '../src/roles/index.js';

export async function runRolesCli(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: acp-service roles sync --profile FILE [--cache-root DIRECTORY] [--lock FILE]\n\nDefault cache: CWD/.1agents/cache/roles. A new lock resolves current revisions; an existing lock is verified and reused offline. No model is invoked.');
    return;
  }
  if (argv[0] !== 'sync') throw new Error('Unknown roles command; use roles sync --help');
  const { values } = parseArgs({ args: argv.slice(1), options: {
    profile: { type: 'string' }, 'cache-root': { type: 'string' }, lock: { type: 'string' },
  }, strict: true });
  if (!values.profile) throw new Error('--profile is required');
  const cacheRoot = resolve(values['cache-root'] ?? '.1agents/cache/roles');
  const lockPath = resolve(values.lock ?? join(cacheRoot, 'locks', `manual-${randomUUID()}.json`));
  const lock = await resolveRoleSkills({ profilePath: resolve(values.profile), cacheRoot, lockPath });
  console.log(JSON.stringify({ roleId: lock.roleId, roleVersion: lock.roleVersion, lockPath,
    roleDirectory: lock.roleDirectory, entryGuidePath: lock.entryGuidePath,
    skills: lock.skills.map(({ key, skillId, sourceId, revision, directory }) => ({ key, skillId, sourceId, revision, directory })) }, null, 2));
}
