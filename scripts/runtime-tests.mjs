/** Run disjoint CI test lanes without rebuilding the shared test artifacts. */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../packages/runtime');
const lane = process.argv[2];
const files = readdirSync(resolve(root, 'dist-test/test')).filter(file => file.endsWith('.test.js')).sort();
const args = ['--test', '--test-concurrency=4'];
const env = { ...process.env };
if (/^integration-[1-4]$/.test(lane)) {
  env.ACP_INTEGRATION_SHARD = `${lane.at(-1)}/4`;
  args.push('dist-test/test/integration.test.js');
} else if (lane === 'viewer') {
  args.push('dist-test/test/replay-viewer-lossless.test.js');
} else if (/^unit-[1-2]$/.test(lane)) {
  const selected = files.filter(file => !['integration.test.js', 'replay-viewer-lossless.test.js'].includes(file))
    .filter((_, i) => i % 2 === Number(lane.at(-1)) - 1);
  if (!selected.length) throw new Error('Empty unit shard');
  args.push(...selected.map(file => `dist-test/test/${file}`));
} else throw new Error(`Unknown runtime test lane: ${lane}`);
console.log(`Runtime test lane: ${lane}`);
const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
