import { SessionManager, estimateTokens, getAgentDir, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import { Type } from "typebox";
import { compact, recall, messageText, MARKER, LIMITS } from "./compact.ts";
import { prepareInit } from "./init.ts";
import { loadConfig, resolveKey } from "./config.ts";

const VERSION = "0.3.1";

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let mode: "fast" | "summary" = "fast";
  const config = loadConfig(getAgentDir());
  // Notices are invisible in print/json mode: a native fallback is also recorded in the session.
  let pendingFallback: { reason: string; jevKey: string } | undefined;
  const fallBack = (reason: string, jevKey: string) => { pendingFallback = { reason, jevKey }; };
  const conflicting = () => pi.getActiveTools().some(name => ["compress", "decompress", "acp_status"].includes(name));
  pi.registerCommand("jev-compact", {
    description: "Jev compact init | status | fast | summary | on | off (default: fast)",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "init") {
        if (!enabled || conflicting()) { ctx.ui.notify("Enable Jev compact and disable other compactors before init.", "warning"); return; }
        let result;
        try {
          // Pi 0.87.1 does not export this helper at the package root.
          const { prepareCompaction } = await import(pathToFileURL(join(getPackageDir(), "dist/core/compaction/compaction.js")).href);
          const active = new Set(pi.getActiveTools());
          const fixedContext = ctx.getSystemPrompt() + JSON.stringify(pi.getAllTools().filter(t => active.has(t.name)));
          result = await prepareInit(ctx, { SessionManager, estimateTokens, prepareCompaction }, fixedContext);
        } catch (error) { ctx.ui.notify(`Jev init v${VERSION}: ${error instanceof Error ? error.message : String(error)}`, "warning"); return; }
        if (result.status === "already_ok") { ctx.ui.notify(`Jev init v${VERSION}: already below target (~${result.before} / ${result.target} tokens).`, "info"); return; }
        if (result.status === "already_minimal") { ctx.ui.notify(`Jev init v${VERSION}: history is already minimal; the remaining context is mainly system prompt/tools.`, "info"); return; }
        const switched = await ctx.switchSession(result.path, { withSession: async fresh => {
          fresh.ui.notify(`Jev init v${VERSION}: ~${result.before} → ${result.after} tokens (${(100 * result.after / result.contextWindow).toFixed(1)}%; target 45%). Continuing in compacted copy; full originals remain recoverable. Standard fast mode is active.${result.after > result.target ? " History reduced as far as possible; system prompt/tools keep the total above target." : ""}`, "info");
        } });
        if (switched.cancelled) { await rm(result.path, { force: true }); ctx.ui.notify("Jev init cancelled; current session unchanged.", "info"); }
        return;
      }
      if (action === "on") enabled = true;
      else if (action === "off") enabled = false;
      else if (action === "fast" || action === "summary") { mode = action; enabled = true; }
      else if (action && action !== "status") { ctx.ui.notify("Usage: /jev-compact [init|status|fast|summary|on|off]", "warning"); return; }
      const latest = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "compaction" && (e.details as any)?.engine === MARKER);
      ctx.ui.notify(JSON.stringify({ version: VERSION, enabled, mode, conflict: conflicting(), jevKey: resolveKey(config).source,
        configError: config.error ?? null, last: (latest?.details as any)?.metrics ?? null }), "info");
    },
  });
  pi.registerTool({
    name: "jev_recall", label: "Recall compacted history",
    description: "Search original messages on this session branch (exact phrase, else messages containing every word). Read an entry by id with offset pagination. Recover exact details omitted by compaction.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()), id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const result = recall(ctx.sessionManager.getBranch(), params);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
  pi.on("session_compact", event => {
    if (pendingFallback && !event.fromExtension) pi.appendEntry("pi-jev-compact-fallback", { version: VERSION, ...pendingFallback });
    pendingFallback = undefined;
  });
  pi.on("session_before_compact", async (event, ctx) => {
    pendingFallback = undefined;
    if (!enabled) return;
    const { key, source } = resolveKey(config);
    if (conflicting()) {
      ctx.ui.notify("Jev compact inactive: another compactor exposes compress/decompress/acp_status.", "warning");
      fallBack("conflicting_compactor", source);
      return;
    }
    try {
      const currentUser = [...ctx.sessionManager.buildSessionProjection().messages].reverse().find(m => m.role === "user");
      const result = await compact(event, {
        key,
        activeGoal: currentUser ? messageText(currentUser) : undefined,
        summarize: mode === "summary" && ctx.model ? async (prompt, signal) => {
          const stream = ctx.modelRegistry.streamSimple(ctx.model!, { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
            { maxTokens: LIMITS.outputTokens, reasoning: "off", signal, cacheRetention: "none" });
          return stream.result();
        } : undefined,
      });
      if (result.cancel) {
        if (event.signal.aborted) return { cancel: true };
        ctx.ui.notify(`Jev compact: using native compaction (${result.reason}).`, "info");
        fallBack(result.reason, source);
        return;
      }
      return result;
    } catch {
      if (event.signal.aborted) return { cancel: true };
      ctx.ui.notify("Jev compact unavailable; using native compaction.", "warning");
      fallBack("error", source);
      return;
    }
  });
}
