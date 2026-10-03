"""Offline: a long string is stored once per job, not once per task, and comes back byte-for-byte.

The measurement behind this (2026-09-16): `~/.hswarm/jobs` held 1,165 MiB after one day, and 1,153 MiB of
it was a few strings written thousands of times: a 162 KiB shared system prompt on all 1,844 task rows of
one job.json, and the same prompt again in each of its 1,844 transcripts."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import blobs  # noqa: E402

LONG = "You are a swarm worker. " + ("index entry, " * 400)  # ~10 KiB, the shape that caused the problem
OTHER = "A different system prompt. " + ("x" * 5000)


def test_a_repeated_string_is_written_once_and_expands_back(tmp_path):
    where = tmp_path / "blobs"
    tasks = [{"id": f"t{i}", "prompt": f"question {i}", "system": LONG, "max_turns": 4} for i in range(50)]
    packed = blobs.pack_all(tasks, where)

    assert len(list(where.glob("*.txt"))) == 1  # fifty tasks, one blob
    assert all("system" not in t and t["system_ref"] == packed[0]["system_ref"] for t in packed)
    assert packed[0]["prompt"] == "question 0" and packed[0]["max_turns"] == 4  # short values stay inline
    assert len(json.dumps(packed)) * 20 < len(json.dumps(tasks))  # at least 20x smaller on this shape

    back = blobs.expand_all(packed, where)
    assert back == tasks  # byte-for-byte, every field, every task

    two = blobs.pack_all(tasks + [{"id": "x", "system": OTHER}], where)
    assert len(list(where.glob("*.txt"))) == 2 and two[-1]["system_ref"] != two[0]["system_ref"]
    assert blobs.pack_all(packed, where) == packed  # packing something already packed changes nothing


def test_crlf_and_every_newline_shape_survives_the_round_trip(tmp_path):
    # Windows text mode expands "\n" to "\r\n" on write and collapses it on read, which mangles a string
    # that already holds CRLF. Three of 201 real job folders did (2026-09-16), so this is a fixed shape now.
    where = tmp_path / "blobs"
    for body in ("crlf\r\n" * 400, "lf\n" * 700, "cr\r" * 700, "mixed\r\n\r\rand\n\n" * 200, "no newlines at all " * 200):
        packed = blobs.pack({"id": "t", "system": body}, where)
        assert blobs.expand(packed, where)["system"] == body, f"mangled: {body[:12]!r}"
    import hashlib

    for p in where.glob("*.txt"):  # content addressing holds: the name IS the hash of the bytes on disk
        assert hashlib.sha1(p.read_bytes()).hexdigest() == p.stem


@pytest.mark.skipif(sys.platform != "win32", reason="the damage is Windows text mode turning \\n into \\r\\n; POSIX text mode never translates")  # floor-ok: POSIX cannot produce the damage this repairs
def test_repair_recovers_blobs_written_by_the_old_translating_writer(tmp_path):
    import hashlib

    where = tmp_path / "job" / "blobs"
    where.mkdir(parents=True)
    original = "line one\r\nline two\nline three\r\n" * 200
    sha = hashlib.sha1(original.encode("utf-8")).hexdigest()
    with open(where / f"{sha}.txt", "w", encoding="utf-8") as f:  # the old buggy writer: text mode, translating
        f.write(original)
    assert blobs.read_blob(sha, where) != original  # the damage, reproduced

    dry = blobs.repair_blobs(tmp_path, apply=False)
    assert dry == {"checked": 1, "already_ok": 0, "repaired": 1, "unrecoverable": []}
    assert blobs.read_blob(sha, where) != original  # a dry run changes nothing

    assert blobs.repair_blobs(tmp_path, apply=True)["repaired"] == 1
    assert blobs.read_blob(sha, where) == original  # exact, and proven by the sha1 in the file name
    assert blobs.repair_blobs(tmp_path, apply=True) == {"checked": 1, "already_ok": 1, "repaired": 0, "unrecoverable": []}

    (where / ("0" * 40 + ".txt")).write_bytes(b"content that matches no name")
    assert len(blobs.repair_blobs(tmp_path, apply=True)["unrecoverable"]) == 1  # reported, never guessed at


def test_shapes_we_did_not_anticipate_pass_through_untouched(tmp_path):
    # The `cc` backend writes a single dict, not a list of messages (125 such files on disk, 2026-09-16).
    # Nothing may be filtered away just because it is not the shape the `api` backend produces.
    where = tmp_path / "blobs"
    cc = {"cmd": ["claude.exe", "-p"], "exit": 0, "stderr": LONG}
    assert blobs.expand_any(blobs.pack_any(cc, where), where) == cc
    assert "stderr_ref" in blobs.pack_any(cc, where)

    mixed = [{"role": "system", "content": LONG}, "a bare string", 42, None, {"role": "user", "content": "hi"}]
    assert blobs.expand_any(blobs.pack_any(mixed, where), where) == mixed
    assert blobs.pack_any("just a string", where) == "just a string"


def test_a_missing_blob_still_reads_and_never_raises(tmp_path):
    where = tmp_path / "blobs"
    packed = blobs.pack({"id": "t1", "system": LONG}, where)
    next(where.glob("*.txt")).unlink()
    assert blobs.expand(packed, where) == {"id": "t1", "system": None}
    assert blobs.expand({"id": "t1", "system": "short"}, where) == {"id": "t1", "system": "short"}


def _job_folder(root: Path, n_tasks: int = 30) -> Path:
    d = root / "20260915-010101-aaaa"
    (d / "transcripts").mkdir(parents=True)
    tasks = [{"id": f"t{i}", "prompt": f"q{i}", "system": LONG} for i in range(n_tasks)]
    (d / "job.json").write_text(json.dumps({"summary": {"job_id": d.name}, "tasks": tasks, "results": {}}, indent=1), encoding="utf-8")
    for i in range(n_tasks):
        msgs = [{"role": "system", "content": LONG}, {"role": "user", "content": f"q{i}"}]
        (d / "transcripts" / f"t{i}.json").write_text(json.dumps(msgs, indent=1), encoding="utf-8")
    return d


def test_compacting_an_old_folder_is_lossless_and_idempotent(tmp_path):
    d = _job_folder(tmp_path)
    original_tasks = json.loads((d / "job.json").read_text(encoding="utf-8"))["tasks"]
    original_msgs = json.loads((d / "transcripts" / "t7.json").read_text(encoding="utf-8"))

    dry = blobs.compact_job(d, apply=False)
    assert dry["saved"] > 0 and dry["before"] > dry["after"]
    assert json.loads((d / "job.json").read_text(encoding="utf-8"))["tasks"] == original_tasks  # a dry run writes nothing

    real = blobs.compact_job(d, apply=True)
    assert real["saved"] > real["before"] * 0.8  # the shape is ~all repeated string
    assert len(list(blobs.blob_dir(d).glob("*.txt"))) == 1
    where = blobs.blob_dir(d)
    assert blobs.expand_all(json.loads((d / "job.json").read_text(encoding="utf-8"))["tasks"], where) == original_tasks
    assert blobs.expand_all(json.loads((d / "transcripts" / "t7.json").read_text(encoding="utf-8")), where) == original_msgs

    again = blobs.compact_job(d, apply=True)
    assert again["saved"] == 0  # nothing left to move
    assert blobs.expand_all(json.loads((d / "job.json").read_text(encoding="utf-8"))["tasks"], where) == original_tasks
