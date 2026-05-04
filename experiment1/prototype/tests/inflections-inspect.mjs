// Quick inspection of inflections detected on Riverlands.gpx.
// Not part of the acceptance gate — just for sanity-checking variety scoring.

import { computeMetrics } from '../lib/metrics.js';
import { detectInflections } from '../lib/inflections.js';
import { haversine } from '../lib/gpx.js';
import { readFileSync } from 'fs';

const text = readFileSync('data/Riverlands.gpx', 'utf8');
const re = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)">\s*<ele>([^<]+)<\/ele>\s*<time>([^<]+)<\/time>/g;
const points = [];
let m;
while ((m = re.exec(text)) !== null) {
  points.push({
    lat: parseFloat(m[1]), lon: parseFloat(m[2]),
    ele: parseFloat(m[3]), time: new Date(m[4]),
    segDist: 0, segDt: 0, speed: 0
  });
}
for (let i = 1; i < points.length; i++) {
  const p = points[i], q = points[i - 1];
  p.segDist = haversine(q.lat, q.lon, p.lat, p.lon);
  p.segDt = (p.time - q.time) / 1000;
  p.speed = p.segDt > 0 ? p.segDist / p.segDt : 0;
}

const met = computeMetrics(points);
const inf = detectInflections(points, met.loops, met.stops, met.daylight, met.cumDist, met.grades);

console.log(`Inflections detected on Riverlands: ${inf.length} of ${met.loops.length * 4} max`);
const byType = {};
for (const c of inf) byType[c.type] = (byType[c.type] || 0) + 1;
console.log('By type:', byType);
console.log();
for (const c of inf) {
  const loopIdx = met.loops.findIndex(l => c.idx >= l.startIdx && c.idx <= l.endIdx);
  console.log(
    `L${loopIdx + 1}  mi ${c.distMi.toFixed(1).padStart(5)}  ${c.type.padEnd(18)} score ${c.score.toFixed(0).padStart(4)}  ${c.label}`
  );
}
