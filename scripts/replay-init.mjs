// Offline bootstrap replay: source is never changed or sent to a provider.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sdk, piRoot } from './pi-sdk.mjs';
import { prepareInit } from '../init.ts';
import { compact, recall, MARKER } from '../compact.ts';
const source = process.argv[2];
if (!source) throw Error('Usage: node scripts/replay-init.mjs /path/to/session.jsonl');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(await readFile(source));
const dir = await mkdtemp(join(tmpdir(), 'jev-init-replay-'));
const { prepareCompaction } = await import(pathToFileURL(join(piRoot, 'dist/core/compaction/compaction.js')));
try {
  const path = join(dir, 'session.jsonl'); await copyFile(source, path);
  const manager = sdk.SessionManager.open(path);
  const originals = structuredClone(manager.getBranch());
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
  // Reproduce the user running init after an ordinary compact.
  const preparation = prepareCompaction(manager.getBranch(), settings);
  if (preparation) {
    const r = await compact({ preparation, branchEntries: manager.getBranch(), signal: new AbortController().signal });
    assert(r.compaction);
    const c = r.compaction;
    manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  }
  const ctx = { cwd: manager.getCwd(), sessionManager: manager, model: { contextWindow: 65536 },
    waitForIdle: async () => {}, hasPendingMessages: () => false, isIdle: () => true, getContextUsage: () => undefined };
  const result = await prepareInit(ctx, { ...sdk, prepareCompaction }, '');
  assert.equal(result.status, 'ready');
  const fork = sdk.SessionManager.open(result.path);
  const latest = fork.getBranch().at(-1);
  assert.equal(latest.details.engine, MARKER);
  assert(latest.details.metrics.checkpointEstimate <= 2400);
  assert(result.after <= result.target);
  for (const entry of originals) assert.equal(JSON.stringify(fork.getEntry(entry.id)), JSON.stringify(entry));
  const previous = [...originals].reverse().find(e => e.type === 'compaction');
  const recovered = recall(fork.getBranch(), { id: previous.id });
  assert.equal(recovered.id, previous.id);
  const calls = new Set(); let pairs = 0;
  for (const m of fork.buildSessionProjection().messages) {
    if (m.role === 'assistant') for (const c of m.content) if (c.type === 'toolCall') calls.add(c.id);
    if (m.role === 'toolResult') { assert(calls.has(m.toolCallId)); pairs++; }
  }
  assert.equal(hash(await readFile(source)), originalHash);
  console.log(JSON.stringify({ offlineCopyOnly: true, sourceUnchanged: true, rawEntriesPreserved: originals.length,
    priorCheckpointRecoverable: true, toolPairsValidated: pairs, apiCalls: 0,
    checkpointEstimate: latest.details.metrics.checkpointEstimate, blocks: latest.details.metrics.blocks,
    passes: latest.details.metrics.passes, ...latest.details.metrics.init }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
