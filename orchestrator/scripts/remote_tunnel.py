#!/usr/bin/env python3
"""remote_tunnel.py - act (machine config): THE PERMANENT ADDRESS - provision, inspect or
repair this machine's NAMED Cloudflare tunnel, so the remote dashboard lives at a hostname
that never changes.

WHY A NAMED TUNNEL AND NOT THE QUICK ONE. A Quick Tunnel gets a fresh
`*.trycloudflare.com` name on every start, so the gateway has to announce itself to a relay
just to be findable, and trycloudflare is widely DNS-blocked (abuse), so a phone on a filtered
network cannot reach it at all. A named tunnel is a hostname on a zone we own: stable across
restarts, resolvable everywhere, and it completes the OAuth dance on its OWN /oauth/callback
with no relay in the path.

⛔ THIS SCRIPT NEVER PRINTS A TUNNEL TOKEN. The connector token is a credential - anyone
holding it can serve traffic for that hostname - so it is fetched inside this process and
written straight to state/remote/config.json (gitignored, ACL-restricted by the gateway).
What comes back to a terminal, a log or an AI is the tunnel id, the hostname, and a sha256
prefix of the token so two machines can be compared without either side revealing it.

⛔ ONE TUNNEL PER MACHINE. Two connectors on one tunnel is a load-balanced pair, not a
failover - Cloudflare will split requests between them and half your dashboard hits land on
the wrong computer. Michael and Jacob each get their own tunnel and their own hostname.

AUTHENTICATION: a Cloudflare API token in CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) with
Account:Cloudflare Tunnel:Edit and Zone:DNS:Edit on the target zone. Through the Connections
MCP the credential can be leased value-blind:
    connections_execute { local: true, tool_name: "shell", params: {
      command: "python scripts/remote_tunnel.py --provision --name orch-michael",
      secrets: [{ service: "cloudflare", as: "CLOUDFLARE_API_TOKEN" }] } }

Usage: python scripts/remote_tunnel.py --status
       python scripts/remote_tunnel.py --provision --name orch-michael [--hostname H] [--dry-run]
       python scripts/remote_tunnel.py --provision --name orch-jacob --no-install   (the sibling's)
       python scripts/remote_tunnel.py --install-token --name orch-michael
       python scripts/remote_tunnel.py --export-token <file> --name orch-jacob
       python scripts/remote_tunnel.py --import-token <file>
Exit:  0 ok - 1 a Cloudflare call failed - 2 no API token in the environment -
       3 bad arguments - 4 nothing configured yet.

--export-token writes ONE credential to ONE file for hand-delivery to the other machine. It
refuses any path inside this repo that git does not ignore, so a token cannot land somewhere a
`git add -A` would stage. --import-token consumes that file and overwrites it before unlinking.

⛔ That overwrite is TIDINESS, NOT ERASURE. On NTFS and on any SSD, wear levelling, the
filesystem journal and Volume Shadow Copy can all retain the original blocks, so treat an
exported token as compromised-if-it-leaked rather than as safely destroyed - if the file went
anywhere you did not intend, rotate the tunnel instead of trusting the shred. And a file that is
never imported simply sits there: a machine that can reach the Cloudflare API should use
--install-token and never materialise the token at all.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets as _secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from lib import clilib

REPO = Path(__file__).resolve().parents[1]

# The LunarWerx zone the internal tools live on. Both are non-secret identifiers.
DEFAULT_ACCOUNT_ID = "36d7c731fd0352ef08ea7e46d2d20793"
DEFAULT_ZONE_ID = "2b92ad2039f113c2bdf96f2e6208631e"
DEFAULT_ZONE_NAME = "lunarwerx.com"
API = "https://api.cloudflare.com/client/v4"

# The gateway's local port - the tunnel's only ingress target (server/src/config.ts DEFAULT_PORT).
GATEWAY_PORT = int(os.environ.get("ORCH_REMOTE_PORT") or 7790)

# ⛔ ONE LABEL ONLY. lunarwerx.com is on Cloudflare's FREE plan, whose Universal SSL
# certificate covers `lunarwerx.com` and `*.lunarwerx.com` - ONE level. A two-level name like
# `michael.orch.lunarwerx.com` resolves and then fails the TLS handshake in every browser,
# which reads as "the site is broken" rather than "you need Advanced Certificate Manager".
# Refuse it here instead of shipping a hostname that cannot serve.
HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class CfError(RuntimeError):
    pass


def _state_dir() -> Path:
    env = os.environ.get("ORCHESTRATOR_STATE_DIR")
    return Path(env) if env else REPO / "state"


def _config_path() -> Path:
    return _state_dir() / "remote" / "config.json"


def _token() -> str:
    for var in ("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_TOKEN"):
        v = (os.environ.get(var) or "").strip()
        if v:
            return v
    raise SystemExit(
        "no Cloudflare API token in the environment (CLOUDFLARE_API_TOKEN).\n"
        "  Through the Connections MCP, lease it value-blind:\n"
        '    shell { command: "python scripts/remote_tunnel.py ...",\n'
        '            secrets: [{ service: "cloudflare", as: "CLOUDFLARE_API_TOKEN" }] }'
    )


def _api(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "authorization": f"Bearer {_token()}",
            "content-type": "application/json",
            "accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            payload = json.loads(res.read())
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            parsed = json.loads(e.read())
            detail = "; ".join(str(x.get("message")) for x in parsed.get("errors") or []) or str(parsed)[:300]
        except Exception:
            detail = f"HTTP {e.code}"
        raise CfError(f"{method} {path} -> {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise CfError(f"{method} {path} -> {e}") from None
    if not payload.get("success", True):
        msgs = "; ".join(str(x.get("message")) for x in payload.get("errors") or [])
        raise CfError(f"{method} {path} -> {msgs or 'call was not successful'}")
    return payload


def _account() -> str:
    return (os.environ.get("CF_ACCOUNT_ID") or DEFAULT_ACCOUNT_ID).strip()


def _zone() -> str:
    return (os.environ.get("CF_ZONE_ID") or DEFAULT_ZONE_ID).strip()


def _zone_name() -> str:
    return (os.environ.get("CF_ZONE_NAME") or DEFAULT_ZONE_NAME).strip()


def fingerprint(value: str) -> str:
    """A comparable, non-reversible stand-in for a secret - enough to prove two machines hold
    the same token (or different ones) without either printing it."""
    return hashlib.sha256(value.encode()).hexdigest()[:12]


# ── config.json ────────────────────────────────────────────────────────────────
def load_config() -> dict:
    p = _config_path()
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    p = _config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    _restrict(p)


def _restrict(path: Path) -> bool:
    """Give the file a real ACL, and SAY SO IF IT DID NOT WORK.

    The POSIX mode bit is nearly a no-op on NTFS, so this is what actually restricts the file -
    the same icacls dance the gateway's fs-perms.ts does for the session key. It used to swallow
    every failure and never inspect icacls' result, so a save could print "token stored" over a
    file still sitting at inherited permissions, undetectably (audit, 2026-09-03). Still never
    fatal - an unrestricted file is what we had before, not a reason to abort - but no longer
    silent. Returns True when the file is known to be restricted.
    """
    if os.name != "nt":
        return True  # the mode bit is real on POSIX
    user = os.environ.get("USERNAME")
    if not user:
        print("  ⚠ could not restrict the file: USERNAME is unset, so no ACL was applied",
              file=sys.stderr)
        return False
    import subprocess

    try:
        r = clilib.run_text(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F", "/grant:r", "*S-1-5-18:F"],
            timeout=15,
        )
    except Exception as err:
        print(f"  ⚠ could not restrict {path}: {err} - it keeps inherited permissions", file=sys.stderr)
        return False
    if r.returncode != 0:
        detail = (r.stderr or r.stdout or "").strip().splitlines()
        print(f"  ⚠ icacls did not restrict {path}: {detail[-1] if detail else 'exit ' + str(r.returncode)}",
              file=sys.stderr)
        return False
    return True


def _write_tunnel(hostname: str, token: str, tunnel_id: str, name: str) -> None:
    cfg = load_config()
    cfg["tunnel"] = {
        **(cfg.get("tunnel") or {}),
        "provider": "named",
        "hostname": hostname,
        "token": token,
        "tunnelId": tunnel_id,
        "tunnelName": name,
    }
    save_config(cfg)


# ── Cloudflare operations ──────────────────────────────────────────────────────
def find_tunnel(name: str) -> dict | None:
    q = urllib.parse.quote(name)
    res = _api("GET", f"/accounts/{_account()}/cfd_tunnel?name={q}&is_deleted=false")
    rows = res.get("result") or []
    return rows[0] if rows else None


def create_tunnel(name: str) -> dict:
    # config_src "cloudflare" = the ingress rules live in Cloudflare and are set by the PUT
    # below, so the connector needs no local config file and `--token` alone is enough to run.
    res = _api("POST", f"/accounts/{_account()}/cfd_tunnel", {"name": name, "config_src": "cloudflare"})
    return res["result"]


def put_ingress(tunnel_id: str, hostname: str) -> None:
    config = {
        "ingress": [
            {"hostname": hostname, "service": f"http://localhost:{GATEWAY_PORT}"},
            # Cloudflare requires a catch-all with no hostname as the LAST rule.
            {"service": "http_status:404"},
        ]
    }
    _api("PUT", f"/accounts/{_account()}/cfd_tunnel/{tunnel_id}/configurations", {"config": config})


def upsert_dns(hostname: str, tunnel_id: str) -> tuple[str, str]:
    """The proxied CNAME that points the hostname at the tunnel. Returns (action, record id)."""
    target = f"{tunnel_id}.cfargotunnel.com"
    q = urllib.parse.quote(hostname)
    existing = (_api("GET", f"/zones/{_zone()}/dns_records?name={q}").get("result") or [])
    body = {"type": "CNAME", "name": hostname, "content": target, "proxied": True,
            "comment": "orchestrator remote dashboard (named tunnel)"}
    if existing:
        rec = existing[0]
        if rec.get("content") == target and rec.get("type") == "CNAME" and rec.get("proxied"):
            return "unchanged", rec["id"]
        _api("PUT", f"/zones/{_zone()}/dns_records/{rec['id']}", body)
        return "updated", rec["id"]
    rec = _api("POST", f"/zones/{_zone()}/dns_records", body)["result"]
    return "created", rec["id"]


def tunnel_token(tunnel_id: str) -> str:
    """The connector credential. Returned into THIS PROCESS only - never printed."""
    return _api("GET", f"/accounts/{_account()}/cfd_tunnel/{tunnel_id}/token")["result"]


# ── commands ───────────────────────────────────────────────────────────────────
def cmd_status() -> int:
    cfg = load_config()
    t = cfg.get("tunnel") or {}
    if not t.get("hostname"):
        print("no named tunnel configured on this machine - the gateway falls back to a")
        print("rotating Quick Tunnel plus the relay's permanent address.")
        print("  provision one:  python scripts/remote_tunnel.py --provision --name orch-<you>")
        return 4
    print(f"named tunnel: {t.get('tunnelName') or '?'}")
    print(f"  hostname:   https://{t['hostname']}")
    print(f"  tunnel id:  {t.get('tunnelId') or '?'}")
    tok = t.get("token") or ""
    print(f"  token:      {'present, sha256:' + fingerprint(tok) if tok else 'MISSING - run --install-token'}")
    print(f"  provider:   {t.get('provider')}")
    return 0


def cmd_provision(name: str, hostname: str | None, dry_run: bool, install: bool = True) -> int:
    """`install=False` provisions a tunnel THIS machine will not run - the sibling's. It creates
    the tunnel, its ingress and its DNS record and stops there, deliberately never fetching the
    connector token, so provisioning Jacob's address from Michael's desk cannot overwrite
    Michael's own tunnel config (one connector per tunnel: two would load-balance the hostname
    across both computers and half the dashboard hits would land on the wrong one)."""
    label = name if hostname is None else hostname.split(".")[0]
    if not HOSTNAME_RE.match(label):
        print(f"'{label}' is not a single DNS label.", file=sys.stderr)
        return 3
    host = hostname or f"{name}.{_zone_name()}"
    if host.count(".") != _zone_name().count(".") + 1:
        print(f"⛔ {host} is not a ONE-LEVEL subdomain of {_zone_name()}.", file=sys.stderr)
        print("   The zone is on Cloudflare's free plan, whose Universal SSL certificate covers", file=sys.stderr)
        print("   only one level. A deeper name resolves and then fails the TLS handshake.", file=sys.stderr)
        return 3
    if dry_run:
        print("DRY RUN - nothing was created.")
        print(f"  tunnel:  {name}  (account {_account()})")
        print(f"  ingress: {host} -> http://localhost:{GATEWAY_PORT}")
        print(f"  DNS:     CNAME {host} -> <tunnel-id>.cfargotunnel.com, proxied")
        print(f"  then the connector token is written to {_config_path()}")
        return 0

    existing = find_tunnel(name)
    if existing:
        tunnel, action = existing, "reused"
    else:
        tunnel, action = create_tunnel(name), "created"
    tid = tunnel["id"]
    print(f"tunnel {action}: {name}  ({tid})")

    put_ingress(tid, host)
    print(f"  ingress set: {host} -> http://localhost:{GATEWAY_PORT}")

    dns_action, rec_id = upsert_dns(host, tid)
    print(f"  DNS {dns_action}: CNAME {host} -> {tid}.cfargotunnel.com (proxied)  [{rec_id}]")

    if not install:
        print("  token NOT fetched - this tunnel belongs to another machine.")
        print()
        print(f"PERMANENT ADDRESS: https://{host}")
        print(f"  On that machine:  python scripts/remote_tunnel.py --install-token --name {name}")
        print("  (or, with no Cloudflare API access there, --export-token here and --import-token there)")
        return 0

    tok = tunnel_token(tid)
    _write_tunnel(host, tok, tid, name)
    print(f"  token stored in {_config_path()}  (sha256:{fingerprint(tok)}, never printed)")
    print()
    print(f"PERMANENT ADDRESS: https://{host}")
    print("  Add it to the OAuth app's redirect URIs as https://" + host + "/oauth/callback,")
    print("  then restart the gateway (the tray icon's 'Restart remote access').")
    return 0


def cmd_install_token(name: str) -> int:
    tunnel = find_tunnel(name)
    if not tunnel:
        print(f"no tunnel named {name!r} on this account - run --provision first", file=sys.stderr)
        return 4
    cfg = load_config()
    host = (cfg.get("tunnel") or {}).get("hostname") or f"{name}.{_zone_name()}"
    tok = tunnel_token(tunnel["id"])
    _write_tunnel(host, tok, tunnel["id"], name)
    print(f"token installed for {name} -> https://{host}  (sha256:{fingerprint(tok)}, never printed)")
    return 0


def _refuse_committable(path: Path) -> str | None:
    """Why this path must not receive a credential, or None if it may.

    ⛔ A LOUD WARNING IS NOT A GUARD. This command used to write the token to whatever path it
    was handed and merely print a warning afterwards, so `--export-token token.json` dropped a
    live credential straight into the repo root, where the very next `git add -A` would stage it
    (audit, 2026-09-03). Inside the repo the file must be one git already ignores; outside it,
    that is the caller's own filesystem and their call.
    """
    try:
        resolved = path.resolve()
        resolved.relative_to(REPO.resolve())
    except (ValueError, OSError):
        return None  # outside the repo entirely - not ours to police
    import subprocess

    try:
        r = clilib.run_text(["git", "-C", str(REPO), "check-ignore", "-q", str(resolved)],
                           capture_output=True, timeout=20)
    except Exception:
        # Cannot ask git => cannot prove it is safe. Refuse: the safe direction.
        return (f"{path} is inside the repo and git could not be asked whether it is ignored.\n"
                f"  Write it under {REPO / 'state'} instead, which is ignored.")
    if r.returncode == 0:
        return None
    return (f"⛔ REFUSED: {path} is inside the repo and git does NOT ignore it, so a credential\n"
            f"  written there is one `git add -A` away from being committed.\n"
            f"  Use a path under {REPO / 'state'} (ignored), or somewhere outside the repo.")


def cmd_export(path: Path, name: str) -> int:
    problem = _refuse_committable(path)
    if problem:
        print(problem, file=sys.stderr)
        return 3
    tunnel = find_tunnel(name)
    if not tunnel:
        print(f"no tunnel named {name!r} on this account", file=sys.stderr)
        return 4
    tok = tunnel_token(tunnel["id"])
    host = f"{name}.{_zone_name()}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"hostname": host, "tunnelId": tunnel["id"], "tunnelName": name, "token": tok}) + "\n",
                    encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    _restrict(path)
    print(f"⚠ WROTE A CREDENTIAL to {path}")
    print(f"  It is the connector token for {host} (sha256:{fingerprint(tok)}).")
    print("  Hand it over out of band (not email, not a git repo, not a chat log), then on the")
    print("  other machine run:  python scripts/remote_tunnel.py --import-token <file>")
    print("  That command shreds the file after reading it.")
    return 0


def _shred(path: Path) -> None:
    """Overwrite then unlink. See the module docstring: on NTFS/SSD this is tidiness, not a
    guarantee of erasure - the journal, shadow copies and wear levelling can all keep the
    original blocks. It removes the casual copy; it does not make the token unrecoverable."""
    try:
        size = path.stat().st_size
        with path.open("r+b") as fh:
            for _ in range(3):
                fh.seek(0)
                fh.write(_secrets.token_bytes(max(size, 1)))
                fh.flush()
                os.fsync(fh.fileno())
        path.unlink()
    except OSError:
        try:
            path.unlink()
        except OSError:
            pass


def cmd_import(path: Path) -> int:
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"cannot read {path}: {err}", file=sys.stderr)
        return 3
    tok = str(rec.get("token") or "")
    host = str(rec.get("hostname") or "")
    if not tok or not host:
        print("that file carries no token/hostname pair", file=sys.stderr)
        return 3
    _write_tunnel(host, tok, str(rec.get("tunnelId") or ""), str(rec.get("tunnelName") or ""))
    _shred(path)
    print(f"installed the named tunnel for https://{host}  (sha256:{fingerprint(tok)})")
    print(f"  and shredded {path}")
    return 0


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    def opt(flag: str) -> str | None:
        if flag in argv:
            i = argv.index(flag)
            if i + 1 < len(argv):
                return argv[i + 1]
        return None

    name = opt("--name") or ""
    hostname = opt("--hostname")
    if "--status" in argv or not argv:
        return cmd_status()
    try:
        if "--provision" in argv:
            if not name:
                print("--provision needs --name (e.g. orch-michael)", file=sys.stderr)
                return 3
            return cmd_provision(name, hostname, "--dry-run" in argv, install="--no-install" not in argv)
        if "--install-token" in argv:
            if not name:
                print("--install-token needs --name", file=sys.stderr)
                return 3
            return cmd_install_token(name)
        if "--export-token" in argv:
            target = opt("--export-token")
            if not target or not name:
                print("--export-token needs a file path and --name", file=sys.stderr)
                return 3
            return cmd_export(Path(target), name)
        if "--import-token" in argv:
            target = opt("--import-token")
            if not target:
                print("--import-token needs a file path", file=sys.stderr)
                return 3
            return cmd_import(Path(target))
    except CfError as err:
        print(f"Cloudflare: {err}", file=sys.stderr)
        return 1
    print("nothing to do - see --help", file=sys.stderr)
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
