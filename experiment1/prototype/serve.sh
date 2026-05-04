#!/usr/bin/env bash
# Riverlands Tribute — macOS/Linux launcher.
# Mirrors serve.bat: verify Python, install deps if missing, check for
# port conflict, run the FastAPI server in the foreground, open the
# browser after a 2 s delay so uvicorn has time to bind.

set -e
cd "$(dirname "$0")"

LOGFILE=serve.log
{
  echo "=== serve.sh run at $(date) ==="
  echo "Working dir: $(pwd)"
} > "$LOGFILE"

# ----- Step 1: Python on PATH -----
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo
  echo "ERROR: Python is not on PATH."
  echo "Install Python from https://www.python.org/downloads/ and re-run."
  echo
  exit 1
fi
echo "[Step 1] Python: $($PY --version 2>&1)" >> "$LOGFILE"

# ----- Step 2: FastAPI + uvicorn -----
if ! $PY -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing dependencies on first run..."
  if ! $PY -m pip install -r requirements.txt >> "$LOGFILE" 2>&1; then
    echo
    echo "ERROR: Failed to install fastapi + uvicorn."
    echo "See $LOGFILE for the pip output."
    exit 1
  fi
fi
echo "[Step 2] Deps OK" >> "$LOGFILE"

# ----- Step 3: Port check -----
PORT_PID=""
if command -v lsof >/dev/null 2>&1; then
  PORT_PID=$(lsof -nP -i :8765 -sTCP:LISTEN -t 2>/dev/null || true)
fi
if [ -n "$PORT_PID" ]; then
  echo
  echo "WARNING: Port 8765 is already in use by PID $PORT_PID."
  echo
  read -p "Kill it and continue? [y/N] " yn
  case "$yn" in
    [Yy]*)
      kill -9 $PORT_PID 2>/dev/null || true
      sleep 1
      ;;
    *)
      echo "Aborted by user."
      exit 1
      ;;
  esac
fi
echo "[Step 3] Port 8765 free" >> "$LOGFILE"

# ----- Step 4: Run -----
echo
echo "============================================"
echo "  Riverlands Tribute"
echo "  Server : http://localhost:8765/"
echo "  Browser: opening in 2 seconds"
echo "  Stop   : Ctrl+C"
echo "============================================"
echo

# Schedule a delayed browser open in the background so uvicorn has time to bind.
(
  sleep 2
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:8765/ >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open http://localhost:8765/ >/dev/null 2>&1 || true
  fi
) &

echo "[Step 4] Launching server..." >> "$LOGFILE"
$PY server.py --no-browser
EXIT_CODE=$?

echo "Server exited at $(date) with code $EXIT_CODE" >> "$LOGFILE"
echo
echo "============================================"
echo "  Server stopped."
echo "============================================"
exit $EXIT_CODE
