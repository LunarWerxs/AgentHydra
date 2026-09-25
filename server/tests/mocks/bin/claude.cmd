@echo off
rem Replays a recorded claude session instead of running the real CLI (see ..\mock-agent.mjs).
rem Put this folder first on PATH, or point AGENTHYDRA_CLAUDE_PATH at this file.
bun "%~dp0..\mock-agent.mjs" --as claude %*
