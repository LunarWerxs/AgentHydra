@echo off
setlocal
rem Standalone rebuild of the AgentHydra GUI (no tray dependency). The tray's
rem "Rebuild & Restart" does this plus restarts the daemon; this is the manual path.
cd /d "%~dp0.."
echo Rebuilding AgentHydra GUI...
call bun run build
if errorlevel 1 (
  echo.
  echo Build FAILED - see the output above.
  pause
  exit /b 1
)

echo.
echo Done.
exit /b 0
