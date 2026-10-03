"""The key vault: `hswarm vault`. The key lists in HSWARM_HOME/secrets, kept encrypted on a server only you can reach and
in step on every machine that holds the vault key, so a rolled key is one `vault add` / `vault remove` and not a copy
to each PC.

Ported from ZSwarm's zswarm/vault.py (2026-10-03). The stored file, the merge and the pairing code are ZSwarm's own, so
an HSwarm and a ZSwarm paired to the same vault keep each other's lists in step; `hswarm vault adopt` pairs this
HSwarm with the vault this machine's ZSwarm already holds. The server only ever holds ciphertext, so where it lives (an
SSH box, a folder a sync client shares) is a plain choice, never a trust decision.

WHAT is synced: every file in HSWARM_HOME/secrets named <provider>_api_keys, <provider>_api_keys.dead or
<provider>_api_keys.unfunded (one key per line, # comments kept). Those are the lists. Nothing else leaves the machine:
not the provider files in HSWARM_HOME/providers, not the disabled-slot state (that is each machine's own measurement).

HOW, in four rules:
- One encrypted file on the backend (AES-256-GCM, a random 32-byte vault key kept in HSWARM_HOME/vault.key and shared
  between the machines through a pairing code that only prints to a person's own terminal).
- The state is, per list, one entry per key (its sha256 prefix): the key, a time and the machine that wrote it, or a
  tombstone (no key, the dead key's value wiped) when it was removed. Merging two states keeps the newer entry of
  each key, and a tombstone wins a tie. Merge is order-free, so two machines that both changed things converge.
- A machine writes only what changed locally since its last sync (the base, HSWARM_HOME/vault-base.json): keys that
  appeared are puts, keys that vanished are tombstones. The write is compare-and-swap on the file's hash, so a writer
  that lost a race re-reads, merges and retries; nobody's change is overwritten.
- A machine's FIRST sync only adds (its keys carry time 1, so they never override a removal the others made, and
  nothing is deleted from its folder by a base it does not have yet). A sync that would delete a quarter of the keys,
  or empty a whole list, stops and says so (`--allow-removals`): a wiped or missing secrets/ must not erase the vault.

Backends (a URL in HSWARM_HOME/vault.json, chosen at `hswarm vault init`): ssh://[user@]host[:port]/<dir> (the directory
is under the remote home; ssh://host//srv/x is absolute; needs ssh, flock and sha256sum there) and dir:<folder> (a
shared folder, and what the tests use). A new backend is a class with get() and put(); see open_backend.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import zlib
from pathlib import Path
from urllib.parse import urlsplit

from . import config

MAGIC = b"ZSV1"         # ZSwarm's, on purpose: one vault serves both, and a ZSwarm pairing code joins this one
CODE_PREFIX = "zsv1-"
# The lists: a file name is also a path, so only these shapes are ever read or written (a name from the vault is checked
# against it before a byte touches the disk).
LIST_RX = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}_api_keys(\.(dead|unfunded))?$")
KEY_MIN_LEN = 8
KEEP_VERSIONS = 40            # earlier vault files kept beside the current one on the backend: the way back from a bad merge
SYNC_EVERY_S = 120            # the shared server's own sync cadence
FIRST_SYNC_DELAY_S = 20
FIRST_SYNC_TIME = 1           # a first sync's puts are older than any real change: they never beat a tombstone
CAS_TRIES = 8
SSH_TIMEOUT_S = 120
MASS_REMOVE_SHARE = 4         # refuse a sync that removes 1/4 or more of the base's keys ...
MASS_REMOVE_MIN = 5           # ... when that is at least this many, or empties a list that held at least this many


class VaultError(Exception):
    """Something the person has to act on; the text says what. Never carries a key."""


class Conflict(Exception):
    """put() lost the race: the backend's file is no longer the one the caller read."""


def config_file() -> Path:
    return config.HOME / "vault.json"


def key_file() -> Path:
    return config.HOME / "vault.key"


def base_file() -> Path:
    return config.HOME / "vault-base.json"


def configured() -> bool:
    return config_file().exists() and key_file().exists()


def zswarm_home() -> Path:
    """This machine's ZSwarm home, as ZSwarm itself finds it (ZSWARM_HOME, else ~/.zswarm): where `adopt` reads from."""
    return Path(os.environ.get("ZSWARM_HOME") or (Path.home() / ".zswarm"))


def zswarm_paired() -> bool:
    home = zswarm_home()
    return (home / "vault.key").is_file() and (home / "vault.json").is_file()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, doc: dict, private: bool = True) -> None:
    from .shared import atomic_write

    atomic_write(path, json.dumps(doc, indent=1, sort_keys=True) + "\n", private=private)


def _load_config() -> dict:
    cfg = _read_json(config_file())
    if not cfg or not cfg.get("backend") or not key_file().exists():
        raise VaultError("no vault on this machine: `hswarm vault init <backend>` makes one, `hswarm vault join` joins one")
    return cfg


def _load_key() -> bytes:
    try:
        key = base64.b64decode(key_file().read_text(encoding="utf-8").strip(), validate=True)
    except (OSError, ValueError) as e:
        raise VaultError(f"{key_file()} could not be read as a vault key ({type(e).__name__}); join again with `hswarm vault join`") from e
    if len(key) != 32:
        raise VaultError(f"{key_file()} is not a 32-byte vault key; join again with `hswarm vault join`")
    return key


def seal(key: bytes, state: dict) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    plain = zlib.compress(json.dumps(state, sort_keys=True, separators=(",", ":")).encode("utf-8"), 6)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, plain, MAGIC)


def unseal(key: bytes, blob: bytes) -> dict:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if blob[:4] != MAGIC or len(blob) < 32:
        raise VaultError("the stored file is not a ZSwarm/HSwarm vault (wrong folder, or a damaged upload)")
    try:
        plain = AESGCM(key).decrypt(blob[4:16], blob[16:], MAGIC)
        state = json.loads(zlib.decompress(plain))
    except (InvalidTag, zlib.error, ValueError) as e:
        raise VaultError("this machine's vault key does not open the stored vault (another key made it, or the file was altered): "
                         "join again with the current pairing code") from e
    if not isinstance(state, dict) or not isinstance(state.get("lists"), dict):
        raise VaultError("the stored vault has an unknown layout; update hswarm on this machine")
    state.setdefault("rev", 0)
    return state


def _etag(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def key_id(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def empty_state() -> dict:
    return {"rev": 0, "lists": {}}


def _beats(a: dict, b: dict) -> bool:
    """a replaces b: the later time; a tie goes to the removal, then to the machine name, so every machine decides alike."""
    return (a["t"], a["k"] is None, a["by"]) > (b["t"], b["k"] is None, b["by"])


def merge(a: dict, b: dict) -> dict:
    """The union of two states, newest entry per key. Order-free and repeatable: merge(a, b) == merge(b, a)."""
    out = {"rev": max(a.get("rev", 0), b.get("rev", 0)), "lists": {}}
    for name in set(a["lists"]) | set(b["lists"]):
        la, lb = a["lists"].get(name, {}), b["lists"].get(name, {})
        out["lists"][name] = {kid: (la[kid] if kid not in lb else lb[kid] if kid not in la else la[kid] if _beats(la[kid], lb[kid]) else lb[kid])
                              for kid in set(la) | set(lb)}
    return out


def present(state: dict) -> dict[tuple[str, str], bool]:
    return {(name, kid): e["k"] is not None for name, entries in state["lists"].items() for kid, e in entries.items()}


def live_count(state: dict) -> int:
    return sum(1 for e in present(state).values() if e)


def _keys_in(path: Path) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError as e:
        raise VaultError(f"{path.name} is not UTF-8 text, so it was not synced") from e
    return list(dict.fromkeys(s for s in (line.strip() for line in lines) if s and not s.startswith("#")))


def scan() -> dict[str, list[str]]:
    """Every list file in this machine's HSWARM_HOME/secrets -> its keys in file order."""
    folder = config.SECRETS_DIR
    if not folder.is_dir():
        return {}
    return {p.name: _keys_in(p) for p in sorted(folder.iterdir()) if p.is_file() and LIST_RX.fullmatch(p.name)}


def _rewrite(path: Path, drop: set[str], add: list[str]) -> bool:
    """Take the lines whose key id is in `drop` out of a list file and append the keys in `add` that are not there; comments
    and order stay. True when the file changed."""
    from .shared import atomic_write

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    kept, have = [], set()
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#"):
            kid = key_id(s)
            if kid in drop:
                continue
            have.add(kid)
        kept.append(line)
    new = [k for k in dict.fromkeys(add) if key_id(k) not in have]
    if len(kept) == len(lines) and not new:
        return False
    atomic_write(path, "\n".join(kept + new) + "\n", private=True)
    return True


def list_file(target: str) -> str:
    """`openrouter` -> openrouter_api_keys; a full list name (`cohere_api_keys.dead`) stays as it is."""
    name = target if LIST_RX.fullmatch(target or "") else f"{target}_api_keys"
    if not LIST_RX.fullmatch(name):
        raise VaultError(f"{target!r} is not a list: use a provider name (openrouter) or a file name like openrouter_api_keys.dead")
    return name


class DirBackend:
    """The vault file in a folder: a shared drive, a folder a sync client mirrors, or a test's temp dir."""

    def __init__(self, folder: Path):
        self.dir = Path(folder)
        self.label = f"dir:{self.dir}"

    def get(self) -> tuple[bytes | None, str | None]:
        try:
            blob = (self.dir / "vault.bin").read_bytes()
        except FileNotFoundError:
            return None, None
        return blob, _etag(blob)

    def put(self, blob: bytes, expect: str | None) -> str:
        from .client import file_lock
        from .shared import REPLACE_TRIES

        self.dir.mkdir(parents=True, exist_ok=True)
        with file_lock(self.dir / "lock"):
            cur, etag = self.get()
            if etag != expect:
                raise Conflict()
            if cur is not None:
                hist = self.dir / "history"
                hist.mkdir(exist_ok=True)
                (hist / f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{etag[:12]}.bin").write_bytes(cur)
                for old in sorted(hist.iterdir())[:-KEEP_VERSIONS]:
                    old.unlink(missing_ok=True)
            tmp = self.dir / f"vault.{os.getpid()}.tmp"
            tmp.write_bytes(blob)
            for attempt in range(REPLACE_TRIES):
                try:
                    os.replace(tmp, self.dir / "vault.bin")
                    break
                except PermissionError:
                    if attempt == REPLACE_TRIES - 1:
                        tmp.unlink(missing_ok=True)
                        raise
                    time.sleep(0.05 * (attempt + 1))
        return _etag(blob)


# The remote half of the ssh backend: plain sh, one ssh call each. No double quotes, so the command crosses a Windows
# command line unchanged; every value spliced in is checked first (a directory name, a hex digest).
_SSH_GET = "d={dir}; test -f $d/vault.bin || exit 3; cat $d/vault.bin"
_SSH_PUT = (
    "d={dir}; umask 077; mkdir -p $d/history; exec 9>$d/lock; flock -w 30 9 || exit 4; "
    "cur=none; test -f $d/vault.bin && cur=$(sha256sum < $d/vault.bin | cut -c1-64); "
    "test $cur = {expect} || exit 5; "
    "cat > $d/in.tmp; test -s $d/in.tmp || exit 6; "
    "test $(sha256sum < $d/in.tmp | cut -c1-64) = {new} || exit 7; "
    "test -f $d/vault.bin && cp -p $d/vault.bin $d/history/$(date -u +%Y%m%dT%H%M%S).bin; "
    "mv -f $d/in.tmp $d/vault.bin; "
    "ls -1t $d/history | tail -n +{keep} | while read f; do rm -f $d/history/$f; done; exit 0"
)
_NAME_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$")
_DIR_RX = re.compile(r"^/?[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")


class SshBackend:
    """The vault file in a directory on a server reached with the machine's own ssh (its config, keys and agent)."""

    def __init__(self, url: str, run=None):
        parts = urlsplit(url)
        host, user, path = parts.hostname or "", parts.username or "", parts.path[1:]
        try:
            port = parts.port
        except ValueError:
            port = None
        if parts.scheme != "ssh" or not _NAME_RX.match(host) or (user and not _NAME_RX.match(user)):
            raise VaultError(f"{url!r} is not an ssh backend: ssh://[user@]host[:port]/<dir>")
        if not _DIR_RX.match(path) or any(seg in (".", "..") for seg in path.split("/")):
            raise VaultError("the backend directory is letters, digits, '.', '_', '-' and '/' only (relative to the remote home; "
                             "ssh://host//srv/hswarm is absolute)")
        self.dest, self.port, self.dir = (f"{user}@{host}" if user else host), port, path
        self.label = f"ssh://{self.dest}{f':{port}' if port else ''}/{path}"
        self._run = run or self._ssh

    def _ssh(self, script: str, stdin: bytes) -> tuple[int, bytes, str]:
        from .procgate import CREATE_NO_WINDOW

        argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=10"]
        argv += (["-p", str(self.port)] if self.port else []) + [self.dest, script]
        try:
            r = subprocess.run(argv, input=stdin, capture_output=True, timeout=SSH_TIMEOUT_S, creationflags=CREATE_NO_WINDOW)
        except FileNotFoundError as e:
            raise VaultError("ssh is not installed on this machine") from e
        except subprocess.TimeoutExpired as e:
            raise VaultError(f"ssh to {self.dest} timed out after {SSH_TIMEOUT_S}s") from e
        return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")

    def get(self) -> tuple[bytes | None, str | None]:
        rc, out, err = self._run(_SSH_GET.format(dir=self.dir), b"")
        if rc == 3:
            return None, None
        if rc != 0:
            raise VaultError(f"could not read the vault over ssh ({self.dest}): {err.strip()[:300] or f'exit {rc}'}")
        return out, _etag(out)

    def put(self, blob: bytes, expect: str | None) -> str:
        new = _etag(blob)
        rc, _out, err = self._run(_SSH_PUT.format(dir=self.dir, expect=expect or "none", new=new, keep=KEEP_VERSIONS + 1), blob)
        if rc == 0:
            return new
        if rc in (5, 7):  # 5: someone wrote first; 7: the upload arrived damaged. Either way: read again and retry
            raise Conflict()
        raise VaultError({4: "the vault is locked by another writer for over 30 s", 6: "the server received an empty upload"}
                         .get(rc) or f"could not write the vault over ssh ({self.dest}): {err.strip()[:300] or f'exit {rc}'}")


def open_backend(url: str):
    """The backend a URL names. Add one by writing a class with `label`, get() -> (bytes | None, etag | None) and
    put(blob, expect_etag) -> etag (raising Conflict when expect_etag is stale), and naming its scheme here."""
    if url.startswith("dir:"):
        return DirBackend(Path(url[4:]))
    if url.startswith("ssh://"):
        return SshBackend(url)
    raise VaultError(f"unknown backend {url!r}: use ssh://[user@]host[:port]/<dir> or dir:<folder>")


def _local_ops(local: dict[str, list[str]], base: dict | None, me: str, t: int) -> tuple[dict, dict]:
    """What changed here since the last sync, as entries to merge, and the counts the guard looks at."""
    was = (base or {}).get("lists", {})
    ops: dict[str, dict] = {}
    stats = {"added": 0, "removed": 0, "emptied": []}
    for name in set(local) | set(was):
        now = {key_id(k): k for k in local.get(name, ())}
        old = set(was.get(name, ()))
        for kid in set(now) - old:
            ops.setdefault(name, {})[kid] = {"k": now[kid], "t": t, "by": me}
            stats["added"] += 1
        for kid in old - set(now):
            ops.setdefault(name, {})[kid] = {"k": None, "t": t, "by": me}
            stats["removed"] += 1
        if len(old) >= MASS_REMOVE_MIN and not now:
            stats["emptied"].append(name)
    stats["base_total"] = sum(len(v) for v in was.values())
    return ops, stats


def _guard(stats: dict) -> None:
    mass = stats["removed"] >= MASS_REMOVE_MIN and stats["removed"] * MASS_REMOVE_SHARE >= stats["base_total"]
    if stats["emptied"] or mass:
        what = (f"empties {', '.join(sorted(stats['emptied']))}" if stats["emptied"] else f"removes {stats['removed']} of {stats['base_total']} keys")
        raise VaultError(f"this sync {what}, which looks like a wiped or missing secrets folder rather than a roll, so nothing was changed. "
                         "If it is on purpose, run `hswarm vault sync --allow-removals`; if this folder was lost, "
                         "`hswarm vault sync --rebase` brings every key back from the vault.")


def _apply_local(merged: dict, local: dict[str, list[str]]) -> dict:
    """Make this machine's list files agree with the merged state: add the keys it lacks, drop the ones tombstoned.
    Returns the new base lists and the counts."""
    folder = config.SECRETS_DIR
    added = removed = 0
    for name, entries in merged["lists"].items():
        if not LIST_RX.fullmatch(name):
            continue  # a name that is not a list is never a path
        have = {key_id(k) for k in local.get(name, ())}
        drop = {kid for kid, e in entries.items() if e["k"] is None and kid in have}
        add = [e["k"] for kid, e in sorted(entries.items()) if e["k"] is not None and kid not in have]
        if drop or add:
            _rewrite(folder / name, drop, add)
            added, removed = added + len(add), removed + len(drop)
    after = scan()
    base = {name: sorted(kid for kid in map(key_id, keys) if merged["lists"].get(name, {}).get(kid, {}).get("k") is not None)
            for name, keys in after.items()}
    return {"lists": base, "added": added, "removed": removed}


def sync(*, rebase: bool = False, allow_removals: bool = False, dry_run: bool = False, backend=None) -> dict:
    """One round: read the vault, add what changed here, push it if anything is new there, bring this machine's files up
    to date. Counts only; a key is never in the result."""
    from .client import file_lock

    cfg, key = _load_config(), _load_key()
    be = backend or open_backend(cfg["backend"])
    me = cfg.get("machine") or socket.gethostname().lower()
    with file_lock(config.HOME / "vault.lock"):
        base = None if rebase else _read_json(base_file())
        local = scan()
        ops, stats = _local_ops(local, base, me, FIRST_SYNC_TIME if base is None else _now_ms())
        if base is not None and not allow_removals:
            _guard(stats)
        merged = remote = None
        pushed = False
        for _ in range(CAS_TRIES):
            blob, etag = be.get()
            remote = unseal(key, blob) if blob else empty_state()
            if base is not None and remote["rev"] < base.get("rev", 0):
                raise VaultError(f"the server holds an older vault (rev {remote['rev']}, this machine last saw {base['rev']}): it was rolled back "
                                 "or replaced; nothing was changed. `hswarm vault sync --rebase` accepts it.")
            merged = merge(remote, {"lists": ops})
            if present(merged) == present(remote) or dry_run:
                break
            merged["rev"] = remote["rev"] + 1
            try:
                be.put(seal(key, merged), etag)
                pushed = True
                break
            except Conflict:
                continue
        else:
            raise VaultError("the vault kept changing under this sync (another machine writing); try again in a minute")
        after, before = present(merged), present(remote)  # once each: this runs over every key, and 60,000 of them is seconds, not hours
        into_vault = sum(1 for k, v in after.items() if v and not before.get(k))
        out_of_vault = sum(1 for k, v in after.items() if not v and before.get(k))
        if dry_run:
            held = {n: {key_id(k) for k in keys} for n, keys in local.items()}
            local_add = sum(1 for (n, kid), v in after.items() if v and kid not in held.get(n, ()) and LIST_RX.fullmatch(n))
            return {"backend": be.label, "dry_run": True, "pushed": False, "rev": remote["rev"], "to_vault": into_vault, "from_vault": out_of_vault,
                    "to_here": local_add, "keys": live_count(merged)}
        applied = _apply_local(merged, local)
        _write_json(base_file(), {"rev": merged["rev"], "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lists": applied["lists"]})
    return {"backend": be.label, "dry_run": False, "pushed": pushed, "rev": merged["rev"], "to_vault": into_vault, "from_vault": out_of_vault,
            "added_here": applied["added"], "removed_here": applied["removed"], "keys": live_count(merged), "lists": len(applied["lists"])}


def init(backend: str) -> dict:
    """Make a vault on this machine: a new vault key, the backend, then the first sync (it imports every key here)."""
    if configured():
        raise VaultError("this machine already has a vault (`hswarm vault status`); remove vault.key and vault.json from HSWARM_HOME to start over")
    be = open_backend(backend)
    key = os.urandom(32)
    blob, _etag_ = be.get()
    if blob:
        raise VaultError(f"{be.label} already holds a vault; join it instead: `hswarm vault join` with the code from the machine that made it")
    _save_setup(key, backend)
    return {"set_up": be.label, **sync()}


def _save_setup(key: bytes, backend: str) -> None:
    from .shared import atomic_write

    atomic_write(key_file(), base64.b64encode(key).decode("ascii") + "\n", private=True)
    _write_json(config_file(), {"backend": backend, "machine": socket.gethostname().lower()})
    base_file().unlink(missing_ok=True)


def pair_code() -> str:
    """The key to every stored key, with where the vault is, as `init` was given it (never rewritten to an address this machine's
    ssh config resolved: a login that is refused counts toward an IP ban, a name that does not resolve costs nothing).
    Hand it to the other person directly, never through a chat."""
    cfg = _load_config()
    payload = {"v": 1, "key": base64.b64encode(_load_key()).decode("ascii"), "backend": cfg["backend"]}
    return CODE_PREFIX + base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii").rstrip("=")


def parse_code(code: str) -> tuple[bytes, str]:
    code = (code or "").strip()
    try:
        if not code.startswith(CODE_PREFIX):
            raise ValueError("prefix")
        body = code[len(CODE_PREFIX):]
        doc = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        key = base64.b64decode(doc["key"], validate=True)
        backend = str(doc["backend"])
        if len(key) != 32 or doc.get("v") != 1:
            raise ValueError("shape")
    except (ValueError, KeyError, TypeError) as e:
        raise VaultError("that is not a vault pairing code (it starts with zsv1-): run `hswarm vault pair` on the machine that has the vault") from e
    return key, backend


def join(code: str, backend: str | None = None, force: bool = False) -> dict:
    """Join the vault a pairing code names: keep this machine's own keys, add everyone else's, remove nothing."""
    if configured() and not force:
        raise VaultError("this machine already has a vault (`hswarm vault status`); `hswarm vault join --force` replaces it")
    key, url = parse_code(code)
    url = backend or url
    be = open_backend(url)
    try:
        blob, _etag_ = be.get()
    except VaultError as e:
        hint = "" if backend else f" (the code's address is {be.label}; if this machine reaches the server under another ssh name, add `--backend ssh://<that name>/<dir>`)"
        raise VaultError(f"{e}{hint}") from e
    if blob:
        unseal(key, blob)  # a code that does not open the stored vault stops here, before anything is saved
    _save_setup(key, url)
    return {"joined": be.label, **sync()}


def adopt() -> dict:
    """Pair this HSwarm with the vault this machine's ZSwarm already holds: copy its vault.key and vault.json into
    HSWARM_HOME (owner-only, as `init` and `join` write them), then a first sync, which only adds. Nothing is copied
    unless the key opens the stored vault. Counts only: the vault key is copied, never shown."""
    if configured():
        raise VaultError("HSWARM_HOME already has a vault (`hswarm vault status`); adopt only sets up one that has none")
    src = zswarm_home()
    if not zswarm_paired():
        raise VaultError(f"no ZSwarm vault to adopt: {src} has no vault.key and vault.json "
                         "(`hswarm vault join` takes a pairing code instead)")
    cfg = _read_json(src / "vault.json")
    if not isinstance(cfg, dict) or not cfg.get("backend"):
        raise VaultError(f"{src / 'vault.json'} names no backend; run `zswarm vault status` there first")
    try:
        key = base64.b64decode((src / "vault.key").read_text(encoding="utf-8").strip(), validate=True)
    except (OSError, ValueError) as e:
        raise VaultError(f"{src / 'vault.key'} could not be read as a vault key ({type(e).__name__})") from e
    if len(key) != 32:
        raise VaultError(f"{src / 'vault.key'} is not a 32-byte vault key")
    be = open_backend(str(cfg["backend"]))
    blob, _etag_ = be.get()
    if blob:
        unseal(key, blob)  # a key that does not open the stored vault stops here, before anything is copied
    from .shared import atomic_write

    atomic_write(key_file(), base64.b64encode(key).decode("ascii") + "\n", private=True)
    _write_json(config_file(), cfg)
    base_file().unlink(missing_ok=True)
    return {"adopted_from": str(src), **sync()}


def fetch_state() -> dict:
    cfg, key = _load_config(), _load_key()
    blob, _etag_ = open_backend(cfg["backend"]).get()
    return unseal(key, blob) if blob else empty_state()


def rows(target: str | None = None) -> list[dict]:
    """The keys in this machine's lists (fingerprint and masked form, never the key), with who put each in the vault and when
    when the vault can be read."""
    from .settings import mask

    try:
        entries = fetch_state()["lists"]
    except VaultError:
        entries = {}
    out = []
    for name, keys in scan().items():
        if target and name != list_file(target):
            continue
        for k in keys:
            e = entries.get(name, {}).get(key_id(k), {})
            out.append({"list": name, "fingerprint": config.fingerprint(k), "masked": mask(k), "by": e.get("by"),
                        "at": time.strftime("%Y-%m-%d %H:%M", time.localtime(e["t"] / 1000)) if e.get("t", 0) > 1000 else None})
    return out


def add_keys(target: str, keys: list[str]) -> dict:
    """Append keys to a list file, then sync, so every machine has them within a minute."""
    name = list_file(target)
    bad = [k for k in keys if len(k) < KEY_MIN_LEN or any(c.isspace() for c in k)]
    if bad or not keys:
        raise VaultError(f"a key is one unbroken string of at least {KEY_MIN_LEN} characters" if bad else "no key given")
    have = {key_id(k) for k in scan().get(name, ())}
    new = [k for k in dict.fromkeys(keys) if key_id(k) not in have]
    if new:
        _rewrite(config.SECRETS_DIR / name, set(), new)
    out = {"list": name, "added": len(new), "already_there": len(keys) - len(new), "fingerprints": [config.fingerprint(k) for k in new]}
    return {**out, "sync": sync()} if configured() else out


def remove_key(target: str, fingerprint: str) -> dict:
    name = list_file(target)
    hits = [k for k in scan().get(name, ()) if config.fingerprint(k) == fingerprint]
    if not hits:
        raise VaultError(f"no key in {name} has fingerprint {fingerprint!r} (`hswarm vault list {target}`)")
    if len(hits) > 1:
        raise VaultError(f"{len(hits)} keys in {name} share fingerprint {fingerprint!r}; remove one by editing the file")
    _rewrite(config.SECRETS_DIR / name, {key_id(hits[0])}, [])
    out = {"list": name, "removed": fingerprint}
    return {**out, "sync": sync(allow_removals=True)} if configured() else out


def status() -> dict:
    out = {"configured": configured(), "local": {n: len(k) for n, k in scan().items()}}
    if not out["configured"]:
        if zswarm_paired():
            out["adopt"] = f"this machine's ZSwarm has a vault ({zswarm_home()}): `hswarm vault adopt` pairs HSwarm with it"
        return out
    cfg = _load_config()
    base = _read_json(base_file()) or {}
    out.update(backend=cfg["backend"], machine=cfg.get("machine"), last_sync=base.get("at"), last_rev=base.get("rev"))
    try:
        remote = fetch_state()
        out["vault"] = {"rev": remote["rev"], "keys": live_count(remote), "lists": len({n for (n, _k), v in present(remote).items() if v})}
    except VaultError as e:
        out["vault_error"] = str(e)
    return out


def autosync_loop() -> None:
    """The shared server's thread: sync every SYNC_EVERY_S while a vault is set up, say so on a change and say each new
    failure once. A refused sync (the guard) is not retried until a person acts; the loop just keeps looking."""
    time.sleep(FIRST_SYNC_DELAY_S)
    last = None
    while True:
        last = autosync_tick(last)
        time.sleep(SYNC_EVERY_S)


def autosync_tick(last: str | None = None) -> str | None:
    """One round of the loop: nothing at all without a vault. Returns the failure it reported (or None), so the next
    round says the same failure only once."""
    try:
        if configured():
            r = sync()
            if r["pushed"] or r["added_here"] or r["removed_here"]:
                print(f"[hswarm vault] rev {r['rev']}: {r['to_vault']} keys to the vault, {r['added_here']} added here, "
                      f"{r['removed_here']} removed here ({r['keys']} keys)", file=sys.stderr, flush=True)
        return None
    except Exception as e:  # noqa: BLE001 - a sync that died would leave this machine out of step until the next restart
        msg = f"{type(e).__name__}: {e}"
        if msg != last:
            print(f"[hswarm vault] sync failed: {msg}", file=sys.stderr, flush=True)
        return msg
