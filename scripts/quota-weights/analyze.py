"""Re-fit the 5-hour meter against token kinds; compare the shipped weights on held-out intervals.

Reads data.pkl from build.py. Readings come from three sources, never mixed inside one interval:
  corch  per-request five_hour utilization from Corch stream logs (Pro CLI accounts, has resetsAt)
  hist   AgentHydra usage-history sessionPct (integer, has sessionResetsAt)
  plan   each desktop profile's own plan-usage-history.json (integer fh, NO reset time): an interval
         is kept only when it lies inside 5 hours of a reading of 0 or a drop, which bounds the
         window it is in (a window lasts 5h from its first request and never resets sooner).
"""
import bisect
import glob
import json
import os
import pickle
import sys
from collections import defaultdict

import numpy as np
from scipy.optimize import nnls

DATA = os.environ.get('QUOTA_WEIGHTS_DATA', os.path.expanduser('~/.agenthydra/quota-weights'))
D = pickle.load(open(os.path.join(DATA, 'data.pkl'), 'rb'))
TYPES = ['input', 'cread', 'cw5m', 'cw1h', 'output']
FAMS = ['opus', 'fable', 'sonnet', 'haiku', 'other']
NC = len(TYPES) * len(FAMS)
col = {(f, t): i * len(TYPES) + j for i, f in enumerate(FAMS) for j, t in enumerate(TYPES)}

ORG = {}
for org, rows in D['by_org'].items():
    T = np.array([r[0] for r in rows])
    F = np.zeros((len(rows) + 1, NC + 2))
    for k, (t, fam, inp, cr, w5, w1, out, sid, moved) in enumerate(rows, 1):
        F[k] = F[k - 1]
        base = col[(fam, 'input')]
        F[k, base:base + 5] += (inp, cr, w5, w1, out)
        F[k, NC] += 1
        F[k, NC + 1] += moved
    ORG[org] = (T, F)


def spend(org, t0, t1):
    if org not in ORG:
        return np.zeros(NC + 2)
    T, F = ORG[org]
    return F[bisect.bisect_right(T, t1)] - F[bisect.bisect_right(T, t0)]


def tier_of(org):
    s = D['tier'].get(org, '?')
    if 'max_20x' in s:
        return 'max20'
    if 'max_5x' in s:
        return 'max5'
    if 'default_claude_ai' in s or s.startswith('pro'):
        return 'pro'
    return '?'


R = defaultdict(list)  # (org, src) -> [(t, pct, key, week)]
for org, rs in D['readings'].items():
    for t, p, k, w, src in rs:
        R[(org, src)].append((t, p, k, w))
profiles = glob.glob(os.path.expanduser('~/.claude-instances/*')) + [os.path.expandvars('%APPDATA%/Claude')]
for p in profiles:
    try:
        d = json.load(open(os.path.join(p, 'plan-usage-history.json'), encoding='utf-8'))
    except Exception:
        continue
    by = defaultdict(list)
    for s in d.get('samples', []):
        u = s.get('u') or {}
        if 'fh' in u and s.get('org'):
            by[s['org']].append((s['t'] / 1000, float(u['fh']), float(u.get('sd') or 0)))
    for org, ss in by.items():
        ss.sort()
        # window id: index of the last anchor (a 0 reading, or a drop); valid until anchor + 5h
        anchor, wid = None, 0
        prev = None
        for t, fh, sd in ss:
            if prev is not None and (t - prev[0] > 30 * 60):
                anchor = None  # a gap: lose the window
            if fh == 0 or (prev is not None and fh < prev[1]):
                anchor, wid = (prev[0] if prev is not None and fh < prev[1] and t - prev[0] <= 30 * 60 else t), wid + 1
            if anchor is not None and t <= anchor + 5 * 3600:
                R[(org, 'plan')].append((t, fh, f'w{wid}', sd))
            prev = (t, fh)


def intervals(min_s, srcs=('corch', 'hist', 'plan'), max_s=3 * 3600):
    out = []
    for (org, src), rs in R.items():
        if src not in srcs:
            continue
        rs = sorted(rs)
        i = 0
        while i < len(rs) - 1:
            t0, p0, k0, w0 = rs[i]
            j = i + 1
            while j < len(rs) and rs[j][2] == k0 and rs[j][0] - t0 < min_s:
                j += 1
            if j >= len(rs):
                break
            t1, p1, k1, w1 = rs[j]
            if k1 != k0 or t1 - t0 > max_s:
                i = j
                continue
            x = spend(org, t0, t1)
            cen = None
            if p0 >= 100 or p1 >= 100:
                cen = 'capped'
            elif w1 >= 100:
                cen = 'week_capped'
            elif p1 < p0:
                cen = 'backwards'
            elif p1 - p0 >= 2 and x[NC] == 0:
                cen = 'unrecorded'
            out.append(dict(org=org, src=src, t0=t0, t1=t1, dy=p1 - p0, x=x[:NC], n=x[NC], moved=x[NC + 1],
                            tier=tier_of(org), cen=cen))
            i = j
    return out


def windows(srcs=('hist', 'plan')):
    """One interval per quota window: its first reading to its last reading under 100%.

    A whole window moves tens of points, so the integer percentage's rounding stops dominating.
    The window is dropped when any step in it rose 2+ points with no recorded request (usage this
    machine cannot see), or when the weekly cap was hit inside it."""
    out = []
    for (org, src), rs in R.items():
        if src not in srcs:
            continue
        by = defaultdict(list)
        for r in sorted(rs):
            by[r[2]].append(r)
        for key, w in by.items():
            w = [r for r in w if r[1] < 100]
            if len(w) < 2:
                continue
            cen = None
            for a, b in zip(w, w[1:]):
                if b[1] < a[1]:
                    cen = 'backwards'
                elif b[1] - a[1] >= 2 and spend(org, a[0], b[0])[NC] == 0:
                    cen = cen or 'unrecorded'
                if b[3] >= 100:
                    cen = 'week_capped'
            t0, t1 = w[0][0], w[-1][0]
            x = spend(org, t0, t1)
            out.append(dict(org=org, src=src, t0=t0, t1=t1, dy=w[-1][1] - w[0][1], x=x[:NC], n=x[NC],
                            moved=x[NC + 1], tier=tier_of(org), cen=cen))
    return out


def agg(x, scheme):
    """Collapse the 25 family x type columns into a scheme's columns.

    Input tokens are folded into the write column: they are a few hundred per request (about 0.001%
    of the volume), so a column of their own only fits noise, and an uncached input token is billed
    like a cache write without the premium."""
    v = x.reshape(len(FAMS), len(TYPES))
    if scheme == 'rwo':
        s = v.sum(axis=0)
        return np.array([s[1], s[0] + s[2] + s[3], s[4]])
    if scheme == 'rwo_ttl':
        s = v.sum(axis=0)
        return np.array([s[1], s[0] + s[2], s[3], s[4]])
    if scheme == 'rwo_family':  # Opus+Fable | Sonnet+Haiku+other
        g = [v[0] + v[1], v[2] + v[3] + v[4]]
        return np.array([c for gg in g for c in (gg[1], gg[0] + gg[2] + gg[3], gg[4])])
    raise ValueError(scheme)


def r2(y, p):
    return 1 - ((y - p) ** 2).sum() / ((y - y.mean()) ** 2).sum()


def fit_scaled(iv, scheme, iters=30, robust=True):
    """y = s_org * (beta . x). Alternating NNLS; Huber-style reweighting against unseen usage."""
    orgs = sorted({v['org'] for v in iv})
    init = {'pro': 1.0, 'max5': 0.2, 'max20': 0.05, '?': 0.2}
    s = {o: init[tier_of(o)] for o in orgs}
    X = np.array([agg(v['x'], scheme) for v in iv]) / 1e6
    y = np.array([v['dy'] for v in iv])
    oi = np.array([orgs.index(v['org']) for v in iv])
    wts = np.ones(len(y))
    beta = None
    for _ in range(iters):
        S = np.array([s[o] for o in orgs])[oi]
        A = X * S[:, None] * np.sqrt(wts)[:, None]
        beta, _ = nnls(A, y * np.sqrt(wts))
        base = X @ beta
        for k, o in enumerate(orgs):
            m = oi == k
            den = (wts[m] * base[m] ** 2).sum()
            if den > 0:
                s[o] = max(1e-4, (wts[m] * base[m] * y[m]).sum() / den)
        # normalise so Pro accounts average 1 (beta then reads as % of a Pro window per 1M tokens)
        pro = [s[o] for o in orgs if tier_of(o) == 'pro']
        if pro:
            g = float(np.median(pro))
            s = {o: v / g for o, v in s.items()}
            beta = beta * g
        if robust:
            pred = X @ beta * np.array([s[o] for o in orgs])[oi]
            res = np.abs(y - pred)
            c = 1.345 * max(np.median(res) / 0.6745, 1.0)
            wts = np.where(res <= c, 1.0, c / np.maximum(res, 1e-9))
    pred = X @ beta * np.array([s[o] for o in orgs])[oi]
    return beta, s, r2(y, pred), wts


def main():
    min_desk = float(os.environ.get('MIN_DESK_MIN', '60')) * 60
    min_corch = float(os.environ.get('MIN_CORCH_MIN', '15')) * 60
    iv = intervals(min_corch, ('corch',)) + intervals(min_desk, ('hist',)) + intervals(min_desk, ('plan',))
    cen = defaultdict(int)
    for v in iv:
        cen[(v['src'], v['cen'])] += 1
    print('intervals:', dict(cen))
    clean = [v for v in iv if v['cen'] is None]
    for src in ('corch', 'hist', 'plan'):
        c = [v for v in clean if v['src'] == src]
        print(f"  {src}: {len(c)} clean on {len({v['org'] for v in c})} accounts; tiers",
              dict(sorted(defaultdict(int, {t: sum(1 for v in c if v['tier'] == t) for t in ('pro', 'max5', 'max20', '?')}).items())))
    # token mix inside clean intervals
    tot = np.sum([v['x'] for v in clean], axis=0).reshape(len(FAMS), len(TYPES))
    print('token mix (M) by family x [input, cread, cw5m, cw1h, output]:')
    for f, row in zip(FAMS, tot):
        if row.sum():
            print(f'  {f:7s}', ' '.join(f'{c / 1e6:10.1f}' for c in row))


if __name__ == '__main__':
    sys.exit(main())
