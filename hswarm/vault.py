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

SEALED PAIRING (wire format v1, shared with ZSwarm byte for byte): `vault request <backend>` on a new machine makes an
X25519 key (HSWARM_HOME/vault-request.key) and leaves requests/<machine>.json beside the vault file; `vault grant` on a
vault machine seals the pairing code to that public key once a person typed its full fingerprint (requests/<machine>.sealed);
`vault accept` on the new machine opens it and joins. The backend only ever holds the public key and ciphertext, and the
code never reaches a screen, a pipe or a log. A sealed file proves nothing about who wrote it, so `request` also pins the
backend's vault file (HSWARM_HOME/vault-request.pin) and `accept` joins only a code whose key opens that pin.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import re
import secrets
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
LIST_RX = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}_api_keys(\.(dead|unfunded))?$")
KEY_MIN_LEN = 8
KEEP_VERSIONS = 40            # earlier vault files kept beside the current one on the backend: the way back from a bad merge
SYNC_EVERY_S = 120            # the shared server's own sync cadence
FIRST_SYNC_DELAY_S = 20
FIRST_SYNC_TIME = 1           # a first sync's puts are older than any real change: they never beat a tombstone
CAS_TRIES = 8
LOCAL_LOCK_WAIT_S = 10
SSH_TIMEOUT_S = 120
MASS_REMOVE_SHARE = 4         # refuse a sync that removes 1/4 or more of the base's keys ...
MASS_REMOVE_MIN = 5           # ... when that is at least this many, or empties a list that held at least this many


class VaultError(Exception):
    """Something the person has to act on; the text says what. Never carries a key."""


class Conflict(Exception):
    """put() lost the race: the backend's file is no longer the one the caller read."""


class NotGranted(VaultError):
    """`accept` found no sealed grant for this machine's request yet."""


# Sealed pairing, wire format v1: the names, the HKDF info and the AAD prefix are ZSwarm's too, so either side's grant
# opens on the other.
REQUEST_NAME_RX = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}\.(json|sealed)$")
GRANT_INFO = b"zsv1-grant"


def config_file() -> Path:
    return config.HOME / "vault.json"


def request_key_file() -> Path:
    return config.HOME / "vault-request.key"


def request_file() -> Path:
    return config.HOME / "vault-request.json"


def pin_file() -> Path:
    """The backend's vault file as `request` read it: `accept` joins only a code whose key opens it."""
    return config.HOME / "vault-request.pin"


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

    def _request_path(self, name: str) -> Path:
        """requests/<name>, once neither the folder nor the file is a link: a link there could point a write or a delete
        anywhere this user may write."""
        path = self.dir / "requests" / request_name(name)
        for p in (path.parent, path):
            if p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction()):
                raise VaultError(f"{p} is a symlink; refusing")
        return path

    def list_requests(self) -> list[str]:
        try:
            return sorted(p.name for p in (self.dir / "requests").iterdir() if p.is_file() and REQUEST_NAME_RX.fullmatch(p.name))
        except FileNotFoundError:
            return []

    def read_request(self, name: str) -> bytes | None:
        try:
            return self._request_path(name).read_bytes()
        except FileNotFoundError:
            return None

    def write_request(self, name: str, data: bytes) -> None:
        path = self._request_path(name)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self._request_path(name)  # again: the folder may have just been made
        tmp = path.with_name(f".{path.name}.{_tmp_token()}.tmp")  # a dot name never matches the request names, so no reader lists it
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def delete_request(self, name: str) -> None:
        self._request_path(name).unlink(missing_ok=True)


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
# The requests/ folder beside the vault file. {name} is always checked against REQUEST_NAME_RX first, {tmp} against
# _TMP_RX. Exit 8 or 9: the folder or the file is a symlink, and nothing was read, written or removed.
_SSH_REQ_LIST = "d={dir}/requests; test -d $d || exit 0; ls -1 $d"
_SSH_REQ_CHECK = "d={dir}/requests; f=$d/{name}; test ! -L $d || exit 8; test ! -L $f || exit 9; "
_SSH_REQ_READ = _SSH_REQ_CHECK + "test -f $f || exit 3; cat $f"
_SSH_REQ_WRITE = _SSH_REQ_CHECK + "umask 077; mkdir -p $d && chmod 700 $d && cat > $d/.{name}.{tmp}.tmp && mv -f $d/.{name}.{tmp}.tmp $f"
_SSH_REQ_DELETE = _SSH_REQ_CHECK + "rm -f $f"
_TMP_RX = re.compile(r"^[0-9a-f]{16}$")
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

    def _req(self, template: str, what: str, name: str | None = None, stdin: bytes = b"") -> tuple[int, bytes]:
        name = request_name(name) if name is not None else ""
        rc, out, err = self._run(template.format(dir=self.dir, name=name, tmp=_tmp_token()), stdin)
        if rc in (8, 9):
            raise VaultError(f"{self.label}/requests{f'/{name}' if rc == 9 else ''} is a symlink; refusing")
        if rc not in (0, 3):
            raise VaultError(f"could not {what} over ssh ({self.dest}): {err.strip()[:300] or f'exit {rc}'}")
        return rc, out

    def list_requests(self) -> list[str]:
        _rc, out = self._req(_SSH_REQ_LIST, "list the pairing requests")
        return sorted(n for n in out.decode("utf-8", "replace").split() if REQUEST_NAME_RX.fullmatch(n))

    def read_request(self, name: str) -> bytes | None:
        rc, out = self._req(_SSH_REQ_READ, "read a pairing request", name)
        return None if rc == 3 else out

    def write_request(self, name: str, data: bytes) -> None:
        if self._req(_SSH_REQ_WRITE, "write a pairing request", name, data)[0] != 0:
            raise VaultError(f"could not write a pairing request over ssh ({self.dest})")

    def delete_request(self, name: str) -> None:
        self._req(_SSH_REQ_DELETE, "remove a pairing request", name)


def request_name(name: str) -> str:
    """A file name in requests/: checked before it becomes a path or reaches a remote shell."""
    if not isinstance(name, str) or not REQUEST_NAME_RX.fullmatch(name):
        raise VaultError(f"{name!r} is not a pairing request name (<machine>.json or <machine>.sealed)")
    return name


def _tmp_token() -> str:
    """16 random hex digits for a request write's temp file: no two writes share one, and nobody can plant it in advance."""
    token = secrets.token_hex(8)
    if not _TMP_RX.fullmatch(token):
        raise VaultError("could not make a temp file name for a pairing request")
    return token


def open_backend(url: str):
    """The backend a URL names. Add one by writing a class with `label`, get() -> (bytes | None, etag | None) and
    put(blob, expect_etag) -> etag (raising Conflict when expect_etag is stale), plus the requests/ quartet
    list_requests(), read_request(name), write_request(name, bytes) and delete_request(name), and naming its scheme here."""
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


@contextlib.contextmanager
def local_lock():
    """Serialize local key edits and syncs. A busy or unavailable lock refuses the operation."""
    from .client import _lock_fd, _unlock_fd

    path = config.HOME / "vault.lock"
    fd, held = None, False
    try:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as e:
            raise VaultError("the local vault lock could not be opened; nothing was changed") from e
        deadline = time.monotonic() + LOCAL_LOCK_WAIT_S
        while not held:
            try:
                _lock_fd(fd)
                held = True
            except OSError as e:
                if time.monotonic() >= deadline:
                    raise VaultError("another local key edit or sync holds the vault lock; nothing was changed, try again") from e
                time.sleep(0.02)
        yield
    finally:
        if fd is not None:
            try:
                if held:
                    _unlock_fd(fd)
            finally:
                os.close(fd)


def mutate_local(change, *, allow_removals: bool = False) -> dict:
    """Run a local edit and its configured sync under one lock; the callback returns counts or fingerprints only.
    An unsuccessful upload keeps the saved local change for the next sync and explicitly reports that state."""
    with local_lock():
        out = change()
        if configured():
            try:
                out = {**out, "sync": _sync_locked(allow_removals=allow_removals)}
            except VaultError as e:
                raise VaultError(f"local key changes were saved, but vault sync failed: {e}; the next sync will retry") from e
        return out


def sync(*, rebase: bool = False, allow_removals: bool = False, dry_run: bool = False, backend=None) -> dict:
    """Synchronize under the same lock used by local key edits."""
    with local_lock():
        return _sync_locked(rebase=rebase, allow_removals=allow_removals, dry_run=dry_run, backend=backend)


def _sync_locked(*, rebase: bool = False, allow_removals: bool = False, dry_run: bool = False, backend=None) -> dict:
    """One round: read the vault, add what changed here, push it if anything is new there, bring this machine's files up
    to date. Counts only; a key is never in the result."""
    cfg, key = _load_config(), _load_key()
    be = backend or open_backend(cfg["backend"])
    me = cfg.get("machine") or socket.gethostname().lower()
    base = None if rebase else _read_json(base_file())
    local = scan()
    ops, stats = _local_ops(local, base, me, FIRST_SYNC_TIME if base is None else _now_ms())
    if base is not None and not allow_removals:
        _guard(stats)
    merged, remote, pushed = _push(be, key, base, ops, dry_run)
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


def _push(be, key: bytes, base: dict | None, ops, dry_run: bool) -> tuple[dict, dict, bool]:
    """Merge `ops` into the vault and write it back by compare-and-swap, again while another machine writes first.
    Returns the merged state, the remote it was merged into, and whether it was pushed."""
    for _ in range(CAS_TRIES):
        blob, etag = be.get()
        remote = unseal(key, blob) if blob else empty_state()
        if base is not None and remote["rev"] < base.get("rev", 0):
            raise VaultError(f"the server holds an older vault (rev {remote['rev']}, this machine last saw {base['rev']}): it was rolled back "
                             "or replaced; nothing was changed. `hswarm vault sync --rebase` accepts it.")
        merged = merge(remote, {"lists": ops})
        if present(merged) == present(remote) or dry_run:
            return merged, remote, False
        merged["rev"] = remote["rev"] + 1
        try:
            be.put(seal(key, merged), etag)
            return merged, remote, True
        except Conflict:
            continue
    raise VaultError("the vault kept changing under this sync (another machine writing); try again in a minute")


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


def _save_setup(key: bytes, backend: str, via: str | None = None) -> None:
    from .shared import atomic_write

    atomic_write(key_file(), base64.b64encode(key).decode("ascii") + "\n", private=True)
    _write_json(config_file(), {"backend": backend, "machine": socket.gethostname().lower(), **({"via": via} if via else {})})
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


def join(code: str, backend: str | None = None, force: bool = False, *, _via: str | None = None) -> dict:
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
    _save_setup(key, url, _via)
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


def machine_name() -> str:
    """This machine's name in requests/: the host name, lower case, every character outside [a-z0-9-] made '-', no '-' at
    either end, 63 at most ("machine" when nothing is left)."""
    name = re.sub(r"[^a-z0-9-]", "-", socket.gethostname().lower()).strip("-")[:63].rstrip("-") or "machine"
    request_name(f"{name}.json")
    return name


def request_fingerprint(pub: bytes) -> str:
    """sha256 of the raw public key, the first 16 hex characters in groups of 4: what a person compares on both machines."""
    h = hashlib.sha256(pub).hexdigest()[:16].upper()
    return "-".join(h[i:i + 4] for i in range(0, 16, 4))


def _raw_pub(priv) -> bytes:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    return priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _grant_key(shared: bytes, eph_pub: bytes, req_pub: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return HKDF(algorithm=hashes.SHA256(), length=32, salt=eph_pub + req_pub, info=GRANT_INFO).derive(shared)


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text, size: int | None = None) -> bytes:
    raw = base64.b64decode(str(text), validate=True)
    if size is not None and len(raw) != size:
        raise ValueError("length")
    return raw


def seal_grant(code: str, req_pub: bytes, machine: str, *, eph_priv: bytes | None = None, nonce: bytes | None = None) -> dict:
    """The pairing code sealed to one request's public key (X25519 + HKDF-SHA256 + AES-256-GCM, the machine name in the AAD).
    eph_priv and nonce are fixed only by the golden-vector test; a real grant draws both fresh."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    request_name(f"{machine}.sealed")
    eph = X25519PrivateKey.from_private_bytes(eph_priv) if eph_priv is not None else X25519PrivateKey.generate()
    eph_pub = _raw_pub(eph)
    k = _grant_key(eph.exchange(X25519PublicKey.from_public_bytes(req_pub)), eph_pub, req_pub)
    nonce = os.urandom(12) if nonce is None else nonce
    ct = AESGCM(k).encrypt(nonce, code.encode("utf-8"), b"zsv1-grant:" + machine.encode("ascii"))
    return {"v": 1, "machine": machine, "eph": _b64(eph_pub), "nonce": _b64(nonce), "ct": _b64(ct)}


def open_grant(doc, req_priv: bytes, machine: str) -> str:
    """The pairing code inside a sealed grant, or a VaultError (made for another key or machine, or altered): never the code."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        if not isinstance(doc, dict) or doc.get("v") != 1 or doc.get("machine") != machine:
            raise ValueError("shape")
        eph_pub, nonce, ct = _unb64(doc["eph"], 32), _unb64(doc["nonce"], 12), _unb64(doc["ct"])
        priv = X25519PrivateKey.from_private_bytes(req_priv)
        k = _grant_key(priv.exchange(X25519PublicKey.from_public_bytes(eph_pub)), eph_pub, _raw_pub(priv))
        return AESGCM(k).decrypt(nonce, ct, b"zsv1-grant:" + machine.encode("ascii")).decode("utf-8")
    except (InvalidTag, ValueError, KeyError, TypeError, UnicodeDecodeError) as e:
        raise VaultError(f"the grant for {machine} does not open with this machine's request key (made for another request, "
                         "or altered): nothing was saved; ask the vault machine to grant again") from e


def _load_request() -> tuple[dict, bytes]:
    """This machine's open request: its vault-request.json and the private key bytes."""
    req = _read_json(request_file())
    if not isinstance(req, dict) or not req.get("backend") or not request_key_file().exists():
        raise VaultError("no pairing request on this machine: `hswarm vault request <backend>` makes one")
    priv = _read_request_key()
    request_name(f"{req.get('machine')}.json")
    return req, priv


def _read_request_key() -> bytes:
    try:
        return _unb64(request_key_file().read_text(encoding="utf-8").strip(), 32)
    except (OSError, ValueError) as e:
        raise VaultError(f"{request_key_file()} could not be read as a request key ({type(e).__name__}); "
                         "delete it and vault-request.json, then `hswarm vault request <backend>` again") from e


def request(backend: str, force: bool = False) -> dict:
    """Ask the vault at `backend` for its pairing code: publish this machine's request public key there. A repeat re-uses
    the saved key, so the fingerprint stays the one the person already compared. The backend's vault file is pinned here
    (every run refreshes it): `accept` joins only a code whose key opens it, so a grant sealed by anyone else is refused."""
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
    from .shared import atomic_write

    if configured() and not force:
        raise VaultError("this machine already has a vault (`hswarm vault status`); `hswarm vault request --force` asks to replace it")
    be = open_backend(backend)
    machine = machine_name()
    pin, _etag_ = be.get()
    if not pin:
        raise VaultError(f"no vault at {be.label}: a pairing request needs an existing vault")
    if request_key_file().exists():
        priv = X25519PrivateKey.from_private_bytes(_read_request_key())
    else:
        priv = X25519PrivateKey.generate()
        raw = priv.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        atomic_write(request_key_file(), _b64(raw) + "\n", private=True)
    atomic_write(pin_file(), pin, private=True)
    _write_json(request_file(), {"backend": backend, "machine": machine, **({"replace": True} if force else {})})
    pub = _raw_pub(priv)
    doc = {"v": 1, "machine": machine, "pub": _b64(pub), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    be.write_request(f"{machine}.json", json.dumps(doc, sort_keys=True).encode("utf-8"))
    return {"machine": machine, "fingerprint": request_fingerprint(pub), "backend": be.label}


def requests_waiting(be=None) -> list[dict]:
    """The requests on this vault's backend: machine, at, fingerprint and whether a grant is already there. A request file
    that does not parse is listed with an error and is never granted."""
    be = be or open_backend(_load_config()["backend"])
    names = set(be.list_requests())
    out = []
    for name in sorted(n for n in names if n.endswith(".json")):
        machine = name[:-5]
        row = {"machine": machine, "granted": f"{machine}.sealed" in names}
        try:
            doc = json.loads(be.read_request(name) or b"")
            if doc.get("v") != 1 or doc.get("machine") != machine:
                raise ValueError("shape")
            row.update(at=str(doc.get("at") or ""), fingerprint=request_fingerprint(_unb64(doc["pub"], 32)), pub=doc["pub"])
        except (ValueError, KeyError, TypeError, AttributeError):
            row["error"] = "not a v1 pairing request"
        out.append(row)
    return out


def fingerprint_matches(typed, fp: str) -> bool:
    """Whether a person typed the WHOLE fingerprint `fp`: exactly its 16 hex digits once dashes and spaces are removed and
    case is ignored. The one comparison behind the terminal prompt, --yes and the console. A first few characters are not
    enough: anyone who can write to the backend grinds a key whose fingerprint starts the same in seconds."""
    h = re.sub(r"[-\s]", "", str(typed or "")).upper()
    return re.fullmatch(r"[0-9A-F]{16}", h) is not None and h == fp.replace("-", "")


def grant(machine: str | None = None, yes: str | None = None, ask=None) -> dict:
    """Seal this vault's pairing code to one request, once a person confirmed it: `yes`, or what `ask(row)` returns (a
    terminal only), must be the FULL fingerprint. Anything else refuses and writes nothing. Returns the machine and the
    fingerprint, never the code."""
    cfg = _load_config()
    be = open_backend(cfg["backend"])
    rows = [r for r in requests_waiting(be) if "error" not in r]
    if machine is not None:
        request_name(f"{machine}.json")
        chosen = [r for r in rows if r["machine"] == machine]
        if not chosen:
            raise VaultError(f"no pairing request from {machine} on {be.label} (`hswarm vault grant` lists them)")
    else:
        chosen = [r for r in rows if not r["granted"]]
        if len(chosen) != 1:
            raise VaultError("no pairing request is waiting" if not chosen else
                             f"{len(chosen)} requests are waiting ({', '.join(r['machine'] for r in chosen)}): name one, `hswarm vault grant <machine>`")
    row = chosen[0]
    fp = row["fingerprint"]
    if yes is None and ask is None:
        raise VaultError("a grant needs a person: run it in a terminal and type the full fingerprint the new machine printed, "
                         "or pass --yes <that full fingerprint>; nothing was granted")
    if not fingerprint_matches(yes if yes is not None else ask(row), fp):
        raise VaultError(f"that does not match {row['machine']}'s full fingerprint {fp} (all 16 characters; case and dashes "
                         "do not matter); nothing was granted")
    sealed = seal_grant(pair_code(), _unb64(row["pub"], 32), row["machine"])
    be.write_request(f"{row['machine']}.sealed", json.dumps(sealed, sort_keys=True).encode("utf-8"))
    return {"granted": row["machine"], "fingerprint": fp}


def accept(force: bool = False) -> dict:
    """Open this machine's grant and join with it, through the backend URL this machine asked on (the one it reaches).
    Then the request is removed here and on the backend. Returns join's counts, never the code or a key."""
    req, priv = _load_request()
    machine = req["machine"]
    be = open_backend(req["backend"])
    blob = be.read_request(f"{machine}.sealed")
    if blob is None:
        raise NotGranted(f"not granted yet: on the vault machine run `hswarm vault grant {machine}` (or `zswarm vault grant {machine}`)")
    try:
        doc = json.loads(blob)
    except ValueError:
        doc = None
    code = open_grant(doc, priv, machine)
    key, _url = parse_code(code)
    try:
        pin = pin_file().read_bytes()
    except FileNotFoundError:
        raise VaultError("this request was made before the vault pin existed: run `vault request <backend>` again "
                         "(the fingerprint stays the same), then `vault accept`") from None
    try:
        unseal(key, pin)
    except VaultError:
        raise VaultError("the granted code does not open the vault this machine saw when it asked; the grant was not written "
                         "by a vault machine (or the vault was re-keyed since). Nothing was saved.") from None
    out = join(code, backend=req["backend"], force=force or bool(req.get("replace")), _via="accept")
    try:
        be.delete_request(f"{machine}.json")
        be.delete_request(f"{machine}.sealed")
    except (VaultError, OSError) as e:
        out["cleanup"] = f"joined, but requests/{machine}.json and .sealed are still on the backend ({type(e).__name__}): remove them by hand"
    for path in (request_key_file(), request_file(), pin_file()):
        path.unlink(missing_ok=True)
    return out


def _request_status() -> dict | None:
    """This machine's open request, for `status`: machine, fingerprint, whether the vault is pinned and whether the grant is there."""
    if not request_file().exists():
        return None
    try:
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

        req, priv = _load_request()
        row = {"machine": req["machine"], "fingerprint": request_fingerprint(_raw_pub(X25519PrivateKey.from_private_bytes(priv))),
               "pinned": pin_file().exists()}
    except VaultError as e:
        return {"error": str(e)}
    try:
        row["granted"] = "yes" if open_backend(req["backend"]).read_request(f"{req['machine']}.sealed") is not None else "no"
    except (VaultError, OSError) as e:
        row["granted"] = f"unknown ({e})"
    return row


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
    def change():
        have = {key_id(k) for k in scan().get(name, ())}
        new = [k for k in dict.fromkeys(keys) if key_id(k) not in have]
        if new:
            _rewrite(config.SECRETS_DIR / name, set(), new)
        return {"list": name, "added": len(new), "already_there": len(keys) - len(new),
                "fingerprints": [config.fingerprint(k) for k in new]}
    return mutate_local(change)


def remove_key(target: str, fingerprint: str) -> dict:
    name = list_file(target)
    def change():
        hits = [k for k in scan().get(name, ()) if config.fingerprint(k) == fingerprint]
        if not hits:
            raise VaultError(f"no key in {name} has fingerprint {fingerprint!r} (`hswarm vault list {target}`)")
        if len(hits) > 1:
            raise VaultError(f"{len(hits)} keys in {name} share fingerprint {fingerprint!r}; remove one by editing the file")
        _rewrite(config.SECRETS_DIR / name, {key_id(hits[0])}, [])
        return {"list": name, "removed": fingerprint}
    return mutate_local(change, allow_removals=True)


def status() -> dict:
    out = {"configured": configured(), "local": {n: len(k) for n, k in scan().items()}}
    pending = _request_status()
    if pending is not None:
        out["request"] = pending
    if not out["configured"]:
        if zswarm_paired():
            out["adopt"] = f"this machine's ZSwarm has a vault ({zswarm_home()}): `hswarm vault adopt` pairs HSwarm with it"
        return out
    cfg = _load_config()
    base = _read_json(base_file()) or {}
    out.update(backend=cfg["backend"], machine=cfg.get("machine"), last_sync=base.get("at"), last_rev=base.get("rev"))
    if cfg.get("via") == "accept":
        out["paired_by"] = "vault accept: HSwarm joined the vault directly, so `vault adopt` has nothing to do"
    try:
        remote = fetch_state()
        out["vault"] = {"rev": remote["rev"], "keys": live_count(remote), "lists": len({n for (n, _k), v in present(remote).items() if v})}
    except VaultError as e:
        out["vault_error"] = str(e)
    try:
        names = set(open_backend(cfg["backend"]).list_requests())  # one listing, no reads: status stays one round trip more
        out["pending_requests"] = sum(1 for n in names if n.endswith(".json") and f"{n[:-5]}.sealed" not in names)
    except (VaultError, OSError):
        pass
    return out


def leave() -> dict:
    """Stop using the vault on this machine: remove its vault.key, vault.json and base, and nothing else. The key lists in
    secrets/ stay as they are, and so does everything on the backend (other machines keep syncing). Returns where it left."""
    cfg = _load_config()
    label = open_backend(cfg["backend"]).label
    for path in (key_file(), config_file(), base_file()):
        path.unlink(missing_ok=True)
    return {"left": label, "kept_in_folder": sum(len(k) for k in scan().values())}


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
