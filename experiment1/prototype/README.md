# Riverlands Tribute — prototype

The running app. A static client-side web prototype for trail-running race
analysis. See the [project README](../../README.md) for design background.

## Run it

### Windows
Double-click **`serve.bat`**. First run installs `fastapi` and `uvicorn`; subsequent runs are instant. Browser opens at `http://localhost:8765/`.

### macOS / Linux
```bash
./serve.sh
```
(`chmod +x serve.sh` first if needed.)

### Any platform, manually
```bash
pip install -r requirements.txt
python server.py
```

### Without Python
The app is fully client-side; any static HTTP server works:
```bash
python3 -m http.server 8765
# or
npx http-server -p 8765
```

> ⚠ Don't double-click `index.html`. ES module imports are blocked over `file://`. The page renders but no JavaScript runs. A red banner explains this when it happens.

## URL parameters (testing / sharing)

| Param | Effect |
|---|---|
| `?race=riverlands` | Auto-load the bundled race |
| `?tab=stop-classification` | Open a specific drill-down tab (`loop-comparison`, `pace-by-grade`, `stop-classification`, `daylight-overlay`, `elevation-profile`) |
| `?trace=l3` | Show only Loop 3's polyline. Also `l1`, `l2`, `all`, `stops`. |
| `?game=1` | Open the Re-Run modal |
| `?sliders=L2stop:12,L2effort:1.05,L3stop:47,L3effort:1.10` | Preset Re-Run sliders |
| `?faq=fade-decomposition` | Open a specific FAQ question |
| `?postcard=focus` | Open the Postcard in focus mode (currently disabled) |

## Tests

```bash
node tests/synthetic.test.mjs    # 22 synthetic-fixture assertions
node tests/node-runner.mjs       # 24 assertions on Riverlands.gpx
node tests/inflections-inspect.mjs  # human-readable dump of detected inflections
# Browser suite: open http://localhost:8765/tests/test-runner.html (25 assertions, incl. SunCalc)
```

## Re-cache map tiles

If you want to expand the cached bbox or change the basemap style, edit the constants at the top of `scripts/cache_tiles.py` and run:
```bash
python scripts/cache_tiles.py
```
The script is idempotent (skips tiles already on disk) and detects rate-limit responses from tile providers.

## File layout

```
.
├── index.html, app.js, styles.css   # the app
├── server.py + requirements.txt     # FastAPI/uvicorn launcher
├── serve.bat, serve.sh              # one-click launchers
├── package.json                     # npm test runs node-runner.mjs
├── lib/
│   ├── gpx.js                       # DOMParser → trackpoints + per-segment deltas
│   ├── metrics.js                   # totals, loops, stops, grades, daylight, elevation
│   ├── inflections.js               # 5 detection rules, variety-aware capping
│   ├── rerun.js                     # counterfactual arithmetic + banded pool model
│   ├── postcard.js                  # token taxonomy + per-type prompts (UI on hold)
│   └── faq.js                       # 8 rollup questions with assumption + confound
├── scripts/cache_tiles.py           # tile pre-fetcher
├── vendor/
│   ├── leaflet/                     # Leaflet 1.9.4 (js + css + marker images)
│   ├── chartjs/                     # Chart.js 4.4 + annotation plugin
│   ├── suncalc.js                   # sunrise/sunset/twilight
│   └── tiles/                       # ~174 PNG basemap tiles, ~730 KB
├── data/Riverlands.gpx              # test fixture
└── tests/
    ├── derivations.test.js          # browser test runner (25 assertions)
    ├── synthetic.test.mjs           # 11 synthetic fixtures, 22 assertions (Node)
    ├── node-runner.mjs              # Node version of derivation tests
    ├── inflections-inspect.mjs      # ad-hoc inspector
    └── test-runner.html             # browser host
```
