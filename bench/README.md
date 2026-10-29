# Long-session benchmark

`lctest.py` (Python 3, standard library only) measures whether planted facts survive compaction.

- `session --pi`: 24 user turns of about 6,000 tokens of real Python stdlib source, sent through `pi -p` into one saved session. 12 access codes are planted as `# NOTE:` lines in turns 1–8, and 4 of them are changed by `# CORRECTION:` lines in turns 12–16. A final turn asks for every current code as JSON; the score is exact matches and stale (pre-correction) answers. The total is about 150k tokens, so a 98k window compacts 2–3 times.
- `session` without `--pi`: the same conversation over raw HTTP, with no compaction (a control that overflows).
- `needle`: one large prompt at several sizes; checks recall and prefill speed.

The benchmark model gets no built-in tools and no MCP (`--no-builtin-tools --no-mcp`), so it can't run commands. Pass the extension set under test with `--pi-args`. `--no-extensions` keeps other installed packages, such as memory extensions that write to their own stores, out of the measurement.

```sh
cd /some/output/dir   # results/ and pi-sessions/ are created here
M=provider/model-id
R=/path/to/pi-jev-compact
COMMON="--no-skills --no-context-files --no-prompt-templates"
# Pi native compaction only (loop guard kept for parity)
python3 -I $R/bench/lctest.py session --pi --pi-model $M --name native --run-id native-1 \
  --pi-args "--no-extensions -e $R/loop-guard.ts $COMMON"
# Jev compactor; set TYPESAFE_API_KEY or typesafeApiKeyFile for API mode, unset for local mode
python3 -I $R/bench/lctest.py session --pi --pi-model $M --name jev --run-id jev-1 \
  --pi-args "--no-extensions -e $R/index.ts -e $R/loop-guard.ts $COMMON"
```

Use a new `--run-id` each time: it names the Pi session. Run one job at a time if the model server has a single slot. Afterwards, check the mode each compaction actually ran in from the session file, not from the score. Look at `fromHook`, `details.engine`, `details.metrics.jev`, and `pi-jev-compact-fallback` custom entries.

Raw modes need `--base` and `--model` (or `LCTEST_BASE`/`LCTEST_MODEL`). They use `LCTEST_API_KEY`, or the key of `--auth-provider` in `~/.pi/agent/auth.json`.
