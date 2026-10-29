// Per-compaction growth report for a saved Pi session: summary size, context right after the
// compaction (Pi's own estimate, excluding system prompt and tools), and turns between compactions.
// Usage: node scripts/compaction-growth.mjs <session.jsonl> [window=98304] [reserve=16384]
import { readFileSync } from 'node:fs';
import { sdk } from './pi-sdk.mjs';

const [file, window = 98304, reserve = 16384] = process.argv.slice(2);
const entries = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type !== 'session');
const byId = new Map(entries.map(e => [e.id, e]));
const branchTo = entry => { const out = []; for (let e = entry; e; e = e.parentId && byId.get(e.parentId)) out.unshift(e); return out; };
let userTurns = 0, lastAt = 0;
const rows = [];
for (const e of entries) {
  if (e.type === 'message' && e.message.role === 'user') userTurns++;
  if (e.type !== 'compaction') continue;
  const ctx = sdk.buildSessionContext(branchTo(e)).messages.reduce((n, m) => n + sdk.estimateTokens(m), 0);
  const m = e.details?.metrics ?? {};
  rows.push({ n: rows.length + 1, atUserTurn: userTurns, turnsSincePrevious: userTurns - lastAt, engine: e.details?.engine ? 'jev' : 'native',
    summaryTokens: Math.ceil(Buffer.byteLength(e.summary) / 3), contextAfter: ctx, roomBeforeNextTrigger: window - reserve - ctx,
    jev: m.jev ?? null, pins: m.pins ?? null, summaryModelTokens: e.usage?.totalTokens ?? null });
  lastAt = userTurns;
}
console.log(JSON.stringify(rows, null, 1));
