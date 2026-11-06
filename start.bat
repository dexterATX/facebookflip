@echo off
title FlipRadar
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

if not exist node_modules echo Installing for the first time, this takes a minute...
rem Quick when nothing changed; picks up new libraries after an update.
call npm install --no-fund --no-audit --prefer-offline --loglevel=error
if errorlevel 1 goto :installfailed

rem Reading past the first 24 results needs a browser: use an installed one, or get Chromium once.
node tools\ensure-browser.js

set OPEN=1
node src\server.js
pause
exit /b 0

:nonode
echo.
echo   Node.js is not installed.
echo   Download the "LTS" version from https://nodejs.org , install it,
echo   then double-click start.bat again.
echo.
start "" https://nodejs.org/
pause
exit /b 1

:installfailed
echo.
echo   Installing failed. Check your internet connection and try again.
echo.
pause
exit /b 1
