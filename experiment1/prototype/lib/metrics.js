// Derivations: totals, smoothed elevation, grades, loops, stops, daylight.
// All math operates on the points array produced by gpx.js.

import { haversine, M_TO_MI, M_TO_FT } from './gpx.js';

const MOVING_THRESHOLD_MPS = 0.4;
const STOP_MIN_DURATION_S  = 30;
const NEAR_START_M         = 80;
const MIN_LOOP_GAP_PTS     = 60;
const MIN_PTS_AFTER_START  = 50;
const SMOOTH_WINDOW        = 5;
const HYSTERESIS_M         = 1.0;
const STOP_GRID_M          = 50;
const GRADE_CLIMB_PCT      = 3;
const GRADE_DESC_PCT       = -3;

export function computeMetrics(points, opts = {}) {
  const totals       = computeTotals(points);
  const smoothEle    = smoothElevation(points);
  const grades       = computeGrades(points, smoothEle);
  const elevation    = computeElevation(points, smoothEle);
  const cumDist      = computeCumulativeDistance(points);
  const loops        = detectLoops(points);
  const stops        = detectStops(points);
  const stopClusters = clusterStops(stops);
  const loopMetrics  = loops.map(l => loopSummary(points, l, grades));
  const daylight     = (typeof SunCalc !== 'undefined' && points[0].time)
                         ? computeDaylight(points, cumDist) : null;
  const isLooped     = loops.length >= 2;

  return {
    totals, elevation, smoothEle, grades, cumDist,
    loops, loopMetrics, stops, stopClusters, daylight, isLooped
  };
}

// ─────────── Totals ───────────

function computeTotals(points) {
  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += points[i].segDist;

  const elapsedSec = points[0].time && points[points.length - 1].time
    ? (points[points.length - 1].time - points[0].time) / 1000
    : 0;

  let movingSec = 0, stoppedSec = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].speed >= MOVING_THRESHOLD_MPS) movingSec += points[i].segDt;
    else stoppedSec += points[i].segDt;
  }

  return {
    distM:        dist,
    distMi:       dist * M_TO_MI,
    elapsedSec,
    elapsedH:     elapsedSec / 3600,
    movingSec,
    movingH:      movingSec / 3600,
    stoppedSec,
    stoppedH:     stoppedSec / 3600,
    pointCount:   points.length
  };
}

// ─────────── Smoothed elevation ───────────

function smoothElevation(points) {
  const w = SMOOTH_WINDOW;
  const half = Math.floor(w / 2);
  const sm = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(points.length, i + half + 1);
    let sum = 0, n = 0;
    for (let j = lo; j < hi; j++) {
      if (points[j].ele !== null) { sum += points[j].ele; n++; }
    }
    sm[i] = n > 0 ? sum / n : null;
  }
  return sm;
}

function computeElevation(points, smoothEle) {
  let minM = Infinity, maxM = -Infinity;
  for (const p of points) {
    if (p.ele === null) continue;
    if (p.ele < minM) minM = p.ele;
    if (p.ele > maxM) maxM = p.ele;
  }
  if (!isFinite(minM)) { minM = 0; maxM = 0; }

  let gainRawM = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].ele !== null && points[i - 1].ele !== null) {
      const d = points[i].ele - points[i - 1].ele;
      if (d > 0) gainRawM += d;
    }
  }

  // 1m hysteresis on smoothed series
  let gainSmoothM = 0;
  let ref = smoothEle.find(v => v !== null) ?? 0;
  for (let i = 0; i < smoothEle.length; i++) {
    const v = smoothEle[i];
    if (v == null) continue;
    if (v - ref >= HYSTERESIS_M) { gainSmoothM += v - ref; ref = v; }
    else if (v < ref)            { ref = v; }
  }

  return {
    minM, maxM,
    minFt:        minM * M_TO_FT,
    maxFt:        maxM * M_TO_FT,
    gainRawM,
    gainRawFt:    gainRawM * M_TO_FT,
    gainSmoothM,
    gainSmoothFt: gainSmoothM * M_TO_FT
  };
}

// ─────────── Grades ───────────

function computeGrades(points, smoothEle) {
  const grades = new Array(points.length);
  grades[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const dist = points[i].segDist;
    const dEle = (smoothEle[i] != null && smoothEle[i - 1] != null)
      ? smoothEle[i] - smoothEle[i - 1]
      : 0;
    grades[i] = dist > 0.5 ? (dEle / dist) * 100 : 0;
  }
  return grades;
}

// ─────────── Cumulative distance ───────────

function computeCumulativeDistance(points) {
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + points[i].segDist;
  return cum;
}

// ─────────── Loop detection ───────────

function detectLoops(points) {
  if (points.length < MIN_PTS_AFTER_START + 10) return [{ idx: 0, startIdx: 0, endIdx: points.length - 1 }];

  const start = points[0];
  const near = [];
  for (let i = 0; i < points.length; i++) {
    const d = haversine(start.lat, start.lon, points[i].lat, points[i].lon);
    if (d < NEAR_START_M) near.push({ i, d });
  }

  // Cluster contiguous near-start indices
  const clusters = [];
  let cluster = [];
  let prevI = -MIN_LOOP_GAP_PTS - 1;
  for (const n of near) {
    if (n.i - prevI > MIN_LOOP_GAP_PTS) {
      if (cluster.length > 0) clusters.push(cluster);
      cluster = [n];
    } else {
      cluster.push(n);
    }
    prevI = n.i;
  }
  if (cluster.length > 0) clusters.push(cluster);

  const returns = clusters
    .map(c => c.reduce((best, x) => x.d < best.d ? x : best))
    .filter(r => r.i > MIN_PTS_AFTER_START)
    .map(r => r.i);

  if (returns.length === 0) {
    return [{ idx: 0, startIdx: 0, endIdx: points.length - 1 }];
  }

  // The detector's "returns" are closest-pass-to-start indices. The final
  // return represents the finish-line crossing, but the watch typically
  // keeps recording for some time after — the runner stands at the timing
  // tent or walks to their drop bag. Always extend the final loop to the
  // end of the file so the post-finish dwell is captured (otherwise it
  // shows up as a phantom 4th "loop" or worse, missing time).
  const lastIdx = points.length - 1;
  const boundaries = [0, ...returns];
  if (boundaries[boundaries.length - 1] !== lastIdx) {
    boundaries[boundaries.length - 1] = lastIdx;
  }

  const loops = [];
  for (let k = 0; k < boundaries.length - 1; k++) {
    loops.push({
      idx:      k,
      startIdx: boundaries[k],
      endIdx:   boundaries[k + 1]
    });
  }
  return loops;
}

function loopSummary(points, loop, grades) {
  let dist = 0, moving = 0, stopped = 0;
  let climbDist = 0, climbTime = 0;
  let flatDist  = 0, flatTime  = 0;
  let descDist  = 0, descTime  = 0;

  for (let i = loop.startIdx + 1; i <= loop.endIdx; i++) {
    const p = points[i];
    dist += p.segDist;
    if (p.speed >= MOVING_THRESHOLD_MPS) moving += p.segDt;
    else stopped += p.segDt;

    if (p.segDist < 0.5 || p.segDt < 1) continue;
    const g = grades[i];
    if (g > GRADE_CLIMB_PCT)      { climbDist += p.segDist; climbTime += p.segDt; }
    else if (g < GRADE_DESC_PCT)  { descDist  += p.segDist; descTime  += p.segDt; }
    else                          { flatDist  += p.segDist; flatTime  += p.segDt; }
  }

  const elapsedSec = points[loop.startIdx].time && points[loop.endIdx].time
    ? (points[loop.endIdx].time - points[loop.startIdx].time) / 1000
    : 0;

  return {
    idx:        loop.idx,
    startIdx:   loop.startIdx,
    endIdx:     loop.endIdx,
    distMi:     dist * M_TO_MI,
    elapsedSec,
    elapsedH:   elapsedSec / 3600,
    movingSec:  moving,
    movingH:    moving / 3600,
    stoppedSec: stopped,
    stoppedMin: stopped / 60,
    paceAvg:    paceMinPerMile(dist, elapsedSec),
    paceMoving: paceMinPerMile(dist, moving),
    paceClimb:  paceMinPerMile(climbDist, climbTime),
    paceFlat:   paceMinPerMile(flatDist,  flatTime),
    paceDesc:   paceMinPerMile(descDist,  descTime),
    climbMi:    climbDist * M_TO_MI,
    flatMi:     flatDist  * M_TO_MI,
    descMi:     descDist  * M_TO_MI
  };
}

function paceMinPerMile(distM, timeS) {
  if (distM <= 0 || timeS <= 0) return 0;
  return (timeS / 60) / (distM * M_TO_MI);
}

// ─────────── Stop detection + clustering ───────────

function detectStops(points) {
  const stops = [];
  let inStop = false;
  let stopStartIdx = -1;
  let stopDur = 0;

  for (let i = 1; i < points.length; i++) {
    if (points[i].speed < MOVING_THRESHOLD_MPS) {
      if (!inStop) { inStop = true; stopStartIdx = i - 1; stopDur = 0; }
      stopDur += points[i].segDt;
    } else if (inStop) {
      if (stopDur >= STOP_MIN_DURATION_S) pushStop(stops, points, stopStartIdx, i - 1, stopDur);
      inStop = false;
    }
  }
  if (inStop && stopDur >= STOP_MIN_DURATION_S) {
    pushStop(stops, points, stopStartIdx, points.length - 1, stopDur);
  }
  return stops;
}

function pushStop(stops, points, startIdx, endIdx, durationSec) {
  // Use the centroid of the stop segment, not the entry point — better for clustering.
  let sumLat = 0, sumLon = 0, n = 0;
  for (let j = startIdx; j <= endIdx; j++) { sumLat += points[j].lat; sumLon += points[j].lon; n++; }
  stops.push({
    startIdx, endIdx,
    startTime:   points[startIdx].time,
    durationSec,
    durationMin: durationSec / 60,
    lat:         sumLat / n,
    lon:         sumLon / n
  });
}

function clusterStops(stops) {
  // Grid-bucket clustering. 1 deg lat ≈ 111 km; lon scales with cos(lat).
  const latBucketDeg = STOP_GRID_M / 111000;
  const buckets = new Map();

  for (const stop of stops) {
    const lonBucketDeg = latBucketDeg / Math.cos(stop.lat * Math.PI / 180);
    const latKey = Math.round(stop.lat / latBucketDeg);
    const lonKey = Math.round(stop.lon / lonBucketDeg);
    const key = `${latKey},${lonKey}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(stop);
  }

  const clusters = [];
  for (const [key, group] of buckets.entries()) {
    const totalMin   = group.reduce((s, x) => s + x.durationMin, 0);
    const longest    = group.reduce((m, x) => x.durationMin > m.durationMin ? x : m);
    const avgLat     = group.reduce((s, x) => s + x.lat, 0) / group.length;
    const avgLon     = group.reduce((s, x) => s + x.lon, 0) / group.length;
    clusters.push({
      key, lat: avgLat, lon: avgLon,
      visits:     group.length,
      totalMin,
      longestMin: longest.durationMin,
      stops:      group
    });
  }
  clusters.sort((a, b) => b.totalMin - a.totalMin);
  return clusters;
}

// ─────────── Daylight ───────────

function computeDaylight(points, cumDist) {
  const start = points[0];
  if (!start.time) return null;

  const day1     = SunCalc.getTimes(start.time, start.lat, start.lon);
  const nextDay  = new Date(start.time); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const day2     = SunCalc.getTimes(nextDay,    start.lat, start.lon);

  const sunriseMs1   = day1.sunrise.getTime();
  const sunsetMs1    = day1.sunset.getTime();
  const sunriseMs2   = day2.sunrise.getTime();

  const startMs = points[0].time.getTime();
  const endMs   = points[points.length - 1].time.getTime();

  let daylightSec = 0;
  for (let i = 1; i < points.length; i++) {
    const t = points[i].time.getTime();
    const inDay = (t >= sunriseMs1 && t <= sunsetMs1) || (t >= sunriseMs2);
    if (inDay) daylightSec += points[i].segDt;
  }

  // Map a clock time to a cumulative distance (mi) for x-axis overlay
  const timeToDistMi = (clockMs) => {
    if (clockMs < startMs) return 0;
    if (clockMs > endMs)   return cumDist[cumDist.length - 1] * M_TO_MI;
    // Binary search
    let lo = 0, hi = points.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].time.getTime() < clockMs) lo = mid;
      else hi = mid;
    }
    return cumDist[lo] * M_TO_MI;
  };

  return {
    sunrise1:        day1.sunrise,
    sunset1:         day1.sunset,
    civilEnd1:       day1.dusk,
    nauticalEnd1:    day1.nauticalDusk,
    astroEnd1:       day1.night,
    astroBegin2:     day2.nightEnd,
    nauticalBegin2:  day2.nauticalDawn,
    civilBegin2:     day2.dawn,
    sunrise2:        day2.sunrise,
    daylightSec,
    daylightPct:     ((endMs - startMs) > 0) ? 100 * daylightSec / ((endMs - startMs) / 1000) : 0,
    timeToDistMi
  };
}
