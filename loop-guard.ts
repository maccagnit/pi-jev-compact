import { SessionManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rm } from "node:fs/promises";
import { repeatedFailure, recoverLoop, withoutReplayedThinking } from "./loop.ts";
import { loadConfig } from "./config.ts";

// Independent entrypoint: remains enabled when the Jev compactor is disabled.
export default function (pi: ExtensionAPI) {
  // Thinking is dropped from replayed history only for models listed in stripThinkingModels.
  const { stripThinkingModels } = loadConfig(getAgentDir());
  pi.on("context", (event, ctx) => ({ messages: withoutReplayedThinking(event.messages, ctx.model, stripThinkingModels) }));
  pi.on("tool_call", (event, ctx) => {
    if (event.parentToolCallId) return;
    const run = repeatedFailure(ctx.sessionManager.getBranch(), event);
    if (!run) return;
    const reason = `Stopped repeated tool failure: this identical call already returned the same error ${run.count} times. The next attempt was not executed. Change approach; /loop-recover can restore the session before the repetitions.`;
    if (ctx.hasUI) ctx.ui.notify(reason, "warning");
    return { block: true, terminate: true, reason };
  });
  pi.registerCommand("loop-recover", {
    description: "Recover from repeated identical tool failures in a preserved session copy",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (ctx.hasPendingMessages()) { ctx.ui.notify("Wait for queued messages before recovery.", "warning"); return; }
      const recovery = recoverLoop(ctx.sessionManager, SessionManager);
      if (!recovery) { ctx.ui.notify("No repeated identical failure found in the current turn.", "info"); return; }
      const switched = await ctx.switchSession(recovery.path, { withSession: async fresh => {
        fresh.ui.notify(`Recovered before ${recovery.repetitions - 1} repeated failures. Original history preserved. Send your next message to continue.`, "info");
      } });
      if (switched.cancelled) await rm(recovery.path, { force: true });
    },
  });
}
