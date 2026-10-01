/** Select only a successful main push CI for this exact release commit. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function validateRunIdentity(run, { sha, workflowId, repository }) {
  assert.equal(run.head_sha, sha, 'CI commit differs from release commit');
  assert.equal(run.workflow_id, workflowId, 'Run is not the workspace CI');
  assert.equal(run.event, 'push', 'Only push CI artifacts may be released');
  assert.equal(run.head_branch, 'main', 'Only main artifacts may be released');
  assert.equal(run.head_repository?.full_name, repository, 'CI repository mismatch');
}

export function validateRun(run, context) {
  validateRunIdentity(run, context);
  assert.equal(run.status, 'completed', 'CI has not completed');
  assert.equal(run.conclusion, 'success', 'CI did not pass');
  return String(run.id);
}

export async function resolveRun({ sha, repository, runId, request, pause = ms => new Promise(r => setTimeout(r, ms)), attempts = 80 }) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  if (runId) assert.match(runId, /^\d+$/);
  const workflow = await request('/actions/workflows/ci.yml');
  for (let attempt = 0; attempt < attempts; attempt++) {
    let run;
    if (runId) run = await request(`/actions/runs/${runId}`);
    else {
      const response = await request(`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`);
      const matching = response.workflow_runs.filter(candidate => candidate.head_sha === sha);
      run = matching.find(candidate => candidate.status === 'completed' && candidate.conclusion === 'success')
        ?? matching.find(candidate => candidate.status !== 'completed')
        ?? matching[0];
    }
    const context = { sha, workflowId: workflow.id, repository };
    if (run) validateRunIdentity(run, context);
    if (run?.status === 'completed') return validateRun(run, context);
    console.log(`Waiting for main CI for ${sha} (${attempt + 1}/${attempts})`);
    if (attempt + 1 < attempts) await pause(15_000);
  }
  throw new Error('No successful CI available for this commit; run main CI, then retry Release');
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const request = async path => {
    const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub CI lookup failed: HTTP ${response.status}`);
    return response.json();
  };
  const id = await resolveRun({ sha: process.env.GITHUB_SHA, repository, runId: process.env.CI_RUN_ID, request });
  appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${id}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
