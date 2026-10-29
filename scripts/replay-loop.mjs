import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sdk } from './pi-sdk.mjs';
import { failureRun, recoverLoop, callKey, withoutReplayedThinking } from '../loop.ts';
const source = process.argv[2];
if (!source) throw Error('Provide the saved session path; --live optionally probes the configured local model without executing tools.');
const dir = await mkdtemp(join(tmpdir(), 'pi-loop-replay-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const originalHash = hash(await readFile(source));
try {
  const path = join(dir, 'copy.jsonl'); await copyFile(source, path);
  const manager = sdk.SessionManager.open(path);
  const originals = manager.getEntries();
  const run = failureRun(manager.getBranch()); assert(run?.count >= 3);
  const recovery = recoverLoop(manager, sdk.SessionManager);
  const recovered = sdk.SessionManager.open(recovery.path);
  for (const e of originals) assert.equal(JSON.stringify(recovered.getEntry(e.id)), JSON.stringify(e));
  const projection = recovered.buildSessionProjection();
  const calls = new Set(); let pairs = 0;
  for (const m of projection.messages) {
    if (m.role === 'assistant') for (const c of m.content) if (c.type === 'toolCall') calls.add(c.id);
    if (m.role === 'toolResult') { assert(calls.has(m.toolCallId)); pairs++; }
  }
  assert.equal(projection.messages.filter(m => m.role === 'compactionSummary').length, 0);
  const report = { originalsPreserved: originals.length, repetitions: run.count, recoveredBranchEntries: recovered.getBranch().length,
    validToolPairs: pairs, nativeCompactionsInSource: originals.filter(e => e.type === 'compaction' && !e.fromHook).length,
    jevCompactionsInSource: originals.filter(e => e.details?.engine === 'pi-jev-compact/v1').length,
    recoveredContextEstimate: projection.messages.reduce((n, m) => n + sdk.estimateTokens(m), 0) };
  if (process.argv.includes('--live')) {
    const agentDir = join(homedir(), '.pi/agent');
    const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
      modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    const [provider, ...id] = (process.env.PI_JEV_LIVE_MODEL ?? '').split('/');
    const model = runtime.getModel(provider, id.join('/')); assert(model, 'Set PI_JEV_LIVE_MODEL=provider/model-id');
    const started = Date.now();
    let messages = sdk.convertToLlm(projection.messages);
    if (process.argv.includes('--drop-thinking')) messages = withoutReplayedThinking(messages, model, ['*']);
    const response = await runtime.streamSimple(model, { messages },
      { reasoning: 'off', maxTokens: 3000, cacheRetention: 'none', signal: AbortSignal.timeout(90000) }).result();
    const nextCalls = response.content.filter(c => c.type === 'toolCall');
    const failedArguments = JSON.parse(run.key.slice(run.key.indexOf(':') + 1));
    const failedUrls = (failedArguments.command ?? '').match(/https?:\/\/[^\s"']+/g) ?? [];
    report.live = { ms: Date.now() - started, stop: response.stopReason,
      toolNames: nextCalls.map(c => c.name), repeatsFailedCall: nextCalls.some(c => callKey(c.name, c.arguments) === run.key),
      retriesFailedUrls: nextCalls.some(c => failedUrls.some(url => (c.arguments.command ?? '').includes(url))),
      visibleReplyChars: response.content.filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0),
      error: response.errorMessage, toolsExecuted: 0 };
    console.log(JSON.stringify({ liveProbe: report.live, dropThinking: process.argv.includes('--drop-thinking') }));
    assert.notEqual(response.stopReason, 'error');
    assert(!report.live.repeatsFailedCall, 'The recovered context still repeats the known failure');
    assert(!report.live.retriesFailedUrls, 'The model only changed syntax but retried the same failed URLs');
    assert(nextCalls.length || report.live.visibleReplyChars, 'No actionable reply from the live model');
  }
  assert.equal(hash(await readFile(source)), originalHash);
  console.log(JSON.stringify({ ...report, sourceUnchanged: true }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
