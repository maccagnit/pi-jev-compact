#!/usr/bin/env python3
"""Long-session growth benchmark: many compactions, short user turns, bulky tool output.

Each turn asks the model to read one ~6k-token file with the `read` tool and acknowledge it, so
the context is dominated by tool results (the shape of real coding work). 12 codes are planted
in user messages and 12 inside the files; 3 of each are corrected later. Records, per
compaction, the summary/checkpoint size and the context left afterwards, then quizzes the model
separately on user-told and file-read codes. File tools only (read, ls + jev_recall): no bash.
Run one job at a time on a single-slot model server.
"""
import argparse, glob, json, os, random, shlex, shutil, subprocess, sys, time

CHARS_PER_TOKEN = 3.8


def corpus():
    files = sorted(glob.glob(os.path.join(os.path.dirname(os.__file__), "*.py")))
    random.Random(11).shuffle(files)
    for f in files:
        try:
            yield open(f, encoding="utf-8").read()
        except Exception:
            pass


def code(rng):
    return "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))


def plan(turns, rng):
    names = ["vault", "relay", "beacon", "cipher", "harbor", "lantern", "falcon", "quarry", "orchid", "glacier", "mantis",
             "ember", "nomad", "pylon", "saffron", "tundra", "zephyr", "obelisk", "kestrel", "marrow", "onyx", "prism", "sable", "talon"]
    rng.shuffle(names)
    facts = [{"key": f"{n}-{rng.randint(100, 999)}", "value": code(rng), "source": "user" if i < 12 else "file"} for i, n in enumerate(names)]
    for group in ("user", "file"):
        for f in rng.sample([x for x in facts if x["source"] == group], 3):
            f["old"], f["value"] = f["value"], code(rng)
    user_turn, file_turn, corr = {}, {}, {}
    for i, f in enumerate([x for x in facts if x["source"] == "user"]):
        user_turn.setdefault(1 + i, []).append(f"# NOTE: the access code for {f['key']} is {f.get('old', f['value'])}.")
    for i, f in enumerate([x for x in facts if x["source"] == "file"]):
        file_turn.setdefault(13 + i, []).append(f"# NOTE: the access code for {f['key']} is {f.get('old', f['value'])}.")
    late = list(range(turns // 2, turns // 2 + 6))
    for t, f in zip(late, [x for x in facts if "old" in x]):
        line = (f"# CORRECTION: the access code for {f['key']} has changed. The NEW access code for {f['key']} is "
                f"{f['value']}; the previous code {f['old']} is revoked.")
        (user_turn if f["source"] == "user" else file_turn).setdefault(t, []).append(line)
    return facts, user_turn, file_turn


def pi_turn(args, cwd, text):
    cmd = ["pi", "-p", "--session-id", args.run_id, "--session-dir", os.path.abspath(args.session_dir), "--model", args.pi_model,
           "--tools", "read,ls,jev_recall", "--no-mcp", "--no-approve", *shlex.split(args.pi_args), text]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=args.turn_timeout)
        out, err = p.stdout.strip(), (f"exit {p.returncode}: " + (p.stderr or "")[-300:]) if p.returncode else ""
    except subprocess.TimeoutExpired:
        out, err = "", "timeout"
    return {"wall": round(time.time() - t0, 1), "reply": out[-600:], "error": err}


def score(text, facts):
    import re
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        got = json.loads(m.group(0)) if m else {}
    except Exception:
        got = {}
    return [{"key": f["key"], "want": f["value"], "got": str(got.get(f["key"], "")).strip(), "ok": str(got.get(f["key"], "")).strip() == f["value"],
             "stale": "old" in f and str(got.get(f["key"], "")).strip() == f["old"], "updated": "old" in f} for f in facts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--pi-model", required=True)
    ap.add_argument("--pi-args", default="")
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--session-dir", default="pi-sessions")
    ap.add_argument("--turns", type=int, default=80)
    ap.add_argument("--turn-tokens", type=int, default=6000)
    ap.add_argument("--turn-timeout", type=int, default=1800)
    args = ap.parse_args()
    rng = random.Random(42)
    facts, user_turn, file_turn = plan(args.turns, rng)
    work = os.path.join(args.workdir, args.run_id)
    os.makedirs(work)
    text, chars = "", int(args.turn_tokens * CHARS_PER_TOKEN)
    src = corpus()
    for n in range(1, args.turns + 1):
        while len(text) < chars:
            text += next(src)
        part, text = text[:chars], text[chars:]
        for line in file_turn.get(n, []):
            pos = part.rfind("\n", 0, rng.randint(len(part) // 4, 3 * len(part) // 4)) + 1
            part = part[:pos] + line + "\n" + part[pos:]
        open(os.path.join(work, f"part_{n:03d}.txt"), "w").write(part)
    log = []
    for n in range(1, args.turns + 1):
        notes = "\n".join(user_turn.get(n, []))
        prompt = f"Part {n}: read the file part_{n:03d}.txt and reply with one line: 'ACK {n}' plus any NOTE or CORRECTION lines you saw in it." + (f"\n{notes}" if notes else "")
        r = pi_turn(args, work, prompt)
        log.append({"turn": n, **r})
        print(f"turn {n} {r['wall']}s {r['error'][:60]} | {r['reply'][:80]!r}", flush=True)
    for f in os.listdir(work):
        os.remove(os.path.join(work, f))
    asks = {}
    for group in ("user", "file"):
        keys = ", ".join(f["key"] for f in facts if f["source"] == group)
        where = "that I told you in my messages" if group == "user" else "that appeared inside the files you read"
        q = (f"The files have been deleted. From memory (you may use any session-history tool you have), list the CURRENT access "
             f"code {where} for each of: {keys}. If a code was changed, give the new one. Reply with ONLY a JSON object mapping identifier to code.")
        r = pi_turn(args, work, q)
        log.append({"turn": f"quiz_{group}", **r})
        asks[group] = score(r["reply"], [f for f in facts if f["source"] == group])
        ok = sum(x["ok"] for x in asks[group])
        print(f"quiz {group}: {ok}/12 updated {sum(x['ok'] for x in asks[group] if x['updated'])}/3 stale {sum(x['stale'] for x in asks[group])}", flush=True)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs("results", exist_ok=True)
    json.dump({"turns": log, "facts": facts, "score": asks}, open(f"results/{args.name}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
