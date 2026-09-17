@echo off
rem ============================================================
rem  Laboratory Equipment Booking System - Reset demo data
rem  ASCII-only on purpose (see start.bat for the reason).
rem ============================================================
chcp 65001 > nul
setlocal
rem Move to the PROJECT ROOT (this file lives in <root>\scripts)
cd /d "%~dp0.."
title Lab Booking System - Reset demo data

where node >nul 2>nul
if errorlevel 1 (
  echo [FAILED] Node.js not found. Please install Node.js 22.5+ first.
  goto :halt
)

echo ============================================================
echo   Reset demo data
echo ============================================================
echo.
echo WARNING: all business data in data\lab.db (users, bookings,
echo          violations, ...) will be deleted and regenerated.
echo.
set /p CONFIRM=Type Y and press Enter to continue: 
if /i not "%CONFIRM%"=="Y" (
  echo Cancelled.
  goto :halt
)

node "scripts\reseed.js"
set EXITCODE=%errorlevel%

if "%EXITCODE%"=="0" (
  echo.
  echo [DONE] Demo data has been rebuilt. You can start the server now.
  echo        Default accounts: admin / teacher / student, password 123456
) else (
  echo.
  echo [FAILED] Reset failed with code %EXITCODE%. Please copy the error text above.
)

:halt
echo.
pause
endlocal
