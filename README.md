# Pi Jev Compact

A [Pi](https://github.com/earendil-works/pi) package with two independent extensions:

- **`index.ts`, the Jev compactor.** It replaces Pi's LLM-written compaction summary with a bounded, extractive checkpoint. User requests are kept verbatim, or as labelled excerpts when they're very large. Selected exact evidence is kept, and the [TypeSafe Jev](https://docs.typesafe.ai/introduction/quickstart) API optionally decides what to keep. The full history stays in Pi's session file, and the model can read it back with the `jev_recall` tool.
- **`loop-guard.ts`, the repeated-failure guard.** It stops the 4th identical tool call after three identical errors and offers `/loop-recover`. It can also, optionally, drop stale `thinking` blocks from replayed history for the models you list.

The default compaction mode makes no generative LLM call: at most one Jev request per compaction, and none when no key is configured. Italian version: [README.it.md](README.it.md).

## Install

Requires Pi ≥ 0.87.1 (verified on 0.87.1, 1.0.2 and 1.4.0) and Node ≥ 22.19.

```sh
pi install git:github.com/<owner>/pi-jev-compact        # or: pi install https://github.com/<owner>/pi-jev-compact
pi install git:github.com/<owner>/pi-jev-compact@v0.3.0 # pinned to a tag
pi install ./pi-jev-compact                             # from a local checkout (not copied)
```

Try it for one run without changing settings: `pi -e git:github.com/<owner>/pi-jev-compact`.

Both extensions are enabled after install. Toggle each one with `pi config` (select it, then press Space), then run `/reload` in open sessions.

**Use only one compactor.** Disable other compaction extensions (for example `billion-context`'s `pi-native.js`) before enabling `index.ts`. The extension stands down if it sees the `compress`/`decompress`/`acp_status` tools, but it can't detect every other compactor.

## Configuration

Everything is optional. With no configuration, the compactor runs in local mode and the loop guard filters no models.

### TypeSafe Jev key

The key is looked up at each compaction, in this order:

1. The `TYPESAFE_API_KEY` environment variable of the Pi process.
2. A key file: by default `~/.config/jev/typesafe.key`, or the path in `typesafeApiKeyFile` (config file below). The whole file is the key; surrounding whitespace is ignored.

A key file is the more reliable choice: it works in the TUI, in `pi -p`, and when Pi is started by another tool that doesn't inherit your shell's environment. On a new machine, creating the default file is all the setup needed. Keep it private:

```sh
mkdir -p ~/.config/jev && (umask 077 && printf '%s' 'YOUR_KEY' > ~/.config/jev/typesafe.key)
```

`/jev-compact status` shows where the key came from (`jevKey`: `env`, `file`, `none`, `file_empty` or `file_unreadable`). Each checkpoint records what happened in `details.metrics.jev`: `ok`, `missing_key`, `timeout`, `unavailable` or `input_budget`. Without a key, the extension keeps every selected excerpt (local mode).

### Config file

Path: `<Pi agent dir>/pi-jev-compact.json`, normally `~/.pi/agent/pi-jev-compact.json`; `PI_CODING_AGENT_DIR` moves it. It's read when the extension loads, so run `/reload` after editing it.

```json
{
  "typesafeApiKeyFile": "~/secrets/typesafe.key",
  "stripThinkingModels": ["my-llama-cpp/qwen*"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `typesafeApiKeyFile` | `~/.config/jev/typesafe.key` | File holding the TypeSafe key, used when `TYPESAFE_API_KEY` is unset. `~` is expanded. A missing default file just means local mode. |
| `stripThinkingModels` | `[]` | `provider/model-id` patterns (`*` wildcard). For these models, the loop guard drops earlier `thinking` blocks from the request projection. The saved session is unchanged. This helped a local Qwen escape a 112-call retry loop (see [docs/INCIDENT-2026-10-04.md](docs/INCIDENT-2026-10-04.md)). |

A malformed file never stops Pi from starting: defaults apply, and `/jev-compact status` reports `configError`.

### Pi's own compaction settings

Ordinary compaction keeps Pi's trigger and boundary: it compacts when context exceeds `contextWindow − compaction.reserveTokens` (default 16,384), and keeps the last `compaction.keepRecentTokens` (default 20,000). For a 98,304-token window that means compacting at about 82k and resuming at about 25–30k (system prompt, tools, checkpoint and recent tail). For smaller windows, lower `keepRecentTokens` in `settings.json`, for example to 8000 for a 64k window.

## Commands and tool

```text
/jev-compact status    version, mode, key source, conflicts, metrics of the last checkpoint
/jev-compact fast      default: extractive checkpoint, no generative call
/jev-compact summary   add one bounded summary call to the active model (falls back to fast)
/jev-compact off       hand compaction back to Pi for this process (on re-enables)
/jev-compact init      one-off rescue of an already oversized session (see below)
/compact               Pi's normal command; uses the Jev checkpoint while enabled
/loop-recover          continue from before a repeated-failure loop, in a preserved copy
```

The model gets one tool, `jev_recall`. It takes `query` (case-insensitive substring, 6 matches per page) or `id` (the raw entry, in 4,000-character pages), plus `offset` for paging. It works on the current branch, also after reopening a session.

## How a compaction works

1. Pi's `session_before_compact` hook supplies the messages to replace and the boundary. Pi chooses the boundary, so tool calls and their results stay together.
2. User requests in the replaced span are pinned verbatim and carried across later compactions, newest last. If the verbatim pins can't fit the reclaim budget, they're bounded instead (0.3.0). Each request keeps its complete lines that start with NOTE, CORRECTION, IMPORTANT, must, never, do not, TODO and similar markers. The newest requests then get their first and last lines, or their full text, within 2,400 estimated tokens. Excerpts are labelled with the source entry id. Requests that don't fit are counted, and stay reachable through `jev_recall`.
3. Up to 8 evidence excerpts (complete lines, ≤ 800 characters each) are chosen locally: recent material, matches with the current request, errors and decisions.
4. With a key, Jev classifies each excerpt as KEEP / SUMMARIZE / ARCHIVE / UNCERTAIN. ARCHIVE is applied only at probability ≥ 0.9. Only the shortened current request and the excerpts are sent, after best-effort credential redaction (PEM keys, bearer/basic auth, `key/token/password/secret` assignments including JSON, `sk-`/`ts_`, AWS, GitHub, Slack, Google keys, JWTs, URL credentials). This is not a DLP guarantee.
5. The checkpoint targets 2,400 estimated tokens (UTF-8 bytes / 3, about 25% above real tokens for code). It may grow to carry an earlier summary intact, but it must always free ≥ 512 tokens and ≥ 30% of the span it replaces.
6. If no valid checkpoint can be built (for example too little to reclaim) or the extension fails, Pi's native compaction runs in the same request. Only a user abort cancels. Each fall-through is saved in the session as a `pi-jev-compact-fallback` custom entry (not sent to the model) with the reason, because notices aren't visible in `pi -p`.

### `/jev-compact init`

This is a one-off rescue for a session that is already too large. It makes two local passes (no API calls) and builds a fragment checkpoint aimed at 45% of the window. It then writes it into a **copy** of the session and switches to it; the original stays in `/resume`. It needs a saved session, an idle agent and a model with a known context window. It uses Pi's internal `prepareCompaction` (`dist/core/compaction/compaction.js`), which isn't part of the public API: a future Pi release may break `init` without affecting ordinary compaction.

## Known limits

- An extractive checkpoint loses active context. The originals can be recovered, but the model has to ask for them.
- Verbatim pins can make a checkpoint as large as 70% of what it replaces when that still fits. That frees less space than a summary and compacts more often.
- `summary` mode has never produced an accepted summary from a local Qwen within its 20 s limit. Keep `fast` unless your model is fast.
- Deleting the session file deletes the recoverable originals. `--no-session` sessions keep them only in memory.
- Verified on macOS. Windows and Linux are not verified.

## Development

```sh
npm test                                   # unit tests, no network
PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" npm run test:integration
TYPESAFE_API_KEY=... npm run test:live     # synthetic data only; sends to TypeSafe
```

`PI_PACKAGE_DIR` points at the installed Pi. The tests run against a temporary Pi agent dir, never your real config or key file. `bench/` holds the long-session benchmark ([bench/README.md](bench/README.md)). Measurement history: [docs/VALIDATION.md](docs/VALIDATION.md) and [docs/REVIEW-2026-10-29.md](docs/REVIEW-2026-10-29.md).

## License

MIT, see [LICENSE](LICENSE).
