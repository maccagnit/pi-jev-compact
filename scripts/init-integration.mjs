import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sdk, piRoot } from './pi-sdk.mjs';
import { prepareInit } from '../init.ts';
import { recall, MARKER } from '../compact.ts';

const { prepareCompaction } = await import(pathToFileURL(join(piRoot, 'dist/core/compaction/compaction.js')));
const dependencies = { ...sdk, prepareCompaction };
const dir = await mkdtemp(join(tmpdir(), 'pi-jev-init-'));
const oldKey = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
let host;
const notifications = [];
let cancelSwitch = false;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ id: randomUUID(), role: 'assistant', content, api: 'openai-completions',
  provider: 'test', model: 'fixture', stopReason: 'stop', usage, timestamp: Date.now() });
function batch(manager, count) {
  const first = manager.appendMessage({ id: randomUUID(), role: 'user', content: 'Preserve INIT_ACCOUNT_17; do not deploy.', timestamp: Date.now() });
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    manager.appendMessage(assistant([{ type: 'toolCall', id, name: 'read', arguments: { path: `/fixture/${i}` } }]));
    manager.appendMessage({ id: randomUUID(), role: 'toolResult', toolCallId: id, toolName: 'read',
      content: [{ type: 'text', text: `RAW_SENTINEL_${i}\n` + 'diagnostic output\n'.repeat(240) }], isError: false, timestamp: Date.now() });
  }
  manager.appendMessage(assistant([{ type: 'text', text: 'Next: verify tests.' }]));
  return first;
}
function pairs(manager) {
  const seen = new Set();
  for (const m of manager.buildSessionProjection().messages) {
    if (m.role === 'assistant') for (const c of m.content) if (c.type === 'toolCall') seen.add(c.id);
    if (m.role === 'toolResult') assert(seen.has(m.toolCallId));
  }
}
try {
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-store.json'), refreshOnCreate: false });
  runtime.registerProvider('test', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 4096, cost: usage.cost }] });
  runtime.streamSimple = () => { throw new Error('Init must not call the model'); };
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } });
  const originalSettings = structuredClone(settings.getCompactionSettings());
  const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      additionalExtensionPaths: [resolve('index.ts')], noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Synthetic init test.' });
    await loader.reload();
    const result = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
      model: runtime.getModel('test', 'fixture'), sessionManager, settingsManager: settings, resourceLoader: loader, sessionStartEvent });
    assert.deepEqual(result.extensionsResult.errors, []);
    return { ...result, services: { cwd: dir, agentDir: dir } };
  };
  const first = await createRuntime({ sessionManager: sdk.SessionManager.create(dir, dir) });
  host = new sdk.AgentSessionRuntime(first.session, first.services, createRuntime);
  const bind = session => session.bindExtensions({ mode: 'json', uiContext: { notify: (text, level) => notifications.push({ text, level }) },
    onError: e => { throw new Error(JSON.stringify(e)); }, commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      switchSession: (path, options) => cancelSwitch ? Promise.resolve({ cancelled: true }) : host.switchSession(path, options),
    } });
  host.setRebindSession(bind);
  await bind(host.session);
  const source = host.session.sessionManager;
  const kept = batch(source, 50);
  const omitted = source.appendMessage({ id: randomUUID(), role: 'user', content: 'OMITTED_POISON', timestamp: Date.now() });
  source.appendContextEdit(omitted, null);
  const leaf = source.getLeafId();
  source.appendMessage({ id: randomUUID(), role: 'user', content: 'SIBLING_POISON', timestamp: Date.now() });
  source.branch(leaf);
  const previous = 'OLD_CONSTRAINT_42\n' + 'Earlier verified state.\n'.repeat(900);
  source.appendCompaction(previous, kept, 64000, {}, false);
  host.session.refreshContext();
  const path = source.getSessionFile();
  const raw = await readFile(path, 'utf8');
  const originals = structuredClone(source.getBranch());
  assert.equal(prepareCompaction(originals, originalSettings), undefined, 'Native refuses an immediate second compact');
  assert.equal(host.session.getContextUsage().tokens, null);
  // A veto must leave the original selected and remove the unused fork.
  cancelSwitch = true;
  const filesBefore = (await readdir(dir)).sort();
  await host.session.prompt('/jev-compact init');
  assert.equal(host.session.sessionFile, path);
  assert.deepEqual((await readdir(dir)).sort(), filesBefore);
  assert(notifications.at(-1).text.includes('cancelled'), JSON.stringify(notifications));
  cancelSwitch = false;
  await host.session.prompt('/jev-compact init');
  const initialized = host.session.sessionManager;
  assert.notEqual(initialized.getSessionFile(), path, JSON.stringify(notifications));
  assert.equal(initialized.getHeader().parentSession, path);
  assert.equal(await readFile(path, 'utf8'), raw);
  for (const entry of originals) assert.equal(JSON.stringify(initialized.getEntry(entry.id)), JSON.stringify(entry));
  const checkpoint = [...initialized.getBranch()].reverse().find(e => e.type === 'compaction');
  assert.equal(checkpoint.details.engine, MARKER);
  assert(checkpoint.summary.includes('OLD_CONSTRAINT_42'));
  assert(checkpoint.summary.length < previous.length);
  assert(checkpoint.summary.includes('INIT_ACCOUNT_17'));
  const projected = JSON.stringify(initialized.buildSessionProjection().messages);
  assert(!projected.includes('OMITTED_POISON')); assert(!projected.includes('SIBLING_POISON'));
  const metrics = checkpoint.details.metrics;
  assert.equal(metrics.jevRequests, 0); assert.equal(metrics.summary, 'disabled');
  assert(metrics.init.afterEstimate <= metrics.init.targetEstimate);
  assert(notifications.at(-1).text.includes('Standard fast mode'), JSON.stringify(notifications));
  pairs(initialized);
  const found = recall(initialized.getBranch(), { query: 'RAW_SENTINEL_0' });
  assert(found.total > 0);
  assert(recall(sdk.SessionManager.open(initialized.getSessionFile()).getBranch(), { id: found.matches[0].id }).text.includes('RAW_SENTINEL_0'));
  const initPath = initialized.getSessionFile();
  const initRaw = await readFile(initPath, 'utf8');
  await host.session.prompt('/jev-compact init');
  assert.equal(host.session.sessionFile, initPath);
  assert.equal(await readFile(initPath, 'utf8'), initRaw);
  assert(notifications.at(-1).text.includes('already below target'));
  // Normal compact continues using the original 20k tail setting after init.
  batch(initialized, 35); host.session.refreshContext();
  const normal = await host.session.compact();
  assert.equal(normal.details.engine, MARKER); assert.equal(normal.details.metrics.mode, 'extractive');
  assert.equal(normal.details.metrics.init, undefined); pairs(initialized);
  assert.deepEqual(settings.getCompactionSettings(), originalSettings);
  // Oversized historical requests must bootstrap, not repeat fallback_exceeds_budget.
  const protectedManager = sdk.SessionManager.create(dir, dir);
  protectedManager.appendMessage({ id: randomUUID(), role: 'user', content: 'Verbatim instruction. '.repeat(8000), timestamp: Date.now() });
  protectedManager.appendMessage(assistant([{ type: 'text', text: 'Recent tail.' }]));
  const protectedRaw = await readFile(protectedManager.getSessionFile(), 'utf8');
  const ctx = { cwd: dir, sessionManager: protectedManager, model: { contextWindow: 65536 }, waitForIdle: async () => {},
    hasPendingMessages: () => false, isIdle: () => true, getContextUsage: () => undefined };
  const protectedResult = await prepareInit(ctx, dependencies, '');
  assert.equal(protectedResult.status, 'ready');
  assert(protectedResult.after <= protectedResult.target);
  const protectedFork = sdk.SessionManager.open(protectedResult.path);
  assert(recall(protectedFork.getBranch(), { query: 'Verbatim instruction' }).total > 0);
  assert.equal(await readFile(protectedManager.getSessionFile(), 'utf8'), protectedRaw);
  // A single huge final call/result is archived together if no recent cut fits.
  const huge = sdk.SessionManager.create(dir, dir);
  huge.appendMessage({ id: randomUUID(), role: 'user', content: 'Inspect HUGE_PAIR_SENTINEL without deployment.', timestamp: Date.now() });
  huge.appendMessage(assistant([{ type: 'toolCall', id: 'huge-call', name: 'read', arguments: { path: '/fixture/huge' } }]));
  huge.appendMessage({ id: randomUUID(), role: 'toolResult', toolCallId: 'huge-call', toolName: 'read',
    content: [{ type: 'text', text: 'HUGE_PAIR_SENTINEL\n' + 'large output\n'.repeat(20000) }], isError: false, timestamp: Date.now() });
  const hugeResult = await prepareInit({ ...ctx, sessionManager: huge }, dependencies, '');
  assert.equal(hugeResult.status, 'ready');
  assert.equal(hugeResult.compaction.details.metrics.init.keepRecentTokens, null);
  const hugeFork = sdk.SessionManager.open(hugeResult.path);
  pairs(hugeFork);
  assert.equal(hugeFork.buildSessionProjection().messages.filter(m => m.role === 'toolResult').length, 0);
  assert(recall(hugeFork.getBranch(), { query: 'HUGE_PAIR_SENTINEL' }).total > 0);
  // Uncompressible fixed overhead must not turn the target into a refusal.
  const overheadResult = await prepareInit({ ...ctx, sessionManager: huge }, dependencies, 'System instructions. '.repeat(8000));
  assert.equal(overheadResult.status, 'ready');
  assert(overheadResult.after > overheadResult.target);
  assert(overheadResult.after < overheadResult.before);
  assert.equal(overheadResult.compaction.details.metrics.init.targetReached, false);
  await assert.rejects(prepareInit({ ...ctx, hasPendingMessages: () => true }, dependencies, ''), /queued messages/);
  await host.session.prompt('/jev-compact off');
  await host.session.prompt('/jev-compact init');
  assert(notifications.at(-1).text.includes('Enable Jev compact'));
  console.log(JSON.stringify({ initCommandLoaded: true, realRuntimeSwitch: true, immediatePostCompact: true,
    rawEntriesPreserved: originals.length, sourceUnchanged: true, projectionEditsRespected: true, toolPairsValid: true,
    recallAfterReopen: true, repeatInitNoop: true, standardCompactAfterInit: true, settingsUnchanged: true,
    cancelledSwitchCleaned: true, oversizedRequestBootstrap: true, hugeFinalPairArchived: true,
    targetIsNotARefusal: true, queuedMessagesGuard: true, offGuard: true,
    apiCalls: 0, metrics: metrics.init }, null, 2));
} finally {
  host?.session.dispose();
  if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
  await rm(dir, { recursive: true, force: true });
}
