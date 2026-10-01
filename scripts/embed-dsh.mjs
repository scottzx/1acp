/** Include the already-built DSH host/client faces in the sole public package. */
import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifyPackageBuild } from './verify-package-build.mjs';

const root = resolve(import.meta.dirname, '..');
const plugin = join(root, 'packages/dsh-plugin');
const service = join(root, 'packages/service');
const source = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
const target = JSON.parse(readFileSync(join(service, 'package.json'), 'utf8'));
assert.equal(source.private, true, 'DSH source package must not be published');
for (const [name, range] of Object.entries(source.dependencies)) {
  if (name === target.name) continue;
  assert.equal(target.dependencies[name], range, `Unified package must declare DSH dependency ${name}`);
}
const destination = join(service, 'vendor/dsh');
rmSync(destination, { recursive: true, force: true });
cpSync(join(plugin, 'dist'), destination, { recursive: true });
for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE']) cpSync(join(plugin, file), join(destination, file));
verifyPackageBuild(root);
console.log(`Embedded DSH plugin in ${target.name}@${target.version}`);
