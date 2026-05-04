// Riverlands Tribute — app controller.
// State, view routing, GPX loading, dashboard rendering, Re-Run subgame.

import { parseGpx, M_TO_MI, M_TO_FT } from './lib/gpx.js';
import { computeMetrics } from './lib/metrics.js';
import { computeCounterfactual } from './lib/rerun.js';
import { detectInflections } from './lib/inflections.js';
import { TOKEN_CATEGORIES, promptFor, iconFor, labelFor, cardKey } from './lib/postcard.js';
import { QUESTIONS, groupedQuestions, getQuestion } from './lib/faq.js';

// ─────────── Version ───────────

const APP_VERSION = '0.10';

// ─────────── Race catalog ───────────

const KNOWN_RACES = [
  {
    id: 'riverlands',
    title: 'Riverlands · May 2–3, 2026',
    sub: '74.6 mi · 25 h 18 m · 3 loops · Androscoggin Riverlands State Park, Turner ME',
    file: 'data/Riverlands.gpx',
    icon: '⛰'
  }
];

// ─────────── State ───────────

const state = {
  raceId: null,
  raceTitle: '',
  metrics: null,
  sliders: [],         // [{ stopMin, effort }] per loop
  map: null,
  mapLayers: [],
  timelineChart: null,
  uploadedGpx: null    // {id, title, sub, gpxText}
};

// ─────────── Init ───────────

window.addEventListener('DOMContentLoaded', () => {
  // file:// detection lives in an inline script in index.html — it
  // needs to run even when ES module imports are blocked by CORS.
  renderRaceCards();
  attachEvents();
  // URL params for deep-linking and testing:
  //   ?race=<id>      auto-load that race
  //   ?tab=<panelId>  open a specific drill-down tab (loop-comparison,
  //                   pace-by-grade, stop-classification, daylight-overlay,
  //                   elevation-profile)
  //   ?game=1         open the Re-Run modal
  //   ?postcard=1     navigate to the Postcard
  //   ?sliders=L2stop:12,L2effort:1.05,L3stop:47,L3effort:1.10
  //                   preset Re-Run sliders for testing/sharing
  const params = new URLSearchParams(window.location.search);
  const raceParam = params.get('race');
  if (raceParam) {
    const race = KNOWN_RACES.find(r => r.id === raceParam);
    if (race) {
      loadRace(race).then(() => {
        const tabParam = params.get('tab');
        if (tabParam && document.getElementById(tabParam)) {
          activateDrillTab(tabParam);
        }
        const traceParam = params.get('trace');
        if (traceParam) setTraceMode(traceParam);
        if (params.get('game') || params.get('sliders')) {
          openReRun();
          const slidersParam = params.get('sliders');
          if (slidersParam) applySlidersFromUrl(slidersParam);
        }
        else if (params.get('postcard')) {
          openPostcard();
          if (params.get('postcard') === 'focus') togglePostcardFocus();
        }
        else if (params.get('faq')) {
          const fqid = params.get('faq');
          openFaq(fqid && fqid !== '1' ? fqid : undefined);
        }
      });
    }
  }
});

function attachEvents() {
  document.getElementById('back-to-picker').addEventListener('click', () => showScreen('picker'));
  document.getElementById('game-it-btn').addEventListener('click', openReRun);
  document.getElementById('postcard-btn').addEventListener('click', openPostcard);
  document.getElementById('back-from-postcard').addEventListener('click', () => showScreen('dashboard'));
  document.getElementById('postcard-print').addEventListener('click', () => window.print());
  document.getElementById('postcard-mode-toggle').addEventListener('click', togglePostcardFocus);
  document.getElementById('postcard-prev').addEventListener('click', () => stepPostcard(-1));
  document.getElementById('postcard-next').addEventListener('click', () => stepPostcard(+1));

  // FAQ wiring
  document.getElementById('faq-btn').addEventListener('click', () => openFaq());
  document.getElementById('back-from-faq').addEventListener('click', () => showScreen('dashboard'));

  // Re-Run modal
  document.querySelectorAll('[data-close-modal]').forEach(el => el.addEventListener('click', closeReRun));
  document.getElementById('rerun-reset').addEventListener('click', resetSliders);
  document.getElementById('rerun-save').addEventListener('click', saveCurrentRun);
  document.getElementById('rerun-saved-list').addEventListener('click', openSavedList);

  // Saved modal
  document.querySelectorAll('[data-close-saved]').forEach(el => el.addEventListener('click', closeSavedList));
  document.getElementById('saved-clear').addEventListener('click', clearSavedRuns);

  // About modal — every [data-version] element gets "v{APP_VERSION}" injected.
  document.querySelectorAll('[data-version]').forEach(el => { el.textContent = `v${APP_VERSION}`; });
  document.getElementById('about-btn').addEventListener('click', openAbout);
  document.querySelectorAll('[data-close-about]').forEach(el => el.addEventListener('click', closeAbout));

  // Drag-drop and click-to-pick wiring. Skipped when the dropzone is
  // marked is-disabled in HTML — keeps the page from reacting to drops
  // when the UI is greyed out. Re-enable by removing the is-disabled
  // class on #dropzone (and updating the copy in index.html).
  const dz = document.getElementById('dropzone');
  if (dz && !dz.classList.contains('is-disabled')) {
    // Window-level so drops anywhere on the page route to the handler;
    // otherwise the browser's default behavior opens the file in a new
    // tab when the drop lands outside the dropzone bounds. Always
    // preventDefault on dragover/drop — the dataTransfer.types check is
    // unreliable on some browser/OS combos, and a single missed
    // preventDefault is enough for the browser to take over.
    window.addEventListener('dragenter', e => {
      if (hasFiles(e)) dz.classList.add('is-active');
    });
    window.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', e => {
      if (e.relatedTarget === null && e.clientX === 0 && e.clientY === 0) {
        dz.classList.remove('is-active');
      }
    });
    window.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('is-active');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) loadDroppedFile(files[0]);
    });

    const fileInput = document.getElementById('file-input');
    dz.addEventListener('click', () => fileInput && fileInput.click());
    dz.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput && fileInput.click();
      }
    });
    if (fileInput) {
      fileInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (file) loadDroppedFile(file);
        fileInput.value = '';  // allow same-file re-upload
      });
    }
  }

  // Esc closes modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeReRun(); closeSavedList(); closeAbout(); }
  });

  // Drill-down tabs (replaces the previous accordion). Click a tab,
  // toggle .active on the tab and its corresponding panel.
  document.querySelectorAll('.drill-tab').forEach(tab => {
    tab.addEventListener('click', () => activateDrillTab(tab.dataset.tab));
  });
}

function activateDrillTab(panelId) {
  document.querySelectorAll('.drill-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === panelId);
  });
  document.querySelectorAll('.drill-panel').forEach(p => {
    p.classList.toggle('active', p.id === panelId);
  });
}

// ─────────── View routing ───────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  window.scrollTo(0, 0);
}

// ─────────── File picker ───────────

function renderRaceCards() {
  const grid = document.getElementById('card-grid');
  grid.innerHTML = '';
  const cards = [...KNOWN_RACES];
  if (state.uploadedGpx) cards.push(state.uploadedGpx);
  for (const race of cards) {
    const card = document.createElement('button');
    card.className = 'race-card';
    card.type = 'button';
    card.innerHTML = `
      <div class="race-card-icon">${race.icon || '↗'}</div>
      <div class="race-card-body">
        <div class="race-card-title">${escapeHtml(race.title)}</div>
        <div class="race-card-stats">${escapeHtml(race.sub)}</div>
      </div>
      <div class="race-card-arrow">→</div>
    `;
    card.addEventListener('click', () => loadRace(race));
    grid.appendChild(card);
  }
}

async function loadRace(race) {
  try {
    let text;
    if (race.gpxText) {
      text = race.gpxText;
    } else {
      const res = await fetch(race.file);
      if (!res.ok) throw new Error(`Could not fetch ${race.file}`);
      text = await res.text();
    }
    const parsed = parseGpx(text);
    if (!parsed.hasTime) {
      alert('This GPX has no timestamps. Pace and stops can\'t be derived.');
    }
    const metrics = computeMetrics(parsed.points);
    state.raceId = race.id;
    state.raceTitle = race.title;
    state.metrics = metrics;
    state.cachedPoints = parsed.points;
    state.inflections = detectInflections(
      parsed.points, metrics.loops, metrics.stops, metrics.daylight, metrics.cumDist, metrics.grades
    );
    initSliders();
    showScreen('dashboard');     // make container visible before sizing map/chart
    renderDashboard();
  } catch (e) {
    console.error(e);
    alert('Failed to load GPX: ' + e.message);
  }
}

function hasFiles(e) {
  if (!e.dataTransfer) return false;
  // dataTransfer.types is a list-like; "Files" is present when files are being dragged.
  const types = e.dataTransfer.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

function handleDrop(e) {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  loadDroppedFile(file);
}

function loadDroppedFile(file) {
  if (!/\.gpx$/i.test(file.name)) {
    alert('Please drop a .gpx file. Got: ' + file.name);
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => alert('Could not read file: ' + (reader.error && reader.error.message));
  reader.onload = () => {
    const text = reader.result;
    state.uploadedGpx = {
      id: 'uploaded-' + Date.now(),
      title: file.name.replace(/\.gpx$/i, ''),
      sub: 'Uploaded GPX (cleared on reload)',
      gpxText: text,
      icon: '↑'
    };
    renderRaceCards();
    loadRace(state.uploadedGpx);
  };
  reader.readAsText(file);
}

// ─────────── Dashboard ───────────

function renderDashboard() {
  const m = state.metrics;
  document.getElementById('dash-title').textContent = state.raceTitle;
  const distMi = m.totals.distMi.toFixed(2);
  const elapsed = formatHM(m.totals.elapsedSec);
  const loopsLabel = m.isLooped ? `${m.loops.length} loops` : 'point-to-point / no loops detected';
  document.getElementById('dash-sub').textContent = `${distMi} mi · ${elapsed} · ${loopsLabel}`;

  // Hide loop-dependent buttons if not a loop course
  document.getElementById('game-it-btn').style.display = m.isLooped ? '' : 'none';
  document.getElementById('postcard-btn').style.display =
    (state.inflections && state.inflections.length > 0) ? '' : 'none';

  renderSummaryBand();
  renderMap();
  renderTimelineChart();
  renderLoopComparison();
  renderPaceByGrade();
  renderStopClassification();
  renderDaylight();
  renderElevationProfile();
}

function renderSummaryBand() {
  const m = state.metrics;
  const t = m.totals;
  const e = m.elevation;
  const dl = m.daylight;
  const tiles = [
    { label: 'Distance',    conf: 'H', value: `${t.distMi.toFixed(2)} mi`, sub: `${(t.distM/1000).toFixed(1)} km` },
    { label: 'Elapsed',     conf: 'H', value: formatHM(t.elapsedSec), sub: '' },
    { label: 'Moving',      conf: 'M', value: formatHM(t.movingSec), sub: `${(100*t.movingSec/t.elapsedSec).toFixed(0)}%` },
    { label: 'Climb',       conf: 'M', value: `${e.gainSmoothFt.toFixed(0)} ft`, sub: `raw ${e.gainRawFt.toFixed(0)} ft` },
    { label: 'Loops',       conf: m.isLooped ? 'H' : 'L', value: `${m.loops.length}`, sub: m.isLooped ? '' : 'not detected' },
    { label: 'Daylight',    conf: 'H', value: dl ? `${dl.daylightPct.toFixed(0)}%` : '—', sub: dl ? `${formatHM(dl.daylightSec)} of light` : '' },
    { label: 'Stops',       conf: 'M', value: formatHM(t.stoppedSec), sub: `${m.stops.length} stops ≥ 30s` }
  ];

  const html = tiles.map(t => `
    <div class="stat-tile">
      <div class="stat-label">${escapeHtml(t.label)} <span class="conf-badge conf-${t.conf}" title="Confidence: ${t.conf}">${t.conf}</span></div>
      <div class="stat-value">${escapeHtml(t.value)}</div>
      <div class="stat-sub">${escapeHtml(t.sub)}</div>
    </div>
  `).join('');
  document.getElementById('summary-band').innerHTML = html;
}

// ─────────── Map ───────────

function renderMap() {
  const m = state.metrics;
  const allPts = state.cachedPoints;

  // Tear down previous map if any
  if (state.map) {
    state.map.remove();
    state.map = null;
  }

  const mapEl = document.getElementById('map');
  mapEl.innerHTML = '';

  // Manual min/max — spreading 13K+ args into Math.min/max can overflow the call stack.
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const p of allPts) {
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
  }
  const bounds = L.latLngBounds([latMin, lonMin], [latMax, lonMax]);

  const map = L.map('map', { zoomControl: true }).fitBounds(bounds, { padding: [20, 20] });
  state.map = map;

  // Two base layers:
  //   - "Offline (cached)" — CARTO Voyager pre-cached for the park bbox
  //     (lat 44.17-44.28, lon -70.25 to -70.17, zoom 11-15). See
  //     scripts/cache_tiles.py. No network required.
  //   - "OpenStreetMap (live)" — fetched on demand, requires a network.
  //     Useful for panning beyond the cached bbox or for richer detail.
  const cachedTiles = L.tileLayer(
    'vendor/tiles/{z}/{x}/{y}.png',
    {
      maxZoom: 15,
      minZoom: 11,
      errorTileUrl: '',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>'
    }
  );
  const liveOsm = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      errorTileUrl: '',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }
  );

  // Cached layer is the default and the only one shown initially. The
  // user opts into the live layer via the layer control. Falls back to a
  // dark background on tile errors so the trace still reads.
  let tilesFailed = false;
  cachedTiles.on('tileerror', () => {
    if (!tilesFailed) {
      tilesFailed = true;
      mapEl.style.background = '#1c2026';
    }
  });
  cachedTiles.addTo(map);

  L.control.layers(
    {
      'Offline (cached)': cachedTiles,
      'OpenStreetMap (live)': liveOsm
    },
    null,
    { collapsed: false, position: 'topright' }
  ).addTo(map);

  // Crosshair marker for chart→map sync. Hidden by default; revealed
  // when the chart fires onHover. pointer-events: none so it doesn't
  // block the polyline mouse-move events that drive map→chart sync.
  const crosshairIcon = L.divIcon({
    className: 'crosshair-marker',
    html: '<div></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  state.crosshair = L.marker([allPts[0].lat, allPts[0].lon], {
    icon: crosshairIcon,
    opacity: 0,
    interactive: false,
    keyboard: false
  }).addTo(map);

  // Map → chart sync. Listen at the map level so the user can hover
  // anywhere over the trace area; we find the nearest trackpoint and
  // tell the chart to show its tooltip there. Throttled to ~33 fps.
  const SYNC_RADIUS_M = 250;  // only sync if cursor is within this of the trace
  let lastSync = 0;
  map.on('mousemove', e => {
    const now = performance.now();
    if (now - lastSync < 30) return;
    lastSync = now;
    const idx = nearestPointIdx(allPts, e.latlng.lat, e.latlng.lng);
    const dist = approxDistMeters(allPts[idx], e.latlng);
    if (dist > SYNC_RADIUS_M) {
      clearChartCursor();
      return;
    }
    setChartCursorByPointIdx(idx);
  });
  map.on('mouseout', () => {
    clearChartCursor();
  });

  // Initial trace render — replaceable via the trace mode toggle without
  // re-creating the map.
  if (!state.traceMode) state.traceMode = 'all';
  redrawTrace();

  // Map legend / trace-mode toggle (rendered by redrawTrace too)
  renderTraceToggle();
}

// ─────────── Trace rendering (mode-aware) ───────────

// Removes the current trace polylines + boundary/stop markers, then
// redraws based on state.traceMode. Called from the toggle handler so
// the user's pan/zoom is preserved (no map.remove()).
function redrawTrace() {
  const map = state.map;
  const m   = state.metrics;
  const allPts = state.cachedPoints;
  if (!map || !m || !allPts) return;

  // Tear down old layers
  if (state.traceLayers) {
    for (const layer of state.traceLayers) map.removeLayer(layer);
  }
  state.traceLayers = [];

  const mode = state.traceMode || 'all';

  // ----- Stops mode: a thin neutral trace + only stop markers -----
  if (mode === 'stops') {
    const latlngs = allPts.map(p => [p.lat, p.lon]);
    const line = L.polyline(latlngs, {
      color: '#5a606e',
      weight: 1.8,
      opacity: 0.55
    }).addTo(map);
    state.traceLayers.push(line);
    addStopClusterMarkers(map, m, state.traceLayers);
    return;
  }

  // ----- Pace-coloring modes: 'all', 'l1', 'l2', etc. -----
  // Determine which range of points to draw.
  let startIdx = 0;
  let endIdx   = allPts.length - 1;
  const loopMatch = mode.match(/^l(\d+)$/);
  if (loopMatch && m.isLooped) {
    const k = parseInt(loopMatch[1], 10) - 1;
    if (m.loops[k]) {
      startIdx = m.loops[k].startIdx;
      endIdx   = m.loops[k].endIdx;
    }
  }

  // Pace-graded polyline within the selected range
  const rangeLen = endIdx - startIdx;
  const SEG_COUNT = Math.min(80, Math.max(20, Math.floor(rangeLen / 150)));
  const segLen = Math.max(1, Math.floor(rangeLen / SEG_COUNT));
  for (let s = startIdx; s < endIdx; s += segLen) {
    const end = Math.min(s + segLen, endIdx);
    let totDist = 0, totDt = 0;
    for (let i = s + 1; i <= end; i++) { totDist += allPts[i].segDist; totDt += allPts[i].segDt; }
    const speedMps = totDt > 0 ? totDist / totDt : 0;
    const color = paceToColor(speedMps);
    const latlngs = [];
    for (let i = s; i <= end; i++) latlngs.push([allPts[i].lat, allPts[i].lon]);
    const layer = L.polyline(latlngs, { color, weight: 4, opacity: 0.85, lineCap: 'round' }).addTo(map);
    state.traceLayers.push(layer);
  }

  // Loop boundary + finish markers (only in 'all'; per-loop view is cleaner without them)
  if (mode === 'all' && m.isLooped) {
    for (let k = 0; k < m.loops.length; k++) {
      const p = allPts[m.loops[k].startIdx];
      const label = k === 0 ? 'S' : String(k);
      const marker = L.divIcon({
        className: 'loop-marker',
        html: `<div style="background:#f97316;color:#1a1208;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)">${label}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12]
      });
      state.traceLayers.push(L.marker([p.lat, p.lon], { icon: marker }).addTo(map));
    }
    const last = allPts[allPts.length - 1];
    const finishIcon = L.divIcon({
      className: 'finish-marker',
      html: `<div style="background:#22c55e;color:#0d2614;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)">F</div>`,
      iconSize: [24, 24], iconAnchor: [12, 12]
    });
    state.traceLayers.push(L.marker([last.lat, last.lon], { icon: finishIcon }).addTo(map));
  }

  addStopClusterMarkers(map, m, state.traceLayers);
}

function addStopClusterMarkers(map, m, layerSink) {
  for (const cl of m.stopClusters.slice(0, 8)) {
    if (cl.totalMin < 1) continue;
    const radius = Math.max(6, Math.min(18, Math.sqrt(cl.totalMin) * 3));
    const marker = L.circleMarker([cl.lat, cl.lon], {
      radius,
      color: '#f97316',
      weight: 1,
      fillColor: '#f97316',
      fillOpacity: 0.35
    }).bindTooltip(`Stop: ${cl.totalMin.toFixed(0)} min total · ${cl.visits} visit${cl.visits > 1 ? 's' : ''}`).addTo(map);
    layerSink.push(marker);
  }
}

function setTraceMode(mode) {
  state.traceMode = mode;
  redrawTrace();
  renderTraceToggle();
}

function renderTraceToggle() {
  const m = state.metrics;
  if (!m) return;
  const legend = document.getElementById('map-legend');
  if (!legend) return;
  const mode = state.traceMode || 'all';

  // Build mode options. For looped courses: All + L1..Ln + Stops. For
  // non-looped (Generic mode): just Pace + Stops.
  const opts = [];
  if (m.isLooped) {
    opts.push(['all', 'All']);
    for (let i = 0; i < m.loops.length; i++) opts.push([`l${i + 1}`, `L${i + 1}`]);
    opts.push(['stops', 'Stops']);
  } else {
    opts.push(['all', 'Pace']);
    opts.push(['stops', 'Stops']);
  }

  const isStops = mode === 'stops';
  const buttonsHtml = opts.map(([k, lbl]) =>
    `<button class="trace-mode-btn ${mode === k ? 'active' : ''}" data-mode="${k}">${lbl}</button>`
  ).join('');
  const legendHtml = isStops
    ? `<div class="legend-grad legend-stops">stops sized by dwell time</div>`
    : `<div class="legend-grad"><span>fast</span><span class="legend-bar" aria-hidden="true"></span><span>slow</span></div>`;

  legend.innerHTML = `<div class="trace-mode-toggle">${buttonsHtml}</div>${legendHtml}`;
  legend.querySelectorAll('.trace-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setTraceMode(btn.dataset.mode));
  });
}

// ─────────── Map ↔ chart sync helpers ───────────

// Find the trackpoint nearest to a given lat/lon. Two-pass: coarse
// stride-10 search, then fine refinement around the best coarse match.
// ~1.3 K squared-distance comparisons for 13 K points; well under 1 ms.
function nearestPointIdx(points, lat, lon) {
  let bestIdx = 0, bestSq = Infinity;
  for (let i = 0; i < points.length; i += 10) {
    const dLat = points[i].lat - lat;
    const dLon = points[i].lon - lon;
    const sq = dLat * dLat + dLon * dLon;
    if (sq < bestSq) { bestSq = sq; bestIdx = i; }
  }
  const lo = Math.max(0, bestIdx - 10);
  const hi = Math.min(points.length, bestIdx + 11);
  for (let i = lo; i < hi; i++) {
    const dLat = points[i].lat - lat;
    const dLon = points[i].lon - lon;
    const sq = dLat * dLat + dLon * dLon;
    if (sq < bestSq) { bestSq = sq; bestIdx = i; }
  }
  return bestIdx;
}

// Quick-and-dirty meters between a points[] point and a Leaflet LatLng.
// Equirectangular approximation; close enough at trail-running distances.
function approxDistMeters(point, latlng) {
  const R = 6371000;
  const dLat = (point.lat - latlng.lat) * Math.PI / 180;
  const dLon = (point.lon - latlng.lng) * Math.PI / 180 * Math.cos(point.lat * Math.PI / 180);
  return R * Math.sqrt(dLat * dLat + dLon * dLon);
}

// Programmatic chart cursor — given a points[] index, show the chart's
// tooltip and active-elements at the corresponding chart x.
function setChartCursorByPointIdx(pointIdx) {
  const chart = state.timelineChart;
  if (!chart || state.chartStride == null) return;
  const chartIdx = Math.min(
    state.chartToPointIdx.length - 1,
    Math.floor(pointIdx / state.chartStride)
  );
  const els = [
    { datasetIndex: 0, index: chartIdx },
    { datasetIndex: 1, index: chartIdx }
  ];
  chart.setActiveElements(els);
  if (chart.tooltip) {
    chart.tooltip.setActiveElements(els, { x: 0, y: 0 });
  }
  chart.update('none');
}

function clearChartCursor() {
  const chart = state.timelineChart;
  if (!chart) return;
  chart.setActiveElements([]);
  if (chart.tooltip) chart.tooltip.setActiveElements([], { x: 0, y: 0 });
  chart.update('none');
}

function paceToColor(speedMps) {
  // Speed → pace (min/mi). pace = 1/speed * 60 / 0.000621371 / 60 = 26.82/speed
  if (speedMps < 0.1) return '#444b56';  // stopped → desaturated
  const pace = 26.82 / speedMps;
  // Map pace 10..25 → 0..1
  const t = clamp((pace - 10) / 15, 0, 1);
  // 5-stop gradient: blue → cyan → yellow → orange → red
  const stops = [
    [0.00, [59, 130, 246]],
    [0.25, [34, 211, 238]],
    [0.50, [250, 204, 21]],
    [0.75, [249, 115, 22]],
    [1.00, [239, 68, 68]]
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const f = (t - a) / (b - a);
      const r = Math.round(ca[0] + f * (cb[0] - ca[0]));
      const g = Math.round(ca[1] + f * (cb[1] - ca[1]));
      const bl = Math.round(ca[2] + f * (cb[2] - ca[2]));
      return `rgb(${r},${g},${bl})`;
    }
  }
  return '#3b82f6';
}

// ─────────── Timeline chart ───────────

function renderTimelineChart() {
  const m = state.metrics;
  const pts = state.cachedPoints;
  const dl = m.daylight;

  // Downsample to ~250 points
  const TARGET = 250;
  const stride = Math.max(1, Math.floor(pts.length / TARGET));
  const xs = [];
  const eleFt = [];
  const paceMin = [];
  const chartToPointIdx = [];   // chart index → original points[] index
  for (let i = 0; i < pts.length; i += stride) {
    chartToPointIdx.push(i);
    const distMi = m.cumDist[i] * M_TO_MI;
    xs.push(distMi);
    eleFt.push(pts[i].ele !== null ? pts[i].ele * M_TO_FT : null);
    // Pace: smooth speed over a window of ~30s by walking back from i
    let totDist = 0, totDt = 0;
    for (let j = i; j > 0 && totDt < 30; j--) {
      totDist += pts[j].segDist;
      totDt += pts[j].segDt;
    }
    const speed = totDt > 0 ? totDist / totDt : 0;
    paceMin.push(speed > 0.3 ? Math.min(40, 26.82 / speed) : null);
  }
  // Stash mappings on state so map↔chart sync helpers can use them.
  state.chartStride = stride;
  state.chartToPointIdx = chartToPointIdx;

  // Twilight bands as Chart.js annotations
  const annotations = {};
  if (dl) {
    const bandColor = '#3b3f4d';
    const nightColor = '#1a1d28';
    const phases = [
      { from: dl.civilEnd1,    to: dl.nauticalEnd1,  color: 'rgba(70, 60, 110, 0.18)' },
      { from: dl.nauticalEnd1, to: dl.astroEnd1,     color: 'rgba(50, 50, 100, 0.25)' },
      { from: dl.astroEnd1,    to: dl.astroBegin2,   color: 'rgba(30, 35, 70, 0.32)' },
      { from: dl.astroBegin2,  to: dl.nauticalBegin2,color: 'rgba(50, 50, 100, 0.25)' },
      { from: dl.nauticalBegin2,to: dl.civilBegin2,  color: 'rgba(70, 60, 110, 0.18)' }
    ];
    let idx = 0;
    for (const ph of phases) {
      const xMin = dl.timeToDistMi(ph.from.getTime());
      const xMax = dl.timeToDistMi(ph.to.getTime());
      if (xMax <= xMin) continue;
      annotations['phase' + (idx++)] = {
        type: 'box',
        xMin, xMax,
        backgroundColor: ph.color,
        borderWidth: 0
      };
    }
    // Sunrise / sunset vertical lines
    const lines = [
      { t: dl.sunrise1, label: 'sunrise' },
      { t: dl.sunset1,  label: 'sunset' },
      { t: dl.sunrise2, label: 'sunrise' }
    ];
    for (const ln of lines) {
      const x = dl.timeToDistMi(ln.t.getTime());
      if (x > 0 && x < m.totals.distMi) {
        annotations['line' + (idx++)] = {
          type: 'line',
          xMin: x, xMax: x,
          borderColor: 'rgba(252, 211, 77, 0.55)',
          borderWidth: 1.2,
          borderDash: [4, 4],
          label: { content: ln.label, display: true, position: 'start',
                   color: '#fcd34d', font: { size: 10 }, backgroundColor: 'rgba(0,0,0,0)' }
        };
      }
    }
  }

  if (state.timelineChart) state.timelineChart.destroy();

  const ctx = document.getElementById('timeline-chart').getContext('2d');
  state.timelineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: xs,
      datasets: [
        {
          label: 'Elevation (ft)',
          data: eleFt,
          yAxisID: 'yEle',
          borderColor: '#fb923c',
          backgroundColor: 'rgba(251,146,60,.16)',
          fill: true,
          pointRadius: 0,
          borderWidth: 1.2,
          tension: 0.2,
          order: 2
        },
        {
          label: 'Pace (min/mi)',
          data: paceMin,
          yAxisID: 'yPace',
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0)',
          fill: false,
          pointRadius: 0,
          borderWidth: 1.2,
          tension: 0.2,
          spanGaps: true,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      // Chart→map sync. When the user moves the cursor over the chart,
      // the active element index converts back to a points[] index via
      // chartToPointIdx, and we move the map crosshair marker there.
      onHover: (event, elements, chart) => {
        if (!elements || elements.length === 0) {
          if (state.crosshair) state.crosshair.setOpacity(0);
          return;
        }
        const chartIdx = elements[0].index;
        const pointIdx = state.chartToPointIdx[chartIdx];
        if (pointIdx == null || !state.cachedPoints) return;
        const p = state.cachedPoints[pointIdx];
        if (state.crosshair) {
          state.crosshair.setLatLng([p.lat, p.lon]);
          state.crosshair.setOpacity(1);
        }
      },
      plugins: {
        legend: { labels: { color: '#b1b6c0', font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false,
          callbacks: { title: items => `${items[0].label} mi` } },
        annotation: { annotations }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Distance (mi)', color: '#7e8492', font: { size: 11 } },
          ticks: { color: '#7e8492', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,.04)' }
        },
        yEle: {
          position: 'left',
          title: { display: true, text: 'Elevation (ft)', color: '#fb923c', font: { size: 11 } },
          ticks: { color: '#9aa0a6', font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,.05)' }
        },
        yPace: {
          position: 'right',
          reverse: true,  // lower (faster) pace at top
          title: { display: true, text: 'Pace (min/mi)', color: '#22d3ee', font: { size: 11 } },
          ticks: { color: '#9aa0a6', font: { size: 10 } },
          grid: { display: false }
        }
      }
    }
  });
}

// ─────────── Drill-downs ───────────

function renderLoopComparison() {
  const m = state.metrics;
  if (!m.isLooped) {
    document.getElementById('loop-comparison').innerHTML = '<p class="card-sub">No loops detected on this course.</p>';
    return;
  }
  const rows = m.loopMetrics.map(l => `
    <tr>
      <td>Loop ${l.idx + 1}</td>
      <td class="numeric">${l.distMi.toFixed(2)}</td>
      <td class="numeric">${formatHM(l.elapsedSec)}</td>
      <td class="numeric">${formatHM(l.movingSec)}</td>
      <td class="numeric">${l.stoppedMin.toFixed(0)} min</td>
      <td class="numeric">${formatPace(l.paceAvg)}</td>
      <td class="numeric">${formatPace(l.paceMoving)}</td>
    </tr>
  `).join('');
  document.getElementById('loop-comparison').innerHTML = `
    <table class="metric-table">
      <thead><tr>
        <th>Loop</th>
        <th class="numeric">Mi</th>
        <th class="numeric">Elapsed</th>
        <th class="numeric">Moving</th>
        <th class="numeric">Stopped</th>
        <th class="numeric">Pace</th>
        <th class="numeric">Moving pace</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderPaceByGrade() {
  const m = state.metrics;
  if (!m.isLooped) {
    document.getElementById('pace-by-grade').innerHTML = '<p class="card-sub">Requires loop structure.</p>';
    return;
  }
  const lm = m.loopMetrics;
  const decay = (a, b) => a > 0 ? (((b - a) / a) * 100) : 0;
  const climbDecay = lm.length >= 2 ? decay(lm[0].paceClimb, lm[lm.length-1].paceClimb) : 0;
  const flatDecay  = lm.length >= 2 ? decay(lm[0].paceFlat,  lm[lm.length-1].paceFlat)  : 0;
  const descDecay  = lm.length >= 2 ? decay(lm[0].paceDesc,  lm[lm.length-1].paceDesc)  : 0;
  const rows = lm.map(l => `
    <tr>
      <td>Loop ${l.idx + 1}</td>
      <td class="numeric">${formatPace(l.paceClimb)}</td>
      <td class="numeric">${formatPace(l.paceFlat)}</td>
      <td class="numeric">${formatPace(l.paceDesc)}</td>
    </tr>
  `).join('');
  document.getElementById('pace-by-grade').innerHTML = `
    <table class="metric-table">
      <thead><tr>
        <th>Loop</th>
        <th class="numeric">Climb (>3%)</th>
        <th class="numeric">Flat</th>
        <th class="numeric">Descent (<-3%)</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr>
          <td>Decay L1→L${lm.length}</td>
          <td class="numeric cell-decay">+${climbDecay.toFixed(0)}%</td>
          <td class="numeric cell-decay">+${flatDecay.toFixed(0)}%</td>
          <td class="numeric cell-decay">+${descDecay.toFixed(0)}%</td>
        </tr>
      </tbody>
    </table>
    <p class="card-sub" style="margin-top:10px">Larger flat-pace decay than climb-pace decay points to systemic depletion (fueling, sleep) rather than quad damage.</p>
  `;
}

function renderStopClassification() {
  const m = state.metrics;
  const top = m.stopClusters.slice(0, 12).filter(c => c.totalMin >= 0.5);
  if (top.length === 0) {
    document.getElementById('stop-classification').innerHTML = '<p class="card-sub">No stops detected (≥ 30 s).</p>';
    return;
  }
  const items = top.map(c => `
    <div class="stop-item">
      <div class="stop-time">${c.totalMin.toFixed(1)} min</div>
      <div class="stop-meta">${c.visits} visit${c.visits>1?'s':''} · longest ${c.longestMin.toFixed(1)} min</div>
      <div class="stop-meta">@ ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</div>
    </div>
  `).join('');
  document.getElementById('stop-classification').innerHTML = `
    <p class="card-sub" style="margin-bottom:12px">Stops grouped by 50 m grid cell. Total: ${m.stops.length} stops ≥ 30 s, ${formatHM(m.stops.reduce((s,x)=>s+x.durationSec,0))} cumulative.</p>
    <div class="stop-list">${items}</div>
  `;
}

function renderDaylight() {
  const dl = state.metrics.daylight;
  if (!dl) {
    document.getElementById('daylight-overlay').innerHTML = '<p class="card-sub">No timestamps available; daylight not computed.</p>';
    return;
  }
  const f = d => d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  document.getElementById('daylight-overlay').innerHTML = `
    <p class="card-sub" style="margin-bottom:12px">All times in your local timezone. Anchored to the GPX start coordinates.</p>
    <dl class="daylight-table" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:0">
      <div><dt>Sunrise (day 1)</dt><dd>${f(dl.sunrise1)}</dd></div>
      <div><dt>Sunset (day 1)</dt><dd>${f(dl.sunset1)}</dd></div>
      <div><dt>Civil twilight ends</dt><dd>${f(dl.civilEnd1)}</dd></div>
      <div><dt>Astro twilight ends</dt><dd>${f(dl.astroEnd1)}</dd></div>
      <div><dt>Astro twilight begins</dt><dd>${f(dl.astroBegin2)}</dd></div>
      <div><dt>Sunrise (day 2)</dt><dd>${f(dl.sunrise2)}</dd></div>
      <div><dt>Daylight share</dt><dd>${dl.daylightPct.toFixed(0)}% of elapsed</dd></div>
      <div><dt>Time in daylight</dt><dd>${formatHM(dl.daylightSec)}</dd></div>
    </dl>
  `;
}

function renderElevationProfile() {
  const e = state.metrics.elevation;
  document.getElementById('elevation-profile').innerHTML = `
    <p class="card-sub" style="margin-bottom:12px">Smoothing: 1 m hysteresis on a 5-point moving average. Raw GPS gain shown for comparison; raw is typically inflated by altitude noise.</p>
    <div class="elevation-summary">
      <div class="stat-tile">
        <div class="stat-label">Range</div>
        <div class="stat-value">${e.minFt.toFixed(0)}–${e.maxFt.toFixed(0)} ft</div>
        <div class="stat-sub">${e.minM.toFixed(0)}–${e.maxM.toFixed(0)} m</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Gain (raw)</div>
        <div class="stat-value">${e.gainRawFt.toFixed(0)} ft</div>
        <div class="stat-sub">${e.gainRawM.toFixed(0)} m · noisy</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Gain (smoothed)</div>
        <div class="stat-value">${e.gainSmoothFt.toFixed(0)} ft</div>
        <div class="stat-sub">${e.gainSmoothM.toFixed(0)} m · 1 m hysteresis</div>
      </div>
    </div>
  `;
}

// ─────────── Re-Run subgame ───────────

function initSliders() {
  const m = state.metrics;
  state.sliders = m.loopMetrics.map(l => ({ stopMin: l.stoppedMin, effort: 1.0 }));
}

function openReRun() {
  const m = state.metrics;
  if (!m || !m.isLooped) return;
  document.getElementById('rerun-modal').classList.add('open');
  document.getElementById('rerun-modal').setAttribute('aria-hidden', 'false');
  buildLoopControls();
  renderReRun();
  updateSavedCount();
}

function closeReRun() {
  document.getElementById('rerun-modal').classList.remove('open');
  document.getElementById('rerun-modal').setAttribute('aria-hidden', 'true');
}

function buildLoopControls() {
  const m = state.metrics;
  const container = document.getElementById('loop-controls');
  container.innerHTML = '';
  m.loopMetrics.forEach((l, i) => {
    const stopMax = Math.max(1, Math.ceil(l.stoppedMin * 1.5));
    const actualStopRounded = Math.round(l.stoppedMin);
    const row = document.createElement('div');
    row.className = 'loop-row';
    row.innerHTML = `
      <div class="loop-row-title">Loop ${i + 1}</div>
      <div class="slider-row">
        <span class="slider-label">stop</span>
        <input type="range" min="0" max="${stopMax}" step="1" value="${actualStopRounded}" data-loop="${i}" data-kind="stop">
        <span class="slider-value"><span data-display="stop-${i}">${actualStopRounded}</span> min</span>
      </div>
      <div class="slider-effect" data-effect="stop-${i}">actual ${actualStopRounded} min &mdash; no change</div>

      <div class="slider-row">
        <span class="slider-label">effort</span>
        <input type="range" min="0.85" max="1.20" step="0.01" value="1.00" data-loop="${i}" data-kind="effort">
        <span class="slider-value"><span data-display="effort-${i}">1.00</span>×</span>
      </div>
      <div class="slider-effect" data-effect="effort-${i}">actual 1.00× &mdash; no change</div>
    `;
    container.appendChild(row);
  });
  container.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', onSliderChange);
  });
}

function onSliderChange(e) {
  const i = parseInt(e.target.dataset.loop, 10);
  const kind = e.target.dataset.kind;
  const val = parseFloat(e.target.value);
  if (kind === 'stop')   state.sliders[i].stopMin = val;
  if (kind === 'effort') state.sliders[i].effort  = val;
  document.querySelector(`[data-display="${kind}-${i}"]`).textContent =
    kind === 'stop' ? Math.round(val) : val.toFixed(2);
  renderReRun();
}

function resetSliders() {
  initSliders();
  buildLoopControls();
  renderReRun();
}

function applySlidersFromUrl(spec) {
  // Format: "L2stop:12,L2effort:1.05,L3stop:47"
  for (const part of spec.split(',')) {
    const m = part.match(/^L(\d+)(stop|effort):([\d.]+)$/);
    if (!m) continue;
    const i = parseInt(m[1], 10) - 1;
    const kind = m[2];
    const val = parseFloat(m[3]);
    if (i < 0 || i >= state.sliders.length) continue;
    if (kind === 'stop')   state.sliders[i].stopMin = val;
    if (kind === 'effort') state.sliders[i].effort  = val;
    const input = document.querySelector(`input[data-loop="${i}"][data-kind="${kind}"]`);
    if (input) {
      input.value = val;
      const display = document.querySelector(`[data-display="${kind}-${i}"]`);
      if (display) display.textContent = (kind === 'stop') ? Math.round(val) : val.toFixed(2);
    }
  }
  renderReRun();
}

function renderReRun() {
  const m = state.metrics;
  const cf = computeCounterfactual(m.loopMetrics, state.sliders);

  // Result blocks
  const actualFinishSec = m.totals.elapsedSec;
  const actualStopMin   = m.loopMetrics.reduce((s, l) => s + l.stoppedMin, 0);
  document.getElementById('actual-finish').textContent = formatHM(actualFinishSec);
  document.getElementById('actual-detail').textContent = `Stops ${formatHM(actualStopMin*60)} · Status ✓`;

  const cfFinishEl = document.getElementById('cf-finish');
  const deltaSec = cf.newFinishSec - actualFinishSec;
  if (cf.dnf) {
    cfFinishEl.textContent = 'DNF';
    cfFinishEl.className = 'result-finish dnf';
  } else if (Math.abs(deltaSec) < 30) {
    // Effectively no change — don't show a +0 delta
    cfFinishEl.textContent = formatHM(cf.newFinishSec);
    cfFinishEl.className = 'result-finish';
  } else {
    const sign = deltaSec < 0 ? '−' : '+';
    cfFinishEl.textContent = `${formatHM(cf.newFinishSec)}  (${sign}${formatHM(Math.abs(deltaSec))})`;
    cfFinishEl.className = 'result-finish ' + (deltaSec < 0 ? 'delta-good' : 'delta-bad');
  }
  const detail = `Stops ${formatHM(cf.newStopSec)} · ` + (cf.dnf
    ? `<span style="color:var(--bad)">DNF — pool ≤ 0</span>`
    : `Status ✓`);
  document.getElementById('cf-detail').innerHTML = detail;

  // Pools (with hover tooltips explaining what each represents)
  const poolMeta = {
    legs:    'Cumulative leg load. Depleted by effort > 1.00× (eccentric quad damage). Banded.',
    fuel:    'Metabolic depletion. Depleted by effort > 1.00× (glycogen, electrolytes). Banded.',
    stomach: 'GI tolerance. Depleted by reducing stop time below actual (you skipped food). Banded.',
    morale:  'Will to keep going. Depleted by reducing stop time below actual (you suffered without rest). Banded.'
  };
  const poolsEl = document.getElementById('pools');
  poolsEl.innerHTML = '';
  for (const k of ['legs', 'fuel', 'stomach', 'morale']) {
    const v = cf.poolDisplay[k];
    const pct = Math.max(0, Math.min(100, (cf.pools[k] / 10) * 100));
    const cls = cf.pools[k] <= 0 ? 'bad' : (cf.pools[k] <= 2 ? 'warn' : '');
    const warn = cf.poolWarnings[k] || '';
    const row = document.createElement('div');
    row.className = 'pool-row';
    row.innerHTML = `
      <div class="pool-name" title="${escapeHtml(poolMeta[k])}">${k.charAt(0).toUpperCase() + k.slice(1)}</div>
      <div class="pool-bar-track"><div class="pool-bar-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="pool-value">${v}</div>
      <div class="pool-warn ${cf.pools[k] <= 0 ? 'bad' : ''}">${escapeHtml(warn)}</div>
    `;
    poolsEl.appendChild(row);
  }

  // Per-slider effect annotations — each slider gets a live readout of
  // (a) time delta against actual and (b) pool cost it just incurred.
  for (let i = 0; i < cf.perLoop.length; i++) {
    const loop = cf.perLoop[i];
    const lm = m.loopMetrics[i];
    const stopEl = document.querySelector(`[data-effect="stop-${i}"]`);
    const effortEl = document.querySelector(`[data-effect="effort-${i}"]`);
    if (stopEl)   stopEl.innerHTML   = formatStopEffect(loop, lm);
    if (effortEl) effortEl.innerHTML = formatEffortEffect(loop, lm);
  }

  // Warnings
  const warnEl = document.getElementById('rerun-warnings');
  warnEl.innerHTML = cf.warnings.map(w => `<div class="warning">${escapeHtml(w)}</div>`).join('');
}

function formatStopEffect(loop, lm) {
  const actual = Math.round(lm.stoppedMin);
  const newStop = Math.round(loop.stopMin);
  const delta = newStop - actual;
  if (delta === 0) return `actual ${actual} min &mdash; <span class="effect-neutral">no change</span>`;
  if (delta > 0)   return `actual ${actual} min &mdash; <span class="effect-neutral">+${delta} min stopped, no cost</span>`;
  // delta < 0: reducing stop time
  const saved = -delta;
  return `actual ${actual} min &mdash; <span class="effect-good">save ${saved} min</span> &middot; <span class="effect-cost">&minus;${loop.cost.stomach.toFixed(2)} Stomach, &minus;${loop.cost.morale.toFixed(2)} Morale</span>`;
}

function formatEffortEffect(loop, lm) {
  if (Math.abs(loop.effort - 1.0) < 0.005) return `actual 1.00× &mdash; <span class="effect-neutral">no change</span>`;
  if (loop.effort < 1.0) {
    const slowedSec = (lm.movingSec / loop.effort) - lm.movingSec;
    return `actual 1.00× &mdash; <span class="effect-neutral">+${formatHM(slowedSec)} slower, no cost</span>`;
  }
  // effort > 1.0: pushing harder
  const savedSec = lm.movingSec - (lm.movingSec / loop.effort);
  return `actual 1.00× &mdash; <span class="effect-good">save ${formatHM(savedSec)}</span> &middot; <span class="effect-cost">&minus;${loop.cost.legs.toFixed(2)} Legs, &minus;${loop.cost.fuel.toFixed(2)} Fuel</span>`;
}

// ─────────── Save / load ───────────

function localStorageKey() { return `riverlands-tribute:${state.raceId}`; }

function getSavedRuns() {
  try {
    return JSON.parse(localStorage.getItem(localStorageKey())) || [];
  } catch { return []; }
}

function setSavedRuns(arr) {
  localStorage.setItem(localStorageKey(), JSON.stringify(arr));
  updateSavedCount();
}

function saveCurrentRun() {
  const m = state.metrics;
  const cf = computeCounterfactual(m.loopMetrics, state.sliders);
  const run = {
    id: Date.now(),
    ts: new Date().toISOString(),
    sliders: state.sliders.map(s => ({ ...s })),
    finishSec: cf.newFinishSec,
    pools: cf.poolDisplay,
    dnf: cf.dnf
  };
  const arr = getSavedRuns();
  arr.unshift(run);
  setSavedRuns(arr.slice(0, 50));
  // Brief feedback
  const btn = document.getElementById('rerun-save');
  const orig = btn.textContent;
  btn.textContent = '✓ saved';
  setTimeout(() => { btn.textContent = orig; }, 1200);
}

function updateSavedCount() {
  document.getElementById('saved-count').textContent = getSavedRuns().length;
}

function openSavedList() {
  renderSavedList();
  document.getElementById('saved-modal').classList.add('open');
  document.getElementById('saved-modal').setAttribute('aria-hidden', 'false');
}
function closeSavedList() {
  document.getElementById('saved-modal').classList.remove('open');
  document.getElementById('saved-modal').setAttribute('aria-hidden', 'true');
}

function openAbout() {
  document.getElementById('about-modal').classList.add('open');
  document.getElementById('about-modal').setAttribute('aria-hidden', 'false');
}
function closeAbout() {
  document.getElementById('about-modal').classList.remove('open');
  document.getElementById('about-modal').setAttribute('aria-hidden', 'true');
}

function renderSavedList() {
  const arr = getSavedRuns();
  const ul = document.getElementById('saved-list');
  if (arr.length === 0) {
    ul.innerHTML = '<li class="saved-empty">No counterfactuals saved yet.</li>';
    return;
  }
  ul.innerHTML = arr.map(r => `
    <li class="saved-item">
      <div class="saved-item-info">
        <div class="saved-item-finish">${r.dnf ? '<span style="color:var(--bad)">DNF</span>' : formatHM(r.finishSec)}</div>
        <div class="saved-item-time">${new Date(r.ts).toLocaleString()}</div>
      </div>
      <button class="btn" data-load-run="${r.id}">Load</button>
    </li>
  `).join('');
  ul.querySelectorAll('[data-load-run]').forEach(b => b.addEventListener('click', e => {
    const id = parseInt(e.target.dataset.loadRun, 10);
    const run = getSavedRuns().find(x => x.id === id);
    if (!run) return;
    state.sliders = run.sliders.map(s => ({ ...s }));
    closeSavedList();
    buildLoopControls();
    // Set slider DOM values to match
    state.sliders.forEach((s, i) => {
      const stopInput   = document.querySelector(`input[data-loop="${i}"][data-kind="stop"]`);
      const effortInput = document.querySelector(`input[data-loop="${i}"][data-kind="effort"]`);
      if (stopInput)   { stopInput.value = s.stopMin; document.querySelector(`[data-display="stop-${i}"]`).textContent = Math.round(s.stopMin); }
      if (effortInput) { effortInput.value = s.effort; document.querySelector(`[data-display="effort-${i}"]`).textContent = s.effort.toFixed(2); }
    });
    renderReRun();
  }));
}

function clearSavedRuns() {
  if (!confirm('Clear all saved counterfactuals for this race?')) return;
  localStorage.removeItem(localStorageKey());
  updateSavedCount();
  renderSavedList();
}

// ─────────── Postcard ───────────

function postcardKey() { return `riverlands-tribute-postcard:${state.raceId}`; }

function getPostcardData() {
  try {
    return JSON.parse(localStorage.getItem(postcardKey())) || { cards: {} };
  } catch { return { cards: {} }; }
}

function savePostcardCard(key, partial) {
  const data = getPostcardData();
  if (!data.cards) data.cards = {};
  data.cards[key] = { ...(data.cards[key] || {}), ...partial };
  data.lastEdited = new Date().toISOString();
  localStorage.setItem(postcardKey(), JSON.stringify(data));
  updatePostcardProgress();
  renderPostcardProgressStrip();
}

function openPostcard() {
  if (!state.inflections || state.inflections.length === 0) return;
  showScreen('postcard');
  renderPostcard();
}

function renderPostcard() {
  const sub = document.getElementById('postcard-sub');
  sub.textContent = state.raceTitle;
  const list = document.getElementById('postcard-cards');
  list.innerHTML = '';
  const data = getPostcardData();

  state.inflections.forEach((inf, i) => {
    const key = cardKey(inf);
    const saved = data.cards[key] || {};
    const card = buildPostcardCard(inf, key, saved);
    card.dataset.cardIdx = i;
    list.appendChild(card);
  });

  // Focus state init
  if (state.postcardIdx == null) state.postcardIdx = 0;
  updatePostcardCurrentCard();
  renderPostcardProgressStrip();
  updatePostcardProgress();
}

function togglePostcardFocus() {
  const main = document.getElementById('postcard-main');
  const isFocus = main.classList.toggle('focus-mode');
  document.getElementById('postcard-mode-toggle').textContent =
    isFocus ? 'Booklet view' : 'Focus mode';
  state.postcardFocus = isFocus;
  if (isFocus) {
    updatePostcardCurrentCard();
    // Scroll the active card into view
    const cur = document.querySelector('.postcard-card.is-current');
    if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function stepPostcard(delta) {
  if (!state.inflections) return;
  const max = state.inflections.length - 1;
  state.postcardIdx = clamp((state.postcardIdx ?? 0) + delta, 0, max);
  updatePostcardCurrentCard();
  renderPostcardProgressStrip();
}

function jumpPostcardTo(idx) {
  if (!state.inflections) return;
  state.postcardIdx = clamp(idx, 0, state.inflections.length - 1);
  updatePostcardCurrentCard();
  renderPostcardProgressStrip();
  // In booklet view, scroll the card into view too
  if (!state.postcardFocus) {
    const cards = document.querySelectorAll('.postcard-card');
    if (cards[state.postcardIdx]) {
      cards[state.postcardIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function updatePostcardCurrentCard() {
  const cards = document.querySelectorAll('.postcard-card');
  cards.forEach((c, i) => c.classList.toggle('is-current', i === state.postcardIdx));
  const total = state.inflections ? state.inflections.length : 0;
  const label = document.getElementById('postcard-nav-label');
  if (label) label.textContent = `Card ${(state.postcardIdx ?? 0) + 1} of ${total}`;
  const prevBtn = document.getElementById('postcard-prev');
  const nextBtn = document.getElementById('postcard-next');
  if (prevBtn) prevBtn.disabled = (state.postcardIdx ?? 0) <= 0;
  if (nextBtn) nextBtn.disabled = (state.postcardIdx ?? 0) >= total - 1;
}

function renderPostcardProgressStrip() {
  const strip = document.getElementById('postcard-progress-strip');
  if (!strip || !state.inflections) return;
  strip.innerHTML = '';
  const data = getPostcardData();
  state.inflections.forEach((inf, i) => {
    const key = cardKey(inf);
    const saved = data.cards[key] || {};
    const filled = (saved.answer && saved.answer.trim()) || (saved.tokens && saved.tokens.length > 0);
    const isCurrent = i === (state.postcardIdx ?? 0);
    const pip = document.createElement('button');
    pip.type = 'button';
    pip.className = 'pc-pip' + (filled ? ' filled' : '') + (isCurrent ? ' is-current' : '');
    pip.title = `Card ${i + 1} of ${state.inflections.length}: ${inf.label}`;
    pip.addEventListener('click', () => jumpPostcardTo(i));
    strip.appendChild(pip);
  });
  // Trailing label: filled count
  const filledCount = state.inflections.filter(inf => {
    const s = data.cards[cardKey(inf)] || {};
    return (s.answer && s.answer.trim()) || (s.tokens && s.tokens.length > 0);
  }).length;
  const label = document.createElement('span');
  label.className = 'pc-pip-label';
  label.textContent = `${filledCount} of ${state.inflections.length} filled`;
  strip.appendChild(label);
}

function buildPostcardCard(inf, key, saved) {
  const card = document.createElement('article');
  card.className = 'postcard-card';
  const timeStr = (state.cachedPoints && state.cachedPoints[inf.idx] && state.cachedPoints[inf.idx].time)
    ? state.cachedPoints[inf.idx].time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
  const prompt = promptFor(inf);
  const filled = !!(saved.answer && saved.answer.trim());

  card.innerHTML = `
    <div class="pc-card-header">
      <div class="pc-card-icon" aria-hidden="true">${escapeHtml(iconFor(inf.type))}</div>
      <div class="pc-card-meta">
        <div class="pc-card-title">${escapeHtml(inf.label)}</div>
        <div class="pc-card-sub">mile ${inf.distMi.toFixed(1)} · ${escapeHtml(timeStr)} · ${escapeHtml(labelFor(inf.type))}</div>
      </div>
      <div class="pc-saved-pip ${filled ? 'shown' : ''}" data-pip aria-label="saved indicator"></div>
    </div>
    <p class="pc-prompt">${escapeHtml(prompt)}</p>
    <textarea class="pc-textarea" rows="3" placeholder="Short answer is fine. Empty is fine.">${escapeHtml(saved.answer || '')}</textarea>
    <div class="pc-tokens-host"></div>
  `;

  // Tokens — chips per category, max 2 selected total
  const tokensHost = card.querySelector('.pc-tokens-host');
  const selected = new Set(saved.tokens || []);
  for (const [cat, tokens] of Object.entries(TOKEN_CATEGORIES)) {
    const row = document.createElement('div');
    row.className = 'pc-token-row';
    row.innerHTML = `<span class="pc-token-cat-label">${escapeHtml(cat)}</span>`;
    for (const tok of tokens) {
      const tokKey = `${cat.toLowerCase()}:${tok}`;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pc-token' + (selected.has(tokKey) ? ' active' : '');
      chip.textContent = tok;
      chip.dataset.tokenKey = tokKey;
      chip.dataset.category = cat;
      chip.addEventListener('click', () => onTokenClick(card, key, chip, selected));
      row.appendChild(chip);
    }
    tokensHost.appendChild(row);
  }
  const limit = document.createElement('p');
  limit.className = 'pc-token-limit';
  limit.textContent = 'Up to 2 tokens. Click again to remove.';
  tokensHost.appendChild(limit);
  refreshTokenAvailability(card, selected);

  // Auto-save on textarea blur and on input (debounced)
  const ta = card.querySelector('.pc-textarea');
  let timer;
  const flush = () => {
    savePostcardCard(key, { answer: ta.value });
    const pip = card.querySelector('[data-pip]');
    if (ta.value.trim()) pip.classList.add('shown'); else pip.classList.remove('shown');
  };
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 600); });
  ta.addEventListener('blur', flush);

  return card;
}

function onTokenClick(card, key, chip, selected) {
  const tokKey = chip.dataset.tokenKey;
  if (selected.has(tokKey)) {
    selected.delete(tokKey);
    chip.classList.remove('active');
  } else {
    if (selected.size >= 2) return;  // max 2
    selected.add(tokKey);
    chip.classList.add('active');
  }
  savePostcardCard(key, { tokens: [...selected] });
  refreshTokenAvailability(card, selected);
}

function refreshTokenAvailability(card, selected) {
  // When 2 are picked, dim the rest. When <2, none dimmed.
  const atLimit = selected.size >= 2;
  card.querySelectorAll('.pc-token').forEach(chip => {
    if (chip.classList.contains('active')) return;
    chip.classList.toggle('disabled', atLimit);
  });
}

function updatePostcardProgress() {
  const data = getPostcardData();
  const filled = Object.values(data.cards || {}).filter(c =>
    (c.answer && c.answer.trim()) || (c.tokens && c.tokens.length > 0)
  ).length;
  const total = state.inflections ? state.inflections.length : 0;
  const el = document.getElementById('postcard-progress');
  if (el) el.textContent = `${filled} of ${total}`;
}

// ─────────── FAQ ───────────

function openFaq(initialQid) {
  if (!state.metrics) return;
  showScreen('faq');
  document.getElementById('faq-sub').textContent = state.raceTitle;
  renderFaqList();
  // Default to the first question, or one passed in.
  const qid = initialQid || (state.faqActive || QUESTIONS[0].id);
  selectFaqQuestion(qid);
}

function renderFaqList() {
  const list = document.getElementById('faq-list');
  list.innerHTML = '';
  const groups = groupedQuestions();
  for (const [cat, qs] of Object.entries(groups)) {
    const h = document.createElement('h3');
    h.className = 'faq-cat-label';
    h.textContent = cat;
    list.appendChild(h);
    for (const q of qs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'faq-q' + (state.faqActive === q.id ? ' active' : '');
      btn.dataset.qid = q.id;
      btn.textContent = q.label;
      btn.addEventListener('click', () => selectFaqQuestion(q.id));
      list.appendChild(btn);
    }
  }
}

function selectFaqQuestion(qid) {
  state.faqActive = qid;
  // Update active state on list buttons
  document.querySelectorAll('.faq-q').forEach(b => {
    b.classList.toggle('active', b.dataset.qid === qid);
  });
  // Reset params for the new question (fresh defaults each time the user
  // clicks a question; preserves params if they re-tune the same one).
  if (!state.faqParams) state.faqParams = {};
  state.faqParams[qid] = state.faqParams[qid] || defaultParamsFor(qid);
  renderFaqDetail();
}

function defaultParamsFor(qid) {
  const q = getQuestion(qid);
  if (!q || !q.params) return {};
  const out = {};
  for (const p of q.params) out[p.name] = p.default;
  return out;
}

function renderFaqDetail() {
  const detail = document.getElementById('faq-detail');
  const qid = state.faqActive;
  const q = getQuestion(qid);
  if (!q) {
    detail.innerHTML = '<p class="faq-detail-empty">Pick a question on the left.</p>';
    return;
  }
  const params = state.faqParams[qid] || defaultParamsFor(qid);
  const ans = q.answer(state.metrics, state.cachedPoints, params);

  const paramsHtml = (q.params || []).map(p => `
    <label class="faq-param-label">
      ${escapeHtml(p.label)}
      <input type="number"
             data-faq-param="${escapeHtml(p.name)}"
             min="${p.min ?? ''}" max="${p.max ?? ''}" step="${p.step ?? 1}"
             value="${params[p.name] ?? p.default}">
      ${p.suffix ? `<span class="faq-param-suffix">${escapeHtml(p.suffix)}</span>` : ''}
    </label>
  `).join('');

  const detailHtml = (ans.detail || []).map(d => `<li>${renderInlineMd(d)}</li>`).join('');

  detail.innerHTML = `
    <h2>${escapeHtml(q.label)}</h2>
    <p class="faq-blurb">${escapeHtml(q.blurb)}</p>
    ${q.params && q.params.length ? `<div class="faq-params">${paramsHtml}</div>` : ''}
    <p class="faq-headline">${renderInlineMd(ans.headline || '')}</p>
    ${detailHtml ? `<ul class="faq-detail-list">${detailHtml}</ul>` : ''}
    <div class="faq-meta">
      ${ans.assumption ? `<div class="faq-meta-block faq-assumption"><b>Assumption:</b> ${escapeHtml(ans.assumption)}</div>` : ''}
      ${ans.confound ? `<div class="faq-meta-block faq-confound"><b>Confound:</b> ${escapeHtml(ans.confound)}</div>` : ''}
    </div>
  `;
  // Wire param inputs — recompute on input.
  detail.querySelectorAll('input[data-faq-param]').forEach(inp => {
    inp.addEventListener('input', e => {
      const name = e.target.dataset.faqParam;
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) {
        state.faqParams[qid][name] = v;
        renderFaqDetail();
      }
    });
  });
}

// Render simple inline-markdown: **bold** -> <strong>. Used by FAQ
// answers so authors can highlight the punchline number without
// hand-writing HTML in the question registry.
function renderInlineMd(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// ─────────── Helpers ───────────

function formatHM(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

function formatPace(minPerMile) {
  if (!minPerMile || !isFinite(minPerMile) || minPerMile <= 0) return '—';
  let m = Math.floor(minPerMile);
  let s = Math.round((minPerMile - m) * 60);
  if (s === 60) { m += 1; s = 0; }   // 21:60/mi → 22:00/mi
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

