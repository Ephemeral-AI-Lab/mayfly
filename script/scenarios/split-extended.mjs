/** Additional published-reference workflows kept independent of the initial frozen checkpoints. @module script/scenarios/split-extended */

const command = (name, checkpoint = name) => [
  { step: 'type', text: `/${name}` }, { step: 'key', name: 'enter' },
  { step: 'wait', ms: 350 }, { step: 'checkpoint', name: checkpoint },
  { step: 'key', name: 'esc' },
]

/** Native startup preference, a genuinely created recent Session, and keyboard resume. */
export const SPLIT_STARTUP_STEPS = Object.freeze([
  { step: 'until', text: 'No sessions here yet' }, { step: 'checkpoint', name: 'splash-empty' },
  { step: 'type', text: 'Say one line about this isolated replay.' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'the model is a stub' },
  { step: 'type', text: '/new' }, { step: 'key', name: 'enter' },
  { step: 'checkpoint', name: 'splash-recent' },
  { step: 'key', name: 'up' }, { step: 'checkpoint', name: 'splash-recent-focused' },
  { step: 'key', name: 'esc' }, { step: 'checkpoint', name: 'splash-recent-return' },
  { step: 'key', name: 'up' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'the model is a stub' }, { step: 'checkpoint', name: 'splash-resumed' },
])

/** The model shortcut cycles through native provider models without consuming editor input. */
export const SPLIT_MODEL_SHORTCUT_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'key', name: 'alt+m' },
  { step: 'checkpoint', name: 'model-shortcut' },
  { step: 'type', text: '保留 draft 🪰' }, { step: 'key', name: 'alt+m' },
  { step: 'checkpoint', name: 'model-shortcut-draft' },
  { step: 'key', name: 'ctrl+u' }, { step: 'checkpoint', name: 'model-shortcut-cleared' },
])

/** Same current native Session for every passive command surface; no external writes. */
export const SPLIT_PANEL_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'type', text: 'Say one line about this isolated replay.' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'the model is a stub' },
  ...command('context'), ...command('version'), ...command('skills'),
  ...command('provider'), ...command('settings'), ...command('sessions'),
  ...command('preset'), ...command('permissions'), ...command('model'), ...command('effort'),
])

/** These references are acquired independently and cannot replace the initial eighteen. */
export const SPLIT_EXTENDED_CASES = Object.freeze({
  startup: { startup: 'splash', profileTag: 'startup', steps: SPLIT_STARTUP_STEPS },
  'model-shortcut': { profileTag: 'model-shortcut', steps: SPLIT_MODEL_SHORTCUT_STEPS },
  panels: { profileTag: 'panels', steps: SPLIT_PANEL_STEPS },
})
