@echo off
REM Rebuilds the DevWebUI GUI (web\dist) that the daemon serves.
REM Standalone replacement for the tray's dev-only "Rebuild & Restart". Double-click to run.
cd /d "%~dp0.."
echo Building DevWebUI GUI (web\dist)...
call bun run build
if errorlevel 1 (
  echo Build FAILED - see the output above.
  exit /b 1
)

echo Done. Restart DevWebUI ^(tray: Restart^) to serve the new build.
exit /b 0
