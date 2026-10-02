"""Fuzz CliMayte's dispatch (POST /api/corch/workers) with malformed requests. Each must be refused
with a 4xx and a message a caller can act on; none may create a worker or take the daemon down.
Any worker a case did create is cancelled at once and reported as a finding."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

BASE = os.environ.get('AGENTHYDRA_URL', 'http://127.0.0.1:7787')
CWD = Path(__file__).resolve().parents[2].as_posix()  # the repo: an existing folder
OK = {'prompt': 'fuzz: say ok', 'cwd': CWD, 'title': 'fuzz'}


def call(method, path, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode('utf8') if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={'Content-Type': ctype})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode('utf8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf8', 'replace')
    except Exception as e:  # connection reset, timeout
        return 0, f'{type(e).__name__}: {e}'


def ids():
    s, b = call('GET', '/api/corch/workers')
    d = json.loads(b)
    return {w['id'] for w in (d if isinstance(d, list) else d.get('workers', []))}


CASES = [
    ('no body', None, None),
    ('not json', None, b'{not json'),
    ('empty object', {}, None),
    ('tasks empty', {'tasks': []}, None),
    ('tasks not a list', {'tasks': 'x'}, None),
    ('task empty object', {'tasks': [{}]}, None),
    ('task null', {'tasks': [None]}, None),
    ('empty prompt', {'tasks': [{**OK, 'prompt': ''}]}, None),
    ('whitespace prompt', {'tasks': [{**OK, 'prompt': '   \n '}]}, None),
    ('cwd missing on disk', {'tasks': [{**OK, 'cwd': 'Z:/no/such/folder'}]}, None),
    ('cwd relative', {'tasks': [{**OK, 'cwd': 'app'}]}, None),
    ('cwd is a file', {'tasks': [{**OK, 'cwd': CWD + '/package.json'}]}, None),
    ('unknown model', {'tasks': [{**OK, 'model': 'gpt-5'}]}, None),
    ('unknown effort', {'tasks': [{**OK, 'effort': 'ultra'}]}, None),
    ('top-level unknown model', {'tasks': [OK], 'model': 'banana'}, None),
    ('priority out of range', {'tasks': [{**OK, 'priority': 5000}]}, None),
    ('priority not a number', {'tasks': [{**OK, 'priority': 'high'}]}, None),
    ('priority fraction', {'tasks': [{**OK, 'priority': 1.5}]}, None),
    ('per_account 0', {'tasks': [OK], 'per_account': 0}, None),
    ('per_account 9', {'tasks': [OK], 'per_account': 9}, None),
    ('unknown account', {'tasks': [OK], 'accounts': ['#999']}, None),
    ('account not a ref', {'tasks': [OK], 'accounts': [{'x': 1}]}, None),
    ('unknown size', {'tasks': [{**OK, 'size': 'huge'}]}, None),
    ('unknown kind', {'tasks': [{**OK, 'kind': 'banana'}]}, None),
    ('prompt not a string', {'tasks': [{**OK, 'prompt': 42}]}, None),
    ('2 MB prompt', {'tasks': [{**OK, 'prompt': 'x' * 2_000_000, 'model': 'gpt-5'}]}, None),
]

before = ids()
rows = []
for name, body, raw in CASES:
    status, text = call('POST', '/api/corch/workers', body, raw)
    rows.append((name, status, text.replace('\n', ' ')[:150]))
after = ids()
made = sorted(after - before)
for wid in made:
    call('POST', '/api/corch/cancel', {'id': wid})
health = call('GET', '/api/health')[0]
bad = 0
for name, status, text in rows:
    ok = 400 <= status < 500
    bad += 0 if ok else 1
    print(f'{"ok  " if ok else "FIND"} {status:3}  {name:26} {text}')
print(f'\n{len(rows)} cases, {bad} not refused with a 4xx; workers created by fuzz: {made or "none"}; daemon health {health}')
