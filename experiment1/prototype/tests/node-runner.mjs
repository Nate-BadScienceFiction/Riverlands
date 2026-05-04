// Node-runnable verification of the JS metrics module against Riverlands.gpx.
// Bypasses parseGpx (which needs DOMParser) by parsing with regex.
// Run: cd experiment1/prototype && node tests/node-runner.mjs

import { computeMetrics } from '../lib/metrics.js';
import { computeCounterfactual } from '../lib/rerun.js';
import { haversine } from '../lib/gpx.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Regex parser — same shape as parseGpx output (minus the DOM dependency).
function parseGpxNode(text) {
  const re = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)">\s*<ele>([^<]+)<\/ele>\s*<time>([^<]+)<\/time>/g;
  const points = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    points.push({
      lat: parseFloat(m[1]),
      lon: parseFloat(m[2]),
      ele: parseFloat(m[3]),
      time: new Date(m[4]),
      segDist: 0, segDt: 0, speed: 0
    });
  }
  for (let i = 1; i < points.length; i++) {
    const p = points[i], q = points[i-1];
    p.segDist = haversine(q.lat, q.lon, p.lat, p.lon);
    p.segDt   = (p.time - q.time) / 1000;
    p.speed   = p.segDt > 0 ? p.segDist / p.segDt : 0;
  }
  return points;
}

const gpxPath = resolve(__dirname, '../data/Riverlands.gpx');
const text = readFileSync(gpxPath, 'utf8');
const points = parseGpxNode(text);
console.log(`parsed: ${points.length} trackpoints`);

const m = computeMetrics(points);

let pass = 0, fail = 0;
function check(name, actual, predicate, expected) {
  const ok = predicate(actual);
  const fmt = v => typeof v === 'number' ? v.toFixed(4).replace(/\.?0+$/, '') : String(v);
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(38)} actual=${String(fmt(actual)).padEnd(20)} expected=${expected}`);
  if (ok) pass++; else fail++;
}
const within  = (t, tol)    => v => Math.abs(v - t) <= tol;
const between = (lo, hi)    => v => v >= lo && v <= hi;
const equal   = (t)         => v => v === t;

check('trackpoint count',          points.length, equal(13126), '13126');
check('total distance (mi)',       m.totals.distMi, within(74.64, 0.1), '74.64 ± 0.1');
check('elapsed time (h)',          m.totals.elapsedH, within(25.31, 0.02), '25.31 ± 0.02');
check('moving time (h)',           m.totals.movingH, within(22.96, 0.10), '22.96 ± 0.10');
check('stopped time (h)',          m.totals.stoppedH, within(2.35, 0.10), '2.35 ± 0.10');
check('elevation min (m)',         m.elevation.minM, within(81.3, 0.5), '81.3 ± 0.5');
check('elevation max (m)',         m.elevation.maxM, within(171.8, 0.5), '171.8 ± 0.5');
check('raw cumulative gain (ft)',  m.elevation.gainRawFt, within(10063, 50), '10063 ± 50');
check('smoothed gain (ft)',        m.elevation.gainSmoothFt, between(7000, 10000), '7000–10000');
check('isLooped',                  m.isLooped, equal(true), 'true');
check('loop count',                m.loops.length, equal(3), '3');
check('Loop 1 distance (mi)',      m.loopMetrics[0].distMi, within(24.60, 0.2), '24.60 ± 0.2');
check('Loop 2 distance (mi)',      m.loopMetrics[1].distMi, within(24.60, 0.2), '24.60 ± 0.2');
check('Loop 3 distance (mi)',      m.loopMetrics[2].distMi, within(25.40, 0.3), '25.40 ± 0.3');
check('Loop 3 stopped (min)',      m.loopMetrics[2].stoppedMin, within(111, 5), '111 ± 5');
check('Loop 1 moving pace',        m.loopMetrics[0].paceMoving, within(15.52, 0.3), '15.52 ± 0.3');
check('Loop 3 moving pace',        m.loopMetrics[2].paceMoving, within(22.0, 0.5), '22.0 ± 0.5');

const flatDecay = ((m.loopMetrics[2].paceFlat - m.loopMetrics[0].paceFlat) / m.loopMetrics[0].paceFlat) * 100;
check('flat-pace decay L1→L3 (%)', flatDecay, v => v >= 70, '≥ 70');

// Re-Run pool model sanity
const sliders = m.loopMetrics.map((l, i) => {
  if (i === 0) return { stopMin: l.stoppedMin, effort: 1.0 };
  if (i === 1) return { stopMin: 12, effort: 1.05 };
  return            { stopMin: 47, effort: 1.10 };
});
const cf = computeCounterfactual(m.loopMetrics, sliders);
check('cf Stomach',                cf.poolDisplay.stomach, within(2.2, 0.5), '~2.2');
check('cf Morale',                 cf.poolDisplay.morale,  within(5.0, 0.5), '~5.0');
check('cf Legs',                   cf.poolDisplay.legs,    within(7.5, 0.6), '~7.5');
check('cf Fuel',                   cf.poolDisplay.fuel,    within(6.5, 0.6), '~6.5');
check('cf not DNF',                cf.dnf, equal(false), 'false');
check('cf finish (h)',             cf.newFinishSec / 3600, within(22.85, 0.4), '~22.85');

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
