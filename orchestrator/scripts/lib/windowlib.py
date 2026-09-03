"""windowlib - put a desktop window back the way the owner had it.

WHY (owner, 2026-09-01: "often I'm noticing you end up full screening the desktop instance for
some reason - we should stop that from happening").

WHAT WAS MEASURED, because the first two guesses were wrong: firing `claude://resume?session=`
at a running instance left its placement byte-identical (showCmd 1, same rect), and so did
`claude://code/new`. So the toolbox's two deeplink routes do NOT maximize anything on their
own, and this is NOT the fix for a cause we understood - it is a guard for one we did not
fully catch. What remains is the app's own second-instance handling and its fresh-start
placement, neither of which we can switch off from outside.

So the guard is the considerate thing rather than the clever one: note how the window was
before we poke the app, put it back if it changed, and LEAVE A LINE IN THE LOG when it had to.
That line is the evidence the next occurrence needs - if a route really does maximize a window,
this names it instead of the owner having to notice it again.

⛔ It restores placement ONLY. It never raises, focuses, moves or resizes a window on its own,
never touches one the owner has minimized in the meantime, and does nothing at all when the
placement is unchanged - which, per the measurement above, is the normal case.
"""

from __future__ import annotations

import contextlib
import re
import time
from pathlib import Path

from lib import clilib

ACTUATOR = Path(__file__).resolve().parents[1] / "actuator" / "window_placement.ps1"
# A UI lock older than this belongs to a dead lane (send pipeline worst case: a daemon message
# call of CONFIRM_SECS+120s plus a CONFIRM_SECS actuator confirm, ~7 min) and is broken.
UI_LOCK_STALE_SECS = 15 * 60


def _lock_key(instance: str | None) -> str:
    """One key per instance whether the caller names it ('5claude') or paths it
    ('C:\\...\\.claude-instances\\5claude') - both shapes reach the lanes."""
    s = str(instance or "").strip()
    if "/" in s or chr(92) in s:
        s = Path(s).name
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or "unknown"


@contextlib.contextmanager
def instance_lock(instance: str | None, wait_secs: float = 90.0):
    """ONE DRIVER PER WINDOW AT A TIME. `with instance_lock(inst) as mine:` yields True when
    this process holds the instance's UI lock, False when another lane kept it past
    `wait_secs` - then SKIP the poke and say so; it is retried next cycle.

    WHY (review 2026-09-01): every 5-minute lane has its own job lock and none of them share
    one per WINDOW, yet the courier's composer send, archive_chat's sidebar control,
    unblock_prompts' Allow press and spawn_chat's deeplink all drive the same Electron window
    of one instance. Interleaved, one lane's sidebar click switches the pane another lane is
    typing into - the exact wrong-chat failure the verify rail exists for - and two
    capture/restore pairs can leave the window re-maximized after the first lane put it back
    (the owner's "full screening" complaint, from the very guard meant to stop it).

    An atomic mkdir is the lock (the same shape as the courier's per-delivery claim); a stale
    one is broken loudly. Nothing here raises: an instance-less caller simply proceeds.
    """
    if not instance:
        yield True
        return
    from lib import ledgerlib

    path = ledgerlib._state_dir() / "locks" / f"ui-{_lock_key(instance)}"
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + max(0.0, wait_secs)
    held = False
    while True:
        try:
            path.mkdir()
            held = True
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > UI_LOCK_STALE_SECS:
                    path.rmdir()  # a dead lane's leftovers - break it and retake
                    continue
            except OSError:
                continue  # it vanished: the other lane just finished - retake
            if time.time() >= deadline:
                break
            time.sleep(1.0)
        except OSError:
            held = True  # the locks dir itself is unusable: never let a courtesy block work
            break
    try:
        if held:
            # THE LOCK IS THE ONE PLACE EVERY DRIVER PASSES THROUGH, so the placement courtesy
            # lives here too (owner, 2026-09-01: "something full screened one of the accounts
            # again" during the live smoke). Before this, only archive, courier and rename
            # wrapped keep_placement themselves; the doctrine picker, the spawn's deeplink and
            # trust dialog, the unblock press and the naming pass drove the same windows with
            # nothing putting them back. One mechanism, every caller, no way to forget it.
            with keep_placement(instance):
                yield held
        else:
            yield held
    finally:
        if held:
            with contextlib.suppress(OSError):
                path.rmdir()


def _run(args: list[str]) -> tuple[int, str]:
    try:
        r = clilib.run_text(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR)]
            + args, timeout=60)
        return r.returncode, (r.stdout or "").strip()
    except Exception as err:  # a courtesy must never break the delivery it wraps
        return 1, str(err)[:160]


def capture(instance: str | None) -> str | None:
    """The window's placement as an opaque JSON line, or None when there is nothing to keep."""
    if not instance or not ACTUATOR.exists():
        return None
    code, out = _run(["-Capture", "-Instance", str(instance)])
    return out if code == 0 and out.startswith("{") else None


def restore(instance: str | None, state: str | None) -> str | None:
    """Put it back if it moved. Returns a note ONLY when a restore actually happened."""
    if not instance or not state or not ACTUATOR.exists():
        return None
    code, out = _run(["-Apply", "-Instance", str(instance), "-State", state])
    return out if code == 0 and out.startswith("restored") else None


def unmaximize(instance: str | None) -> str | None:
    """A window WE just brought up that came up maximized is put back to normal (its own
    restore rect, showCmd 1). Returns a note only when that actually happened.

    The app relaunches with its profile's saved placement, and a profile last closed
    maximized reopens full screen natively (AgentHydra's launcher says so in its own
    comments) - which is how an instance the toolbox opened during the live smoke filled the
    owner's screen (2026-09-01: "something full screened one of the accounts again"). This
    touches only a window that is maximized RIGHT NOW after our own open; it never fights a
    window the owner sized himself later."""
    if not instance or not ACTUATOR.exists():
        return None
    state = capture(instance)
    if not state:
        return None
    try:
        import json

        placement = json.loads(state)
    except ValueError:
        return None
    if int(placement.get("showCmd") or 0) != 3:
        return None
    placement["showCmd"] = 1
    return restore(instance, json.dumps(placement))


@contextlib.contextmanager
def keep_placement(instance: str | None, note=None):
    """Wrap anything that pokes a desktop app: `with keep_placement(inst): ...`.

    `note` is an optional callable that receives the one-line evidence when a restore was
    genuinely needed - the caller decides where that goes (a log line, a ledger detail).
    """
    # A COURTESY MUST NEVER BREAK THE WORK IT WRAPS. Every step here is suppressed, including
    # the capture: this exists to be polite about a window, and a delivery that failed because
    # the politeness threw would be far worse than a window left where the app put it.
    before = None
    with contextlib.suppress(Exception):
        before = capture(instance)
    try:
        yield
    finally:
        said = None
        with contextlib.suppress(Exception):
            said = restore(instance, before)
        if said and note:
            with contextlib.suppress(Exception):
                note(said)
