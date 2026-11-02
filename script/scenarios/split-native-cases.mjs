/** Actual question, Stats, and delivered-file/native-diff acceptance against the immutable rc.2 runtime. @module */
const send = text => [{ step: 'type', text }, { step: 'key', name: 'enter' }]
const checkpoint = name => ({ step: 'checkpoint', name })

export const SPLIT_QUESTION_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('native:question:one'), { step: 'until', text: 'Choose a delivery route' },
  checkpoint('question-one'), { step: 'resize', cols: 40, rows: 16 }, checkpoint('question-one-narrow'),
  { step: 'resize', cols: 120, rows: 40 }, checkpoint('question-one-wide'),
  { step: 'resize', cols: 80, rows: 24 }, { step: 'key', name: '2' },
  { step: 'until', text: 'Native question finished: one' }, checkpoint('question-one-answered'),
  ...send('native:question:wizard'), { step: 'until', text: 'Choose a delivery route' },
  checkpoint('question-wizard-route'), { step: 'key', name: '1' },
  { step: 'until', text: 'Choose the scopes' }, checkpoint('question-wizard-scopes'),
  { step: 'key', name: 'space' }, { step: 'key', name: 'down' }, { step: 'key', name: 'space' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'Add a delivery note' }, { step: 'type', text: '保留 native draft 🪰' }, checkpoint('question-wizard-note'),
  { step: 'key', name: 'enter' }, checkpoint('question-wizard-review'), { step: 'key', name: 'end' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'Native question finished: wizard' }, checkpoint('question-wizard-answered'),
])

export const SPLIT_STATS_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  ...send('Say one line about the first Stats seed.'), { step: 'until', text: 'the model is a stub' },
  ...send('/new'), ...send('Say one line about the current Stats seed.'), { step: 'until', text: 'the model is a stub' },
  ...send('/stats'), { step: 'until', text: 'Stats' }, { step: 'wait', ms: 600 }, checkpoint('stats-session'),
  { step: 'key', name: 'r' }, { step: 'wait', ms: 350 }, checkpoint('stats-session-refresh'),
  { step: 'key', name: 'alt+right' }, { step: 'wait', ms: 350 }, checkpoint('stats-account'),
  { step: 'key', name: 'alt+right' }, { step: 'wait', ms: 600 }, checkpoint('stats-history'),
  { step: 'key', name: 'r' }, checkpoint('stats-history-range'),
  { step: 'key', name: 'w' }, { step: 'wait', ms: 600 }, checkpoint('stats-history-workspace'),
  { step: 'key', name: 'c' }, { step: 'until', text: 'copied the stats summary' }, checkpoint('stats-history-copy'),
  { step: 'key', name: 'alt+right' }, { step: 'wait', ms: 600 }, checkpoint('stats-models'),
  { step: 'key', name: 'r' }, checkpoint('stats-models-range'),
  { step: 'resize', cols: 40, rows: 16 }, checkpoint('stats-models-narrow'),
  { step: 'resize', cols: 120, rows: 40 }, checkpoint('stats-models-wide'),
  { step: 'key', name: 'esc' }, checkpoint('stats-closed'),
])

export const SPLIT_FILES_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' }, ...send('native:files:delivered'),
  { step: 'until', text: 'Native files finished: delivered' }, ...send('/files'),
  { step: 'until', text: 'Files' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'Deterministic native delivery' }, { step: 'wait', ms: 500 }, checkpoint('files-delivered-detail'),
  { step: 'key', name: 'p' }, { step: 'until', text: 'Exact preview' }, checkpoint('files-delivered-preview'),
  { step: 'key', name: 'p' }, { step: 'key', name: 'esc' }, { step: 'key', name: 'down' }, { step: 'key', name: 'enter' }, { step: 'wait', ms: 500 }, checkpoint('files-native-diff'),
  { step: 'resize', cols: 40, rows: 16 }, { step: 'key', name: 'esc' }, checkpoint('files-narrow-list'),
  { step: 'key', name: 'enter' }, checkpoint('files-narrow-detail'),
  { step: 'key', name: 'esc' }, checkpoint('files-narrow-back'),
  { step: 'resize', cols: 120, rows: 40 }, checkpoint('files-wide-diff'),
  { step: 'key', name: 'esc' }, checkpoint('files-closed'),
])

export const SPLIT_NATIVE_CASES = Object.freeze({
  questions: { steps: SPLIT_QUESTION_STEPS, profileTag: 'questions-v1' },
  stats: { steps: SPLIT_STATS_STEPS, profileTag: 'stats-v1' },
  files: { steps: SPLIT_FILES_STEPS, fixture: 'native-files', profileTag: 'files-v1' },
})
