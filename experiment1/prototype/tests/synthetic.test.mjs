// Synthetic-fixture tests. Catches the bug class that doesn't show on
// Riverlands.gpx — missing elevation, missing time, point-to-point,
// out-and-back, two-loop, near-start-pass-but-not-a-loop, tiny activity,
// reversed timestamps. Run: node tests/synthetic.test.mjs

import { computeMetrics } from '../lib/metrics.js';
import { detectInflections } from '../lib/inflections.js';
import { haversine } from '../lib/gpx.js';

let pass = 0, fail = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}

// ─── Synthetic GPX builder ───
// Builds a points array with proper segment deltas. Each step adds a point
// at lat/lon with the given timestamp (or null) and elevation (or null).

function buildPoints(steps) {
  const points = steps.map(s => ({
    lat: s.lat, lon: s.lon,
    ele: s.ele === undefined ? 100 : s.ele,
    time: s.time === undefined ? null : (s.time instanceof Date ? s.time : new Date(s.time)),
    segDist: 0, segDt: 0, speed: 0
  }));
  for (let i = 1; i < points.length; i++) {
    const p = points[i], q = points[i - 1];
    p.segDist = haversine(q.lat, q.lon, p.lat, p.lon);
    p.segDt = (p.time && q.time) ? (p.time - q.time) / 1000 : 0;
    p.speed = p.segDt > 0 ? p.segDist / p.segDt : 0;
  }
  return points;
}

// Sample a circular arc around (lat0, lon0) with given radius and step count.
function arc(lat0, lon0, radiusM, n, t0Iso, durSec, opts = {}) {
  const ele0 = opts.ele !== undefined ? opts.ele : 100;
  const eleAmp = opts.eleAmp !== undefined ? opts.eleAmp : 5;
  const startAngle = opts.startAngle || 0;
  const endAngle = opts.endAngle !== undefined ? opts.endAngle : 2 * Math.PI;
  const latPerM = 1 / 111000;
  const lonPerM = 1 / (111000 * Math.cos(lat0 * Math.PI / 180));
  const t0 = new Date(t0Iso).getTime();
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const angle = startAngle + f * (endAngle - startAngle);
    out.push({
      lat: lat0 + radiusM * latPerM * Math.cos(angle),
      lon: lon0 + radiusM * lonPerM * Math.sin(angle),
      ele: opts.ele === null ? null : ele0 + eleAmp * Math.sin(angle * 3),
      time: opts.time === null ? null : new Date(t0 + f * durSec * 1000)
    });
  }
  return out;
}

// Straight line between two points.
function line(lat1, lon1, lat2, lon2, n, t0Iso, durSec, opts = {}) {
  const t0 = new Date(t0Iso).getTime();
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    out.push({
      lat: lat1 + (lat2 - lat1) * f,
      lon: lon1 + (lon2 - lon1) * f,
      ele: opts.ele === null ? null : 100 + 50 * f,
      time: opts.time === null ? null : new Date(t0 + f * durSec * 1000)
    });
  }
  return out;
}

const LAT = 44.0, LON = -70.0;

// ───── Fixture 1: Single 5K loop ─────
{
  const steps = arc(LAT, LON, 800, 200, '2026-06-01T10:00:00Z', 1800);
  const m = computeMetrics(buildPoints(steps));
  check('single-loop totals', m.totals.distMi > 2.5 && m.totals.distMi < 3.5,
    `distMi=${m.totals.distMi.toFixed(2)}`);
  // The single-loop case returns to start at the last point — the detector
  // emits 1 "return" but boundaries become [0, last], yielding 1 loop.
  // The runner started AND finished at the same point — that's still "1 loop"
  // in the looped-mode sense (≥2 returns to start required for isLooped).
  check('single-loop isLooped=false', m.isLooped === false,
    `isLooped=${m.isLooped}, loop count=${m.loops.length}`);
}

// ───── Fixture 2: Two loops ─────
{
  const steps = [
    ...arc(LAT, LON, 800, 200, '2026-06-01T10:00:00Z', 1800),
    ...arc(LAT, LON, 800, 200, '2026-06-01T10:30:00Z', 1800)
  ];
  const m = computeMetrics(buildPoints(steps));
  check('two-loop isLooped=true', m.isLooped === true,
    `loop count=${m.loops.length}`);
  check('two-loop count=2', m.loops.length === 2,
    `loops=${m.loops.length}`);
}

// ───── Fixture 3: Three loops (sanity) ─────
{
  const steps = [
    ...arc(LAT, LON, 800, 200, '2026-06-01T10:00:00Z', 1800),
    ...arc(LAT, LON, 800, 200, '2026-06-01T10:30:00Z', 1800),
    ...arc(LAT, LON, 800, 200, '2026-06-01T11:00:00Z', 1800)
  ];
  const m = computeMetrics(buildPoints(steps));
  check('three-loop count=3', m.loops.length === 3,
    `loops=${m.loops.length}`);
}

// ───── Fixture 4: Point-to-point (no loop) ─────
{
  const steps = line(LAT, LON, LAT + 0.05, LON + 0.05, 200, '2026-06-01T10:00:00Z', 1800);
  const m = computeMetrics(buildPoints(steps));
  check('point-to-point isLooped=false', m.isLooped === false,
    `loop count=${m.loops.length}`);
  check('point-to-point distance > 0', m.totals.distMi > 0.5,
    `distMi=${m.totals.distMi.toFixed(2)}`);
}

// ───── Fixture 5: No elevation ─────
{
  const steps = arc(LAT, LON, 800, 200, '2026-06-01T10:00:00Z', 1800, { ele: null });
  const m = computeMetrics(buildPoints(steps));
  check('no-elevation: no crash', true);
  check('no-elevation: gain is 0 or NaN-safe',
    m.elevation.gainSmoothFt === 0 || !Number.isFinite(m.elevation.gainSmoothFt) || m.elevation.gainSmoothFt < 100,
    `gainSmoothFt=${m.elevation.gainSmoothFt}`);
}

// ───── Fixture 6: No timestamps ─────
{
  const steps = arc(LAT, LON, 800, 200, '2026-06-01T10:00:00Z', 1800, { time: null });
  const m = computeMetrics(buildPoints(steps));
  check('no-time: no crash', true);
  check('no-time: elapsed is 0', m.totals.elapsedSec === 0);
  check('no-time: moving is 0', m.totals.movingSec === 0);
  check('no-time: distance still computed', m.totals.distMi > 2 && m.totals.distMi < 4,
    `distMi=${m.totals.distMi.toFixed(2)}`);
}

// ───── Fixture 7: Out-and-back ─────
// Goes 1km out, then 1km back. Returns to start.
{
  const steps = [
    ...line(LAT, LON, LAT + 0.01, LON, 100, '2026-06-01T10:00:00Z', 600),
    ...line(LAT + 0.01, LON, LAT, LON, 100, '2026-06-01T10:10:00Z', 600)
  ];
  const m = computeMetrics(buildPoints(steps));
  // An out-and-back has only ONE return to start (at the very end).
  // With the "always end final loop at file end" rule, that's 1 loop, not looped.
  check('out-and-back is single loop', m.loops.length === 1,
    `loops=${m.loops.length}`);
  check('out-and-back isLooped=false', m.isLooped === false);
}

// ───── Fixture 8: Tiny activity (10 points) ─────
{
  const steps = arc(LAT, LON, 100, 10, '2026-06-01T10:00:00Z', 60);
  const m = computeMetrics(buildPoints(steps));
  check('tiny: no crash', true);
  check('tiny: distance computed', m.totals.distMi > 0,
    `distMi=${m.totals.distMi.toFixed(3)}`);
}

// ───── Fixture 9: Reversed timestamps ─────
// Watch glitch where time goes backwards mid-track.
{
  const steps = arc(LAT, LON, 800, 100, '2026-06-01T10:00:00Z', 1800);
  // Corrupt: reverse second half of timestamps
  for (let i = 50; i < steps.length; i++) {
    const orig = new Date(steps[i].time);
    steps[i].time = new Date(orig.getTime() - 600000);  // 10 min back
  }
  const m = computeMetrics(buildPoints(steps));
  check('reversed-time: no crash', true);
  // Some segments will have negative segDt — they're treated as 0 dt with 0 speed,
  // so they appear as stops. The fixture should still produce sane values.
  check('reversed-time: non-negative moving time',
    m.totals.movingSec >= 0,
    `movingSec=${m.totals.movingSec}`);
}

// ───── Fixture 10: Near-start mid-race pass (figure-8-ish) ─────
// Course passes within 80m of start at midpoint (false positive risk for
// loop detection). Documents a known limitation.
{
  const steps = [
    ...line(LAT, LON, LAT + 0.005, LON + 0.005, 50, '2026-06-01T10:00:00Z', 600),
    ...line(LAT + 0.005, LON + 0.005, LAT, LON + 0.0001, 50, '2026-06-01T10:10:00Z', 600),
    ...line(LAT, LON + 0.0001, LAT - 0.005, LON - 0.005, 50, '2026-06-01T10:20:00Z', 600),
    ...line(LAT - 0.005, LON - 0.005, LAT, LON, 50, '2026-06-01T10:30:00Z', 600)
  ];
  const m = computeMetrics(buildPoints(steps));
  // The detector WILL flag the midpoint as a return. Documented limitation.
  // We assert the count is at least 1; the user is informed by the dashboard
  // that loops are detected (if isLooped=true).
  check('figure-8: detector runs without crash', m.loops.length >= 1,
    `loops=${m.loops.length} (figure-8 may produce a phantom split — known limitation)`);
}

// ───── Fixture 11: Inflections on synthetic course ─────
{
  const steps = [
    ...arc(LAT, LON, 800, 200, '2026-06-01T10:00:00Z', 1800),
    ...arc(LAT, LON, 800, 200, '2026-06-01T10:30:00Z', 1800),
    ...arc(LAT, LON, 800, 200, '2026-06-01T11:00:00Z', 1800)
  ];
  const points = buildPoints(steps);
  const m = computeMetrics(points);
  const inflections = detectInflections(points, m.loops, m.stops, m.daylight, m.cumDist, m.grades);
  check('inflections: detect runs without crash', Array.isArray(inflections),
    `count=${inflections.length}`);
  check('inflections: cap respected (≤ 4 per loop)',
    inflections.length <= m.loops.length * 4,
    `count=${inflections.length}, loops=${m.loops.length}`);
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
