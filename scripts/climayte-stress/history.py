"""Where CliMayte's time and tokens went, from its own record (~/.agenthydra/corch: workers.json and
journal.jsonl). Read-only. Prints the numbers an inefficiency hunt needs: how long work waited
before starting and between attempts, what each attempt outcome cost, how much a move re-read,
which waits recurred, and which tasks were the most expensive for what they did."""
import json
import os
import statistics as st
import sys
from collections import Counter, defaultdict

sys.stdout.reconfigure(encoding='utf8')
ROOT = os.path.expanduser('~/.agenthydra/corch')
ws = json.load(open(os.path.join(ROOT, 'workers.json'), encoding='utf8'))['workers']
ws = list(ws.values()) if isinstance(ws, dict) else ws
journal = [json.loads(l) for l in open(os.path.join(ROOT, 'journal.jsonl'), encoding='utf8') if l.strip()]


def tok(t):
    t = t or {}
    return {k: t.get(k, 0) or 0 for k in ('input', 'output', 'cacheRead', 'cacheWrite')}


def mins(ms):
    return ms / 60000


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0


print(f'{len(ws)} tasks, {sum(len(w.get("attempts") or []) for w in ws)} attempts, {len(journal)} journal lines')
print('status:', dict(Counter(w['status'] for w in ws)))

# start latency and gaps
latency, gaps, walls, runs = [], [], [], []
for w in ws:
    at = w.get('attempts') or []
    if not at:
        continue
    latency.append(at[0]['startedAt'] - w['createdAt'])
    for a, b in zip(at, at[1:]):
        if a.get('endedAt'):
            gaps.append(b['startedAt'] - a['endedAt'])
    ends = [a['endedAt'] for a in at if a.get('endedAt')]
    if ends:
        walls.append(max(ends) - at[0]['startedAt'])
        runs.append(sum((a['endedAt'] - a['startedAt']) for a in at if a.get('endedAt')))
print(f'\nqueue -> first start: median {mins(st.median(latency)):.1f} min, p90 {mins(pct(latency, .9)):.1f}, max {mins(max(latency)):.1f}')
print(f'between attempts:     median {mins(st.median(gaps)):.1f} min, p90 {mins(pct(gaps, .9)):.1f}, max {mins(max(gaps)):.1f}  (n={len(gaps)})')
print(f'first start -> done:  median {mins(st.median(walls)):.1f} min; time actually running is {sum(runs) / max(1, sum(walls)):.0%} of it')

# attempt outcomes: count, time, tokens, dollars
by = defaultdict(lambda: {'n': 0, 'ms': 0, 'out': 0, 'cr': 0, 'cw': 0, 'usd': 0.0, 'resumed': 0, 'nostart': 0})
for w in ws:
    for a in w.get('attempts') or []:
        o = a.get('outcome') or 'running'
        b = by[o]
        b['n'] += 1
        if a.get('endedAt'):
            b['ms'] += a['endedAt'] - a['startedAt']
        t = tok(a.get('tokens'))
        b['out'] += t['output']
        b['cr'] += t['cacheRead']
        b['cw'] += t['cacheWrite']
        sp = a.get('spend') or {}
        b['usd'] += (sp.get('costUsd') or sp.get('usd') or 0) if isinstance(sp, dict) else 0
        b['resumed'] += 1 if a.get('resumed') else 0
        b['nostart'] += 1 if (a.get('started') is False) else 0
print('\nattempt outcome   n   minutes  output-tok  cacheWrite-tok  usd    resumed')
tot_usd = sum(b['usd'] for b in by.values()) or 1
for o, b in sorted(by.items(), key=lambda x: -x[1]['n']):
    print(f'  {o:14} {b["n"]:4} {mins(b["ms"]):8.0f} {b["out"]:11,} {b["cw"]:14,} {b["usd"]:6.2f} ({b["usd"] / tot_usd:.0%}) {b["resumed"]:4}')

# moves: what the first attempt on a new account re-wrote into a cold cache
move_cw, move_usd, same_cw = [], [], []
for w in ws:
    at = w.get('attempts') or []
    for prev, a in zip(at, at[1:]):
        t = tok(a.get('tokens'))
        sp = a.get('spend') or {}
        usd = (sp.get('costUsd') or 0) if isinstance(sp, dict) else 0
        if a['account']['id'] != prev['account']['id'] and a.get('resumed'):
            move_cw.append(t['cacheWrite'])
            move_usd.append(usd)
        elif a.get('resumed'):
            same_cw.append(t['cacheWrite'])
print(f'\nresumed on ANOTHER account: {len(move_cw)} attempts, cacheWrite median {st.median(move_cw) if move_cw else 0:,.0f} tok, ${sum(move_usd):.2f}')
print(f'resumed on the SAME account: {len(same_cw)} attempts, cacheWrite median {st.median(same_cw) if same_cw else 0:,.0f} tok')

# per task: attempts, moves, dollars; the costliest
rows = []
for w in ws:
    at = w.get('attempts') or []
    usd = sum(((a.get('spend') or {}).get('costUsd') or 0) for a in at if isinstance(a.get('spend'), dict))
    rows.append((usd or w.get('costUsd') or 0, len(at), w.get('moves') or 0, w['status'], (w.get('model') or '-'), (w.get('title') or '')[:60]))
print('\nattempts per task:', dict(sorted(Counter(r[1] for r in rows).items())))
print('moves per task:   ', dict(sorted(Counter(r[2] for r in rows).items())))
print('\ncostliest tasks:')
for r in sorted(rows, reverse=True)[:8]:
    print(f'  ${r[0]:6.2f}  attempts {r[1]}  moves {r[2]}  {r[3]:9} {r[4]:16} {r[5]}')
print('\nmodel x status:', dict(Counter((r[4], r[3]) for r in rows).most_common(8)))

# journal: events and recurring wait reasons
ev = Counter(e.get('event') for e in journal)
print('\njournal events:', dict(ev.most_common(16)))
why = Counter()
for e in journal:
    if e.get('event') == 'waiting':
        msg = (e.get('error') or '')
        why[msg.split(':')[0][:70]] += 1
print('wait reasons:', dict(why.most_common(8)))
nudges = [e for e in journal if e.get('event') == 'nudged']
print(f'keepalive nudges: {len(nudges)}, ok {sum(1 for e in nudges if e.get("ok"))}')
