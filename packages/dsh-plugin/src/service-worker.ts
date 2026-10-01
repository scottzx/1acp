/** Isolated service owner. IPC loss also shuts down the service after an abrupt DSH exit. */
import type { serveAcpService } from '@1agents/acp-service/service';

let startup: ReturnType<typeof serveAcpService> | undefined;
let stopping = false;
let shutdownTimeoutMs = 5_000;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), shutdownTimeoutMs);
  try { await (await startup)?.close(); }
  finally { clearTimeout(timer); process.exit(0); }
}
process.once('disconnect', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('message', message => {
  if (!message || typeof message !== 'object' || !('host' in message) || typeof message.host !== 'string'
    || !('port' in message) || typeof message.port !== 'number' || !Number.isSafeInteger(message.port) || message.port < 1 || message.port > 65535
    || !('shutdownTimeoutMs' in message) || typeof message.shutdownTimeoutMs !== 'number' || !Number.isSafeInteger(message.shutdownTimeoutMs) || message.shutdownTimeoutMs < 1) {
    process.exit(1);
  }
  if (stopping) return;
  shutdownTimeoutMs = message.shutdownTimeoutMs;
  const { host, port } = message;
  startup = import('@1agents/acp-service/service').then(service => service.serveAcpService({ host, port, report: false }));
  void startup.then(() => {
    if (!stopping && process.connected) process.send?.({ type: 'ready' });
  }, error => {
    if (process.connected) process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
    else process.exit(1);
  });
});
if (!process.connected) void shutdown();
