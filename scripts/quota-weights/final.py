"""The weights to ship, and their held-out error against the shipped ones on every split.

Final form: model multiplier at list price relative to Sonnet (Opus 2, Fable 5, Haiku 0.5); one
write coefficient with a 1-hour write at 1.6x a 5-minute one (their list-price ratio) and an
uncached input token at 1/1.25 of a 5-minute write; read and output free. Read is pinned at 0.1.
"""
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402
import evaluate as E  # noqa: E402

FAM = np.array([2, 5, 1, 0.5, 1])
ROUNDED = np.array([float(x) for x in os.environ.get('ROUNDED', '0').split(',')]) if os.environ.get('ROUNDED') else None


def constrained(train):
    """[input, read, w5m, w1h, output] fitted with the write split fixed."""
    iv = []
    for v in train:
        x = v['x'].reshape(E.NF, E.NT) * FAM[:, None]
        s = x.sum(axis=0)
        # agg('rwo') reads columns [cread, input + cw5m + cw1h, output]; pack the constrained write
        # into the cw5m slot so the same fitter applies.
        packed = np.zeros((E.NF, E.NT))
        packed[0] = [0, s[1], s[0] / 1.25 + s[2] + 1.6 * s[3], 0, s[4]]
        iv.append({**v, 'x': packed.reshape(-1)})
    r, w, o = A.fit_scaled(iv, 'rwo')[0]
    k = 0.1 / r
    return np.array([w * k / 1.25, 0.1, w * k, 1.6 * w * k, o * k])


def main():
    corch = [v for v in A.intervals(4 * 60, ('corch',)) if v['cen'] is None]
    train_all = corch + [v for v in A.windows() if v['cen'] is None]
    final_all = constrained(train_all)
    print('fitted on all accounts [input, read, w5m, w1h, output]:', np.round(final_all, 2))
    orgs = sorted({o for (o, _) in A.R})
    corch_orgs = {v['org'] for v in corch}
    desk_orgs = set(orgs) - corch_orgs
    tiers = defaultdict(set)
    for o in orgs:
        tiers[A.tier_of(o)].add(o)
    splits = [
        ('leave one account out', [({o}, lambda v: True) for o in orgs]),
        ('desktop -> Corch Pro CLI', [(corch_orgs, lambda v: v['org'] in desk_orgs)]),
        ('Corch Pro CLI -> desktop', [(desk_orgs, lambda v: v['org'] in corch_orgs)]),
        ('Max 5x -> Max 20x', [(tiers['max20'], lambda v: v['tier'] == 'max5')]),
        ('Max 20x -> Max 5x', [(tiers['max5'], lambda v: v['tier'] == 'max20')]),
        ('Pro -> Max', [(tiers['max5'] | tiers['max20'], lambda v: v['tier'] == 'pro')]),
        ('Max -> Pro', [(tiers['pro'], lambda v: v['tier'] in ('max5', 'max20'))]),
    ]
    for meter, horizon in (('five_hour', 3600), ('weekly', 6 * 3600)):
        R = E.readings(meter)
        print(f'=== {meter} meter: predict the next {horizon / 3600:.0f}h from the last 6h, on accounts the fit never saw')
        for label, folds in splits:
            rows, fitted = [], []
            for test, keep in folds:
                w = constrained([v for v in train_all if keep(v) and v['org'] not in test])
                fitted.append(w)
                weighers = {'shipped': lambda x: E.weigh(x, E.OLD_T, E.OLD_F),
                            'refit': lambda x, w=w: E.weigh(x, w, FAM)}
                if ROUNDED is not None:
                    weighers['constants'] = lambda x: E.weigh(x, ROUNDED, FAM)
                for (o, src), rs in R.items():
                    if o in test:
                        rows += E.predictions(rs, o, weighers, horizon)
            if not rows:
                print(f'  {label:26s} no predictions')
                continue
            s0, s1 = E.score(rows, 'shipped'), E.score(rows, 'refit')
            fw = np.median(np.array(fitted), axis=0)
            line = (f"  {label:26s} n={s0['n']:4d}  MAE {s0['mae']:5.2f} -> {s1['mae']:5.2f}   median {s0['med']:4.2f} -> {s1['med']:4.2f}"
                    f"   within 2x {s0['within2x']:.0%} -> {s1['within2x']:.0%}   fold weights w5m {fw[2]:.2f} out {fw[4]:.1f}")
            if ROUNDED is not None:
                s2 = E.score(rows, 'constants')
                line += f"   | constants MAE {s2['mae']:.2f} median {s2['med']:.2f}"
            print(line)


if __name__ == '__main__':
    main()
