import fs from 'node:fs';
import { serveA2AGateway, type A2AGatewayConfig } from '../src/a2a/gateway.js';

export async function runA2ACli(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return args[index + 1];
  };
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  acp-service a2a gateway --config <file> [--no-report]
  acp-service a2a invoke <method> [--url http://127.0.0.1:36814]

invoke reads a JSON parameters object from stdin. Credentials stay in the
gateway config file (chmod 600), outside tool arguments. Remote cwd is absolute.
Methods: remote_agent_spawn, remote_agent_get, remote_agent_message,
         remote_agent_cancel, remote_agent_list, remote_agent_inbox, remote_agent_ack`);
    return;
  }
  if (args[0] === 'gateway') {
    const file = flag('--config');
    if (!file) throw new Error('gateway requires --config <file>');
    const stat = fs.statSync(file);
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Gateway config contains credentials; set chmod 600');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as A2AGatewayConfig;
    const host = await serveA2AGateway(config, { report: !args.includes('--no-report') });
    console.log(`a2a-gateway listening on http://127.0.0.1:${host.port}; registration=${host.registration?.ok ?? false}`);
    const stop = () => { void host.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (args[0] === 'invoke' && args[1] && !args[1].startsWith('--')) {
    const url = new URL('/invoke', flag('--url') ?? 'http://127.0.0.1:36814');
    const params = JSON.parse(fs.readFileSync(0, 'utf8')) as unknown;
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: args[1], params }) });
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
    if (!response.ok) process.exitCode = 1;
    return;
  }
  throw new Error('Unknown A2A command; run acp-service a2a --help');
}
