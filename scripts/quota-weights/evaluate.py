"""Replay usage_budget's prediction with the shipped weights and with re-fitted ones, on held-out accounts.

The budget's claim is: over the last 6h you spent W weighted tokens and the meter rose D points, so
the next W' weighted tokens will raise it W' * D / W points. For every reading tau of an account the
weights never saw (leave-one-account-out), calibrate on (tau - 6h, tau] back to the last reset, then
predict the rise over the following HORIZON and compare with what the meter did. Only the weighting
differs between variants, so the error difference is the weights' doing.
"""
import math
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402

NT, NF = len(A.TYPES), len(A.FAMS)
OLD_T = np.array([1, 0.1, 1.25, 1.25, 5.0])
OLD_F = np.array([5, 5, 1, 0.27, 1])
FLAT_F = np.ones(NF)
LOOKBACK = 6 * 3600
MIN_SPAN = 45 * 60


def weigh(x, wt, wf):
    return float((x.reshape(NF, NT) * wt * wf[:, None]).sum())


def type_weights(beta):
    """[read, write, output] per 1M -> per-type weights with read pinned at 0.1 (the shipped unit)."""
    r, w, o = beta
    k = 0.1 / r
    return np.array([w * k / 1.25, 0.1, w * k, w * k, o * k])


def fit_types(train, fam_mult):
    """Fit [read, write, output] with family multipliers applied to the token counts."""
    iv = []
    for v in train:
        x = (v['x'].reshape(NF, NT) * fam_mult[:, None]).reshape(-1)
        iv.append({**v, 'x': x})
    beta, _, _, _ = A.fit_scaled(iv, 'rwo')
    return beta


def readings(meter):
    """(org, src) -> [(t, pct)], split into runs at every drop (a reset)."""
    out = {}
    for (org, src), rs in A.R.items():
        seq = sorted((r[0], r[1] if meter == 'five_hour' else r[3]) for r in rs)
        if meter == 'five_hour':
            keys = [r[2] for r in sorted(rs)]
        else:
            keys, k = [], 0
            for a, b in zip([None] + seq, seq):
                if a is not None and b[1] < a[1]:
                    k += 1
                keys.append(k)
        out[(org, src)] = [(t, p, key) for (t, p), key in zip(seq, keys)]
    return out


def predictions(rs, org, weighers, horizon):
    """[(actual, {variant: predicted})] for every usable decision point in one reading sequence."""
    out = []
    n = len(rs)
    for i in range(n):
        t, p, k = rs[i]
        if p >= 100:
            continue
        a = i
        while a - 1 >= 0 and rs[a - 1][2] == k and t - rs[a - 1][0] <= LOOKBACK:
            a -= 1
        if t - rs[a][0] < MIN_SPAN:
            continue
        d_cal = p - rs[a][1]
        if d_cal < 2:
            continue
        j = i
        while j + 1 < n and rs[j + 1][2] == k and rs[j + 1][0] - t <= horizon and rs[j + 1][1] < 100:
            j += 1
        if rs[j][0] - t < horizon * 0.5:
            continue
        x_cal = A.spend(org, rs[a][0], t)
        x_next = A.spend(org, t, rs[j][0])
        if x_cal[A.NC] == 0 or x_next[A.NC] == 0:
            continue
        bad = False
        for u, v in zip(rs[a:j], rs[a + 1:j + 1]):
            # CliMayte stamps several readings with the same request time; only a real gap can hide usage.
            if v[0] - u[0] >= 120 and v[1] - u[1] >= 2 and A.spend(org, u[0], v[0])[A.NC] == 0:
                bad = True
                break
        if bad:
            continue
        actual = rs[j][1] - p
        pred = {}
        for name, f in weighers.items():
            wc = f(x_cal[:A.NC])
            pred[name] = f(x_next[:A.NC]) * d_cal / wc if wc > 0 else math.nan
        out.append((actual, pred))
    return out


def score(rows, name):
    a = np.array([r[0] for r in rows])
    p = np.array([r[1][name] for r in rows])
    ok = np.isfinite(p)
    a, p = a[ok], p[ok]
    err = np.abs(p - a)
    big = a >= 3
    lr = np.abs(np.log((p[big] + 0.5) / (a[big] + 0.5)))
    return dict(n=len(a), mae=err.mean(), med=np.median(err), bias=(p - a).mean(),
                within2x=np.mean(lr <= math.log(2)) if big.any() else math.nan,
                mlog=np.median(lr) if big.any() else math.nan)


PRICE_F = np.array([2, 5, 1, 0.5, 1])  # list price vs Sonnet 5.5: Opus 5.5 2x, Fable 5.1 5x, Haiku 4.5 0.5x


def weighers_for(train):
    b_old, b_flat, b_price = fit_types(train, OLD_F), fit_types(train, FLAT_F), fit_types(train, PRICE_F)
    w_old, w_flat, w_price = type_weights(b_old), type_weights(b_flat), type_weights(b_price)
    return {
        'shipped': lambda x: weigh(x, OLD_T, OLD_F),
        'new types, shipped model mult': lambda x, w=w_old: weigh(x, w, OLD_F),
        'new types, price model mult': lambda x, w=w_price: weigh(x, w, PRICE_F),
        'new types, flat model mult': lambda x, w=w_flat: weigh(x, w, FLAT_F),
        'raw token count': lambda x: float(x.reshape(NF, NT)[:, 1:].sum()),
    }, w_old


def report(title, rows, fitted):
    print(f'=== {title}')
    if fitted:
        bf = np.array(fitted)
        print('  fitted weights (shipped model mult) [input, read, write, output]: median',
              np.round(np.median(bf[:, [0, 1, 2, 4]], axis=0), 2), ' write range',
              np.round([bf[:, 2].min(), bf[:, 2].max()], 2), ' output range', np.round([bf[:, 4].min(), bf[:, 4].max()], 2))
    for src in ('climayte', 'hist', 'plan', 'ALL'):
        rr = [r for v in rows.values() for r in v] if src == 'ALL' else rows.get(src, [])
        if not rr:
            continue
        print(f'  [{src}] {len(rr)} predictions, mean actual rise {np.mean([r[0] for r in rr]):.2f} points')
        for name in rr[0][1]:
            s = score(rr, name)
            print(f"    {name:32s} MAE {s['mae']:.2f}  median {s['med']:.2f}  bias {s['bias']:+.2f}  "
                  f"within 2x {s['within2x']:.0%}  median |log ratio| {s['mlog']:.2f}")


def run(meter, horizon, folds, train_all):
    """folds: [(label, test_orgs, train_filter)]; one fit per fold, scored on its test orgs only."""
    R = readings(meter)
    rows, fitted = defaultdict(list), []
    for test_orgs, keep in folds:
        weighers, w = weighers_for([v for v in train_all if keep(v) and v['org'] not in test_orgs])
        fitted.append(w)
        for (o, src), rs in R.items():
            if o in test_orgs:
                rows[src] += predictions(rs, o, weighers, horizon)
    return rows, fitted


def main():
    climayte = [v for v in A.intervals(4 * 60, ('climayte',)) if v['cen'] is None]
    wins = [v for v in A.windows() if v['cen'] is None]
    train_all = climayte + wins
    orgs = sorted({o for (o, _) in A.R})
    climayte_orgs = {v['org'] for v in climayte}
    desk_orgs = set(orgs) - climayte_orgs
    by_tier = defaultdict(set)
    for o in orgs:
        by_tier[A.tier_of(o)].add(o)
    experiments = [
        ('leave one account out', [({o}, lambda v: True) for o in orgs]),
        ('fit on desktop accounts only, test on the CliMayte Pro CLI accounts', [(climayte_orgs, lambda v: v['org'] in desk_orgs)]),
        ('fit on the CliMayte Pro CLI accounts only, test on desktop accounts', [(desk_orgs, lambda v: v['org'] in climayte_orgs)]),
        ('fit on Max 5x only, test on Max 20x', [(by_tier['max20'], lambda v: v['tier'] == 'max5')]),
        ('fit on Max 20x only, test on Max 5x', [(by_tier['max5'], lambda v: v['tier'] == 'max20')]),
        ('fit on Pro only, test on Max', [(by_tier['max5'] | by_tier['max20'], lambda v: v['tier'] == 'pro')]),
        ('fit on Max only, test on Pro', [(by_tier['pro'], lambda v: v['tier'] in ('max5', 'max20'))]),
    ]
    only = os.environ.get('ONLY')
    for meter, horizon in (('five_hour', 3600), ('weekly', 6 * 3600)):
        for k, (label, folds) in enumerate(experiments):
            if only is not None and str(k) not in only.split(','):
                continue
            rows, fitted = run(meter, horizon, folds, train_all)
            report(f'{meter} meter, next {horizon / 3600:.0f}h from the last 6h: {label}', rows, fitted)


if __name__ == '__main__':
    main()
