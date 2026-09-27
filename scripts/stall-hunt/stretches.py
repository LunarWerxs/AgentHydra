"""Name what held the daemon's thread: the long synchronous stretches in a Bun .cpuprofile.

When stall-sentinel.ts logs `STALL ... in flight: none (timers/background work)`, no request is to
blame and the log cannot say more. Profile a SIDE daemon (sidebench.py --prof) and run this on the
profile it writes.

HOW IT READS A PROFILE. JSC samples only while the VM is running, so a gap between two samples
longer than GAP_MS is the event loop being free. A run of samples with no such gap is one stretch in
which nothing else - /api/health included - could be answered. Each stretch is named by the app
frames it spent its time in.

CAVEAT. Work that hands the turn back with setImmediate (core/loop-yield.ts) leaves no idle gap when
nothing else is waiting, so a sliced job shows as one long "stretch" here although a request would
have been served between its slices. Trust a stretch only where the health prober also missed.

usage: python stretches.py <file.cpuprofile> [min_ms=300] [gap_ms=25] [--summary]
  --summary  one line per owner (the deepest app frame covering half the stretch), longest first
"""

import collections
import json
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
SUMMARY = "--summary" in sys.argv
path = args[0]
MIN_MS = float(args[1]) if len(args) > 1 else 300
GAP_MS = float(args[2]) if len(args) > 2 else 25

p = json.load(open(path, encoding="utf-8"))
nodes = {n["id"]: n for n in p["nodes"]}
parent = {c: n["id"] for n in p["nodes"] for c in n.get("children", [])}


def is_app(nid):
    return "/src/" in (nodes[nid]["callFrame"].get("url") or "")


def label(nid):
    cf = nodes[nid]["callFrame"]
    url = cf.get("url") or ""
    short = url.rsplit("/src/", 1)[-1] if "/src/" in url else (url.rsplit("/", 1)[-1] or "native")
    return f"{cf['functionName'] or '(anon)'} {short}:{cf['lineNumber'] + 1}"


def stack(nid):
    """Frames from the sampled leaf up to (not including) the root."""
    out = []
    while nid in nodes:
        if nodes[nid]["callFrame"]["functionName"] != "(root)":
            out.append(nid)
        nid = parent.get(nid)
    return out


samples = p["samples"]
times = []
t = p["startTime"]
for d in p["timeDeltas"]:
    t += d
    times.append(t)
t0 = p["startTime"]

runs, cur = [], [0]
for i in range(1, len(samples)):
    if (times[i] - times[i - 1]) / 1000 > GAP_MS:
        runs.append(cur)
        cur = [i]
    else:
        cur.append(i)
runs.append(cur)
long = [(s, (times[s[-1]] - times[s[0]]) / 1000) for s in runs]
long = [(s, d) for s, d in long if d >= MIN_MS]

print(f"profile {(p['endTime'] - t0) / 1e6:.1f}s, {len(samples)} samples, "
      f"{len(long)} stretches >= {MIN_MS:.0f}ms (gap {GAP_MS:.0f}ms)")

if SUMMARY:
    groups = collections.defaultdict(list)
    for s, dur in long:
        incl, depth = collections.Counter(), {}
        for i in s:
            st = stack(samples[i])
            for x in set(st):
                if is_app(x):
                    incl[label(x)] += 1
            for d, x in enumerate(reversed(st)):
                depth[label(x)] = max(depth.get(label(x), 0), d)
        owners = [k for k, v in incl.items() if v >= len(s) * 0.5]
        owner = max(owners, key=lambda k: depth.get(k, 0)) if owners else "(mixed)"
        groups[owner].append(((times[s[0]] - t0) / 1e6, dur))
    for owner, rows in sorted(groups.items(), key=lambda kv: -max(d for _, d in kv[1])):
        at = ",".join(f"{x:.0f}" for x, _ in rows[:8])
        print(f"{len(rows):3}x max {max(d for _, d in rows):5.0f}ms "
              f"sum {sum(d for _, d in rows):6.0f}ms  {owner}  at {at}s")
    sys.exit(0)

for s, dur in long:
    incl, selfc, roots = collections.Counter(), collections.Counter(), collections.Counter()
    for i in s:
        st = stack(samples[i])
        if st:
            selfc[label(st[0])] += 1
            app = [x for x in st if is_app(x)]
            if app:
                roots[label(app[-1])] += 1
        for x in set(st):
            if is_app(x):
                incl[label(x)] += 1
    n = len(s)
    print(f"\n== +{(times[s[0]] - t0) / 1e6:.2f}s  {dur:.0f}ms  ({n} samples)")
    print("   entry: " + ", ".join(f"{k} {v * 100 // n}%" for k, v in roots.most_common(3)))
    print("   incl : " + ", ".join(f"{k} {v * 100 // n}%" for k, v in incl.most_common(8)))
    print("   self : " + ", ".join(f"{k} {v * 100 // n}%" for k, v in selfc.most_common(5)))
