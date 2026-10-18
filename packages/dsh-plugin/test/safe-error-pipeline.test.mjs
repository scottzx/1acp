import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { createAgentRegistry, createRuntimeStore } from '@1agents/acp-service/runtime';
import { FileA2AStore } from '@1agents/acp-service/a2a';

const secret = 'SYNTHETIC_SECRET_CANARY_NOT_REAL';
const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL';

// Only the external native provider is synthetic; it has no account or model.
const nativeFixture = `
import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params,reply=result=>send({id:m.id,result});
 if(m.method==='initialize') reply({protocolVersion:1,agentInfo:{name:'synthetic-safe-errors',version:'1'},agentCapabilities:{loadSession:true},authMethods:[]});
 else if(m.method==='session/new') reply({sessionId:'synthetic-native'});
 else if(m.method==='session/load'||m.method==='session/resume') reply({});
 else if(m.method==='session/prompt') {
  const kind=p.prompt[0].text;
  const codes={quota:'usageLimitExceeded',rate:'rateLimitExceeded',budget:'sessionBudgetExceeded',auth:'unauthorized'};
  const data={message:${JSON.stringify(secret)},additionalDetails:${JSON.stringify(authLink)},token:'SYNTHETIC_TOKEN_NOT_REAL'};
  if(codes[kind])data.codexErrorInfo=codes[kind];
  if(kind==='spoof')Object.assign(data,{category:'quota',retryable:true,outcomeUnknown:true,operationId:'SYNTHETIC_OPERATION_SECRET_NOT_REAL',publicError:{category:'quota',providerCode:'usageLimitExceeded'}});
  send({id:m.id,error:{code:-32603,message:'Internal error',data}});
 } else if(m.method==='session/cancel') {}
 else if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Method not found'}});
});
`;

function assertNoProviderData(value) {
  const text = JSON.stringify(value);
  for (const canary of [secret, authLink, 'SYNTHETIC_TOKEN_NOT_REAL', 'SYNTHETIC_OPERATION_SECRET_NOT_REAL']) {
    assert.ok(!text.includes(canary), 'Synthetic provider data escaped');
  }
}

test('native ACP failure crosses the real service, Loader plugin, DSH loop and durable A2A API', {
  skip: process.env.DSH_SOURCE ? false : 'Set DSH_SOURCE to a built matching DSH checkout for the full safe-error pipeline',
  timeout: 30000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-dsh-safe-pipeline-'));
  let service, ctx;
  const oldStateDir = process.env.ACP_STATE_DIR;
  t.after(async () => {
    try { await ctx?.fiber.dispose(); }
    finally {
      try { await service?.close(); }
      finally {
        if (oldStateDir === undefined) delete process.env.ACP_STATE_DIR; else process.env.ACP_STATE_DIR = oldStateDir;
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const nativePath = join(directory, 'synthetic-native.mjs');
  await writeFile(nativePath, nativeFixture);
  process.env.ACP_STATE_DIR = join(directory, 'runtime');
  const serviceDir = dirname(createRequire(import.meta.url).resolve('@1agents/acp-service/package.json'));
  const bridge = await import(pathToFileURL(join(serviceDir, 'dist/src/bridge.js')).href);
  const { serveAcpService } = await import('@1agents/acp-service/service');
  const options = Reflect.get(bridge.runtime, 'options');
  options.sessionStore = createRuntimeStore({ stateDir: process.env.ACP_STATE_DIR });
  options.agentRegistry = createAgentRegistry({ overrides: { codex: [process.execPath, nativePath] } });
  service = await serveAcpService({ host: '127.0.0.1', port: 0, report: false });
  const requireHost = createRequire(join(process.env.DSH_SOURCE, 'packages/core/agent-loop/package.json'));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const [{ default: Llm }, { default: Sessions }, { default: Projections }, { default: SystemPrompt },
    { default: Tools }, { default: Agents }, { default: AgentLoop }, { agentPresetProjectionDefinition }] = await Promise.all([
    load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'),
    load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-agent-preset-registry'),
  ]);
  const clientRequire = createRequire(join(process.env.DSH_SOURCE, 'packages/client/modules/package.json'));
  const [{ default: Loader }, { default: WebServer }] = await Promise.all([
    import(pathToFileURL(clientRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href),
    import(pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-host-webserver')).href),
  ]);
  const sdkRequire = createRequire(join(serviceDir, 'package.json'));
  const persistenceRequire = createRequire(join(process.env.DSH_SOURCE, 'packages/session/session-persistence-jsonl/package.json'));
  const { default: JsonlPersistence } = await import(pathToFileURL(persistenceRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
  const [{ SendMessageRequest, GetTaskRequest, TaskState }, { ClientFactory }, { ServerCallContext }] = await Promise.all([
    import(pathToFileURL(sdkRequire.resolve('@a2a-js/sdk')).href),
    import(pathToFileURL(sdkRequire.resolve('@a2a-js/sdk/client')).href),
    import(pathToFileURL(sdkRequire.resolve('@a2a-js/sdk/server')).href),
  ]);
  ctx = new Context();
  const logs = [], stateDirectory = join(directory, 'a2a');
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => { logs.push(args); });
  for (const plugin of [Llm, Sessions, Projections, SystemPrompt, Tools, Agents]) await ctx.plugin(plugin);
  ctx.sessionProjections.register(agentPresetProjectionDefinition);
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  for (const name of ['approval', 'userQuestions', 'workspaceRegistry']) ctx.provide(name, {});
  ctx.provide('commands', { register: () => () => {} });
  ctx.provide('agentPresets', { register: async () => () => {} });
  let nextSession = 0;
  // The controller fixture delegates task creation and input to actual Agents;
  // the error path, native process, host loop, transport and task store are real.
  ctx.provide('sessionController', {
    create: async request => {
      const sessionId = request.sessionId ?? `synthetic-pipeline-session-${++nextSession}`;
      if (!ctx.agents.get(sessionId)) try { await ctx.agents.create({ sessionId,
        meta: { cwd: request.cwd, agentPreset: 'oneagents-acp-codex' },
        agentOptions: { provider: '1agents-acp', model: 'codex' } }); }
      catch (error) { t.diagnostic(`Fixture Agent creation failed: ${error.stack}`); throw error; }
      return { sessionId };
    },
    inspect: async id => ({ meta: ctx.agents.get(id).session.header, events: [] }),
    resolveAgent: async id => ({ agent: ctx.agents.get(id) }),
    prompt: async request => {
      const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
      ctx.agents.get(request.sessionId).followup(createUserMessage({ content: request.content,
        source: { kind: 'user', rpcId: request.requestId } }));
      return { accepted: true };
    },
  });
  class MemoryLoader extends Loader { write() {} }
  await ctx.plugin(MemoryLoader, { baseUrl: pathToFileURL(resolve(import.meta.dirname, '..')).href + '/' });
  const url = `http://127.0.0.1:${ctx.webServer.port}`;
  const id = await ctx.loader.create({ name: './dist/index.js', config: {
    serviceMode: 'external', serviceUrl: `http://127.0.0.1:${service.port}`, agents: ['codex'],
    stateDirectory: join(directory, 'adapter'), reconnectAttempts: 0,
    a2a: { token: 'synthetic-test-token', publicUrl: url, stateDirectory, defaultCwd: directory },
  } });
  const fiber = ctx.loader.resolve(id).fiber; await fiber.await();
  const client = await new ClientFactory().createFromUrl(url);
  const authenticated = { serviceParameters: { Authorization: 'Bearer synthetic-test-token' } };
  const tasks = [], diagnostics = [];
  for (const [kind, category, providerCode] of [
    ['quota', 'quota', 'usageLimitExceeded'], ['rate', 'rate_limit', 'rateLimitExceeded'],
    ['budget', 'budget', 'sessionBudgetExceeded'], ['auth', 'auth', 'unauthorized'],
    ['unknown', 'unknown', undefined], ['spoof', 'unknown', undefined],
  ]) {
    const admitted = await client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: `synthetic-${kind}`, role: 'ROLE_USER', parts: [{ text: kind }] },
      configuration: { returnImmediately: true },
    }), authenticated);
    const deadline = Date.now() + 10000;
    let task;
    do {
      task = await client.getTask(GetTaskRequest.fromJSON({ id: admitted.id }), authenticated);
      if (task.status.state === TaskState.TASK_STATE_FAILED) break;
      assert.ok(Date.now() < deadline, 'Synthetic error did not settle as failed');
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
    const error = task.metadata['1agents'].error;
    const agent = ctx.agents.get(task.metadata['1agents'].sessionId);
    assert.ok(agent, JSON.stringify({ task, logs: logs.map(args => args.map(value => value instanceof Error ? value.stack : value)) }));
    await agent.whenIdle();
    const reason = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason;
    assert.equal(error.category, category, JSON.stringify({ kind, error, reason })); assert.equal(error.providerCode, providerCode);
    assert.equal(error.retryable, false); assert.equal(error.outcomeUnknown, false);
    assert.equal(error.origin, 'acp'); assert.equal(typeof error.operationId, 'string');
    assertNoProviderData(task);
    assert.equal(reason.kind, 'error'); assert.equal(reason.error.publicError.category, category);
    assert.equal(reason.error.publicError.providerCode, providerCode); assertNoProviderData(reason);
    diagnostics.push({ kind, state: task.status.state, category, providerCode,
      hostFields: Object.keys(reason.error.publicError).sort() });
    tasks.push(task);
  }
  assertNoProviderData(logs);
  await fiber.dispose();
  const store = new FileA2AStore(stateDirectory);
  try {
    const scope = new ServerCallContext({ user: { isAuthenticated: true, userName: 'dsh-a2a' } });
    for (const task of tasks) {
      const restored = await store.taskStore.load(task.id, scope);
      assert.deepEqual(restored.metadata['1agents'].error, task.metadata['1agents'].error);
      assert.equal(restored.status.state, TaskState.TASK_STATE_FAILED); assertNoProviderData(restored);
    }
  } finally { store.close(); }
  const bindings = await readdir(join(directory, 'adapter'));
  assert.ok(bindings.some(name => name.endsWith('.json')));
  for (const name of bindings.filter(name => name.endsWith('.json'))) assertNoProviderData(await readFile(join(directory, 'adapter', name), 'utf8'));
  t.diagnostic(JSON.stringify({ pipeline: 'native-runtime-ACP-adapter-DSH-A2A-query-reload', cases: diagnostics }));
});
