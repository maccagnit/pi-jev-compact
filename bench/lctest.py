#!/usr/bin/env python3
"""Long-context tests for the workstation Qwen endpoint.

  needle  : one big prompt (16k..90k tokens) of real text with planted facts + updated facts;
            checks exact recall, prefill speed and that an over-window prompt fails cleanly.
  session : a multi-turn "agent-like" session that grows past the 98k window, planting facts
            early (some later updated), then asks for all of them. Run it direct (control)
            and through the billion-context proxy (--base http://127.0.0.1:8799/bili/<upstream>).

Filler is real Python stdlib source (high entropy, not lorem). Results go to results/<name>.json.

Endpoint/model come from flags or LCTEST_* env vars. The bearer key is LCTEST_API_KEY, else the
key of --auth-provider in ~/.pi/agent/auth.json. With --pi, turns go through `pi -p`; pass the
extension set under test with --pi-args (see bench/README.md). Run each job alone: one GPU slot.
"""
import argparse, glob, json, os, random, re, shlex, sys, time, urllib.request, urllib.error

CHARS_PER_TOKEN = 3.8  # calibrated from server prompt_tokens on this filler; refined at runtime
MODEL = KEY = None  # set from args in __main__


def load_key(provider):
    if os.environ.get("LCTEST_API_KEY"):
        return os.environ["LCTEST_API_KEY"]
    if not provider:
        return None
    auth = json.load(open(os.path.expanduser("~/.pi/agent/auth.json")))
    return (auth.get(provider) or {}).get("key")


def filler_corpus():
    files = sorted(glob.glob(os.path.join(os.path.dirname(os.__file__), "*.py")))
    random.Random(7).shuffle(files)
    for f in files:
        try:
            yield os.path.basename(f), open(f, encoding="utf-8").read()
        except Exception:
            pass


def chat(base, messages, max_tokens=1024, think=False, timeout=1800, tools=None):
    body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": think}}
    if tools:
        body["tools"] = tools
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {KEY}"} if KEY else {})}
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode(errors="replace")[:600], "wall": time.time() - t0}
    except Exception as e:
        return {"error": type(e).__name__, "body": str(e)[:600], "wall": time.time() - t0}
    d["wall"] = time.time() - t0
    return d


def pi_chat(args, sys_text, user_text, timeout=1800):
    """One turn through the real Pi agent (its extensions + native compaction). History lives in Pi's session."""
    import subprocess
    # No built-in tools or MCP: the model cannot run commands during a benchmark.
    cmd = ["pi", "-p", "--session-id", f"lctest-{args.run_id or 'pi'}", "--session-dir", os.path.abspath(args.session_dir),
           "--model", args.pi_model, "--no-builtin-tools", "--no-mcp", *shlex.split(args.pi_args),
           "--append-system-prompt", sys_text, user_text]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": "timeout", "body": "", "wall": time.time() - t0}
    if p.returncode != 0:
        return {"error": f"exit {p.returncode}", "body": (p.stderr or p.stdout)[-600:], "wall": time.time() - t0}
    return {"choices": [{"message": {"content": p.stdout.strip()}, "finish_reason": None}],
            "usage": {"prompt_tokens": None}, "timings": {}, "wall": time.time() - t0}


def rnd_code(rng, n=8):
    return "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(n))


def make_facts(rng, n, n_updates):
    names = rng.sample(["vault", "relay", "beacon", "cipher", "harbor", "lantern", "falcon", "quarry", "orchid",
                        "glacier", "mantis", "ember", "nomad", "pylon", "saffron", "tundra", "zephyr", "obelisk",
                        "kestrel", "marrow"], n)
    facts = [{"key": f"{nm}-{rng.randint(100, 999)}", "value": rnd_code(rng)} for nm in names]
    for f in rng.sample(facts, n_updates):
        f["old"] = f["value"]
        f["value"] = rnd_code(rng)
    return facts


def fact_line(f, updated=False):
    if updated:
        return f"\n# CORRECTION: the access code for {f['key']} has been changed. The NEW access code for {f['key']} is {f['value']}. The previous code {f['old']} is revoked.\n"
    return f"\n# NOTE: the access code for {f['key']} is {f.get('old', f['value'])}.\n"


QUESTION = ("Using only the material above, list the CURRENT access code for each of these identifiers: {keys}. "
            "If a code was changed, give the new one. Reply with a single JSON object mapping identifier to code, nothing else.")


def score(answer_text, facts):
    m = re.search(r"\{.*\}", answer_text or "", re.S)
    try:
        got = json.loads(m.group(0)) if m else {}
    except Exception:
        got = {}
    rows = []
    for f in facts:
        g = str(got.get(f["key"], "")).strip()
        rows.append({"key": f["key"], "want": f["value"], "got": g, "ok": g == f["value"],
                     "stale": bool(f.get("old")) and g == f["old"], "updated": "old" in f})
    return rows


# ---------------------------------------------------------------- needle mode
def build_haystack(target_tokens, facts, rng):
    chunks, size = [], 0
    for name, txt in filler_corpus():
        piece = f"\n\n===== file: {name} =====\n{txt}"
        chunks.append(piece); size += len(piece)
        if size >= target_tokens * CHARS_PER_TOKEN:
            break
    text = "".join(chunks)[: int(target_tokens * CHARS_PER_TOKEN)]
    # originals spread over 5%..70% depth, corrections later (75%..95%) so "latest wins" is testable
    inserts = []
    for i, f in enumerate(facts):
        inserts.append((0.05 + 0.65 * i / max(1, len(facts) - 1), fact_line(f)))
        if "old" in f:
            inserts.append((rng.uniform(0.75, 0.95), fact_line(f, updated=True)))
    for depth, line in sorted(inserts, reverse=True):
        pos = text.rfind("\n", 0, int(len(text) * depth)) + 1
        text = text[:pos] + line + text[pos:]
    return text


def run_needle(args):
    global CHARS_PER_TOKEN
    out = []
    for target in args.sizes:
        rng = random.Random(target)
        facts = make_facts(rng, args.facts, args.updates)
        hay = build_haystack(target, facts, rng)
        q = QUESTION.format(keys=", ".join(f["key"] for f in facts))
        d = chat(args.base, [{"role": "user", "content": hay + "\n\n" + q}], max_tokens=1024)
        if "error" in d:
            print(f"[{target}] ERROR {d['error']}: {d['body'][:300]}"); out.append({"target": target, **d}); continue
        pt = d["usage"]["prompt_tokens"]
        CHARS_PER_TOKEN = len(hay) / pt  # refine for next size
        rows = score(d["choices"][0]["message"].get("content"), facts)
        t = d.get("timings", {})
        res = {"target": target, "prompt_tokens": pt, "recall": sum(r["ok"] for r in rows), "n": len(rows),
               "updated_ok": sum(r["ok"] for r in rows if r["updated"]), "updated_n": sum(r["updated"] for r in rows),
               "stale": sum(r["stale"] for r in rows), "prefill_tok_s": round(t.get("prompt_per_second", 0)),
               "gen_tok_s": round(t.get("predicted_per_second", 0)), "wall_s": round(d["wall"]),
               "finish": d["choices"][0].get("finish_reason"), "rows": rows}
        print(f"[{target}] prompt={pt} recall={res['recall']}/{res['n']} updated={res['updated_ok']}/{res['updated_n']} "
              f"stale={res['stale']} prefill={res['prefill_tok_s']} tok/s wall={res['wall_s']}s", flush=True)
        out.append(res)
    if args.overflow:
        hay = build_haystack(args.overflow, make_facts(random.Random(1), 4, 0), random.Random(1))
        d = chat(args.base, [{"role": "user", "content": hay + "\n\nSummarize in one line."}], max_tokens=64)
        res = {"target": args.overflow, "overflow_test": True,
               "error": d.get("error"), "body": d.get("body"),
               "prompt_tokens": d.get("usage", {}).get("prompt_tokens"),
               "answer": (d.get("choices") or [{}])[0].get("message", {}).get("content")}
        print(f"[overflow {args.overflow}] -> {res['error'] or 'NO ERROR'} {str(res['body'] or res['answer'])[:200]}")
        out.append(res)
    return out


# ---------------------------------------------------------------- session mode
def run_session(args):
    rng = random.Random(42)
    facts = make_facts(rng, args.facts, args.updates)
    corpus = filler_corpus()
    # schedule: originals in turns 1..N/3, corrections in turns N/2..2N/3, question at the end
    turns = args.turns
    plan = {i: [] for i in range(1, turns + 1)}
    for i, f in enumerate(facts):
        plan[1 + i * max(1, turns // 3) // len(facts)].append(fact_line(f))
        if "old" in f:
            plan[rng.randint(turns // 2, 2 * turns // 3)].append(fact_line(f, updated=True))
    sys_msg = {"role": "system", "content": "You are a code-review assistant. The user pastes source files in parts. "
               "For each part reply with ONE short line: 'ACK part <n>: <file names>'. Remember every NOTE and CORRECTION."
               + (f" [run {args.run_id}]" if args.run_id else "")}
    msgs, log = [sys_msg], []
    chars_per_turn = int(args.turn_tokens * CHARS_PER_TOKEN)
    buf = ""
    for n in range(1, turns + 1):
        while len(buf) < chars_per_turn:
            name, txt = next(corpus); buf += f"\n\n===== file: {name} =====\n{txt}"
        part, buf = buf[:chars_per_turn], buf[chars_per_turn:]
        for line in plan[n]:
            pos = part.rfind("\n", 0, rng.randint(len(part) // 4, 3 * len(part) // 4)) + 1
            part = part[:pos] + line + part[pos:]
        tag = f"[session {args.run_id}] " if args.run_id and n == 1 else ""  # unique first message: bili keys sessions on it
        msgs.append({"role": "user", "content": f"{tag}Part {n}:\n{part}"})
        d = pi_chat(args, sys_msg["content"], msgs[-1]["content"]) if args.pi else chat(args.base, msgs, max_tokens=args.max_tokens)
        entry = {"turn": n, "facts_planted": len(plan[n])}
        if "error" in d:
            entry.update(error=d["error"], body=d["body"][:300]); log.append(entry)
            print(f"turn {n}: ERROR {d['error']} {d['body'][:200]}", flush=True)
            if not args.keep_going:
                break
            msgs.pop(); continue
        m = d["choices"][0]["message"]
        t = d.get("timings", {})
        entry.update(prompt_tokens=d["usage"]["prompt_tokens"], cached=t.get("cache_n"), new=t.get("prompt_n"),
                     wall=round(d["wall"], 1), finish=d["choices"][0].get("finish_reason"),
                     reply=(m.get("content") or "")[:120], tool_calls=[c["function"]["name"] for c in m.get("tool_calls") or []])
        log.append(entry)
        print(f"turn {n}: prompt={entry['prompt_tokens']} cached={entry['cached']} new={entry['new']} "
              f"wall={entry['wall']}s tools={entry['tool_calls']} reply={entry['reply'][:60]!r}", flush=True)
        msgs.append({"role": "assistant", "content": m.get("content") or ""})
    q = QUESTION.format(keys=", ".join(f["key"] for f in facts))
    msgs.append({"role": "user", "content": q})
    d = pi_chat(args, sys_msg["content"], q) if args.pi else chat(args.base, msgs, max_tokens=max(1024, args.max_tokens))
    final = {"error": d.get("error"), "body": d.get("body")} if "error" in d else {
        "prompt_tokens": d["usage"]["prompt_tokens"], "rows": score(d["choices"][0]["message"].get("content"), facts),
        "answer": d["choices"][0]["message"].get("content"), "raw": d["choices"][0]}
    if "rows" in final:
        r = final["rows"]
        print(f"FINAL prompt={final['prompt_tokens']} recall={sum(x['ok'] for x in r)}/{len(r)} "
              f"updated={sum(x['ok'] for x in r if x['updated'])}/{sum(x['updated'] for x in r)} stale={sum(x['stale'] for x in r)}")
    else:
        print(f"FINAL ERROR {final['error']}: {str(final['body'])[:300]}")
    return {"turns": log, "final": final, "facts": facts}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["needle", "session"])
    ap.add_argument("--base", default=os.environ.get("LCTEST_BASE"), help="OpenAI-compatible base URL (raw modes)")
    ap.add_argument("--model", default=os.environ.get("LCTEST_MODEL"), help="model id sent to --base")
    ap.add_argument("--auth-provider", default=os.environ.get("LCTEST_AUTH_PROVIDER"), help="key name in ~/.pi/agent/auth.json")
    ap.add_argument("--pi-model", default=os.environ.get("LCTEST_PI_MODEL"), help="provider/model for pi --model")
    ap.add_argument("--pi-args", default="", help="extra pi flags, e.g. \"--no-extensions -e ./index.ts\"")
    ap.add_argument("--session-dir", default="pi-sessions")
    ap.add_argument("--name", required=True)
    ap.add_argument("--sizes", type=int, nargs="+", default=[16000, 32000, 64000, 90000])
    ap.add_argument("--overflow", type=int, default=0)
    ap.add_argument("--facts", type=int, default=12)
    ap.add_argument("--updates", type=int, default=4)
    ap.add_argument("--turns", type=int, default=24)
    ap.add_argument("--turn-tokens", type=int, default=6000)
    ap.add_argument("--max-tokens", type=int, default=600)
    ap.add_argument("--run-id", default="")
    ap.add_argument("--pi", action="store_true", help="drive turns through the real Pi agent instead of raw HTTP")
    ap.add_argument("--keep-going", action="store_true")
    a = ap.parse_args()
    if a.pi and not a.pi_model:
        ap.error("--pi needs --pi-model provider/model (or LCTEST_PI_MODEL)")
    if not a.pi and not (a.base and a.model):
        ap.error("raw modes need --base and --model (or LCTEST_BASE / LCTEST_MODEL)")
    MODEL, KEY = a.model, load_key(a.auth_provider)
    res = run_needle(a) if a.mode == "needle" else run_session(a)
    os.makedirs("results", exist_ok=True)
    json.dump(res, open(f"results/{a.name}.json", "w"), indent=1)
