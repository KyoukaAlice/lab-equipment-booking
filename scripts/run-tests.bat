@echo off
rem ============================================================
rem  Laboratory Equipment Booking System - Run all tests
rem  ASCII-only on purpose (see start.bat for the reason).
rem ============================================================
chcp 65001 > nul
setlocal
rem Move to the PROJECT ROOT (this file lives in <root>\scripts)
cd /d "%~dp0.."
title Lab Booking System - Tests

where node >nul 2>nul
if errorlevel 1 (
  echo [FAILED] Node.js not found. Please install Node.js 22.5+ first.
  goto :halt
)

echo ============================================================
echo   Automated tests (in-memory database, demo data untouched)
echo ============================================================
echo.

node "test\run.js"
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
  echo [DONE] All tests passed.
) else (
  echo [FAILED] Some tests failed with code %EXITCODE%. See the output above.
)

:halt
echo.
pause
endlocal
