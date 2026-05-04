// Inflection-point detector. Each rule emits scored candidates; variety
// scoring caps to 4 per loop with type-aware diversity rules.

import { M_TO_MI } from './gpx.js';

const MI_TO_M = 1609.34;

// Tunables for pace_drop detection.
const PACE_DROP_WINDOW_M    = 0.25 * MI_TO_M;  // forward window (~0.25 mi)
const PACE_DROP_BASELINE_M  = 0.5  * MI_TO_M;  // prior baseline (~0.5 mi)
const PACE_DROP_THRESHOLD   = 0.25;            // 25% slower than baseline
const PACE_DROP_STEP        = 25;              // step (in points) between candidates
const PACE_DROP_MIN_SPEED   = 0.5;             // skip if either window is at walking-stop speed
const PACE_DROP_MAX_GRADE   = 6;               // skip if either window is on a steep climb/descent

export function detectInflections(points, loops, stops, daylight, cumDist, grades) {
  const candidates = [];

  // 1. Long stops (≥ 60 s)
  for (const stop of stops) {
    if (stop.durationSec < 60) continue;
    candidates.push({
      type:   'long_stop',
      idx:    stop.startIdx,
      score:  stop.durationMin,
      label:  `Stop · ${stop.durationMin.toFixed(0)} min`,
      meta:   { stop }
    });
  }

  // 2. Loop transitions
  for (const loop of loops) {
    if (loop.idx === 0) continue;
    candidates.push({
      type:  'loop_transition',
      idx:   loop.startIdx,
      score: 100,
      label: `End of Loop ${loop.idx}`
    });
  }

  // 3. Light transitions
  if (daylight && points[0] && points[0].time) {
    const events = [
      { t: daylight.sunrise1,    label: 'Sunrise',            score: 60 },
      { t: daylight.sunset1,     label: 'Sunset',             score: 70 },
      { t: daylight.civilEnd1,   label: 'Civil twilight ends', score: 40 },
      { t: daylight.civilBegin2, label: 'Dawn',               score: 40 },
      { t: daylight.sunrise2,    label: 'Sunrise (next day)', score: 60 }
    ];
    const startMs = points[0].time.getTime();
    const endMs   = points[points.length - 1].time.getTime();
    for (const ev of events) {
      const tMs = ev.t.getTime();
      if (tMs < startMs || tMs > endMs) continue;
      candidates.push({
        type:  'light_transition',
        idx:   nearestIdxByTime(points, tMs),
        score: ev.score,
        label: ev.label
      });
    }
  }

  // 4. Sustained climbs (> 8% for ≥ 100 m)
  let climbStart = -1, climbDist = 0, climbGradeSum = 0;
  for (let i = 1; i < points.length; i++) {
    if (grades[i] > 8) {
      if (climbStart < 0) { climbStart = i; climbDist = 0; climbGradeSum = 0; }
      climbDist += points[i].segDist;
      climbGradeSum += grades[i];
    } else {
      if (climbStart >= 0 && climbDist >= 100) {
        const meanGrade = climbGradeSum / (i - climbStart);
        candidates.push({
          type:  'grade_event',
          idx:   climbStart,
          score: meanGrade * climbDist / 50,
          label: `Climb · ${meanGrade.toFixed(0)}% × ${climbDist.toFixed(0)} m`
        });
      }
      climbStart = -1; climbDist = 0; climbGradeSum = 0;
    }
  }

  // 5. Pace drops (>25% slower than prior baseline within the same loop)
  candidates.push(...detectPaceDrops(points, loops, grades));

  // Variety-aware cap: 4 per detected loop with type diversity rules.
  const capped = capPerLoop(candidates, loops);
  for (const c of capped) c.distMi = cumDist[c.idx] * M_TO_MI;
  capped.sort((a, b) => a.idx - b.idx);
  return capped;
}

// ─────────── Pace-drop detection ───────────

function detectPaceDrops(points, loops, grades) {
  const out = [];

  for (const loop of loops) {
    const startIdx = loop.startIdx;
    const endIdx = loop.endIdx;

    // Need enough points for both baseline + window; sample sparsely.
    let i = startIdx + 50;
    while (i < endIdx - 50) {
      // Forward window: collect ~0.25 mi forward from i
      let fDist = 0, fDt = 0, fGradeAbsSum = 0, fGradeN = 0;
      let j = i + 1;
      while (j <= endIdx && fDist < PACE_DROP_WINDOW_M) {
        fDist += points[j].segDist;
        fDt   += points[j].segDt;
        fGradeAbsSum += Math.abs(grades[j]);
        fGradeN++;
        j++;
      }
      if (fDist < PACE_DROP_WINDOW_M * 0.6 || fDt < 30) { i += PACE_DROP_STEP; continue; }
      const fwdSpeed = fDist / fDt;
      const fwdGrade = fGradeN > 0 ? fGradeAbsSum / fGradeN : 0;

      // Baseline window: collect ~0.5 mi backward from i
      let bDist = 0, bDt = 0, bGradeAbsSum = 0, bGradeN = 0;
      let k = i;
      while (k > startIdx && bDist < PACE_DROP_BASELINE_M) {
        bDist += points[k].segDist;
        bDt   += points[k].segDt;
        bGradeAbsSum += Math.abs(grades[k]);
        bGradeN++;
        k--;
      }
      if (bDist < PACE_DROP_BASELINE_M * 0.6 || bDt < 60) { i += PACE_DROP_STEP; continue; }
      const baseSpeed = bDist / bDt;
      const baseGrade = bGradeN > 0 ? bGradeAbsSum / bGradeN : 0;

      // Skip if either window is on a stop (walking-pace floor)
      if (fwdSpeed < PACE_DROP_MIN_SPEED || baseSpeed < PACE_DROP_MIN_SPEED) {
        i += PACE_DROP_STEP; continue;
      }
      // Skip if either window is dominated by steep grade (climbs are expected to be slower)
      if (fwdGrade > PACE_DROP_MAX_GRADE || baseGrade > PACE_DROP_MAX_GRADE) {
        i += PACE_DROP_STEP; continue;
      }

      const drop = (baseSpeed - fwdSpeed) / baseSpeed;
      if (drop > PACE_DROP_THRESHOLD) {
        const fwdPaceMpm = (fDt / 60) / (fDist * M_TO_MI);
        const basePaceMpm = (bDt / 60) / (bDist * M_TO_MI);
        out.push({
          type:  'pace_drop',
          idx:   i,
          score: drop * 100,
          label: `Pace drop · ${basePaceMpm.toFixed(1)} → ${fwdPaceMpm.toFixed(1)} min/mi`,
          meta:  { dropPct: drop * 100, fwdPaceMpm, basePaceMpm }
        });
      }

      i += PACE_DROP_STEP;
    }
  }

  // Coalesce nearby drops to avoid stuttering on sustained slow sections.
  out.sort((a, b) => a.idx - b.idx);
  const coalesced = [];
  for (const c of out) {
    const last = coalesced[coalesced.length - 1];
    if (last && c.idx - last.idx < 100) {
      // Same event — keep the stronger score.
      if (c.score > last.score) coalesced[coalesced.length - 1] = c;
    } else {
      coalesced.push(c);
    }
  }
  return coalesced;
}

// ─────────── Variety-aware cap ───────────

function capPerLoop(candidates, loops) {
  if (loops.length === 0) return candidates;
  const CAP = 4;

  const byLoop = loops.map(() => []);
  for (const c of candidates) {
    const loopIdx = loops.findIndex(l => c.idx >= l.startIdx && c.idx <= l.endIdx);
    if (loopIdx >= 0) byLoop[loopIdx].push(c);
  }

  const out = [];
  for (const arr of byLoop) {
    arr.sort((a, b) => b.score - a.score);
    const picked = [];
    const counts = { long_stop: 0, loop_transition: 0, light_transition: 0, grade_event: 0, pace_drop: 0 };

    // Pass A: force-include up to 1 light_transition and 1 pace_drop if available.
    // These are the highest-narrative-value types and would otherwise lose to
    // raw long_stop scores in late loops where stops dominate.
    for (const type of ['light_transition', 'pace_drop']) {
      const candidate = arr.find(c => c.type === type);
      if (candidate && picked.length < CAP) {
        picked.push(candidate);
        counts[type]++;
      }
    }

    // Pass B: fill remaining slots by score, with type-specific caps so no
    // single type monopolizes a loop. Score scales differ across types
    // (grade_event ~50–100 vs long_stop ~5–30), so without these caps the
    // late-race story-rich long_stops can lose to noisier grade_events.
    const TYPE_CAPS = { long_stop: 2, grade_event: 1, loop_transition: 1 };
    for (const c of arr) {
      if (picked.length >= CAP) break;
      if (picked.includes(c)) continue;
      const cap = TYPE_CAPS[c.type];
      if (cap !== undefined && counts[c.type] >= cap) continue;
      picked.push(c);
      counts[c.type]++;
    }

    out.push(...picked);
  }
  return out;
}

function nearestIdxByTime(points, tMs) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (!points[mid].time) return mid;
    if (points[mid].time.getTime() < tMs) lo = mid;
    else hi = mid;
  }
  return lo;
}
