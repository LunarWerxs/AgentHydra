@echo off
title DevWebUI
cd /d "%~dp0.."

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ERROR: 'bun' is not installed / not on your PATH.
  echo   Install it from https://bun.sh then double-click this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run - installing dependencies ^(one time, takes a moment^)...
  echo.
  call bun install
)

echo.
echo   ===============================================
echo     DevWebUI is starting...
echo     Your browser will open at http://localhost:4010
echo.
echo     Keep this window open while you use DevWebUI.
echo     Close it (or press Ctrl+C) to stop everything.
echo   ===============================================
echo.

rem Open the browser a few seconds after the servers come up.
start "" /b cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:4010"

call bun run dev
