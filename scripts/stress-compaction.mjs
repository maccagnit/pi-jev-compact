// Offline: does the checkpoint grow across many compactions, and how much room is left to work?
// Real Pi preparation/boundaries + this extension's compact(); no network, no model. A cancelled
// Jev compaction is modelled as a 2,500-token native summary ("native" in the output).
// Usage: node scripts/stress-compaction.mjs [--impl dir-with-compact.ts] [--compactions 40] [--shape name]
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdk, piRoot } from './pi-sdk.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const impl = resolve(arg('--impl', '.'));
const { compact, tokens } = await import(pathToFileURL(join(impl, 'compact.ts')).href);
const { prepareCompaction } = await import(pathToFileURL(join(piRoot, 'dist/core/compaction/compaction.js')).href);
const WINDOW = 98304, RESERVE = 16384, KEEP = 20000, OVERHEAD = 5000, TRIGGER = WINDOW - RESERVE;
const TARGET = Number(arg('--compactions', 40));

let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const WORDS = 'alpha beta gamma delta value index result config strategy signal order risk window buffer cache stream parse token frame vector matrix filter'.split(' ');
const text = (approxTokens, prefix = '') => {
  // ~10 words ≈ 60 bytes ≈ 20 estimated tokens per line.
  const lines = [];
  for (let n = 0; n < Math.max(1, Math.round(approxTokens / 20)); n++) lines.push(Array.from({ length: 10 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' '));
  return prefix + lines.join('\n');
};
const between = (a, b) => Math.round(a + rand() * (b - a));
// One user turn per call; facts are NOTE lines in the first 12 user turns.
const SHAPES = {
  chatty_coding: () => ({ user: between(100, 400), reads: between(1, 2), readTokens: between(2000, 8000), reply: between(100, 300) }),
  medium_pastes: () => ({ user: between(1000, 3000), reads: 0, readTokens: 0, reply: between(50, 150) }),
  huge_pastes: () => ({ user: 6000, reads: 0, readTokens: 0, reply: 60 }),
  file_heavy: () => ({ user: between(30, 80), reads: 5, readTokens: 1500, reply: between(50, 150) }),
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ role: 'assistant', content, api: 'openai-completions', provider: 'sim', model: 'sim', stopReason: 'stop', usage, timestamp: Date.now() });

async function run(shapeName) {
  seed = 7;
  const shape = SHAPES[shapeName];
  const manager = sdk.SessionManager.inMemory('/sim');
  const context = () => sdk.buildSessionContext(manager.getBranch()).messages.reduce((n, m) => n + sdk.estimateTokens(m), 0) + OVERHEAD;
  const facts = Array.from({ length: 12 }, (_, i) => `# NOTE: the access code for key-${i} is CODE${i}X.`);
  const rows = [];
  let turn = 0, file = 0;
  while (rows.length < TARGET && turn < 5000) {
    const s = shape();
    const fact = turn < facts.length ? `\n${facts[turn]}\n` : '';
    manager.appendMessage({ role: 'user', content: text(s.user, `Turn ${turn}.${fact}`), timestamp: Date.now() });
    for (let r = 0; r < s.reads; r++) {
      const id = `call-${turn}-${r}`, path = `/repo/src/module_${file++}.py`;
      manager.appendMessage(assistant([{ type: 'toolCall', id, name: 'read', arguments: { path } }]));
      manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: text(s.readTokens) }], isError: false, timestamp: Date.now() });
    }
    manager.appendMessage(assistant([{ type: 'text', text: text(s.reply, `Done with turn ${turn}. `) }]));
    turn++;
    const before = context();
    if (before <= TRIGGER) continue;
    const branchEntries = manager.getBranch();
    const preparation = prepareCompaction(branchEntries, { enabled: true, reserveTokens: RESERVE, keepRecentTokens: KEEP });
    if (!preparation) continue;
    const result = await compact({ preparation, branchEntries, signal: new AbortController().signal });
    let mode = 'jev', summary, details;
    if (result.compaction) ({ summary, details } = result.compaction);
    else { mode = `native(${result.reason})`; summary = text(2500, 'Native summary stub. '); details = { readFiles: [], modifiedFiles: [] }; }
    manager.appendCompaction(summary, preparation.firstKeptEntryId, preparation.tokensBefore, details, mode === 'jev');
    const after = context();
    const st = details.state;
    rows.push({ n: rows.length + 1, turn, mode, checkpoint: tokens(summary), pins: st ? st.pins.reduce((a, p) => a + tokens(p.text), 0) : null,
      nPins: st?.pins.length ?? null, files: (details.readFiles?.length ?? 0) + (details.modifiedFiles?.length ?? 0), after, room: TRIGGER - after,
      factsInCheckpoint: facts.filter(f => summary.includes(f)).length });
  }
  return rows;
}

const shapes = arg('--shape') ? [arg('--shape')] : Object.keys(SHAPES);
const out = {};
for (const name of shapes) {
  const rows = await run(name);
  const rooms = rows.map(r => r.room).sort((a, b) => a - b);
  out[name] = { compactions: rows.length, native: rows.filter(r => r.mode !== 'jev').length,
    checkpoint: { first: rows[0]?.checkpoint, max: Math.max(...rows.map(r => r.checkpoint)), last: rows.at(-1)?.checkpoint },
    roomMin: rooms[0], roomMedian: rooms[Math.floor(rooms.length / 2)], factsLast: rows.at(-1)?.factsInCheckpoint,
    trajectory: rows.map(r => `${r.checkpoint}${r.mode === 'jev' ? '' : '*'}`).join(' '), rows };
  console.error(`${name}: ${rows.length} compactions, room min ${rooms[0]}, checkpoint max ${out[name].checkpoint.max}`);
}
console.log(JSON.stringify(out, null, 1));
