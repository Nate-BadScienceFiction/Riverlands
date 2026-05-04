// Postcard data: typed memory tokens and per-type prompts.
// The Postcard's narrative shape lives here; rendering lives in app.js.

export const TOKEN_CATEGORIES = {
  Body:   ['legs', 'stomach', 'feet', 'cold', 'heat', 'sleep'],
  Mind:   ['fear', 'boredom', 'confidence', 'confusion', 'bargaining', 'flow'],
  Trail:  ['roots', 'mud', 'climb', 'dark', 'turn', 'aid', 'view'],
  People: ['crew', 'volunteer', 'pacer', 'stranger', 'alone']
};

// Prompts per inflection type. Multiple variants — picked deterministically
// per-inflection so re-renders stay stable.
const PROMPTS = {
  long_stop: [
    'What did you need here?',
    'What were you pretending was still fine?',
    'How long did you mean to stop?',
    'Was the chair calling?'
  ],
  loop_transition: [
    'What did you say to yourself before stepping back out?',
    'Who or what was on your mind here?',
    'What did the next loop feel like before it started?'
  ],
  light_transition: [
    'What changed when the light changed?',
    'Were you ready for this?',
    'What sound do you remember from this moment?'
  ],
  grade_event: [
    'What did your legs say here?',
    'Did you walk it or run it?',
    'What were you doing with your hands?'
  ],
  pace_drop: [
    'Why did this runnable section stop being runnable?',
    'What changed in your body here?',
    'What did you say to yourself when you noticed slowing down?'
  ],
  default: [
    'What changed here?',
    'What were you pretending was still fine?'
  ]
};

const TYPE_ICONS = {
  long_stop:        '⏸',
  loop_transition:  '↻',
  light_transition: '☀',
  grade_event:      '⛰',
  pace_drop:        '↓'
};

const TYPE_LABELS = {
  long_stop:        'Stop',
  loop_transition:  'Loop end',
  light_transition: 'Light',
  grade_event:      'Climb',
  pace_drop:        'Pace drop'
};

export function promptFor(inflection) {
  const list = PROMPTS[inflection.type] || PROMPTS.default;
  // Deterministic pick: hash the cumulative-distance and type into the list
  const seed = Math.floor(((inflection.distMi || 0) * 100 + inflection.type.length * 7) % list.length);
  return list[seed];
}

export function iconFor(type) {
  return TYPE_ICONS[type] || '•';
}

export function labelFor(type) {
  return TYPE_LABELS[type] || type;
}

// Stable storage key for an inflection (so user input survives re-render
// and minor slider adjustments).
export function cardKey(inflection) {
  const mi = (inflection.distMi || 0).toFixed(2);
  return `${inflection.type}@${mi}`;
}
