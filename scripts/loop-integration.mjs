import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sdk, ai } from './pi-sdk.mjs';
import { repeatedFailure, recoverLoop, withoutReplayedThinking } from '../loop.ts';
const dir = await mkdtemp(join(tmpdir(), 'pi-loop-test-'));
const agentDirEnv = process.env.PI_CODING_AGENT_DIR;
let session;
try {
  // The thinking filter is opt-in per model through the package config file.
  process.env.PI_CODING_AGENT_DIR = dir;
  await writeFile(join(dir, 'pi-jev-compact.json'), JSON.stringify({ stripThinkingModels: ['home-qwen*/orcarouter-*'] }));
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  runtime.registerProvider('home-qwen', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture',
    models: [{ id: 'orcarouter-qwen3.8-27b', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 2048, cost: usage.cost }] });
  let requests = 0, executions = 0;
  runtime.streamSimple = (_model, context) => {
    assert(++requests <= 4, 'The loop must terminate before a fifth provider request');
    assert(!context.messages.some(m => m.role === 'assistant' && m.content.some(c => c.type === 'thinking')));
    const response = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Synthetic stale analysis.', thinkingSignature: 'reasoning_content' },
      { type: 'toolCall', id: `call-${requests}`, name: 'fixture_read', arguments: { path: 'missing.txt' } }],
      provider: 'home-qwen', model: 'orcarouter-qwen3.8-27b', api: 'openai-completions', stopReason: 'toolUse', usage, timestamp: Date.now() };
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'toolUse', message: response }); stream.end(response); });
    return stream;
  };
  const manager = sdk.SessionManager.create(dir, dir);
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    additionalExtensionPaths: [resolve('loop-guard.ts')], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const created = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel('home-qwen', 'orcarouter-qwen3.8-27b'),
    sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: 'builtin',
    customTools: [{ name: 'fixture_read', label: 'Fixture', description: 'Synthetic missing file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => { executions++; return { content: [{ type: 'text', text: '404: Not Found' }], details: {} }; } }] });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  await session.bindExtensions({ mode: 'json', onError: e => { throw Error(JSON.stringify(e)); } });
  await session.prompt('Read missing.txt.');
  assert.equal(requests, 4); assert.equal(executions, 3); assert(session.isIdle);
  const branch = manager.getBranch();
  const rawThinking = branch.filter(e => e.message?.role === 'assistant' && e.message.content.some(c => c.type === 'thinking'));
  assert.equal(rawThinking.length, 4, 'Original reasoning must remain in the saved session');
  const messages = manager.buildSessionProjection().messages;
  assert.equal(withoutReplayedThinking(messages, { provider: 'other', id: 'other' }), messages);
  const completed = branch.filter(e => !(e.type === 'message' && e.message.toolCallId === 'call-4'));
  const event = { toolName: 'fixture_read', input: { path: 'missing.txt' } };
  assert.equal(repeatedFailure(completed, event).count, 3);
  assert.equal(repeatedFailure([...completed, { type: 'compaction', summary: 'State', id: 'mock-compact' }], event).count, 3);
  assert.equal(repeatedFailure(completed, { ...event, input: { path: 'different.txt' } }), undefined);
  assert.equal(repeatedFailure([...completed, { type: 'message', message: { role: 'user', content: 'Retry now.' } }], event), undefined);
  const success = structuredClone(completed);
  for (const e of success) if (e.message?.role === 'toolResult') { e.message.isError = false; e.message.content = [{ type: 'text', text: 'Still running' }]; }
  assert.equal(repeatedFailure(success, event), undefined, 'Legitimate polling must not be treated as a failure loop');
  const changed = structuredClone(completed);
  changed.find(e => e.message?.toolCallId === 'call-3').message.content = [{ type: 'text', text: 'Error: different failure' }];
  assert.equal(repeatedFailure(changed, event), undefined);
  const raw = await readFile(manager.getSessionFile(), 'utf8');
  const result = recoverLoop(manager, sdk.SessionManager);
  const restored = sdk.SessionManager.open(result.path);
  assert.equal(result.repetitions, 3);
  for (const e of branch) assert.equal(JSON.stringify(restored.getEntry(e.id)), JSON.stringify(e));
  assert.equal(restored.buildSessionProjection().messages.filter(m => m.role === 'toolResult').length, 1);
  assert.equal(await readFile(manager.getSessionFile(), 'utf8'), raw);
  console.log(JSON.stringify({ pi: JSON.parse(await readFile(join(sdk.getPackageDir(), 'package.json'), 'utf8')).version, realAgentLoopTerminated: true, providerRequests: requests, toolExecutions: executions,
    successfulPollingAllowed: true, changedResultsAllowed: true, compactionCannotResetGuard: true,
    newUserCanRetry: true, recoveredProjectionKeepsOnePair: true, fullArchivePreserved: true,
    compactorNotLoaded: true, staleThinkingExcludedFromRequests: true, rawThinkingPreserved: true,
    otherProvidersUnchanged: true, apiCalls: 0 }, null, 2));
} finally {
  session?.dispose(); await rm(dir, { recursive: true, force: true });
  if (agentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = agentDirEnv;
}
