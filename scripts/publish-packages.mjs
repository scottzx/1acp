/** Publish CI-validated tarballs in runtime → service → DSH plugin order. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
/** A retry may reuse only the immutable archive already present in the registry. */
export function verifyPublishedArchive(archive, dist) {
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  if (dist?.integrity !== integrity) throw new Error('Published version has different contents; bump the package version');
}

/** After publishing, confirm the registry copy resolves the declared dependency. */
export async function verifyRegistryState(name, version, dependency, range, runView = (args) => execFileSync('npm', args, { encoding: 'utf8' }), { attempts = 30, delayMs = 10_000 } = {}) {
  let resolved;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const view = JSON.parse(runView(['view', `${name}@${version}`, 'dependencies', '--json']));
      resolved = view?.[dependency];
      if (resolved === range) {
        console.log(`registry ok: ${name}@${version} -> ${dependency}@${resolved}`);
        return;
      }
      if (resolved === undefined) throw new Error(`Registry ${name}@${version} does not list ${dependency} (missing); expected ${range}`);
      throw new Error(`Registry ${name}@${version} declares ${dependency}@${resolved}; expected ${range}`);
    } catch (error) {
      // npm registry reads lag writes by a couple of minutes right after publish.
      if (attempt === attempts || !/E404|No match found/i.test(String(error.message))) throw error;
      console.log(`registry read for ${name}@${version} not propagated yet (attempt ${attempt}/${attempts}); retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const EXPECTED_DEPENDENCIES = {
  runtime: ['@openclaw/fs-safe', '^0.20.0'],
  service: ['@scottzx/1acp', '^0.16.0'],
  'dsh-plugin': ['@1agents/acp-service', '^0.3.0'],
};

async function publishPackages() {
  const selection = process.env.RELEASE_PACKAGE;
  const packages = ['runtime', 'service', 'dsh-plugin'];
  if (selection !== 'all' && !packages.includes(selection)) throw new Error('Invalid release package');
  for (const directory of packages) {
    if (selection !== 'all' && selection !== directory) continue;
    const { name, version } = JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8'));
    const archive = resolve(`release/${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    if (packed.name !== name || packed.version !== version || packed.private) throw new Error(`Invalid release archive: ${archive}`);
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
    if (response.status === 404) {
      execFileSync('npm', ['publish', archive, '--access', 'public', '--provenance'], { stdio: 'inherit' });
    } else if (response.ok) {
      const published = await response.json();
      verifyPublishedArchive(readFileSync(archive), published.dist);
      console.log(`${name}@${version} is already published; skipping`);
    } else {
      throw new Error(`Registry check failed for ${name}: HTTP ${response.status}`);
    }
    const [dependency, range] = EXPECTED_DEPENDENCIES[directory];
    await verifyRegistryState(name, version, dependency, range);
    const tag = `${name.split('/').at(-1)}-v${version}`;
    const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' }).trim();
    if (!remote) {
      execFileSync('git', ['tag', tag]);
      execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await publishPackages();
