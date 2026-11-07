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

/** Execute on the frontend machine and retain the reference echo layout and theme lifetime. */
export const SPLIT_LOCAL_SHELL_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('Say one line before a local shell command.'), { step: 'until', text: 'the model is a stub' },
  ...send('!node -e "process.stdout.write(\'shell parity 你好 🪰\\n\')"'),
  { step: 'until', text: 'shell parity 你好 🪰' }, checkpoint('shell-success'),
  resize(40, 16), checkpoint('shell-success-narrow'), resize(120, 40), checkpoint('shell-success-wide'), resize(80, 24),
  ...send('!node -e "process.stderr.write(\'shell-error\\n\');process.exitCode=7"'),
  { step: 'until', text: 'exit code 7' }, checkpoint('shell-error'),
  ...send('/theme tide'), checkpoint('shell-after-theme'),
  ...send('!node -e ""'), { step: 'until', text: '(no output)' }, checkpoint('shell-empty'),
])

/**
 * Text keys through the real terminal path, in the encodings a kitty-protocol terminal or multiplexer may send: the
 * question row's editor and arrows, a slash filter, and Backspace on a field not yet being edited. Behavior only, since
 * rc.2 has none of it.
 */
export const SPLIT_TEXT_KEY_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('native:question:wizard'), { step: 'until', text: 'Choose a delivery route' },
  key('right'), { step: 'until', text: 'Choose the scopes' }, key('left'), { step: 'until', text: 'Choose a delivery route' },
  key('end'), { step: 'type', text: 'xyzzy' }, { step: 'until', text: 'xyzzy' },
  key('\u001b[127;1:1u'), { step: 'until-gone', text: 'xyzzy' }, { step: 'until', text: 'xyzz' },
  key('\u001b[127u'), { step: 'until-gone', text: 'xyzz' }, { step: 'until', text: 'xyz' },
  key('left'), { step: 'type', text: 'Q' }, { step: 'until', text: 'xyQz' },
  key('home'), { step: 'type', text: 'P' }, { step: 'until', text: 'PxyQz' }, checkpoint('text-keys-caret'),
  key('ctrl+u'), { step: 'until-gone', text: 'PxyQz' }, { step: 'until', text: 'xyQz' },
  key('alt+right'), { step: 'until', text: 'Choose the scopes' }, key('alt+left'), { step: 'until', text: 'xyQz' },
  key('enter'), { step: 'until', text: 'Choose the scopes' }, key('space'), key('enter'),
  { step: 'until', text: 'Add a delivery note' }, { step: 'type', text: 'note' }, key('enter'),
  key('end'), key('enter'), { step: 'until', text: 'Native question finished: wizard' },
  ...send('/skills'), { step: 'until', text: 'Skills' }, key('/'), { step: 'type', text: 'zzq' }, { step: 'until', text: 'zzq' },
  key('\u001b[127;1u'), { step: 'until-gone', text: 'zzq' }, key('\u001b[27u'), key('\u001b[27u'), { step: 'until-gone', text: 'zz' },
  ...send('/rename Seed title'), { step: 'until', text: 'renamed session to Seed title' },
  ...send('/rename'), { step: 'until', text: 'Rename session' }, { step: 'until', text: 'Seed title' },
  key('\u001b[127;1:1u'), { step: 'until-gone', text: 'Seed title' }, { step: 'until', text: 'Seed titl' }, checkpoint('text-keys-rename'),
  { step: 'type', text: 'e' }, { step: 'until', text: 'Seed title' }, key('\u001b[27u'), key('\u001b[27u'), { step: 'until-gone', text: 'Rename session' },
])

/** Rename through the actual title editor, including persistence and dirty cancellation. */
export const SPLIT_RENAME_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('Say one line before the rename workflow.'), { step: 'until', text: 'the model is a stub' },
  ...send('/rename Rename seed 你好 🪰'), { step: 'until', text: 'renamed session to Rename seed 你好 🪰' },
  ...send('/rename'), { step: 'until', text: 'Rename session' }, { step: 'until', text: 'Rename seed 你好 🪰' },
  checkpoint('rename-prefilled'),
  key('esc'), { step: 'until-gone', text: 'Rename session' }, checkpoint('rename-clean-cancel'),
  ...send('/rename'), { step: 'until', text: 'Rename session' },
  { step: 'type', text: ' editing' }, key('ctrl+u'), { step: 'type', text: 'Renamed session 保存 🪰' },
  checkpoint('rename-edited'), resize(40, 16), checkpoint('rename-edited-narrow'),
  resize(120, 40), checkpoint('rename-edited-wide'), resize(80, 24),
  key('enter'), { step: 'until-gone', text: 'Rename session' }, checkpoint('rename-saved'),
  ...send('/rename'), { step: 'until', text: 'Rename session' }, { step: 'until', text: 'Renamed session 保存 🪰' },
  checkpoint('rename-reopened'),
  { step: 'type', text: ' UNSAVED' }, key('esc'), key('esc'),
  { step: 'until', text: 'Discard unsaved changes?' }, checkpoint('rename-discard-confirm'),
  key('n'), { step: 'until-gone', text: 'Discard unsaved changes?' }, checkpoint('rename-keep-draft'),
  key('esc'), { step: 'until', text: 'Discard unsaved changes?' }, key('y'),
  { step: 'until-gone', text: 'Rename session' }, checkpoint('rename-discarded'),
  ...send('/rename'), { step: 'until', text: 'Rename session' }, { step: 'until', text: 'Renamed session 保存 🪰' },
  { step: 'until-gone', text: 'UNSAVED' }, checkpoint('rename-after-cancel'),
  { step: 'type', text: ' editing' }, key('ctrl+u'), key('enter'),
  { step: 'until', text: 'Enter a session name' }, checkpoint('rename-empty-rejected'),
  { step: 'type', text: 'Renamed session 保存 🪰' }, key('enter'), { step: 'until-gone', text: 'Rename session' },
  ...send('/rename'), { step: 'until', text: 'Rename session' }, { step: 'until', text: 'Renamed session 保存 🪰' },
  resize(40, 16), checkpoint('rename-persisted-narrow'), resize(120, 40), checkpoint('rename-persisted-wide'),
  key('esc'), { step: 'until-gone', text: 'Rename session' }, checkpoint('rename-closed'),
])

export const SPLIT_INPUT_CASES = Object.freeze({
  'transcript-search': { profileTag: 'input-search-v1', steps: SPLIT_TRANSCRIPT_SEARCH_STEPS },
  'focus-resize': { profileTag: 'input-focus-v1', steps: SPLIT_FOCUS_RESIZE_STEPS },
  'editor-feedback': { profileTag: 'input-feedback-v1', steps: SPLIT_EDITOR_FEEDBACK_STEPS },
  'local-shell': { profileTag: 'input-shell-v1', steps: SPLIT_LOCAL_SHELL_STEPS },
  rename: { profileTag: 'input-rename-v1', steps: SPLIT_RENAME_STEPS },
  'text-keys': { profileTag: 'input-text-keys-v1', steps: SPLIT_TEXT_KEY_STEPS, splitOnly: true },
})
