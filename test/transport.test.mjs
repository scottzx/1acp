import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { stream } from '../dist/transport.js';

test('SDK cancellation followed by socket close settles the transport once', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, 'open');
  const [peer] = await connected;
  const transport = stream(peer);
  const closed = once(peer, 'close');
  const clientClosed = once(client, 'close');
  await transport.readable.cancel();
  await Promise.all([closed, clientClosed]);
  assert.equal(peer.readyState, WebSocket.CLOSED);
});
