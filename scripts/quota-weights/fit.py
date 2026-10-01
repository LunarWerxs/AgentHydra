"""Fit the meter per source and per tier; print ratios so the sources can be compared."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A  # noqa: E402

MIN_CORCH = float(os.environ.get('MIN_CORCH_MIN', '4')) * 60
NAMES = {'rwo': ['read', 'write', 'output'],
         'rwo_ttl': ['read', 'w5m', 'w1h', 'output'],
         'rwo_family': ['O.read', 'O.write', 'O.out', 'S.read', 'S.write', 'S.out']}


def show(label, iv, scheme='rwo', robust=True):
    if len(iv) < 8:
        print(f'{label}: only {len(iv)} intervals')
        return None
    beta, s, r2, w = A.fit_scaled(iv, scheme, robust=robust)
    names = NAMES[scheme]
    ref = beta[0]
    ratio = ' '.join(f'{n}={b / ref:.0f}' if ref > 0 else f'{n}=?' for n, b in zip(names, beta))
    tiers = {}
    for o, v in s.items():
        tiers.setdefault(A.tier_of(o), []).append(v)
    tstr = ' '.join(f'{t}:{np.median(v):.2f}(n{len(v)})' for t, v in sorted(tiers.items()))
    print(f'{label}: n={len(iv)} R2={r2:.2f} beta=' + ' '.join(f'{n}={b:.2f}' for n, b in zip(names, beta))
          + f' | vs read: {ratio} | scale {tstr} | downweighted {np.mean(w < 1):.0%}')
    return beta, s


def main():
    corch = [v for v in A.intervals(MIN_CORCH, ('corch',)) if v['cen'] is None]
    wins = A.windows()
    from collections import Counter
    print('windows:', Counter((v['src'], v['cen']) for v in wins))
    hist = [v for v in wins if v['src'] == 'hist' and v['cen'] is None]
    plan = [v for v in wins if v['src'] == 'plan' and v['cen'] is None]
    print(f'corch {len(corch)} intervals, hist {len(hist)} windows, plan {len(plan)} windows; mean rise '
          f'{np.mean([v["dy"] for v in hist]):.1f} / {np.mean([v["dy"] for v in plan]):.1f}')
    for robust in (False, True):
        print(f'--- robust={robust}')
        show('corch', corch, robust=robust)
        show('hist ', hist, robust=robust)
        show('plan ', plan, robust=robust)
        show('plan, no moved chats', [v for v in plan if v['moved'] == 0], robust=robust)
        show('desk max5', [v for v in hist + plan if v['tier'] == 'max5'], robust=robust)
        show('desk max20', [v for v in hist + plan if v['tier'] == 'max20'], robust=robust)
        show('desk pro', [v for v in hist + plan if v['tier'] == 'pro'], robust=robust)
        show('corch ttl', corch, 'rwo_ttl', robust=robust)
        show('plan ttl', plan, 'rwo_ttl', robust=robust)
        show('plan family', plan, 'rwo_family', robust=robust)
        show('hist family', hist, 'rwo_family', robust=robust)


if __name__ == '__main__':
    main()
