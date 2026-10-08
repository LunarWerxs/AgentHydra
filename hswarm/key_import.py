"""Merge validated key exports into the vault-backed lists. Reports contain counts only.

An alive export is additive, never a keep-list: absence is not evidence of revocation.
Explicit dead lists remove keys from active lists; a newer alive export overrides old
dead/unfunded classifications. Credit and manual disables remain local measurements.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import tomlkit

from . import config, keystate, vault
from .shared import atomic_write

EXPORT_RX = re.compile(r"^([a-z0-9][a-z0-9_-]{0,62})_(alive|dead|unfunded)_keys\.txt$")


class KeyImportError(ValueError):
    """An input error, always described without a key value."""


def _lines(path: Path) -> list[str]:
    if path.is_symlink():
        raise KeyImportError(f"refusing a linked key file: {path.name}")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as e:
        raise KeyImportError(f"could not read {path.name} ({type(e).__name__})") from e
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        key = line.strip()
        if not key or key.startswith("#"):
            continue
        if len(key) < vault.KEY_MIN_LEN or any(c.isspace() for c in key):
            raise KeyImportError(f"{path.name}, line {i}: expected one unbroken key per line")
        out.append(key)
    return list(dict.fromkeys(out))


def _import_aliases() -> dict[str, str]:
    """Provider-owned aliases route exporter names into the same canonical vault list."""
    config.refresh()
    aliases: dict[str, str] = {}
    for provider, spec in config.PROVIDERS.items():
        names = spec.get("import_aliases", ())
        if not isinstance(names, (list, tuple)):
            raise KeyImportError(f"invalid import_aliases for {provider}")
        for name in names:
            if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", name):
                raise KeyImportError(f"invalid import alias for {provider}")
            if name == provider:
                continue
            if name in config.PROVIDERS or (name in aliases and aliases[name] != provider):
                raise KeyImportError(f"ambiguous provider import alias: {name}")
            aliases[name] = provider
    return aliases


def read_export(source: Path) -> tuple[dict[str, list[str]], dict[str, str]]:
    if not source.is_dir() or source.is_symlink():
        raise KeyImportError("the source must be a real directory of key-list files")
    # Retain the old clone/.secrets input, without its previous destructive copy.
    folder = source / ".secrets" if (source / ".secrets").is_dir() else source
    if folder.is_symlink():
        raise KeyImportError("refusing a linked source directory")
    aliases = _import_aliases()
    routes: dict[str, str] = {}
    lists: dict[str, list[str]] = {}
    for path in sorted(folder.iterdir()):
        name = path.name
        match = EXPORT_RX.fullmatch(name)
        if match:
            provider, status = match.groups()
            canonical = aliases.get(provider, provider)
            if canonical not in config.PROVIDERS:
                raise KeyImportError(f"no H Swarm provider for export: {provider}; add its provider configuration first")
            if canonical != provider:
                routes[provider] = canonical
            provider = canonical
            name = f"{provider}_api_keys" + ({"dead": ".dead", "unfunded": ".unfunded"}.get(status, ""))
        elif not vault.LIST_RX.fullmatch(name):
            continue
        else:
            base = name.removesuffix(".dead").removesuffix(".unfunded").removesuffix("_api_keys")
            if base in aliases:
                routes[base] = aliases[base]
                name = aliases[base] + name[len(base):]
        if not path.is_file():
            raise KeyImportError(f"expected a regular key-list file: {path.name}")
        lists[name] = list(dict.fromkeys([*lists.get(name, []), *_lines(path)]))
    if not lists:
        raise KeyImportError("no supported key lists found (expected *_alive_keys.txt or *_api_keys)")
    for name, values in lists.items():
        if name.endswith((".dead", ".unfunded")):
            continue
        if set(values) & set(lists.get(name + ".dead", ())):
            raise KeyImportError(f"the export marks the same key both alive and dead in {name}")
    return lists, routes


def _state_snapshot() -> dict:
    """Read operational evidence without migrating the legacy state or writing during preview."""
    db = config.KEYS_STATE.with_suffix(".sqlite")
    try:
        if db.exists():
            c = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True)
            try:
                state = {fp: json.loads(text) for fp, text in c.execute("SELECT fp, entry FROM keys")}
            finally:
                c.close()
        elif config.KEYS_STATE.exists():
            state = json.loads(config.KEYS_STATE.read_text(encoding="utf-8"))
        else:
            state = {}
        if not isinstance(state, dict) or any(not isinstance(e, dict) for e in state.values()):
            raise ValueError("invalid key-state shape")
        return state
    except (OSError, ValueError, sqlite3.Error) as e:
        raise KeyImportError("could not read explicit revoked-key evidence; no key lists changed") from e


def _revoked(entry: dict) -> bool:
    why = str(entry.get("disabled_reason") or "").lower()
    return bool(entry.get("disabled")) and entry.get("disabled_status") in (400, 401, 403) \
        and ("revoked" in why or "rejected this key" in why)


def _plan(incoming: dict[str, list[str]]) -> tuple[dict, dict[str, list[str]], list[tuple[Path, str]]]:
    local = vault.scan()
    desired = {n: list(v) for n, v in local.items()}
    toml_edits = []
    migrated = 0
    # Retire persistent TOML key copies, preserving all settings and comments.
    for path in sorted(config.PROVIDERS_DIR.glob("*.toml")):
        if path.is_symlink():
            raise KeyImportError(f"refusing a linked provider file: {path.name}")
        try:
            doc = tomlkit.parse(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise KeyImportError(f"could not parse provider file {path.name} ({type(e).__name__})") from e
        if "keys" not in doc:
            continue
        raw = doc["keys"]
        raw = [raw] if isinstance(raw, str) else raw
        if not isinstance(raw, (list, tomlkit.items.Array)) or any(not isinstance(k, str) for k in raw):
            raise KeyImportError(f"invalid keys field in {path.name}")
        name = f"{path.stem}_api_keys"
        if not vault.LIST_RX.fullmatch(name):
            raise KeyImportError(f"provider name cannot form a vault list: {path.name}")
        held = [k.strip() for k in raw if k.strip()]
        if any(len(k) < vault.KEY_MIN_LEN or any(c.isspace() for c in k) for k in held):
            raise KeyImportError(f"invalid key entry in {path.name}")
        migrated += len(set(held) - set(desired.get(name, ())))
        desired[name] = list(dict.fromkeys([*desired.get(name, []), *held]))
        del doc["keys"]
        toml_edits.append((path, tomlkit.dumps(doc)))
    for name, values in incoming.items():
        desired[name] = list(dict.fromkeys([*desired.get(name, []), *values]))

    by_fp: dict[str, set[str]] = {}
    for name, values in desired.items():
        if not name.endswith((".dead", ".unfunded")):
            for key in values:
                by_fp.setdefault(config.fingerprint(key), set()).add(key)
    revoked = {fp for fp, e in _state_snapshot().items() if len(by_fp.get(fp, ())) == 1 and _revoked(e)}
    providers = sorted({n.removesuffix(".dead").removesuffix(".unfunded").removesuffix("_api_keys") for n in desired})
    rows = []
    for provider in providers:
        name = provider + "_api_keys"
        alive = set(incoming.get(name, ()))
        # Persist explicit revoked evidence as a synced classification, so another machine's
        # older active copy cannot return the key to the usable pool.
        revoked_keys = [k for k in desired.get(name, ()) if config.fingerprint(k) in revoked and k not in alive]
        if revoked_keys:
            desired[name + ".dead"] = list(dict.fromkeys([*desired.get(name + ".dead", []), *revoked_keys]))
        dead = set(desired.get(name + ".dead", ())) - alive
        active = desired.get(name, [])
        removed = len(set(active) & dead)
        desired[name] = [k for k in active if k not in dead]
        restored = 0
        for suffix in (".dead", ".unfunded"):
            archive = name + suffix
            if archive in desired:
                restored += len(set(desired[archive]) & alive)
                desired[archive] = [k for k in desired[archive] if k not in alive]
        added = len(set(desired[name]) - set(local.get(name, ())))
        if alive or removed or restored or added:
            rows.append({"provider": provider, "incoming_alive": len(alive), "added": added,
                         "removed_dead": removed, "restored_classifications": restored,
                         "active_after": len(desired[name])})
    changed = {n: v for n, v in desired.items() if set(v) != set(local.get(n, ())) }
    report = {"incoming_files": len(incoming), "incoming_alive": sum(len(v) for n, v in incoming.items()
              if not n.endswith((".dead", ".unfunded"))), "added": sum(r["added"] for r in rows),
              "removed_dead": sum(r["removed_dead"] for r in rows),
              "restored_classifications": sum(r["restored_classifications"] for r in rows),
              "migrated_from_toml": migrated, "provider_files_consolidated": len(toml_edits),
              "changed_lists": len(changed), "providers": rows}
    return report, changed, toml_edits


def _restore_revoked(incoming: dict[str, list[str]]) -> int:
    """A valid alive check contradicts revocation; it says nothing about paid credit."""
    alive = {config.fingerprint(k) for n, values in incoming.items()
             if not n.endswith((".dead", ".unfunded")) for k in values}
    by_fp: dict[str, set[str]] = {}
    for values in vault.scan().values():
        for key in values:
            by_fp.setdefault(config.fingerprint(key), set()).add(key)
    alive = {fp for fp in alive if len(by_fp.get(fp, ())) == 1}
    restored = 0
    with keystate.txn() as tx:
        if tx is None:
            raise KeyImportError("key lists saved, but key-state database is busy; run the import again")
        for fp, text, _rev in tx.changes(None):
            if fp not in alive:
                continue
            entry = json.loads(text)
            if _revoked(entry):
                tx.put(fp, {k: entry[k] for k in keystate._READINGS if k in entry})
                restored += 1
    return restored


def run(source: Path, *, dry_run: bool = False) -> dict:
    incoming, routes = read_export(source)
    if dry_run:
        with vault.local_lock():
            report, _changed, _edits = _plan(incoming)
        return {**report, "provider_routes": routes, "dry_run": True, "vault_configured": vault.configured()}

    # Include the latest shared additions/evidence before calculating removals. Keep the usual
    # guard for pre-existing local changes; only the subsequent evidence-based edit allows removals.
    if vault.configured():
        vault.sync()

    def change():
        report, changed, edits = _plan(incoming)
        before = {p: p.read_bytes() for p, _text in edits}
        list_before = {config.SECRETS_DIR / n: (config.SECRETS_DIR / n).read_bytes()
                       if (config.SECRETS_DIR / n).exists() else None for n in changed}
        try:
            for name, values in changed.items():
                path = config.SECRETS_DIR / name
                old = set(vault._keys_in(path)) if path.exists() else set()
                wanted = set(values)
                vault._rewrite(path, {vault.key_id(k) for k in old - wanted}, [k for k in values if k not in old])
            for path, text in edits:
                atomic_write(path, text, private=True)
            restored = _restore_revoked(incoming)
        except BaseException:
            for path, data in {**list_before, **before}.items():
                if data is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_write(path, data, private=True)
            raise
        return {**report, "provider_routes": routes, "dry_run": False, "revoked_states_restored": restored}

    # Deletions are backed by explicit dead lists, never by absence from the export.
    return vault.mutate_local(change, allow_removals=True)
