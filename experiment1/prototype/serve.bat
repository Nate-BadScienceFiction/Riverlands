@echo off
REM Riverlands Tribute - Windows one-click launcher.
REM Robust against the double-click-into-pause-buffer issue (uses
REM PowerShell's Read-Host instead of cmd's pause). Writes a log file
REM so we can diagnose if the window still closes unexpectedly.
setlocal
cd /d "%~dp0"

set LOGFILE=serve.log
echo === serve.bat run at %date% %time% === > "%LOGFILE%"
echo Working dir: %cd% >> "%LOGFILE%"
echo. >> "%LOGFILE%"

REM ----- Step 1: Python on PATH -----
echo [Step 1] Checking Python... >> "%LOGFILE%"
python --version >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo Python not found on PATH. >> "%LOGFILE%"
  echo.
  echo ERROR: Python is not on PATH.
  echo Install Python from https://www.python.org/downloads/
  echo Then re-run this script.
  echo.
  echo See %LOGFILE% in this folder for details.
  powershell -NoProfile -Command "Read-Host -Prompt 'Press Enter to close'"
  exit /b 1
)

REM ----- Step 2: FastAPI + uvicorn -----
echo [Step 2] Checking deps... >> "%LOGFILE%"
python -c "import fastapi, uvicorn" >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo Installing dependencies on first run...
  python -m pip install -r requirements.txt >> "%LOGFILE%" 2>&1
  if errorlevel 1 (
    echo.
    echo ERROR: Failed to install fastapi + uvicorn.
    echo See %LOGFILE% for the pip output.
    echo.
    powershell -NoProfile -Command "Read-Host -Prompt 'Press Enter to close'"
    exit /b 1
  )
)

REM ----- Step 3: Port check (with offer to free it) -----
REM Use a temp file rather than triple-piping so the redirect-and-errorlevel
REM combination behaves predictably. Avoid nested parentheses inside the
REM IF block below — cmd's parser treats them as block delimiters.
echo [Step 3] Checking port 8765... >> "%LOGFILE%"
netstat -ano > "%TEMP%\rt-netstat.tmp" 2>&1
findstr "LISTENING" "%TEMP%\rt-netstat.tmp" | findstr ":8765 " > "%TEMP%\rt-port.tmp" 2>&1
set PORT_USED=%errorlevel%
type "%TEMP%\rt-port.tmp" >> "%LOGFILE%"
del "%TEMP%\rt-netstat.tmp" 2>NUL

if "%PORT_USED%"=="0" (
  REM Extract the PID from the netstat line (last whitespace-separated token).
  set "STALE_PID="
  for /f "tokens=5" %%P in ('type "%TEMP%\rt-port.tmp"') do set "STALE_PID=%%P"
  del "%TEMP%\rt-port.tmp" 2>NUL
  call :handle_stale_port
  if errorlevel 1 (
    powershell -NoProfile -Command "Read-Host -Prompt 'Press Enter to close'"
    exit /b 1
  )
)
del "%TEMP%\rt-port.tmp" 2>NUL

REM ----- Step 4: Run -----
echo [Step 4] Launching server... >> "%LOGFILE%"
echo.
echo ============================================
echo   Riverlands Tribute
echo   Server : http://localhost:8765/
echo   Browser: opening in 2 seconds
echo   Stop   : close this window or press Ctrl+C
echo ============================================
echo.

REM Browser open scheduled in background, ~2 s after we start the server
start "" /B powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8765/'"

REM Run server in the foreground so this window shows uvicorn logs
python server.py --no-browser

echo. >> "%LOGFILE%"
echo Server exited at %time% with errorlevel %errorlevel% >> "%LOGFILE%"
echo.
echo ============================================
echo   Server stopped.
echo   See serve.log for the full record of this run.
echo ============================================
echo.
powershell -NoProfile -Command "Read-Host -Prompt 'Press Enter to close this window'"
goto :EOF


REM ============================================================
REM  :handle_stale_port — invoked when port 8765 already has a listener.
REM  Reads STALE_PID from the parent scope; offers to kill it.
REM  Returns errorlevel 0 on success (port freed), 1 on abort/failure.
REM ============================================================
:handle_stale_port
echo.
echo WARNING: Port 8765 is already in use by PID %STALE_PID%.
echo This is usually a leftover server from a previous run.
echo.
choice /C YN /N /M "Kill PID %STALE_PID% and continue? [Y/N] "
if errorlevel 2 (
  echo Aborted by user.
  exit /b 1
)
echo Killing PID %STALE_PID%...
taskkill /PID %STALE_PID% /F >NUL 2>&1
if errorlevel 1 (
  echo.
  echo Failed to kill PID %STALE_PID%. Try one of:
  echo     taskkill /F /IM python.exe
  echo     ^(or run this script as administrator^)
  exit /b 1
)
echo Killed. Waiting briefly for the OS to release the socket...
ping 127.0.0.1 -n 2 >NUL
exit /b 0
