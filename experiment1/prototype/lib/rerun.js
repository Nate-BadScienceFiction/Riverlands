// Re-Run subgame: counterfactual arithmetic + banded pool cost model.
// Pure functions; no DOM access. UI binds these in app.js.

const STOP_BANDS = [
  { upTo: 15, stomach: 0.04, morale: 0.025 },
  { upTo: 30, stomach: 0.09, morale: 0.05  },
  { upTo: 45, stomach: 0.13, morale: 0.08  },
  { upTo: 60, stomach: 0.17, morale: 0.11  },
  { upTo: Infinity, stomach: 0.22, morale: 0.16 }
];

const EFFORT_BANDS = [
  { upTo: 5,  legs: 0.10, fuel: 0.15 },
  { upTo: 10, legs: 0.30, fuel: 0.40 },
  { upTo: 15, legs: 0.60, fuel: 0.70 },
  { upTo: 20, legs: 1.00, fuel: 1.00 }
];

const POOL_START = 10;

/**
 * Compute the counterfactual race state given per-loop sliders.
 *
 * @param {Array} loopMetrics  One entry per loop (output of metrics.loopMetrics)
 * @param {Array} sliders      [{ stopMin, effort }, ...]
 * @returns {Object}           { newFinishSec, newStopSec, pools, dnf, warnings, perLoop }
 */
export function computeCounterfactual(loopMetrics, sliders) {
  const pools = { legs: POOL_START, fuel: POOL_START, stomach: POOL_START, morale: POOL_START };
  const warnings = [];
  let newMovingSec = 0;
  let newStopSec   = 0;
  const perLoop    = [];

  for (let i = 0; i < loopMetrics.length; i++) {
    const lm = loopMetrics[i];
    const s  = sliders[i] || { stopMin: lm.stoppedMin, effort: 1.0 };
    const stopMin = clamp(s.stopMin, 0, lm.stoppedMin * 1.5);
    const effort  = clamp(s.effort,  0.85, 1.20);

    const loopMovingSec = lm.movingSec / effort;
    const loopStopSec   = stopMin * 60;

    newMovingSec += loopMovingSec;
    newStopSec   += loopStopSec;

    // Stop savings cost
    const minutesSaved = Math.max(0, lm.stoppedMin - stopMin);
    const { stomach, morale } = applyStopBands(minutesSaved);
    pools.stomach -= stomach;
    pools.morale  -= morale;

    // Effort cost
    const deltaPct = Math.max(0, (effort - 1.0) * 100);
    const { legs, fuel } = applyEffortBands(deltaPct);
    pools.legs -= legs;
    pools.fuel -= fuel;

    perLoop.push({
      idx: i,
      stopMin, effort,
      movingSec: loopMovingSec,
      stopSec:   loopStopSec,
      cost: { stomach, morale, legs, fuel }
    });
  }

  // Realism guardrails (text only; non-blocking)
  const totalActualStops = loopMetrics.reduce((s, l) => s + l.stoppedMin, 0);
  const totalProposedStops = perLoop.reduce((s, l) => s + l.stopMin, 0);
  if (totalActualStops >= 90 && totalProposedStops <= 15) {
    warnings.push('You\'re proposing the runner skipped real fuel. The soup wizard says: maybe.');
  }
  if (perLoop[2] && perLoop[2].effort >= 1.15) {
    warnings.push('In 25 h of darkness and depletion, this is the version of yourself that did not exist that night.');
  }
  if (perLoop[0] && perLoop[2] && perLoop[0].effort >= 1.15 && perLoop[2].effort >= 1.10) {
    warnings.push('Going out hot and finishing hot is a story your race did not tell.');
  }

  // Round pools for display, but DNF detection uses raw values
  const dnf = pools.legs <= 0 || pools.fuel <= 0 || pools.stomach <= 0 || pools.morale <= 0;
  const poolWarnings = {};
  if (pools.stomach > 0 && pools.stomach <= 2) poolWarnings.stomach = 'GI risk';
  if (pools.legs    > 0 && pools.legs    <= 2) poolWarnings.legs    = 'Quad blowout';
  if (pools.fuel    > 0 && pools.fuel    <= 2) poolWarnings.fuel    = 'Bonk warning';
  if (pools.morale  > 0 && pools.morale  <= 2) poolWarnings.morale  = 'The Chair is calling';

  return {
    newFinishSec: newMovingSec + newStopSec,
    newMovingSec,
    newStopSec,
    pools,
    poolDisplay: {
      legs:    Math.round(Math.max(0, pools.legs)    * 10) / 10,
      fuel:    Math.round(Math.max(0, pools.fuel)    * 10) / 10,
      stomach: Math.round(Math.max(0, pools.stomach) * 10) / 10,
      morale:  Math.round(Math.max(0, pools.morale)  * 10) / 10
    },
    dnf,
    poolWarnings,
    warnings,
    perLoop
  };
}

function applyStopBands(minutesSaved) {
  let stomach = 0, morale = 0;
  let prevUpTo = 0;
  for (const band of STOP_BANDS) {
    const minInBand = Math.max(0, Math.min(minutesSaved, band.upTo) - prevUpTo);
    stomach += minInBand * band.stomach;
    morale  += minInBand * band.morale;
    prevUpTo = band.upTo;
    if (minutesSaved <= band.upTo) break;
  }
  return { stomach, morale };
}

function applyEffortBands(deltaPct) {
  let legs = 0, fuel = 0;
  let prevUpTo = 0;
  for (const band of EFFORT_BANDS) {
    const inBand = Math.max(0, Math.min(deltaPct, band.upTo) - prevUpTo);
    legs += inBand * band.legs;
    fuel += inBand * band.fuel;
    prevUpTo = band.upTo;
    if (deltaPct <= band.upTo) break;
  }
  return { legs, fuel };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Export for tests / debugging
export const _bands = { STOP_BANDS, EFFORT_BANDS, POOL_START };
