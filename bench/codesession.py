#!/usr/bin/env python3
"""Coding-session benchmark: does the model remember its own work after compaction?

A disposable clone of a real repository is explored, edited and then DELETED; the model is
then quizzed on what it read, what it changed and what the user asked. Unlike lctest.py, the
answers live in tool results and in the model's own edits, not in user messages.

Turns go through `pi -p` (cwd = the clone) with file tools only: read, grep, find, ls, edit,
write (+ jev_recall when that extension is loaded). No bash: the model cannot execute code.
The task script below targets Progetto-AI-Trading (dev); adapt TURNS/KEYS for another repo.
Run one job at a time on a single-slot model server.
"""
import argparse, json, os, re, shlex, shutil, subprocess, sys, time

TOOLS = "read,grep,find,ls,edit,write,jev_recall"

EXPLORE = [
    "We are going to work in this repository, a swing-trading system. Start by reading config.py completely. "
    "Then tell me: the maximum number of concurrent daily positions, the maximum number of weekly-trend positions, "
    "the ATR stop multiplier for trend following and for mean reversion, the drawdown thresholds of the circuit "
    "breaker and of the emergency kill switch, and how many trading days new entries pause after the breaker.",
    "Now read engine/risk.py and engine/exits.py. Which function enforces the circuit breaker, and what does it check "
    "first? Which function sizes positions? In exits.py, what does `ratchet` guarantee?",
    "Read engine/strategy.py. What is the single entry point that produces all signals, and which strategy signal "
    "functions does it combine?",
    "Read engine/market_regime.py and engine/weekly_strategy.py and explain how the SPY gate works.",
]
RULES = ("Some rules for the rest of this session. Never modify anything under live/: that is the production path. "
         "Decision: any new behaviour we add must be default-OFF behind a config flag. After today's work, the next "
         "step will be to run the walk-forward backtest on the dev branch with the new flag enabled. Acknowledge briefly.")
EDITS = [
    "Add a new setting to config.py: a cooldown, in trading days, that blocks re-entering a symbol after it was "
    "stopped out. Follow the file's existing naming and Field style, keep it default-OFF, pick the default yourself "
    "and tell me what you chose. Make the edit.",
    "Now add a small pure helper function in engine/exits.py that, given the date of the last stop-out, the current "
    "date and the cooldown setting, says whether re-entry is blocked. Choose a clear name and add a docstring. "
    "Make the edit.",
    "In engine/portfolio.py, rename the function `apply_reentry_cooldown_v0` to `apply_reentry_cooldown`.",
    "Create a short design note in docs/ for this feature (purpose, the setting name, the helper name, the default). "
    "Choose the file name yourself.",
]
PUSH = [
    "Let's understand backtesting. Read backtest/runner.py; it is long, so read it in chunks. What is the main class, "
    "and how does it model order fills?",
    "Read live/orchestrator.py in chunks (read only; remember the rule). Describe the main scan loop and where "
    "orders are submitted.",
    "Read live/reconciliation.py and summarise what it reconciles and when.",
    "Read backtest/walk_forward.py and backtest/monte_carlo.py. How are the walk-forward folds built, and what does "
    "the Monte Carlo randomise?",
]
GONE = ("The working copy has just been deleted from disk, so files can no longer be read. Answer from what you "
        "remember of this session; you may use any session-history tool you have. ")
QUIZ = [
    ("own_work", GONE + "Reply with ONLY a JSON object with these keys: setting_name, setting_file, setting_default, "
     "helper_name, helper_file, doc_file, failed_change (which requested change could not be made, and why)."),
    ("explored", "Still from memory, reply with ONLY a JSON object with these keys: max_positions, weekly_max_positions, "
     "trend_atr_stop_mult, mr_atr_stop_mult, circuit_breaker_drawdown, kill_switch_drawdown, pause_days, "
     "circuit_breaker_function, sizing_function, signals_entry_point, backtest_main_class."),
    ("user", "Last one, from memory: reply with ONLY a JSON object with keys forbidden_path, decision_rule, next_step, "
     "and summary (a list of at most 6 short strings: what we did in this session, in order)."),
]
# Ground truth read from Progetto-AI-Trading (dev) on 2026-10-29.
EXPLORED_KEY = {"max_positions": "5", "weekly_max_positions": "2", "trend_atr_stop_mult": "3.75",
                "mr_atr_stop_mult": "2.81", "circuit_breaker_drawdown": ["0.1", "10%", "10"],
                "kill_switch_drawdown": ["0.2", "20%", "20"], "pause_days": "5",
                "circuit_breaker_function": "check_portfolio_risk", "sizing_function": "compute_position_size",
                "signals_entry_point": "generate_all_signals", "backtest_main_class": "BacktestRunner"}
SUMMARY_TERMS = ["config", "risk", "strateg", "regime", "cooldown", "helper", "rename", "doc", "backtest",
                 "orchestrator", "reconcil", "walk"]


def pi_turn(args, cwd, text):
    cmd = ["pi", "-p", "--session-id", args.run_id, "--session-dir", os.path.abspath(args.session_dir),
           "--model", args.pi_model, "--tools", TOOLS, "--no-mcp",
           # The repo's own .mcp.json/.claude would trigger an interactive trust prompt: ignore them.
           "--no-approve", *shlex.split(args.pi_args), text]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=args.turn_timeout)
        out, err = p.stdout.strip(), (p.stderr or "")[-400:] if p.returncode else ""
        if p.returncode: err = f"exit {p.returncode}: {err}"
    except subprocess.TimeoutExpired:
        out, err = "", "timeout"
    return {"wall": round(time.time() - t0, 1), "reply": out[-1500:], "error": err}


def git(cwd, *a):
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True).stdout


def answer_json(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except Exception:
        return {}


def norm(v):
    return re.sub(r"[`'\"\s()]", "", str(v)).lower().rstrip(".")


def hit(got, want):
    wants = want if isinstance(want, list) else [want]
    g = norm(got)
    return any(norm(w) == g or (len(norm(w)) > 3 and norm(w) in g) for w in wants)


def own_work_key(diff, created):
    """What the model actually did, from the clone's diff before deletion."""
    added = [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
    field = next((re.match(r"\s*(\w+)\s*:\s*[\w| ]+=\s*Field\((.*)", l) for l in added
                  if re.match(r"\s*\w+\s*:\s*[\w| ]+=\s*Field\(", l)), None)
    default = re.search(r"default\s*=\s*([^,)]+)", field.group(2)).group(1).strip() if field and "default" in field.group(2) else None
    helper = next((re.match(r"def (\w+)", l).group(1) for l in added if l.startswith("def ")), None)
    docs = [f for f in created if f.startswith("docs/")]
    return {"setting_name": field.group(1) if field else None, "setting_file": "config.py", "setting_default": default,
            "helper_name": helper, "helper_file": "engine/exits.py", "doc_file": docs[0] if docs else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="source repository (cloned, never modified)")
    ap.add_argument("--branch", default="dev")
    ap.add_argument("--name", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--pi-model", required=True)
    ap.add_argument("--pi-args", default="")
    ap.add_argument("--workdir", required=True, help="parent dir for the disposable clone")
    ap.add_argument("--session-dir", default="pi-sessions")
    ap.add_argument("--turn-timeout", type=int, default=2400)
    ap.add_argument("--only", type=int, default=0, help="smoke test: run only the first N work turns, no quiz")
    args = ap.parse_args()

    before = (git(args.repo, "rev-parse", "HEAD"), git(args.repo, "status", "--porcelain"))
    clone = os.path.join(args.workdir, args.run_id)
    subprocess.run(["git", "clone", "-q", "--depth", "1", "--branch", args.branch, "file://" + os.path.abspath(args.repo), clone], check=True)
    log = []
    work = [("explore", t) for t in EXPLORE] + [("rules", RULES)] + [("edit", t) for t in EDITS] + [("push", t) for t in PUSH]
    if args.only:
        work = work[:args.only]
    for i, (phase, text) in enumerate(work, 1):
        r = pi_turn(args, clone, text)
        log.append({"turn": i, "phase": phase, **r})
        print(f"turn {i} [{phase}] {r['wall']}s {r['error'][:80]} | {r['reply'][:100]!r}", flush=True)
    diff = git(clone, "diff")
    created = git(clone, "ls-files", "--others", "--exclude-standard").split()
    untracked_text = {f: open(os.path.join(clone, f), errors="replace").read()[:3000] for f in created}
    shutil.rmtree(clone)
    os.makedirs(clone)  # same cwd keeps Pi on the same session; nothing is left to read
    after = (git(args.repo, "rev-parse", "HEAD"), git(args.repo, "status", "--porcelain"))
    res = {"turns": log, "diff": diff, "created": untracked_text, "source_unchanged": before == after}
    if not args.only:
        answers = {}
        for key, text in QUIZ:
            r = pi_turn(args, clone, text)
            log.append({"turn": len(log) + 1, "phase": "quiz_" + key, **r})
            answers[key] = answer_json(r["reply"])
            print(f"quiz {key} {r['wall']}s | {r['reply'][:300]!r}", flush=True)
        own = own_work_key(diff, created)
        score = {
            "own_work": {k: {"want": v, "got": answers["own_work"].get(k), "ok": v is not None and hit(answers["own_work"].get(k, ""), v)}
                         for k, v in own.items()},
            "failed_change": answers["own_work"].get("failed_change"),
            "explored": {k: {"want": v, "got": answers["explored"].get(k), "ok": hit(answers["explored"].get(k, ""), v)}
                         for k, v in EXPLORED_KEY.items()},
            "user": {"forbidden_path": hit(answers["user"].get("forbidden_path", ""), "live"),
                     "decision_rule": "off" in norm(answers["user"].get("decision_rule", "")) and "flag" in norm(answers["user"].get("decision_rule", "")),
                     "next_step": "walk" in norm(answers["user"].get("next_step", ""))},
            "summary_terms": [t for t in SUMMARY_TERMS if t in norm(json.dumps(answers["user"].get("summary", "")))],
        }
        res.update(answers=answers, answer_key_own=own, score=score)
        print(json.dumps({k: (sum(x["ok"] for x in v.values()) if isinstance(v, dict) and k in ("own_work", "explored") else v)
                          for k, v in score.items()}, indent=1))
    shutil.rmtree(clone, ignore_errors=True)
    os.makedirs("results", exist_ok=True)
    json.dump(res, open(f"results/{args.name}.json", "w"), indent=1)
    if not res["source_unchanged"]:
        print("WARNING: source repository changed during the run", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
