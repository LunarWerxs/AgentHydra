@echo off
rem Replays a recorded codex session instead of running the real CLI (see ..\mock-agent.mjs).
rem Put this folder first on PATH, or point AGENTHYDRA_CODEX_PATH at this file.
bun "%~dp0..\mock-agent.mjs" --as codex %*
