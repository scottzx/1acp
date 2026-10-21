#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { constants, lstat, open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MEDIA_TYPES = new Map([
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
]);

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !['host', 'port', 'root'].includes(key))
      || typeof config.host !== 'string' || !isIP(config.host)
      || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
      || typeof config.root !== 'string' || !path.isAbsolute(config.root)) {
    throw new Error('Expected config {host: literal IP address, port: 0..65535, root: absolute directory}.');
  }
  return config;
}

/** Config must be a private regular file owned by the service account. */
export async function loadConfig(configPath) {
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink()
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
        || (typeof process.geteuid === 'function' && info.uid !== process.geteuid())))) {
    throw new Error('Config must be a regular file owned by the current user with mode 0600 or 0400.');
  }
  const handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (actual.dev !== info.dev || actual.ino !== info.ino || actual.size > 64 * 1024) {
      throw new Error('Config changed while opening or exceeds 64 KiB.');
    }
    return validateConfig(JSON.parse(await handle.readFile('utf8')));
  } finally {
    await handle.close();
  }
}

function safeSegments(rawUrl) {
  const pathname = rawUrl.split('?', 1)[0];
  // Keep legacy flat URLs and allow exactly one immutable revision directory.
  const match = /^\/artifacts\/([^/]+)\/(?:([^/]+)\/)?([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  let job;
  let revision;
  let filename;
  try {
    job = decodeURIComponent(match[1]);
    revision = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    filename = decodeURIComponent(match[3]);
  } catch {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job)
      || (revision !== undefined && !/^revision-[1-9][0-9]{0,5}$/.test(revision))
      || filename.length > 255 || /^[.]/.test(filename)
      || /[/\\\x00-\x1f\x7f]/.test(filename)
      || !MEDIA_TYPES.has(path.extname(filename).toLowerCase())) return undefined;
  return { directories: revision ? [job, revision] : [job], filename };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function reply(req, res, statusCode, body, extraHeaders = {}) {
  const data = Buffer.from(body);
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/** Creates a server without listening. There are no write or arbitrary file APIs. */
export async function createArtifactServer(config) {
  validateConfig(config);
  const root = await realpath(config.root);
  if (!(await stat(root)).isDirectory()) throw new Error('Artifact root must be a directory.');

  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply(req, res, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    if (req.url === '/health') {
      reply(req, res, 200, JSON.stringify({ status: 'ok', service: 'ppt-beautifier-artifacts' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
      return;
    }
    const segments = safeSegments(req.url ?? '');
    if (!segments) {
      reply(req, res, 404, 'Not found.\n');
      return;
    }

    let handle;
    try {
      const folders = segments.directories.map((_, index) => path.join(root, ...segments.directories.slice(0, index + 1)));
      const folder = folders.at(-1);
      const requested = path.join(folder, segments.filename);
      const [folderInfos, fileInfo] = await Promise.all([Promise.all(folders.map(folder => lstat(folder))), lstat(requested)]);
      // Reject all symlinks, including links that currently resolve inside root.
      if (folderInfos.some(info => !info.isDirectory() || info.isSymbolicLink())
          || !fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Not a plain artifact.');
      const canonical = await realpath(requested);
      if (!inside(root, canonical)) throw new Error('Outside artifact root.');
      handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      const [latestFolders, latestFile, latestPath] = await Promise.all([
        Promise.all(folders.map(folder => lstat(folder))), lstat(requested), realpath(requested),
      ]);
      if (!opened.isFile() || latestFolders.some((info, index) => info.isSymbolicLink() || !info.isDirectory()
          || info.dev !== folderInfos[index].dev || info.ino !== folderInfos[index].ino)
          || latestFile.isSymbolicLink() || !inside(root, latestPath)
          || opened.dev !== fileInfo.dev || opened.ino !== fileInfo.ino
          || opened.dev !== latestFile.dev || opened.ino !== latestFile.ino) {
        throw new Error('Artifact changed while opening.');
      }
      const extension = path.extname(segments.filename).toLowerCase();
      const encodedName = encodeURIComponent(segments.filename).replace(/[!'()*]/g,
        char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      res.writeHead(200, {
        'Content-Type': MEDIA_TYPES.get(extension),
        'Content-Length': opened.size,
        'Content-Disposition': `${extension === '.png' ? 'inline' : 'attachment'}; filename="artifact${extension}"; filename*=UTF-8''${encodedName}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        await handle.close();
        handle = undefined;
        res.end();
        return;
      }
      const stream = createReadStream(canonical, { fd: handle.fd, autoClose: false });
      const streamingHandle = handle;
      handle = undefined;
      stream.once('error', () => res.destroy());
      stream.once('close', () => { void streamingHandle.close().catch(() => {}); });
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) reply(req, res, 404, 'Not found.\n');
      else res.destroy();
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  });
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw new Error('Usage: node artifact-server.mjs --config /absolute/private-config.json');
  }
  const config = await loadConfig(process.argv[3]);
  const server = await createArtifactServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  console.log(`PPT artifact server listening on ${config.host}:${address.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
