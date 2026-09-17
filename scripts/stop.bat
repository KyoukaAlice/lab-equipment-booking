@echo off
rem ============================================================
rem  Laboratory Equipment Booking System - Stop leftover server
rem  ASCII-only on purpose (see start.bat for the reason).
rem ============================================================
chcp 65001 > nul
setlocal
rem Move to the PROJECT ROOT (this file lives in <root>\scripts)
cd /d "%~dp0.."
title Lab Booking System - Stop

set PORTNUM=%PORT%
if "%PORTNUM%"=="" set PORTNUM=3000

echo.
echo Stopping the Node.js service listening on port %PORTNUM% ...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = %PORTNUM%;" ^
  "$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue;" ^
  "if (-not $conns) { Write-Host '  [INFO] Nothing is listening on this port.'; exit 0 }" ^
  "$killed = 0;" ^
  "foreach ($c in $conns) {" ^
  "  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;" ^
  "  if ($p -and $p.ProcessName -eq 'node') {" ^
  "    Write-Host ('  [OK] Killed node.exe PID ' + $p.Id);" ^
  "    Stop-Process -Id $p.Id -Force; $killed++" ^
  "  } elseif ($p) {" ^
  "    Write-Host ('  [SKIP] PID ' + $p.Id + ' is ' + $p.ProcessName + ', not node.exe - not killed.')" ^
  "  }" ^
  "}" ^
  "if ($killed -eq 0) { Write-Host '  [INFO] No node.exe was killed.' }" ^
  "else { Write-Host ('  [DONE] Killed ' + $killed + ' process(es). You can start the server again.') }"

echo.
echo Note: if you started the server on another port, run "set PORT=xxxx" first.
echo.
pause
endlocal
