// Regression: exercise hot reload in ONE Node process, including legacy ESM.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sdk } from './pi-sdk.mjs';
const dir = await mkdtemp(join(tmpdir(), 'jev-hot-reload-'));
let session;
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
try {
  const extensionDir = join(dir, 'extension'); await mkdir(extensionDir);
  const sources = Object.fromEntries(await Promise.all(['index', 'init', 'compact', 'jev', 'config'].map(async name =>
    [name, await readFile(resolve(`${name}.ts`), 'utf8')])));
  const staleError = 'Init cannot reach the 45% target safely (fallback_exceeds_budget). Current session unchanged.';
  const legacy = text => text.replaceAll('./init.ts', './init.mjs').replaceAll('./compact.ts', './compact.mjs').replaceAll('./jev.ts', './jev.mjs');
  const version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
  await writeFile(join(extensionDir, 'index.ts'), legacy(sources.index));
  await writeFile(join(extensionDir, 'config.ts'), sources.config);
  for (const name of ['compact', 'jev']) await writeFile(join(extensionDir, `${name}.mjs`), legacy(sources[name]));
  await writeFile(join(extensionDir, 'init.mjs'), `export async function prepareInit(){throw new Error(${JSON.stringify(staleError)})}`);
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 0 } });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-store.json'), refreshOnCreate: false });
  runtime.registerProvider('test', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  runtime.streamSimple = () => { throw Error('No API calls allowed in reload test'); };
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    additionalExtensionPaths: [join(extensionDir, 'index.ts')], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Reload fixture.' });
  await loader.reload();
  const created = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel('test', 'fixture'),
    sessionManager: sdk.SessionManager.create(dir, dir), settingsManager: settings, resourceLoader: loader });
  session = created.session; assert.deepEqual(created.extensionsResult.errors, []);
  const notifications = [];
  await session.bindExtensions({ mode: 'json', uiContext: { notify: text => notifications.push(text) },
    onError: e => { throw Error(JSON.stringify(e)); }, commandContextActions: { waitForIdle: () => session.waitForIdle() } });
  const init = async () => { await session.prompt('/jev-compact init'); return notifications.at(-1); };
  assert((await init()).includes(staleError));
  await writeFile(join(extensionDir, 'init.mjs'), legacy(sources.init));
  await session.reload();
  assert((await init()).includes(staleError), 'Native ESM remains cached despite a real Pi reload');
  // Migrate the same running process to the fixed, reloadable dependency graph.
  for (const [name, text] of Object.entries(sources)) await writeFile(join(extensionDir, `${name}.ts`), text);
  await session.reload();
  const repaired = await init();
  assert(repaired.includes(`v${version}`) && repaired.includes('already below target'), repaired);
  // Later edits must also reload: init, ordinary compactor and transitive selector.
  await writeFile(join(extensionDir, 'init.ts'), sources.init.replace('contextWindow * 0.45', 'contextWindow * 0.44'));
  await writeFile(join(extensionDir, 'compact.ts'), sources.compact.replace('pi-jev-compact/v1', 'reload-marker'));
  await writeFile(join(extensionDir, 'jev.ts'), sources.jev.replace('status: "missing_key"', 'status: "reloaded-selector"'));
  await session.reload();
  assert((await init()).includes('/ 28835 tokens'), notifications.at(-1));
  const manager = session.sessionManager;
  manager.appendMessage({ role: 'user', content: 'Keep RELOAD_SENTINEL.', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'fixture', name: 'read', arguments: { path: '/fixture/output' } }],
    api: 'openai-completions', provider: 'test', model: 'fixture', stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'fixture', toolName: 'read', content: [{ type: 'text', text: 'tool output\n'.repeat(1500) }], isError: false, timestamp: Date.now() });
  manager.appendMessage({ role: 'user', content: 'Continue the task.', timestamp: Date.now() });
  session.refreshContext();
  const result = await session.compact();
  assert.equal(result.details.engine, 'reload-marker');
  assert.equal(result.details.metrics.jev, 'reloaded-selector');
  assert(result.summary.includes('RELOAD_SENTINEL'));
  await session.prompt('/jev-compact status');
  assert.equal(JSON.parse(notifications.at(-1)).version, version);
  console.log(JSON.stringify({ node: process.version, sameProcess: true, legacyReloadFailureReproduced: true,
    migrationWithoutRestart: true, initReloads: true, compactReloads: true, transitiveSelectorReloads: true,
    visibleVersion: version, apiCalls: 0 }, null, 2));
} finally {
  session?.dispose();
  if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  await rm(dir, { recursive: true, force: true });
}
