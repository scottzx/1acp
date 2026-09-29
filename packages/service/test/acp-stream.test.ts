import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { webSocketStream } from '../src/acp-connection.js';

test('SDK cancellation followed by socket close does not close the readable twice', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const peer of server.clients) peer.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const connected = once(server, 'connection');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, 'open');
  const [peer] = await connected as [WebSocket];
  const stream = webSocketStream(peer);
  const closed = once(peer, 'close');
  const clientClosed = once(client, 'close');
  await stream.readable.cancel();
  await Promise.all([closed, clientClosed]);
  assert.equal(peer.readyState, WebSocket.CLOSED);
});
