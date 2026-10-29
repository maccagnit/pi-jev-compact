import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { modelMatches } from "./config.ts";

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
export const callKey = (name, input) => `${name}:${canonical(input)}`;

export function withoutReplayedThinking(messages, model, patterns = []) {
  if (!modelMatches(patterns, model)) return messages;
  // Only the request projection changes. Keep the raw trace for display/archive,
  // and keep every tool call/result and visible assistant response unchanged.
  return messages.map(m => m.role === "assistant" && Array.isArray(m.content)
    ? { ...m, content: m.content.filter(c => c.type !== "thinking") } : m)
    .filter(m => m.role !== "assistant" || (m.content?.length ?? 0) > 0);
}

// Reconstruct from raw branch entries: compaction/reload must not reset a loop.
export function failureRun(branch) {
  const calls = new Map();
  let run;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "user") { calls.clear(); run = undefined; }
    if (m.role === "assistant") for (const c of Array.isArray(m.content) ? m.content : [])
      if (c.type === "toolCall") calls.set(c.id, callKey(c.name, c.arguments));
    if (m.role !== "toolResult") continue;
    const key = calls.get(m.toolCallId);
    const content = typeof m.content === "string" ? m.content : (m.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
    // The guard's own blocked result must not erase the failure it just stopped.
    if (content.includes("Stopped repeated tool failure:")) continue;
    const failed = m.isError || /(?:^|\n)(?:404:\s*Not Found|Traceback \(most recent call last\)|Error:|Command exited with code [1-9])/i.test(content);
    if (!key || !failed) { run = undefined; continue; }
    const fingerprint = createHash("sha256").update(content).digest("hex");
    run = run?.key === key && run.fingerprint === fingerprint
      ? { ...run, count: run.count + 1, lastResultId: entry.id }
      : { key, fingerprint, count: 1, firstResultId: entry.id, lastResultId: entry.id };
  }
  return run;
}

export function repeatedFailure(branch, event) {
  const run = failureRun(branch);
  return run && run.count >= 3 && run.key === callKey(event.toolName, event.input) ? run : undefined;
}

export function recoverLoop(manager, SessionManager) {
  const original = manager.getBranch();
  const run = failureRun(original);
  if (!run || run.count < 3) return undefined;
  const source = manager.getSessionFile();
  if (!source) throw new Error("Recovery requires a saved session.");
  const fork = SessionManager.forkFrom(source, manager.getCwd(), manager.getSessionDir());
  try {
    const prefix = original.slice(0, original.findIndex(e => e.id === run.firstResultId) + 1);
    if (JSON.stringify(fork.getBranch(run.firstResultId)) !== JSON.stringify(prefix))
      throw new Error("Saved history changed; recovery stopped before switching sessions.");
    // Retain the first call AND its result; all later entries stay archived in the
    // copied session tree and the original session is never rewritten.
    fork.branch(run.firstResultId);
    fork.appendCustomMessageEntry("tool-loop-recovery",
      `Session recovered after ${run.count} identical failed tool calls with unchanged output. The visible history ends at the FIRST of those failures. All later attempts remain in the original session and copied tree. Read the result immediately above: repeating the same call already failed, so do not issue it unchanged. Use a different evidence-based approach, or explain the blocker. Do not restart the completed investigation.`, true,
      { source, firstResultId: run.firstResultId, repetitions: run.count });
    fork.appendSessionInfo("Recovered — repeated tool failure");
    return { path: fork.getSessionFile(), repetitions: run.count, firstResultId: run.firstResultId };
  } catch (error) { rmSync(fork.getSessionFile(), { force: true }); throw error; }
}
