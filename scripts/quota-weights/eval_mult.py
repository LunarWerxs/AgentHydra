"""Which model multipliers and cache-write split the held-out replay supports (leave one account out)."""
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402
import evaluate as E  # noqa: E402

MULTS = {  # opus, fable, sonnet, haiku, other
    'shipped 5/5/1/.27': np.array([5, 5, 1, 0.27, 1]),
    'price 2/5/1/.5': np.array([2, 5, 1, 0.5, 1]),
    'fable=opus 2/2/1/.5': np.array([2, 2, 1, 0.5, 1]),
    'sonnet=opus 1/2.5/1/1': np.array([1, 2.5, 1, 1, 1]),
    'opus 2.5 (4.x price) 2.5/5/1/.5': np.array([2.5, 5, 1, 0.5, 1]),
}


def fit_ttl(train, fam):
    iv = [{**v, 'x': (v['x'].reshape(E.NF, E.NT) * fam[:, None]).reshape(-1)} for v in train]
    beta, _, _, _ = A.fit_scaled(iv, 'rwo_ttl')
    r, w5, w1, o = beta
    k = 0.1 / r
    return np.array([w5 * k / 1.25, 0.1, w5 * k, w1 * k, o * k])


def main():
    corch = [v for v in A.intervals(4 * 60, ('corch',)) if v['cen'] is None]
    train_all = corch + [v for v in A.windows() if v['cen'] is None]
    orgs = sorted({o for (o, _) in A.R})
    full = {}
    for name, fam in MULTS.items():
        full[name] = E.type_weights(E.fit_types(train_all, fam))
    print('weights fitted on ALL accounts [input, read, w5m, w1h, output]:')
    for name, w in full.items():
        print(f'  {name:32s}', np.round(w, 2))
    w_ttl = fit_ttl(train_all, MULTS['price 2/5/1/.5'])
    print(f"  {'price + TTL-split writes':32s}", np.round(w_ttl, 2))
    for meter, horizon in (('five_hour', 3600), ('weekly', 6 * 3600)):
        R = E.readings(meter)
        rows = []
        for org in orgs:
            train = [v for v in train_all if v['org'] != org]
            weighers = {'shipped': lambda x: E.weigh(x, E.OLD_T, E.OLD_F)}
            for name, fam in MULTS.items():
                w = E.type_weights(E.fit_types(train, fam))
                weighers[f'new types, {name}'] = lambda x, w=w, fam=fam: E.weigh(x, w, fam)
            fam = MULTS['price 2/5/1/.5']
            wt = fit_ttl(train, fam)
            weighers['new types, price, TTL-split writes'] = lambda x, w=wt, fam=fam: E.weigh(x, w, fam)
            wt2 = E.type_weights(E.fit_types(train, fam)).copy()
            wt2[3] = wt2[2] * 1.6
            weighers['new types, price, 1h write = 1.6x 5m'] = lambda x, w=wt2, fam=fam: E.weigh(x, w, fam)
            for (o, src), rs in R.items():
                if o == org:
                    rows += E.predictions(rs, o, weighers, horizon)
        print(f'=== {meter} meter, leave one account out: {len(rows)} predictions')
        for name in rows[0][1]:
            s = E.score(rows, name)
            print(f"    {name:42s} MAE {s['mae']:.2f}  median {s['med']:.2f}  bias {s['bias']:+.2f}  "
                  f"within 2x {s['within2x']:.0%}  median |log ratio| {s['mlog']:.2f}")


if __name__ == '__main__':
    main()
