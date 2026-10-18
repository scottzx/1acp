import { officialHost } from './official-host.mjs';
const [directory, serviceUrl, mode] = process.argv.slice(2);
const host = await officialHost(directory, serviceUrl, mode === 'terminal-gap' ? () => {
  // The Adapter's diagnostic write has completed; the A2A turn listener has not run.
  process.kill(process.pid, 'SIGKILL');
} : undefined);
process.send({ ready: true, url: host.url });
process.on('message', async message => {
  if (message === 'close') { await host.close(); process.exit(0); }
});
