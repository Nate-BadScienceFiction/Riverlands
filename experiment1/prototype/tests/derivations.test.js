// Acceptance gate. Runs the full derivation pipeline on Riverlands.gpx
// and asserts against the verified numbers from analysis_possibilities.md.
// Open tests/test-runner.html in a browser to execute.

import { parseGpx, M_TO_MI } from '../lib/gpx.js';
import { computeMetrics } from '../lib/metrics.js';
import { computeCounterfactual, _bands } from '../lib/rerun.js';

let pass = 0, fail = 0;
const results = [];

function expect(name, actual, predicate, expectedDesc) {
  const ok = predicate(actual);
  if (ok) { pass++; }
  else    { fail++; }
  results.push({ name, actual, ok, expected: expectedDesc });
}

const within = (target, tol) => v => Math.abs(v - target) <= tol;
const between = (lo, hi)     => v => v >= lo && v <= hi;
const equal = (target)       => v => v === target;

export async function runTests() {
  const t0 = performance.now();

  const res = await fetch('../data/Riverlands.gpx');
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const text = await res.text();
  const parsed = parseGpx(text);
  const m = computeMetrics(parsed.points);

  // ─── Identity ───
  expect('trackpoint count',
    parsed.points.length, equal(13126), '13,126');
  expect('hasTime',
    parsed.hasTime, equal(true), 'true');
  expect('hasEle',
    parsed.hasEle, equal(true), 'true');

  // ─── Totals ───
  expect('total distance (mi)',
    m.totals.distMi, within(74.64, 0.1), '74.64 ± 0.1');
  expect('elapsed time (h)',
    m.totals.elapsedH, within(25.31, 0.02), '25.31 ± 0.02');
  expect('moving time (h)',
    m.totals.movingH, within(22.96, 0.10), '22.96 ± 0.10');
  expect('stopped time (h)',
    m.totals.stoppedH, within(2.35, 0.10), '2.35 ± 0.10');

  // ─── Elevation ───
  expect('elevation min (m)',
    m.elevation.minM, within(81.3, 0.5), '81.3 ± 0.5');
  expect('elevation max (m)',
    m.elevation.maxM, within(171.8, 0.5), '171.8 ± 0.5');
  expect('raw cumulative gain (ft)',
    m.elevation.gainRawFt, within(10063, 50), '10,063 ± 50');
  expect('smoothed gain (ft)',
    m.elevation.gainSmoothFt, between(7000, 10000), '7,000–10,000 (filter-dependent)');

  // ─── Loops ───
  expect('isLooped',
    m.isLooped, equal(true), 'true');
  expect('loop count',
    m.loops.length, equal(3), '3');
  expect('loop boundaries (cum mi)',
    m.loopMetrics.map(l => l.distMi.toFixed(2)).join(','),
    v => {
      const vals = v.split(',').map(parseFloat);
      return Math.abs(vals[0] - 24.60) < 0.2 && Math.abs(vals[1] - 24.60) < 0.2 && Math.abs(vals[2] - 25.4) < 0.3;
    },
    '~24.60, ~24.60, ~25.4');
  expect('Loop 3 stopped time (min)',
    m.loopMetrics[2].stoppedMin, within(111, 5), '111 ± 5');
  expect('Loop 1 moving pace (min/mi)',
    m.loopMetrics[0].paceMoving, within(15.52, 0.3), '15.52 ± 0.3');
  expect('Loop 3 moving pace (min/mi)',
    m.loopMetrics[2].paceMoving, within(22.0, 0.5), '22.0 ± 0.5');

  // ─── Pace by grade — flat decay ≥ +70% ───
  const flatDecay = ((m.loopMetrics[2].paceFlat - m.loopMetrics[0].paceFlat) / m.loopMetrics[0].paceFlat) * 100;
  expect('flat-pace decay L1→L3 (%)',
    flatDecay, v => v >= 70, '≥ 70%');

  // ─── Daylight (May 2 sunrise ≈ 09:34 UTC = 05:34 EDT) ───
  if (m.daylight) {
    const sunriseMs = m.daylight.sunrise1.getTime();
    const startMs   = parsed.points[0].time.getTime();
    const sunriseMinSinceMidnightUTC =
      (m.daylight.sunrise1.getUTCHours() * 60) + m.daylight.sunrise1.getUTCMinutes();
    expect('May 2 sunrise minute-of-day UTC',
      sunriseMinSinceMidnightUTC, between(560, 580), '560–580 (~09:33-09:35 UTC)');
  }

  // ─── Re-Run pool model ───
  // Loop 3: stops 111 → 47 (save 64 min); Loop 2: stops 24 → 12 (save 12); Loop 2 effort 1.05; Loop 3 effort 1.10
  const sliders = m.loopMetrics.map((l, i) => {
    if (i === 0) return { stopMin: l.stoppedMin, effort: 1.0 };
    if (i === 1) return { stopMin: 12, effort: 1.05 };
    return            { stopMin: 47, effort: 1.10 };
  });
  const cf = computeCounterfactual(m.loopMetrics, sliders);
  expect('counterfactual Stomach ≈ 2',
    cf.poolDisplay.stomach, within(2.2, 0.5), '~2.2');
  expect('counterfactual Morale ≈ 5',
    cf.poolDisplay.morale, within(5.0, 0.5), '~5.0');
  expect('counterfactual Legs ≈ 8',
    cf.poolDisplay.legs, within(7.5, 0.6), '~7.5');
  expect('counterfactual Fuel ≈ 7',
    cf.poolDisplay.fuel, within(6.5, 0.6), '~6.5');
  expect('counterfactual not DNF',
    cf.dnf, equal(false), 'false');
  expect('counterfactual finish time (h)',
    cf.newFinishSec / 3600, within(22.85, 0.4), '~22.85 h');

  const dt = (performance.now() - t0).toFixed(0);
  return { pass, fail, results, dt };
}
