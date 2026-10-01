import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('integration lanes execute each generated test and its children exactly once', t => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-sharding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = new URL('../packages/runtime/test/integration-test-sharding.ts', import.meta.url).href;
  const fixture = join(directory, 'fixture.mjs');
  writeFileSync(fixture, `import test from ${JSON.stringify(helper)};
    for (let i = 0; i < 12; i++) test('dynamic ' + i, async t => {
      console.log('EXECUTED:' + i);
      await t.test('nested', () => console.log('CHILD:' + i));
    });`);
  const executed = [];
  const children = [];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (let index = 1; index <= 4; index++) {
    const output = execFileSync(process.execPath, ['--test', fixture], { env: { ...env, ACP_INTEGRATION_SHARD: `${index}/4` }, encoding: 'utf8' });
    executed.push(...[...output.matchAll(/EXECUTED:(\d+)/g)].map(match => Number(match[1])));
    children.push(...[...output.matchAll(/CHILD:(\d+)/g)].map(match => Number(match[1])));
  }
  const expected = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(executed.sort((a, b) => a - b), expected);
  assert.deepEqual(children.sort((a, b) => a - b), expected);
  delete env.ACP_INTEGRATION_SHARD;
  const full = execFileSync(process.execPath, ['--test', fixture], { env, encoding: 'utf8' });
  assert.equal([...full.matchAll(/EXECUTED:/g)].length, 12);
  assert.throws(() => execFileSync(process.execPath, ['--test', fixture], { env: { ...env, ACP_INTEGRATION_SHARD: '5/4' }, stdio: 'pipe' }));
});
