import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { messageText, tokens, MARKER, LIMITS } from "./compact.ts";

// Map/reduce with exact, labelled fragments: no generated claims, no API calls.
// Unlike ordinary compaction, init may archive oversized historical requests and
// summaries. Their complete originals remain reachable by the displayed IDs.
export function bootstrapCheckpoint(projection) {
  const sources = projection.entries.flatMap(e => e.messages.filter(m => m.role !== "system")
    .map(m => ({ ref: e.sourceEntry.id, role: m.role, text: m.summary ?? messageText(m) }))).filter(s => s.text);
  const goal = [...sources].reverse().find(s => s.role === "user");
  const terms = new Set((goal?.text ?? "").toLowerCase().match(/[\p{L}\p{N}_/.-]{5,}/gu)?.slice(-60) ?? []);
  const score = c => Number(c.ref === goal?.ref) * 8 + Number(c.role === "user") * 2 +
    Number(/must|never|do not|constraint|decision|next|pending|error|fail|vincol|non |deve|prossim|errore/i.test(c.text)) * 4 +
    Math.min(3, [...terms].filter(t => c.text.toLowerCase().includes(t)).length);
  const rank = items => [...items].sort((a, b) => score(b) - score(a) || b.order - a.order);
  const partials = [];
  let block = [], blockChars = 0, order = 0, blocks = 0;
  const reduceBlock = () => { if (block.length) { partials.push(...rank(block).slice(0, 4)); blocks++; } block = []; blockChars = 0; };
  for (const s of sources) {
    // Long lines become explicitly labelled fragments, never asserted complete.
    const pieces = s.text.match(/[^\n]{1,800}(?:\s|$)|[^\n]{1,800}/gu) ?? [];
    for (const text of pieces) {
      if (!text.trim()) continue;
      if (blockChars + text.length > 12000) reduceBlock();
      block.push({ ref: s.ref, role: s.role, text: text.trim(), order: order++ }); blockChars += text.length;
    }
  }
  reduceBlock();
  const latestRef = goal?.ref ?? sources.at(-1)?.ref;
  const intro = `Bootstrap checkpoint: incomplete exact fragments, selected in two local passes. Historical requests may be superseded. Earlier full messages and checkpoints remain in this Pi session. Use jev_recall by id to recover missing constraints, code, paths and results before relying on an excerpt.\nLatest request/source to consult: ${latestRef ?? "none"}.\n\n`;
  const evidence = [];
  const seen = new Set();
  let summary = intro;
  // Include the current request intact when small, otherwise bounded fragments.
  if (goal && tokens(goal.text) <= 600) {
    const item = { ref: goal.ref, role: goal.role, text: goal.text };
    evidence.push(item); seen.add(goal.text);
    summary += `[${goal.ref}; user; complete latest request]\n${goal.text}\n\n`;
  }
  for (const c of rank(partials)) {
    if (seen.has(c.text)) continue;
    const quote = `[${c.ref}; ${c.role}; fragment]\n${c.text}\n\n`;
    if (tokens(summary + quote) > LIMITS.checkpointTokens) continue;
    summary += quote; seen.add(c.text); evidence.push({ ref: c.ref, role: c.role, text: c.text });
  }
  return { summary, details: { engine: MARKER, readFiles: [], modifiedFiles: [],
    state: { pins: [], brief: summary, evidence },
    metrics: { mode: "bootstrap", jev: "local_init", jevRequests: 0, summary: "disabled",
      checkpointEstimate: tokens(summary), checkpointTarget: LIMITS.checkpointTokens, blocks, passes: 2 } } };
}

// A local bootstrap, independent of Pi's ordinary compaction trigger/settings.
// The active session is read-only. Only a validated fork is ever opened by Pi.
export async function prepareInit(ctx, { SessionManager, estimateTokens, prepareCompaction }, fixedContext) {
  await ctx.waitForIdle();
  if (ctx.hasPendingMessages()) throw new Error("Wait for queued messages to finish, then retry init.");
  const source = ctx.sessionManager.getSessionFile();
  if (!source) throw new Error("Init requires a saved Pi session.");
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) throw new Error("Select a model with a known context window first.");
  const original = structuredClone(ctx.sessionManager.getBranch());
  const header = ctx.sessionManager.getHeader();
  const projection = ctx.sessionManager.buildSessionProjection();
  const size = manager => manager.buildSessionProjection().messages.filter(m => m.role !== "system").reduce((n, m) => n + estimateTokens(m), 0);
  const visibleBefore = size(ctx.sessionManager);
  // Include system/tools, and any larger overhead observable in provider usage.
  const overhead = Math.max(0, (usage?.tokens ?? 0) - visibleBefore,
    projection.messages.filter(m => m.role === "system").reduce((n, m) => n + estimateTokens(m), 0),
    estimateTokens({ role: "user", content: fixedContext, timestamp: 0 }));
  const before = visibleBefore + overhead;
  const target = Math.floor(contextWindow * 0.45);
  const previous = [...original].reverse().find(e => e.type === "compaction");
  if (before <= target && tokens(previous?.summary ?? "") <= LIMITS.checkpointTokens) return { status: "already_ok", before, target };
  const checkpoint = bootstrapCheckpoint(projection);
  const recent = Math.min(8000, Math.floor(contextWindow / 8));
  let selected;
  // The final candidate archives the entire visible history, including a single
  // enormous final tool pair. undefined is Pi's supported summary-only boundary.
  for (const keepRecentTokens of [...new Set([recent, Math.floor(recent / 2), 0, null])]) {
    const trial = SessionManager.inMemory(ctx.cwd, undefined, [structuredClone(header), ...structuredClone(original)]);
    // No model-visible message: permits preparation immediately after a compact.
    trial.appendCustomEntry("jev-compact-init", {});
    const branchEntries = trial.getBranch();
    const preparation = keepRecentTokens === null ? undefined : prepareCompaction(branchEntries, { enabled: true, reserveTokens: 16384, keepRecentTokens });
    if (keepRecentTokens !== null && !preparation) continue;
    const c = { ...structuredClone(checkpoint), firstKeptEntryId: preparation?.firstKeptEntryId, tokensBefore: before };
    if (c.firstKeptEntryId && !original.some(e => e.id === c.firstKeptEntryId)) throw new Error("Invalid init retention boundary.");
    trial.appendCompaction(c.summary, c.firstKeptEntryId, before, c.details, true, c.usage);
    const after = size(trial) + overhead;
    if (after >= before || (selected && after >= selected.after)) continue;
    c.details.metrics.init = { beforeEstimate: before, afterEstimate: after, targetEstimate: target,
      contextWindow, overheadEstimate: overhead, keepRecentTokens, targetReached: after <= target };
    selected = { compaction: c, before, after, target, contextWindow };
    if (after <= target) break;
  }
  if (!selected) return { status: "already_minimal", before, target };
  const snapshot = JSON.stringify(original);
  if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.sessionManager.getSessionFile() !== source ||
      JSON.stringify(ctx.sessionManager.getBranch()) !== snapshot) throw new Error("Session changed during init; retry when idle.");
  const fork = SessionManager.forkFrom(source, ctx.cwd, dirname(source));
  const path = fork.getSessionFile();
  try {
    fork.branch(original.at(-1).id);
    if (JSON.stringify(fork.getBranch()) !== snapshot) throw new Error("Saved session differs from the active branch; init stopped.");
    const c = selected.compaction;
    fork.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
    if (size(SessionManager.open(path)) + overhead !== selected.after) throw new Error("Init persistence validation failed.");
    return { status: "ready", path, ...selected };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}
