/** Real input, focus and transcript-search workflows against the immutable npm TUI. @module */

const send = text => [{ step: 'type', text }, { step: 'key', name: 'enter' }]
const key = name => ({ step: 'key', name })
const checkpoint = name => ({ step: 'checkpoint', name })
const resize = (cols, rows) => ({ step: 'resize', cols, rows })

/** Search directions, retained row cursor, overlay return and narrow/wide rendering. */
export const SPLIT_TRANSCRIPT_SEARCH_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('needle first turn'), { step: 'until', text: 'the model is a stub' },
  ...send('needle second turn'), { step: 'until', text: 'needle second turn' }, { step: 'wait', ms: 500 },
  ...send('plain third turn'), { step: 'until', text: 'plain third turn' }, { step: 'wait', ms: 500 },
  key('alt+up'), { step: 'until', text: 'Esc back' },
  key('/'), { step: 'until', text: 'Type a regular expression' }, { step: 'type', text: 'needle' },
  { step: 'until', text: '2 matches' }, checkpoint('stream-search-input'),
  key('enter'), checkpoint('stream-search-selected'),
  key('n'), checkpoint('stream-search-next'), key('N'), checkpoint('stream-search-prev'),
  key('down'), checkpoint('stream-search-down'), key('up'), checkpoint('stream-search-up'),
  key('esc'), checkpoint('stream-search-retained-cursor'),
  key('?'), { step: 'until', text: 'Type a regular expression' }, { step: 'type', text: 'needle' },
  key('enter'), checkpoint('stream-search-reopened-backward'),
  key('n'), checkpoint('stream-search-backward-next'), key('N'), checkpoint('stream-search-backward-prev'),
  resize(40, 16), checkpoint('stream-search-narrow'), resize(120, 40), checkpoint('stream-search-wide'),
  key('esc'), checkpoint('stream-search-resized-cursor'), key('esc'),
  ...send('/help'), { step: 'until', text: 'Commands' }, key('esc'), key('alt+up'), checkpoint('stream-after-overlay-focus'),
  key('?'), { step: 'until', text: 'Type a regular expression' }, { step: 'type', text: 'plain' },
  key('enter'), checkpoint('stream-search-after-overlay'), key('esc'), key('esc'),
])

/** A retained editor caret and selected theme survive overlays and terminal resizes. */
export const SPLIT_FOCUS_RESIZE_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' }, ...send('/theme'), { step: 'until', text: 'Select a theme' },
  key('down'), key('down'), key('down'), key('down'), key('down'), checkpoint('theme-focused-obsidian'),
  resize(40, 16), checkpoint('theme-focused-narrow'), resize(120, 40), checkpoint('theme-focused-wide'),
  resize(80, 24), checkpoint('theme-focused-restored'), key('enter'), checkpoint('theme-focus-accepted'),
  { step: 'type', text: 'caret draft 🪰' }, key('left'), key('left'), checkpoint('editor-caret-before-panel'),
  key('ctrl+u'), ...send('/help'), { step: 'until', text: 'Commands' }, key('esc'),
  { step: 'type', text: 'caret draft 🪰' }, key('left'), key('left'),
  resize(40, 16), checkpoint('editor-caret-narrow'), resize(120, 40), checkpoint('editor-caret-wide'),
  resize(80, 24), checkpoint('editor-caret-restored'),
])

/** The production editor consumes history facts, slash feedback and empty-prompt help. */
export const SPLIT_EDITOR_FEEDBACK_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('Recall this native prompt 你好 🪰'), { step: 'until', text: 'the model is a stub' },
  key('up'), checkpoint('editor-history-recalled'),
  resize(40, 16), checkpoint('editor-history-narrow'), resize(120, 40), checkpoint('editor-history-wide'),
  resize(80, 24), key('end'), key('ctrl+u'),
  { step: 'type', text: '/zzzzmissingcommand' }, { step: 'until', text: 'no matching command: /zzzzmissingcommand' },
  checkpoint('editor-unknown-command'), { step: 'type', text: ' with arguments' }, checkpoint('editor-unknown-command-args'),
  resize(40, 16), checkpoint('editor-unknown-command-narrow'), resize(120, 40), checkpoint('editor-unknown-command-wide'),
  resize(80, 24), key('ctrl+u'), key('?'), { step: 'until', text: 'Commands' }, checkpoint('editor-empty-help'),
  key('esc'), checkpoint('editor-help-return'),
])

export const SPLIT_INPUT_CASES = Object.freeze({
  'transcript-search': { profileTag: 'input-search-v1', steps: SPLIT_TRANSCRIPT_SEARCH_STEPS },
  'focus-resize': { profileTag: 'input-focus-v1', steps: SPLIT_FOCUS_RESIZE_STEPS },
  'editor-feedback': { profileTag: 'input-feedback-v1', steps: SPLIT_EDITOR_FEEDBACK_STEPS },
})
