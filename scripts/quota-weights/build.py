"""Assemble per-account requests and 5-hour meter readings for the quota weight re-fit.

Accounts are keyed by organization uuid (one subscription = one org).
  Requests: every assistant turn, deduplicated by (message id, requestId) keeping the largest output,
            from each CLI instance's own config dir and, for desktop chats, from ~/.claude/projects
            attributed through each desktop profile's claude-code-sessions/<account>/<org>/local_*.json.
  Readings: (a) Corch stream-json rate_limit_event five_hour utilization, stamped with the newest
            assistant timestamp before it; (b) AgentHydra usage-history.json sessionPct with
            sessionResetsAt, org from the profile's plan-usage-history.json sample nearest in time.
Writes data.pkl to QUOTA_WEIGHTS_DATA (default ~/.agenthydra/quota-weights), never into the repo:
it holds this machine's usage. QUOTA_WEIGHTS_DAYS (default 21) sets how far back to read.
"""
import datetime
import glob
import json
import os
import pickle
import re
import sys
from concurrent.futures import ProcessPoolExecutor

HOME = os.path.expanduser('~')
AH = os.path.join(HOME, '.agenthydra')
DATA = os.environ.get('QUOTA_WEIGHTS_DATA', os.path.join(AH, 'quota-weights'))
OUT = os.path.join(DATA, 'data.pkl')
SINCE = datetime.datetime.now(datetime.timezone.utc).timestamp() - float(os.environ.get('QUOTA_WEIGHTS_DAYS', '21')) * 86400
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def iso(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def family(model):
    m = (model or '').lower()
    for f in ('fable', 'opus', 'sonnet', 'haiku'):
        if f in m:
            return f
    return 'other'


def session_of(path):
    """The top-level session a transcript bills to: <proj>/<sid>.jsonl or <proj>/<sid>/.../x.jsonl."""
    parts = os.path.normpath(path).split(os.sep)
    i = parts.index('projects')
    rest = parts[i + 2:]
    if len(rest) == 1:
        return rest[0][:-6]
    return rest[0] if UUID.match(rest[0]) else None


def parse_file(path):
    """[(key, t, family, input, cread, cw5m, cw1h, output, session)] for every assistant usage line."""
    out = []
    sid = session_of(path)
    try:
        if os.path.getmtime(path) < SINCE:
            return path, out
        fh = open(path, encoding='utf-8', errors='replace')
    except OSError:
        return path, out
    with fh:
        for line in fh:
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('type') != 'assistant' or not r.get('timestamp'):
                continue
            m = r.get('message') or {}
            u = m.get('usage')
            if not u:
                continue
            t = iso(r['timestamp'])
            if t < SINCE:
                continue
            cw = u.get('cache_creation_input_tokens') or 0
            split = u.get('cache_creation') or {}
            w5, w1 = split.get('ephemeral_5m_input_tokens') or 0, split.get('ephemeral_1h_input_tokens') or 0
            if w5 + w1 <= 0:
                w5, w1 = cw, 0
            key = (m.get('id'), r.get('requestId')) if r.get('requestId') else (path, t, m.get('id'))
            out.append((key, t, family(m.get('model')), u.get('input_tokens') or 0,
                        u.get('cache_read_input_tokens') or 0, w5, w1, u.get('output_tokens') or 0,
                        sid or r.get('sessionId')))
    return path, out


def jsonl_under(root):
    hits = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if fn.endswith('.jsonl'):
                p = os.path.join(dp, fn)
                try:
                    if os.path.getmtime(p) >= SINCE:
                        hits.append(p)
                except OSError:
                    pass
    return hits


def org_of_config(cfg):
    try:
        return (json.load(open(os.path.join(cfg, '.claude.json'), encoding='utf-8')).get('oauthAccount') or {}).get('organizationUuid')
    except Exception:
        return None


def main():
    known = json.load(open(os.path.join(AH, 'known-accounts.json'), encoding='utf-8'))
    tier = {a['orgUuid']: f"{a.get('plan')}|{a.get('rateLimitTier')}" for a in known.values() if a.get('orgUuid')}

    # --- CLI instances (current and the ones Corch remembers)
    cli_cfg = {}
    for d in glob.glob(os.path.join(AH, 'cli-instances', '*')):
        if os.path.isdir(d):
            cli_cfg[os.path.basename(d)] = d
    cli_org = {i: org_of_config(c) for i, c in cli_cfg.items()}
    cli_org = {i: o for i, o in cli_org.items() if o}

    # --- desktop profiles: session -> {org: createdAt}
    profiles = [p for p in glob.glob(os.path.join(HOME, '.claude-instances', '*')) if os.path.isdir(p)]
    profiles.append(os.path.join(os.environ.get('APPDATA', ''), 'Claude'))
    sess_orgs = {}
    for p in profiles:
        for f in glob.glob(os.path.join(p, 'claude-code-sessions', '*', '*', 'local_*.json')):
            org = os.path.basename(os.path.dirname(f))
            try:
                d = json.load(open(f, encoding='utf-8'))
            except Exception:
                continue
            sid = d.get('cliSessionId')
            if sid:
                sess_orgs.setdefault(sid, {})[org] = (d.get('createdAt') or 0) / 1000

    # --- requests
    files = [(None, p) for p in jsonl_under(os.path.join(HOME, '.claude', 'projects'))]
    for i, c in cli_cfg.items():
        files += [(i, p) for p in jsonl_under(os.path.join(c, 'projects'))]
    src_of = {p: i for i, p in files}
    print(f'{len(files)} transcripts to read', flush=True)
    turns = {}  # key -> row (largest output wins)
    owner = {}  # key -> cli instance id or None (desktop/default)
    with ProcessPoolExecutor(max_workers=int(os.environ.get('NPROC', '6'))) as ex:
        for n, (path, rows) in enumerate(ex.map(parse_file, [p for _, p in files], chunksize=16)):
            for row in rows:
                k = row[0]
                prev = turns.get(k)
                if prev is None or row[7] > prev[7]:
                    turns[k] = row
                    owner[k] = src_of[path]
            if n % 2000 == 0:
                print(f'  {n} files, {len(turns)} requests', flush=True)

    by_org = {}
    stats = {'cli': 0, 'desktop': 0, 'desktop_moved': 0, 'unattributed': 0}
    unattributed = []
    for k, row in turns.items():
        _, t, fam, inp, cr, w5, w1, out, sid = row
        rec = (t, fam, inp, cr, w5, w1, out, sid)
        inst = owner[k]
        if inst is not None:
            org = cli_org.get(inst)
            if org:
                by_org.setdefault(org, []).append(rec + (False,))
                stats['cli'] += 1
            continue
        orgs = sess_orgs.get(sid)
        if not orgs:
            unattributed.append(rec)
            stats['unattributed'] += 1
            continue
        if len(orgs) == 1:
            by_org.setdefault(next(iter(orgs)), []).append(rec + (False,))
            stats['desktop'] += 1
            continue
        # A moved chat: the copy created most recently before the turn is the account that ran it.
        cands = sorted((c, o) for o, c in orgs.items() if c <= t + 60)
        org = cands[-1][1] if cands else min(orgs.items(), key=lambda kv: kv[1])[0]
        by_org.setdefault(org, []).append(rec + (True,))
        stats['desktop_moved'] += 1
    for v in by_org.values():
        v.sort()
    unattributed.sort()
    print('requests:', stats, flush=True)

    # --- readings (a) Corch logs
    readings = {}  # org -> [(t, pct, resetKey, weekPct, src)]
    worker_files = [os.path.join(AH, 'corch', 'workers.json')] + glob.glob(os.path.join(AH, 'corch', 'archive', '*', 'workers.json'))
    seen_logs = set()
    for wf in worker_files:
        try:
            W = json.load(open(wf, encoding='utf-8'))['workers']
        except Exception:
            continue
        for w in W:
            for a in w['attempts']:
                org = cli_org.get(a['account']['id'])
                if '(pro)' in (a['account'].get('name') or '') and org:
                    tier.setdefault(org, 'pro|cli')
                log = a.get('log')
                if not org or not log or log in seen_logs:
                    continue
                seen_logs.add(log)
                last_t = a['startedAt'] / 1000
                try:
                    for line in open(log, encoding='utf-8', errors='replace'):
                        if '"rate_limit_event"' in line:
                            try:
                                ev = json.loads(line)
                            except Exception:
                                continue
                            if ev.get('parent_tool_use_id'):
                                continue
                            uw = (ev.get('rate_limit_info') or {}).get('unifiedWindows') or {}
                            fh = uw.get('five_hour') or {}
                            sd = uw.get('seven_day') or {}
                            if isinstance(fh.get('utilization'), (int, float)):
                                readings.setdefault(org, []).append(
                                    (last_t, fh['utilization'] * 100, round((fh.get('resetsAt') or 0) / 60),
                                     (sd.get('utilization') or 0) * 100, 'corch'))
                        elif '"timestamp"' in line and '"assistant"' in line:
                            try:
                                last_t = iso(json.loads(line)['timestamp'])
                            except Exception:
                                pass
                except OSError:
                    pass

    # --- readings (b) AgentHydra usage history
    plan_hist = {}
    for p in profiles:
        try:
            d = json.load(open(os.path.join(p, 'plan-usage-history.json'), encoding='utf-8'))
        except Exception:
            continue
        plan_hist[os.path.normcase(os.path.normpath(p))] = sorted((s['t'] / 1000, s['org']) for s in d.get('samples', []) if s.get('org'))
    hist = json.load(open(os.path.join(AH, 'data', 'usage-history.json'), encoding='utf-8'))
    for key, samples in hist.items():
        if not isinstance(samples, list):
            continue
        if key.startswith('cli:'):
            org_at = (lambda o: (lambda t: o))(cli_org.get(key[4:]))
        elif key.startswith('desktop:'):
            ph = plan_hist.get(os.path.normcase(os.path.normpath(key[8:])))
            if not ph:
                continue

            def org_at(t, ph=ph):
                best = min(ph, key=lambda s: abs(s[0] - t))
                return best[1] if abs(best[0] - t) <= 20 * 60 else None
        else:
            continue
        for s in samples:
            if s.get('sessionPct') is None or not s.get('sessionResetsAt'):
                continue
            t = iso(s['at'])
            org = org_at(t)
            if not org:
                continue
            rk = datetime.datetime.fromtimestamp(round(iso(s['sessionResetsAt']) / 60) * 60, datetime.timezone.utc).isoformat()
            readings.setdefault(org, []).append((t, float(s['sessionPct']), rk, float(s.get('weekAllPct') or 0), 'hist'))
    for v in readings.values():
        v.sort()
    print('readings:', {k[:8]: len(v) for k, v in readings.items()}, flush=True)
    os.makedirs(DATA, exist_ok=True)
    pickle.dump({'by_org': by_org, 'unattributed': unattributed, 'readings': readings, 'tier': tier,
                 'cli_org': cli_org}, open(OUT, 'wb'))
    print('wrote', OUT)


if __name__ == '__main__':
    sys.exit(main())
