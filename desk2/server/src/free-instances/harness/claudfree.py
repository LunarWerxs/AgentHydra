"""Compatibility launcher; the implementation lives in the claudfree package."""

from pathlib import Path
import subprocess
import sys

if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    interpreter = root / ".venv" / "Scripts" / "python.exe"
    if interpreter.is_file() and Path(sys.executable).resolve() != interpreter.resolve():
        raise SystemExit(subprocess.call([str(interpreter), *sys.argv]))
    from claudfree.cli import entrypoint

    entrypoint()
