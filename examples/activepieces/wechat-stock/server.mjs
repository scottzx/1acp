import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, open, unlink, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StockBridge } from './bridge.mjs';
import { createWorkbenchAdapter } from './adapter.mjs';
import { continuousRunner } from './continuous.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
export function bridgeServer(bridge, token) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A dedicated strong bridge credential is required');
  return http.createServer((req, res) => { void (async () => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://stock.local');
      if (url.search || req.headers.origin) return json(403, { error: 'unsupported_request' });
      if (req.method === 'GET' && url.pathname === '/health') return json(200, { status: 'ok', service: 'wechat-stock-bridge' });
      const artifact = /^\/artifacts\/([a-f0-9]{64})\/([a-zA-Z0-9.-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && artifact) {
        const operation = bridge.state.operations[artifact[1]], file = operation?.delivery?.receipts?.[artifact[2]];
        if (!file) return json(404, { error: 'no_verified_artifact' });
        const path = join(operation.delivery.artifactDirectory, artifact[2]);
        if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error('artifact_changed');
        const bytes = await readFile(path);
        const { createHash } = await import('node:crypto');
        if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('artifact_changed');
        const ext = Object.keys(types).find(value => path.endsWith(value));
        res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; sandbox allow-popups allow-top-navigation-by-user-activation" });
        return res.end(bytes);
      }
      const expected = Buffer.from(`Bearer ${token}`), provided = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return json(401, { error: 'unauthorized' });
      if (req.method === 'GET' && url.pathname === '/status') return json(200, bridge.status());
      if (req.method !== 'POST' || !['/observe', '/apply', ...(bridge.startContinuous ? ['/run'] : [])].includes(url.pathname)) return json(404, { error: 'no_route' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'json_required' });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 65536) return json(413, { error: 'body_too_large' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      return json(200, await (url.pathname === '/run' ? bridge.startContinuous() : url.pathname === '/observe' ? bridge.observe(input) : bridge.apply(input)));
    } catch { json(409, { error: 'business_operation_requires_reconciliation' }); }
  })(); });
}

export async function startBridge(config) {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const leasePath = join(config.stateDirectory, 'service.lock'); let lease;
  for (let tries = 0; tries < 2; tries++) {
    try { lease = await open(leasePath, 'wx', 0o600); await lease.writeFile(String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(leasePath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Stock service is already running'); }
      catch (check) { if (check.code !== 'ESRCH') throw check; await unlink(leasePath); }
    }
  }
  if (!lease) throw new Error('Could not acquire stock service ownership');
  try {
    const adapter = await createWorkbenchAdapter(config), bridge = await new StockBridge(config, adapter).initialize();
    const runner = config.policy.mode === 'catalog_batch' && config.policy.continuous === true ? continuousRunner(bridge) : null;
    if (runner) bridge.startContinuous = async () => ({ ...await runner.start(), status: bridge.status() });
    const server = bridgeServer(bridge, config.token);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    const localServer = config.host !== '127.0.0.1' && config.host !== '0.0.0.0' ? bridgeServer(bridge, config.token) : null;
    if (localServer) {
      try { await new Promise((resolve, reject) => { localServer.once('error', reject); localServer.listen(config.port, '127.0.0.1', resolve); }); }
      catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
    }
    runner?.restore();
    const close = async () => { await runner?.stop(); if (localServer) await new Promise(resolve => localServer.close(resolve)); await new Promise(resolve => server.close(resolve)); await lease.close(); await unlink(leasePath); };
    return { bridge, server, close };
  } catch (error) { await lease.close(); await unlink(leasePath); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const instance = await startBridge(config);
  console.log(JSON.stringify({ service: 'wechat-stock-bridge', status: 'listening', port: config.port, intervalMinutes: config.policy.checkIntervalMs / 60000 }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void instance.close().then(() => process.exit(0)); });
}
