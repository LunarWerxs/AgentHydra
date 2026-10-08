import sys

from .livecode import serve_committed

# The daemon's start serves the clone's committed hswarm (livecode.py), before the working tree's cli is even imported.
if (code := serve_committed(sys.argv[1:])) is not None:
    sys.exit(code)

from .cli import main  # noqa: E402

sys.exit(main())
