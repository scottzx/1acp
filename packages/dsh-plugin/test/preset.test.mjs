import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';

test('bundle registers ACP-only presets and releases them with its lifetime', async () => {
 const dir=mkdtempSync(join(tmpdir(),'dsh-acp-preset-')); const effects=[]; const routes=[]; const presets=new Map();
 const ctx={get: key => key==='dshHomePath' ? (...p)=>join(dir,...p) : undefined, llm:{registerAdapter: names=>{routes.push(...names);return ()=>{};}}, effect: setup=>{effects.push(setup());}, webServer:{register:()=>()=>{}}, agentPresets:{register:async definition=>{presets.set(definition.id,definition);return ()=>presets.delete(definition.id);}}};
 try {
  await apply(ctx);
  assert.deepEqual(routes,['1agents-acp']);
  assert.deepEqual([...presets.keys()],['oneagents-acp-codex','oneagents-acp-grok-build']);
  const codex=presets.get('oneagents-acp-codex');
  assert.equal(codex.plugins[0].config.includeRuntimeContext,false);
  assert.equal(codex.plugins[1].name,'@1agents/dsh-acp/preset');
  assert.equal(codex.plugins[1].config.agent,'codex');
 } finally { for(const dispose of effects) await dispose?.(); rmSync(dir,{recursive:true,force:true}); }
 assert.equal(presets.size,0);
});
