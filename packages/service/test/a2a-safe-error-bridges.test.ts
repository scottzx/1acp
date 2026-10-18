import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { client, type RequestError } from '@agentclientprotocol/sdk';
import { createAgentRegistry, createRuntimeStore, type SafeError } from '@1agents/acp-service/runtime';
import { WebSocket } from 'ws';

const secret = 'SYNTHETIC_SECRET_CANARY_NOT_REAL';
const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL';

/** This process has no model, account or network access. It emits synthetic ACP errors. */
const fixtureSource = `
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let pending;
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line), p=m.params;
  const reply=result=>send({id:m.id,result});
  if(m.method==='initialize') reply({protocolVersion:1,agentInfo:{name:'synthetic-errors',version:'1'},agentCapabilities:{loadSession:true},authMethods:[]});
  else if(m.method==='session/new') {
    if(process.env.SYNTHETIC_INIT_FAILURE==='1') send({id:m.id,error:{code:-32603,message:'Internal error',data:{codexErrorInfo:'usageLimitExceeded',message:${JSON.stringify(secret)},additionalDetails:${JSON.stringify(authLink)}}}});
    else reply({sessionId:'synthetic-native'});
  }
  else if(m.method==='session/load'||m.method==='session/resume') reply({});
  else if(m.method==='session/prompt') {
    const kind=p.prompt[0]?.text;
    if(kind==='wait') { pending=m; return; }
    const code={quota:'usageLimitExceeded',rate:'rateLimitExceeded',budget:'sessionBudgetExceeded',auth:'unauthorized'}[kind];
    const data={message:${JSON.stringify(secret)},additionalDetails:${JSON.stringify(authLink)},token:'SYNTHETIC_TOKEN_NOT_REAL',account:{id:'SYNTHETIC_ACCOUNT_NOT_REAL'}};
    if(code) data.codexErrorInfo=code;
    if(kind==='nested') data.error={codexErrorInfo:'usageLimitExceeded'};
    if(kind==='conflicting') { data.codexErrorInfo='usageLimitExceeded'; data.error={codexErrorInfo:'unauthorized'}; }
    send({id:m.id,error:{code:-32603,message:kind==='unknown'?'quota budget retry later '+${JSON.stringify(secret)}:'Internal error',data}});
  } else if(m.method==='session/cancel'&&pending) { send({id:pending.id,result:{stopReason:'cancelled'}}); pending=undefined; }
  else if(m.id!==undefined) send({id:m.id,error:{code:-32601,message:'Method not found'}});
});
`;

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

function assertSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const canary of [secret, authLink, 'SYNTHETIC_TOKEN_NOT_REAL', 'SYNTHETIC_ACCOUNT_NOT_REAL']) assert.ok(!serialized.includes(canary), 'Synthetic provider data escaped');
  assert.ok(!serialized.includes('additionalDetails'));
}

test('A05 native structured errors cross runtime, live ACP and bridge summary without provider data', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acp-safe-errors-'));
  const fixturePath = join(directory, 'synthetic-agent.mjs');
  writeFileSync(fixturePath, fixtureSource);
  process.env.ACP_STATE_DIR = directory;
  const bridge = await import('../src/bridge.js');
  const { serveAcpService } = await import('../src/server.js');
  const { webSocketStream } = await import('../src/acp-connection.js');
  const options = Reflect.get(bridge.runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: directory });
  options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath, fixturePath] } });
  const logs: unknown[][] = [];
  for (const method of ['error', 'warn', 'log'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  const service = await serveAcpService({ host: '127.0.0.1', port: 0, report: false });
  const ws = new WebSocket(`ws://127.0.0.1:${service.port}/agents/codex`);
  t.after(async () => { ws.terminate(); await service.close(); delete process.env.ACP_STATE_DIR; rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const wire: unknown[] = [];
  ws.on('message', data => wire.push(JSON.parse(data.toString())));
  const connection = client().connect(webSocketStream(ws));
  await connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { '1agents': { version: 1 } } } });
  const { sessionId } = await connection.agent.request('session/new', { cwd: directory, mcpServers: [] });

  for (const [kind, category] of [['quota', 'quota'], ['rate', 'rate_limit'], ['budget', 'budget'], ['auth', 'auth'], ['unknown', 'unknown'], ['nested', 'quota'], ['conflicting', 'unknown']] as const) {
    let rejected: RequestError | undefined;
    await assert.rejects(connection.agent.request('session/prompt', {
      sessionId, prompt: [{ type: 'text', text: kind }],
      _meta: { '1agents': { turnManaged: true, turnId: `synthetic-${kind}`, requestId: `synthetic-${kind}` } },
    }), error => { rejected = error as RequestError; return true; });
    const error = rejected!.data as SafeError;
    assert.equal(error.category, category, kind);
    assert.equal(error.origin, 'acp');
    assert.equal(error.operationId, `synthetic-${kind}`);
    assert.equal(error.retryable, false);
    assert.equal(error.outcomeUnknown, false);
    if (kind === 'quota') assert.equal(error.providerCode, 'usageLimitExceeded');
    assertSafe({ message: rejected!.message, data: error });
    await until(() => !bridge.activeSessions.get(sessionId)?.activeTurn, 'Bridge did not release the failed turn');
  }

  // The standard ACP response adapter always requests live events internally.
  // Drive the real bridge's separate summary branch with the same native session.
  const session = bridge.activeSessions.get(sessionId)!;
  const originalPeer = session.ws;
  const summary: Record<string, unknown>[] = [];
  const summaryPeer = { readyState: 1, send(raw: string) { summary.push(JSON.parse(raw)); } };
  session.ws = summaryPeer;
  await bridge.dispatchCommand(summaryPeer, { action: 'prompt', sessionId, text: 'quota', requestId: 'synthetic-summary', responsePolicy: 'summary' });
  await until(() => summary.some(event => event.event === 'done'), 'Summary failure did not settle');
  for (const event of summary.filter(event => event.event === 'turn_complete' || event.event === 'done')) {
    assert.equal(event.status, 'failed');
    assert.equal((event.error as SafeError).category, 'quota');
    assert.equal((event.error as SafeError).providerCode, 'usageLimitExceeded');
  }
  await until(() => !session.activeTurn, 'Summary turn remained active');
  session.ws = originalPeer;

  // Legacy live terminals also carry the structured failure, without a host Turn ID.
  await assert.rejects(connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'quota' }] }), error => {
    assert.equal(((error as RequestError).data as SafeError).category, 'quota');
    return true;
  });
  await until(() => !session.activeTurn, 'Legacy turn remained active');
  const canceled = connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'wait' }] });
  await until(() => Boolean(session.activeTurn), 'Cancelable native turn did not start');
  await session.activeTurn.promptStarted;
  await connection.agent.notify('session/cancel', { sessionId });
  assert.equal((await canceled).stopReason, 'cancelled');
  await until(() => !session.activeTurn, 'Canceled turn remained active');

  const nativeError = { code: -32603, message: 'Internal error', data: { codexErrorInfo: 'usageLimitExceeded', message: secret, additionalDetails: authLink } };
  const startTurn = bridge.runtime.startTurn;
  try {
    // A synchronous admission exception must pass the same safe prompt boundary.
    bridge.runtime.startTurn = () => { throw nativeError; };
    await assert.rejects(connection.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'synthetic synchronous failure' }] }), error => {
      assert.equal(((error as RequestError).data as SafeError).category, 'quota');
      assertSafe({ message: (error as RequestError).message, data: (error as RequestError).data });
      return true;
    });
    // Async iterable failures exercise bridge logging and both terminal branches.
    bridge.runtime.startTurn = input => ({
      requestId: input.requestId, promptStarted: Promise.resolve(),
      events: (async function* () { throw nativeError; })(),
      result: Promise.resolve({ status: 'cancelled' as const }),
      cancel: async () => {}, closeStream: async () => {},
    });
    for (const responsePolicy of ['summary', 'stream']) {
      const events: Record<string, unknown>[] = [];
      const peer = { readyState: 1, send(raw: string) { events.push(JSON.parse(raw)); } };
      session.ws = peer;
      const requestId = `synthetic-stream-failure-${responsePolicy}`;
      await bridge.dispatchCommand(peer, { action: 'prompt', sessionId, text: 'synthetic stream failure', requestId, turnId: requestId, turnManaged: true, responsePolicy });
      await until(() => events.some(event => event.event === 'turn_terminal' || event.event === 'done'), 'Thrown stream did not terminate');
      const terminal = events.find(event => event.event === 'turn_terminal' || event.event === 'turn_complete')!;
      assert.equal((terminal.error as SafeError).category, 'quota');
      assert.equal((terminal.error as SafeError).operationId, requestId);
      assertSafe(events);
      await until(() => !session.activeTurn, 'Thrown stream remained active');
    }
  } finally { bridge.runtime.startTurn = startTurn; session.ws = originalPeer; }
  // Initialization can fail before a turn exists; its ordinary logger is also closed.
  try {
    process.env.SYNTHETIC_INIT_FAILURE = '1';
    await assert.rejects(connection.agent.request('session/new', { cwd: directory, mcpServers: [] }), error => {
      assertSafe({ message: (error as RequestError).message, data: (error as RequestError).data });
      return true;
    });
  } finally { delete process.env.SYNTHETIC_INIT_FAILURE; }
  assertSafe({ wire, summary, logs });
});
