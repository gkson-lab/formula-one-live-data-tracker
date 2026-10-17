@echo off
title F1 Race Watch - relay
cd /d "%~dp0"
echo.
echo   F1 Race Watch
echo   -------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Opening nodejs.org - install the LTS version, then run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo   First run: installing the one package the relay needs...
  call npm install ws --no-audit --no-fund --loglevel=error
)
echo   Starting the relay. The app opens in your browser.
echo   Keep this window open during the race. Close it to stop.
echo.
node f1-relay.js --open
echo.
pause
