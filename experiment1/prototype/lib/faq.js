// Race FAQ — rollup attribution questions.
//
// Each question is a function from (metrics, points, params) to an
// answer object. Answers carry an explicit assumption and confound
// alongside the headline so the user can interpret what they're
// looking at, not just stare at a number.

import { M_TO_MI, M_TO_FT } from './gpx.js';

const MOVING_THRESHOLD_MPS = 0.4;
const KCAL_PER_J = 1 / 4184;
const G = 9.81;

// ─────────── Tiny formatters (kept local so faq.js is self-contained) ───────────
function fmtHM(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m} min`;
}
function fmtPace(minPerMile) {
  if (!minPerMile || !isFinite(minPerMile) || minPerMile <= 0) return '—';
  let m = Math.floor(minPerMile);
  let s = Math.round((minPerMile - m) * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

// ─────────── Shared helpers ───────────

// Race-average flat moving pace (m/s) — moving segments on grade ±3%.
// This is the "what would I have done on flat ground" baseline used by
// several questions. It's already fade-degraded (averaged across all
// loops), so it tends to UNDER-estimate true climb/dark/stop costs.
function flatMovingSpeedMps(points, grades) {
  let dist = 0, time = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.speed < MOVING_THRESHOLD_MPS) continue;
    if (Math.abs(grades[i]) > 3) continue;
    dist += p.segDist;
    time += p.segDt;
  }
  return time > 0 ? dist / time : 0;
}

// Pace per mile (min/mi) from a speed in m/s.
const speedToPace = (mps) => mps > 0 ? 26.8224 / mps : 0;

// ─────────── Question registry ───────────

export const QUESTIONS = [
  // ============================================================
  {
    id: 'steepest-cost',
    category: 'Costs',
    label: 'What did the steepest sections cost me?',
    blurb: 'Identify the top N % of your uphill distance by grade. Compare time spent on those steeps to what those same miles would have taken at your race-average flat pace.',
    params: [
      { name: 'percentile', label: 'Top N% steepest', type: 'number', default: 10, min: 5, max: 30, step: 1, suffix: '%' }
    ],
    answer: (m, points, params) => {
      const N = Math.max(1, Math.min(50, params.percentile || 10));
      const grades = m.grades;

      // Collect uphill segments with grade > 0
      const climbSegs = [];
      let totalClimbDist = 0;
      for (let i = 1; i < points.length; i++) {
        if (grades[i] > 0 && points[i].segDist > 0.5) {
          climbSegs.push({ idx: i, grade: grades[i], dist: points[i].segDist, dt: points[i].segDt });
          totalClimbDist += points[i].segDist;
        }
      }
      // Sort by grade desc; accumulate top-N% of CLIMB distance
      climbSegs.sort((a, b) => b.grade - a.grade);
      const targetDist = totalClimbDist * (N / 100);
      let topDist = 0, topTime = 0, gradeSum = 0, segCount = 0;
      let thresholdGrade = climbSegs[0]?.grade || 0;
      for (const s of climbSegs) {
        if (topDist >= targetDist) break;
        topDist += s.dist; topTime += s.dt; gradeSum += s.grade; segCount++;
        thresholdGrade = s.grade;
      }
      const flatSpeed = flatMovingSpeedMps(points, grades);
      const counterfactualTime = flatSpeed > 0 ? topDist / flatSpeed : 0;
      const cost = topTime - counterfactualTime;
      const meanGrade = segCount > 0 ? gradeSum / segCount : 0;

      return {
        headline: `The steepest ${N}% of your uphill distance — ${(topDist * M_TO_MI).toFixed(2)} mi — took ${fmtHM(topTime)}. ` +
                  `At your flat pace, those miles would have been ${fmtHM(counterfactualTime)}. ` +
                  `**Climbs cost ~${fmtHM(Math.max(0, cost))}** of moving time.`,
        detail: [
          `Total uphill distance in your race: ${(totalClimbDist * M_TO_MI).toFixed(1)} mi`,
          `Top-${N}% grade threshold: ≥ ${thresholdGrade.toFixed(1)}%`,
          `Average grade in the top-${N}%: ${meanGrade.toFixed(1)}%`,
          `Race-average flat pace: ${fmtPace(speedToPace(flatSpeed))}`
        ],
        assumption: `"Race-average flat pace" is the moving pace across all segments with grade between −3 % and +3 % AND speed ≥ ${MOVING_THRESHOLD_MPS} m/s (excludes stops).`,
        confound: 'Your flat pace is itself fade-degraded — averaged across all three loops including the slow ones. The cost figure is therefore a LOWER BOUND for what the climbs cost; on fresh legs they would have been faster than your flat-pace baseline.'
      };
    }
  },

  // ============================================================
  {
    id: 'stops-cost',
    category: 'Costs',
    label: 'What did stops cost me?',
    blurb: 'Sum dwell time for stops above a duration threshold. Add a small re-acceleration penalty for each restart.',
    params: [
      { name: 'minSec', label: 'Minimum stop length', type: 'number', default: 60, min: 10, max: 600, step: 10, suffix: ' seconds' }
    ],
    answer: (m, points, params) => {
      const minSec = Math.max(0, params.minSec || 60);
      const RESTART_PENALTY_S = 15;  // estimated re-acceleration drag per stop
      const stops = m.stops.filter(s => s.durationSec >= minSec);
      const totalDwell = stops.reduce((s, x) => s + x.durationSec, 0);
      const restartCost = stops.length * RESTART_PENALTY_S;
      const total = totalDwell + restartCost;
      const elapsed = m.totals.elapsedSec;
      const pct = elapsed > 0 ? 100 * total / elapsed : 0;

      return {
        headline: `${stops.length} stops longer than ${minSec} s totalled **${fmtHM(totalDwell)}** of dwell time. ` +
                  `Add ~${fmtHM(restartCost)} of estimated re-acceleration drag (15 s per restart). ` +
                  `**Total stop cost: ${fmtHM(total)}** — about ${pct.toFixed(1)}% of your race.`,
        detail: [
          `Total elapsed: ${fmtHM(elapsed)}`,
          `Total moving: ${fmtHM(m.totals.movingSec)}`,
          `Total stopped (any duration): ${fmtHM(m.totals.stoppedSec)}`,
          `Longest single stop: ${stops.length > 0 ? fmtHM(Math.max(...stops.map(s => s.durationSec))) : 'n/a'}`
        ],
        assumption: `A "stop" is a contiguous run of GPS segments below ${MOVING_THRESHOLD_MPS} m/s (about 1.5 km/h, slower than walking). Re-acceleration drag is a flat 15 s per restart — this is a calibration estimate, not measured.`,
        confound: 'Some stop time is unavoidable (aid stations, bathroom, headlamp swap, GI events). This is "what the clock saw," not "what was optional." Subtract whatever portion of those stops you consider non-negotiable.'
      };
    }
  },

  // ============================================================
  {
    id: 'darkness-cost',
    category: 'Costs',
    label: 'What did running in the dark cost me?',
    blurb: 'Compare moving pace before sunset to moving pace after sunset. Apply the daylight pace to your nighttime distance to get a counterfactual.',
    params: [],
    answer: (m, points, params) => {
      const dl = m.daylight;
      if (!dl || !points[0].time) {
        return {
          headline: 'Cannot compute — this race has no timestamps or no daylight data.',
          detail: [], assumption: '', confound: ''
        };
      }
      const sunsetMs = dl.sunset1.getTime();
      const sunriseMs2 = dl.sunrise2 ? dl.sunrise2.getTime() : Infinity;

      let preDist = 0, preTime = 0, nightDist = 0, nightTime = 0;
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (!p.time || p.speed < MOVING_THRESHOLD_MPS) continue;
        const t = p.time.getTime();
        const isDay = t < sunsetMs || t >= sunriseMs2;
        if (isDay) { preDist += p.segDist; preTime += p.segDt; }
        else       { nightDist += p.segDist; nightTime += p.segDt; }
      }
      const dayPace = speedToPace(preDist / preTime);
      const nightPace = speedToPace(nightDist / nightTime);
      const counterfactualNightSec = preTime > 0 ? nightDist * (preTime / preDist) : 0;
      const cost = nightTime - counterfactualNightSec;

      return {
        headline: `${(nightDist * M_TO_MI).toFixed(1)} mi after sunset, in ${fmtHM(nightTime)} of moving time. ` +
                  `Daylight moving pace ${fmtPace(dayPace)}; night moving pace ${fmtPace(nightPace)}. ` +
                  `**Holding daylight pace through the dark would have saved ~${fmtHM(Math.max(0, cost))}.**`,
        detail: [
          `Sunset: ${dl.sunset1.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          `Sunrise (next day): ${dl.sunrise2 ? dl.sunrise2.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}`,
          `Daylight moving distance: ${(preDist * M_TO_MI).toFixed(1)} mi`,
          `Daylight share of race: ${dl.daylightPct.toFixed(0)}%`
        ],
        assumption: 'Both averages are MOVING pace only (segments with speed ≥ 0.4 m/s). Stops are excluded from both buckets so they do not double-count with the "stops cost" question.',
        confound: '⚠ This is the most overlap-prone of the cost questions. Most of your fade happened in the third loop, which also happened to be at night. Darkness and depletion are confounded — the runner cannot say from this number alone how much of the slowdown was darkness specifically vs. just being 14 hours into a race. The number is best read as "darkness + late-race fatigue together cost about this much," not "darkness alone."'
      };
    }
  },

  // ============================================================
  {
    id: 'fade-cost',
    category: 'Costs',
    label: 'What did the late-race fade cost me?',
    blurb: 'Compute Loop 1 moving pace, then ask what your final loop would have taken at that pace. Difference = fade cost on the final loop.',
    params: [],
    answer: (m, points, params) => {
      if (!m.isLooped || m.loopMetrics.length < 2) {
        return {
          headline: 'Cannot compute — needs at least two loops on the same course.',
          detail: [], assumption: '', confound: ''
        };
      }
      const lm = m.loopMetrics;
      const l1 = lm[0];
      const lN = lm[lm.length - 1];
      const l1MovingPace = l1.paceMoving;       // min/mi
      const counterfactualMovingMin = lN.distMi * l1MovingPace;
      const actualMovingMin = lN.movingSec / 60;
      const cost = actualMovingMin - counterfactualMovingMin;

      return {
        headline: `Loop 1 moving pace: ${fmtPace(l1MovingPace)}. ` +
                  `Holding that pace through Loop ${lN.idx + 1} (${lN.distMi.toFixed(1)} mi): ${fmtHM(counterfactualMovingMin * 60)}. ` +
                  `Actual Loop ${lN.idx + 1} moving time: ${fmtHM(lN.movingSec)}. ` +
                  `**Fade cost on the final loop: ~${fmtHM(Math.max(0, cost) * 60)}** of running.`,
        detail: lm.map(l =>
          `Loop ${l.idx + 1}: ${l.distMi.toFixed(2)} mi · moving pace ${fmtPace(l.paceMoving)} · stopped ${fmtHM(l.stoppedSec)}`
        ),
        assumption: 'Compares Loop 1 moving pace (min/mi over the whole loop, excluding stops) to the final loop. Stops are excluded so this number is fade in the RUNNING, not fade in time-on-course.',
        confound: 'Some of this "fade" is darkness (overlaps with the previous question), some is metabolic, some is stopping more often. See the decomposition question for an attempt to split the gap.'
      };
    }
  },

  // ============================================================
  {
    id: 'fade-decomposition',
    category: 'Costs',
    label: 'How was my finish time spent — climbs vs stops vs dark vs everything else?',
    blurb: 'Speculative four-way attribution. Compare your actual finish to an "ideal race" baseline (Loop 1 flat-pace held throughout, no stops, daylight conditions). Allocate the gap across categories using the per-cause estimates from the other questions.',
    params: [],
    answer: (m, points, params) => {
      if (!m.isLooped || m.loopMetrics.length < 2) {
        return {
          headline: 'Cannot compute — needs at least two loops.',
          detail: [], assumption: '', confound: ''
        };
      }
      const lm = m.loopMetrics;
      const l1 = lm[0];
      // Ideal: distance × L1 flat pace + 0 stops + ideal conditions
      const grades = m.grades;
      // L1 flat-only moving pace as the floor
      let l1FlatDist = 0, l1FlatTime = 0;
      for (let i = l1.startIdx + 1; i <= l1.endIdx; i++) {
        const p = points[i];
        if (p.speed < MOVING_THRESHOLD_MPS) continue;
        if (Math.abs(grades[i]) > 3) continue;
        l1FlatDist += p.segDist;
        l1FlatTime += p.segDt;
      }
      const l1FlatSpeed = l1FlatDist > 0 ? l1FlatDist / l1FlatTime : flatMovingSpeedMps(points, grades);
      const idealMovingSec = m.totals.distM / l1FlatSpeed;
      const actualSec = m.totals.elapsedSec;
      const gap = actualSec - idealMovingSec;

      // Single-cause estimates (re-using logic from other questions)
      const stopsCostSec = m.totals.stoppedSec + m.stops.length * 15;

      // Climbs cost: top-10% steeps
      const cAns = QUESTIONS.find(q => q.id === 'steepest-cost').answer(m, points, { percentile: 10 });
      const climbsCostSec = parseClimbsCostSec(cAns);

      // Darkness/fade combined as the residual
      const otherSec = Math.max(0, gap - stopsCostSec - climbsCostSec);

      return {
        headline: `Ideal race (Loop 1 flat pace held throughout, zero stops, no fade): ${fmtHM(idealMovingSec)}. ` +
                  `Actual: ${fmtHM(actualSec)}. ` +
                  `**Total gap: ${fmtHM(gap)}.** ` +
                  `Estimated split: stops ${fmtHM(stopsCostSec)} · steeps ${fmtHM(climbsCostSec)} · darkness/fade/other ${fmtHM(otherSec)}.`,
        detail: [
          `Race distance: ${m.totals.distMi.toFixed(2)} mi`,
          `Loop 1 flat moving pace: ${fmtPace(speedToPace(l1FlatSpeed))}`,
          `Stops cost (${m.stops.length} stops × dwell + 15 s restart): ${fmtHM(stopsCostSec)}`,
          `Steeps cost (top-10% by grade): ${fmtHM(climbsCostSec)}`,
          `Darkness + late-race fade (residual): ${fmtHM(otherSec)}`
        ],
        assumption: '"Ideal race" sets a floor: full distance covered at the FRESHEST flat pace you ever sustained (Loop 1 flat-only moving pace), with no stops, no climbs, no fade. Categories are then deducted from the gap one by one.',
        confound: '⚠ This is a SPECULATIVE decomposition. Categories overlap heavily — darkness and fade are the same time period; some climbing time is also fade. The percentages should be read as "where the time roughly went," not as "if I removed X I would save exactly Y." The residual bucket absorbs everything that does not fit the other two categories.'
      };
    }
  },

  // Helper: pull the cost number out of the steeps headline (string parse).
  // Centralized so the decomposition stays in sync if the headline format changes.

  // ============================================================
  {
    id: 'expensive-miles',
    category: 'Costs',
    label: 'Which N miles cost me the most relative to my own baseline?',
    blurb: 'Split the route into 1-mile windows. For each, compute "extra time over my own race-average flat pace." Surface the N most expensive.',
    params: [
      { name: 'count', label: 'How many miles to show', type: 'number', default: 5, min: 3, max: 15, step: 1 }
    ],
    answer: (m, points, params) => {
      const N = Math.max(1, Math.min(20, params.count || 5));
      const flatSpeed = flatMovingSpeedMps(points, m.grades);
      const baselinePerMileSec = flatSpeed > 0 ? 1609.34 / flatSpeed : 0;

      // Bucket points into 1-mile windows by cumulative distance
      const buckets = [];
      let bucketStart = 0;
      let bucketDist = 0;
      let bucketTime = 0;
      let bucketIdx = 0;
      for (let i = 1; i < points.length; i++) {
        bucketDist += points[i].segDist;
        bucketTime += points[i].segDt;
        if (bucketDist >= 1609.34 || i === points.length - 1) {
          buckets.push({
            idx: bucketIdx++,
            startIdx: bucketStart,
            endIdx: i,
            distMi: bucketDist * M_TO_MI,
            timeSec: bucketTime,
            cumStartMi: m.cumDist[bucketStart] * M_TO_MI,
            extraSec: bucketTime - baselinePerMileSec * (bucketDist * M_TO_MI)
          });
          bucketStart = i;
          bucketDist = 0;
          bucketTime = 0;
        }
      }
      buckets.sort((a, b) => b.extraSec - a.extraSec);
      const top = buckets.slice(0, N);
      const detail = top.map((b, i) => {
        const t = points[b.startIdx].time;
        const tStr = t ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
        return `${i + 1}. Mile ${b.cumStartMi.toFixed(1)} (${tStr}) — ${fmtHM(b.timeSec)} (vs ~${fmtHM(baselinePerMileSec * b.distMi)} baseline) → +${fmtHM(b.extraSec)}`;
      });

      return {
        headline: `Top ${N} most expensive miles, ranked by extra time over your race-average flat pace (${fmtPace(speedToPace(flatSpeed))}):`,
        detail,
        assumption: 'Each bucket is ~1 mile of cumulative distance. "Extra time" is bucket-time minus (1 mile × race-average flat pace). The flat pace baseline is the same one used by the steeps and decomposition questions.',
        confound: 'A mile that contains a long stop will rank high here for that reason alone — this list does not separate "slow running" from "stopped." Cross-reference the Stop Classification panel for context.'
      };
    }
  },

  // ============================================================
  {
    id: 'pace-distribution',
    category: 'Composition',
    label: 'How was my race time spent — running vs hiking vs walking vs stopped?',
    blurb: 'Bucket every segment by its instantaneous speed into running / jogging / hiking / walking / stopped, then sum elapsed time.',
    params: [],
    answer: (m, points, params) => {
      const buckets = { running: 0, jogging: 0, hiking: 0, walking: 0, stopped: 0 };
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (p.speed < MOVING_THRESHOLD_MPS) { buckets.stopped += p.segDt; continue; }
        const pace = speedToPace(p.speed);
        if (pace < 12)        buckets.running += p.segDt;
        else if (pace < 15)   buckets.jogging += p.segDt;
        else if (pace < 22)   buckets.hiking  += p.segDt;
        else                  buckets.walking += p.segDt;
      }
      const total = Object.values(buckets).reduce((s, x) => s + x, 0);
      const lines = [
        ['Running (<12:00/mi)',    buckets.running],
        ['Jogging (12-15:00/mi)',  buckets.jogging],
        ['Hiking (15-22:00/mi)',   buckets.hiking],
        ['Walking (22+:00/mi)',    buckets.walking],
        ['Stopped (<0.4 m/s)',     buckets.stopped]
      ];
      const dominant = lines.slice().sort((a, b) => b[1] - a[1])[0];
      const dominantLabel = dominant[0].split(' ')[0].toLowerCase();
      const dominantPct = total > 0 ? 100 * dominant[1] / total : 0;

      return {
        headline: `Your race was mostly **${dominantLabel}** (${dominantPct.toFixed(0)}% of elapsed time), not running. ` +
                  `Total time: ${fmtHM(total)}.`,
        detail: lines.map(([lbl, sec]) => {
          const pct = total > 0 ? (100 * sec / total).toFixed(1) : '0.0';
          return `${lbl}: ${fmtHM(sec)} (${pct}%)`;
        }),
        assumption: 'Buckets are by instantaneous segment speed converted to pace (min/mi). Each segment is in exactly one bucket; no interpolation. Stopped is anything below 0.4 m/s.',
        confound: 'A flat pace of 16 min/mi could be a steady hike or a slow jog with brief walk breaks averaging out — this view does not distinguish. Also, GPS noise can briefly inflate or depress speed; the bucket cliffs at 12 / 15 / 22 min/mi are arbitrary boundaries.'
      };
    }
  },

  // ============================================================
  {
    id: 'work-calories',
    category: 'Effort',
    label: 'What was the work on the climbs, in calories?',
    blurb: 'Compute gravitational potential energy from total ascent. Add horizontal cost-of-transport using Minetti-style flat-running coefficients. Convert to kilocalories.',
    params: [
      { name: 'kg', label: 'Body weight', type: 'number', default: 75, min: 40, max: 130, step: 1, suffix: ' kg' }
    ],
    answer: (m, points, params) => {
      const mass = Math.max(30, params.kg || 75);
      const gainM = m.elevation.gainSmoothM;
      const distM = m.totals.distM;
      // Gravitational work: m × g × h (joules); convert to kcal
      const verticalJ  = mass * G * gainM;
      const verticalKcal = verticalJ * KCAL_PER_J;
      // Horizontal cost-of-transport (Minetti, flat ground running): ~3.8 J/kg/m
      // Walking is lower (~3.3); we use a blended estimate.
      const horizCotJperKgPerM_lo = 3.0;  // mostly walking / hiking
      const horizCotJperKgPerM_hi = 4.2;  // mixed running
      const horizKcalLo = mass * distM * horizCotJperKgPerM_lo * KCAL_PER_J;
      const horizKcalHi = mass * distM * horizCotJperKgPerM_hi * KCAL_PER_J;
      const totalLo = verticalKcal + horizKcalLo;
      const totalHi = verticalKcal + horizKcalHi;

      return {
        headline: `${m.elevation.gainSmoothFt.toFixed(0)} ft of vertical at ${mass} kg = **${verticalKcal.toFixed(0)} kcal of pure-vertical work**. ` +
                  `Adding horizontal cost-of-transport, total estimated metabolic cost: **${totalLo.toFixed(0)}–${totalHi.toFixed(0)} kcal**.`,
        detail: [
          `Total ascent (smoothed): ${m.elevation.gainSmoothFt.toFixed(0)} ft (${gainM.toFixed(0)} m)`,
          `Total distance: ${m.totals.distMi.toFixed(2)} mi`,
          `Body weight assumed: ${mass} kg`,
          `Vertical-only work: ${verticalKcal.toFixed(0)} kcal`,
          `Horizontal CoT range used: 3.0–4.2 J/kg/m (Minetti-style; spans walking to mixed running)`
        ],
        assumption: 'Uses standard physics for vertical work (m × g × h) and Minetti\'s laboratory cost-of-transport coefficients for horizontal effort. The result is gross mechanical work, not what your body actually burned — those are related but not equal.',
        confound: 'No HR or VO2 data, so this is a coarse model. Real expenditure is typically ±25 % from this number depending on running economy, fueling state, terrain technicality, and how much you spent on stabilizing on uneven trail (which Minetti\'s flat-track coefficients ignore). Treat as ballpark, not as calorie ledger.'
      };
    }
  }
];

// ─────────── Helpers used by the registry ───────────

// Pull the climbs cost (in seconds) out of the steeps answer's headline.
// Centralized so the decomposition stays in sync if the format changes.
function parseClimbsCostSec(steepsAns) {
  // Match "Climbs cost ~XhYYm" or "~XX min" in the headline.
  const m1 = /Climbs cost ~(\d+)h\s*(\d+)m/i.exec(steepsAns.headline);
  if (m1) return parseInt(m1[1], 10) * 3600 + parseInt(m1[2], 10) * 60;
  const m2 = /Climbs cost ~(\d+)\s*min/i.exec(steepsAns.headline);
  if (m2) return parseInt(m2[1], 10) * 60;
  return 0;
}

// Group questions by category for UI list.
export function groupedQuestions() {
  const groups = {};
  for (const q of QUESTIONS) {
    if (!groups[q.category]) groups[q.category] = [];
    groups[q.category].push(q);
  }
  return groups;
}

export function getQuestion(id) {
  return QUESTIONS.find(q => q.id === id);
}
