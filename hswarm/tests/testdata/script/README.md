# CLI script tests

Each `*.txtar` file here is one end-to-end test of the `hswarm` CLI. `tests/test_cli_scripts.py` finds every
file, writes its archived files into a fresh temp directory, and runs its lines there in order. The api backend
is stubbed at its seams (the AUTO profile plan, the one-shot ask, the task runner, the client lookup, the balance
probe, the price route), so a script never spends a cent and never needs a key.

```
# A comment says what the next lines pin.
hswarm run tasks.json              # the CLI, in-process; its stdout and stderr are kept
stdout '^=== t1 \[ok\]'            # a regexp the last stdout must match (multiline)
stderr '^job \S+: 1 tasks$'
! hswarm run 'not a path'          # `!` must fail; `?` may fail
[windows] skip 'unix paths only'   # a condition guards a line; [!cond] negates

-- tasks.json --
[{"prompt": "count the files", "tools": "none"}]
```

Commands: `hswarm ARGS...`, `stdout`/`stderr`/`grep [-count=N] PATTERN [FILE]`, `cmp A B`, `exists FILE...`,
`env KEY=VALUE...`, `cd DIR`, `skip`, and the stub's own `api echo | reply TEXT | fail MESSAGE | calls N`
(the default answer is `echo: <prompt>`; `api calls 0` pins that nothing reached the backend). Quoting,
expansion (`$WORK` is the work directory) and conditions are documented at the top of `tests/scripttest.py`.

One file per behaviour, named for it; a comment above each group of lines says what it pins.
