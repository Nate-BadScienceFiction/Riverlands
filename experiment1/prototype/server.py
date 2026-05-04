"""
FastAPI server for the Riverlands Tribute prototype.

Serves the prototype directory as static content over HTTP so the app's
ES-module imports and `fetch('data/Riverlands.gpx')` work. Without this
(or an equivalent HTTP origin), opening index.html via file:// silently
breaks: the page renders but no JavaScript runs.

Run:
    pip install -r requirements.txt
    python server.py

Then open http://localhost:8765/ in a browser. Ctrl+C to stop.
"""

import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8765

app = FastAPI(
    title="Riverlands Tribute",
    description="Static-file server for the trail-running analysis prototype.",
    version="0.1.0",
)

# Health endpoint — useful when scripting; returns 200 if the server is up.
@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "host": HOST, "port": PORT}


# Serve everything in the prototype directory at the root path. `html=True`
# makes GET / return index.html (rather than a 404 or directory listing).
app.mount("/", StaticFiles(directory=ROOT, html=True), name="prototype")


def main() -> None:
    url = f"http://{HOST}:{PORT}/"
    # Plain ASCII only — Windows' default console codepage (cp1252) can't
    # encode unicode arrows etc. and crashes on print().
    print()
    print(f"  Riverlands Tribute -> {url}")
    print(f"  Serving from         {ROOT}")
    print(f"  Health endpoint      {url}api/health")
    print(f"  Stop with            Ctrl+C")
    print()

    # Best-effort: open the browser tab for the user, deferred ~1.5 s so
    # uvicorn has time to start listening (otherwise the browser hits a
    # "couldn't connect" page and the user has to refresh manually). The
    # daemon flag means the timer doesn't keep the process alive after
    # Ctrl+C if the user shuts down before it fires.
    if "--no-browser" not in sys.argv:
        def open_browser():
            try:
                webbrowser.open(url)
            except Exception:
                pass
        t = threading.Timer(1.5, open_browser)
        t.daemon = True
        t.start()

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
