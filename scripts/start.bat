@echo off
rem ============================================================
rem  Laboratory Equipment Booking System - Start
rem  NOTE: this file is intentionally ASCII-only.
rem  cmd.exe parses .bat files with the OEM codepage (GBK on
rem  Chinese Windows); non-ASCII bytes here would be mis-decoded
rem  and split into garbage commands. All Chinese messages are
rem  printed by Node.js scripts instead.
rem ============================================================
chcp 65001 > nul
setlocal
rem Move to the PROJECT ROOT (this file lives in <root>\scripts)
cd /d "%~dp0.."
title Lab Booking System - Running

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [FAILED] Node.js not found in PATH.
  echo.
  echo   This system needs Node.js 22.5 or newer ^(it uses the built-in node:sqlite module^).
  echo   Download the LTS build from https://nodejs.org/ , install with default options,
  echo   then close this window and run start.bat again.
  echo.
  echo   ^(Chinese guide: install Node.js 22 LTS or newer from https://nodejs.org/^)
  echo.
  goto :halt
)

node "scripts\preflight.js"
if errorlevel 1 goto :halt

node "src\server.js"
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
  echo.
  echo [FAILED] Server exited with code %EXITCODE%.
  echo.
  echo   Troubleshooting:
  echo     1^) Port already in use: run "set PORT=3001" then start.bat again,
  echo        or run scripts\stop.bat to kill the leftover process.
  echo     2^) Broken demo data: run scripts\reset-data.bat to rebuild it.
  echo     3^) Otherwise please copy the full error text above and report it.
  echo.
) else (
  echo.
  echo [INFO] Server stopped normally.
)

:halt
echo.
pause
endlocal
