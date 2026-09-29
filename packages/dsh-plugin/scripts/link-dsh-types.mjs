/** Link development declarations from a matching, already installed DSH checkout. */
import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';

const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: node scripts/link-dsh-types.mjs /absolute/path/DSH');
const root = resolve(checkout);
const needed = new Set(['dsh-llm', 'dsh-agent', 'dsh-session', 'dsh-user-approval', 'dsh-user-questions', 'dsh-commands', 'dsh-host-webserver', 'dsh-api-session-controller', 'dsh-session-projection', 'dsh-agent-preset-registry', 'dsh-workspace', 'dsh-session-persistence']);
const links = new Map();
for (const group of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  for (const pkg of readdirSync(join(root, 'packages', group.name), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const directory = join(root, 'packages', group.name, pkg.name);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const short = manifest.name?.replace('@deepseek-ai/', '');
    if (needed.has(short)) links.set(short, directory);
  }
}
for (const name of needed) if (!links.has(name)) throw new Error(`Missing DSH package: ${name}`);
links.set('cordis', realpathSync(join(links.get('dsh-agent'), 'node_modules/@deepseek-ai/cordis')));
const destination = new URL('../node_modules/@deepseek-ai/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const [name, target] of links) {
  const path = new URL(name, destination);
  try {
    lstatSync(path);
    if (realpathSync(path) !== realpathSync(target)) throw new Error(`Existing dependency differs: ${path.pathname}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    symlinkSync(target, path, 'dir');
  }
}
console.log(`Linked ${links.size} development dependencies from ${root}`);
