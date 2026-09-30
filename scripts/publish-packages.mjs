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
export function verifyRegistryState(name, version, dependency, range, runView = (args) => execFileSync('npm', args, { encoding: 'utf8' })) {
  const view = JSON.parse(runView(['view', `${name}@${version}`, 'dependencies', '--json']));
  const resolved = view?.[dependency];
  if (resolved !== range) {
    throw new Error(`Registry ${name}@${version} declares ${dependency}@${resolved ?? 'missing'}; expected ${range}`);
  }
  console.log(`registry ok: ${name}@${version} -> ${dependency}@${resolved}`);
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
    verifyRegistryState(name, version, dependency, range);
    const tag = `${name.split('/').at(-1)}-v${version}`;
    const remote = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' }).trim();
    if (!remote) {
      execFileSync('git', ['tag', tag]);
      execFileSync('git', ['push', 'origin', `refs/tags/${tag}`], { stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await publishPackages();
