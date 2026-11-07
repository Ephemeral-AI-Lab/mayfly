#!/usr/bin/env node
/**
 * The redesigned tool display as one running screen: a long conversation plays through the stream, the activity row, the
 * notification line, the editor, the status row, and the view panels together, with their motion, so the design is judged
 * as a whole and not as separate frames.
 *
 * The ownership it shows: the activity row says what the turn is doing now; the stream records each call and what came
 * back; a view owns whatever outlives a call or keeps changing after it (agents, jobs, workflow, goal, todo), so the
 * stream only points at those.
 *
 *   node docs/design/prototypes/tool-display-preview.mjs                  play it (keys below, and on its top rows)
 *   node docs/design/prototypes/tool-display-preview.mjs --chapters       the chapters and what each one shows
 *   node docs/design/prototypes/tool-display-preview.mjs --frame 50 --level verbose --view agents   one frame, printed
 *   node docs/design/prototypes/tool-display-preview.mjs --smoke          render everything; exit 1 on a row of the wrong size
 *   --level compact|standard|detailed|verbose   --width N --height N   --plain   --no-chrome   --row a|b   --open
 *
 *   1-4 level · Ctrl+O open the turns at Verbose · Alt+↓ (or v, F6) enter the views · ←/→ move · ↑/↓ row · Esc back
 *   Alt+↑ (or s) select in the stream · ↑/↓ move · Enter open or close a call · PgUp/PgDn scroll
 *   space pause · , . chapter · [ ] seek 5s · + - speed · a activity row A/B · t tour on/off · c preview rows · r restart · q quit
 *
 * The tour opens the view each chapter is about; any view key hands that over to you. It draws its own colors (the values
 * of the Mayfly Dark palette) and imports nothing from Mayfly, so it shows the design, not the shipped renderer. The data
 * is a hand-written script.
 *
 * @module docs/design/prototypes/tool-display-preview
 */

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback }

// ======================================================================= paint
const INK = {
  text: '#EDEDF2', strong: '#F5F5F7', muted: '#9AA3B8', faint: '#5C6476', accent: '#C9C0F0', primary: '#9A86E6',
  border: '#45406B', success: '#4EC87E', danger: '#E85454', warning: '#E8A838',
}
const BAND = { add: '#1E3A2B', del: '#43232A', sel: '#2B2B30', chrome: '#17171D' }
const PLAIN = flag('plain')
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const mix = (a, b, k) => `#${[1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`

/** A span: its text, its ink (a token or a hex), and whether it is bold, italic, or struck through. */
const s = (t, c = 'text', style = '') => ({ t: String(t), c, b: style.includes('b'), i: style.includes('i'), x: style.includes('x') })
const mu = t => s(t, 'muted')
const fa = t => s(t, 'faint')

function paintSpan(span, bg) {
  if (span.t === '') return ''
  if (PLAIN) return span.t
  const hex = INK[span.c] ?? span.c
  return `\x1b[${span.b ? '1;' : ''}${span.i ? '3;' : ''}${span.x ? '9;' : ''}38;2;${rgb(hex)}${bg ? `;48;2;${rgb(bg)}` : ''}m${span.t}\x1b[0m`
}

/** One row, cut to `width` cells with an ellipsis and filled out to it, so a band covers the whole row. */
function paintRow(row, width) {
  const spans = Array.isArray(row) ? row : row.spans
  const bg = Array.isArray(row) ? undefined : row.bg
  let room = width
  let out = ''
  const total = spans.reduce((sum, span) => sum + [...span.t].length, 0)
  const limit = total > width ? width - 1 : width
  room = limit
  for (const span of spans) {
    if (room <= 0) break
    const chars = [...span.t]
    const kept = chars.length <= room ? span.t : chars.slice(0, room).join('')
    out += paintSpan({ ...span, t: kept }, bg)
    room -= [...kept].length
  }
  if (total > width) out += paintSpan(s('…', 'muted'), bg)
  const used = Math.min(total, width)
  if (used < width) out += bg && !PLAIN ? paintSpan(s(' '.repeat(width - used)), bg) : ' '.repeat(width - used)
  return out
}

const cellsOf = spans => spans.reduce((sum, span) => sum + [...span.t].length, 0)
const R = (spans, extra = {}) => ({ spans, ...extra })

function wrapText(text, width) {
  const out = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (line === '') line = word
      else if ([...line].length + 1 + [...word].length <= width) line += ` ${word}`
      else { out.push(line); line = word }
    }
    out.push(line)
  }
  return out
}

// ======================================================================= motion and time
const BLOOM = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const FILL = ['⡀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿', '⣷', '⣶', '⣦', '⣤', '⣄']
const BREATH = [0.25, 0.45, 0.7, 1, 0.7, 0.45]
const breath = frame => mix(INK.faint, INK.primary, BREATH[Math.floor(frame / 3) % BREATH.length])
const pulse = frame => mix(INK.faint, INK.accent, BREATH[Math.floor(frame / 2) % BREATH.length])
function shimmer(label, frame) {
  const pos = (frame % ([...label].length + 8)) - 3
  return [...label].map((ch, i) => s(ch, Math.abs(i - pos) <= 1 ? 'strong' : Math.abs(i - pos) === 2 ? 'accent' : 'muted'))
}
const secs = n => { const v = Math.max(0, Math.floor(n)); return v < 60 ? `${v}s` : v < 3600 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${Math.floor(v / 3600)}h ${Math.floor(v % 3600 / 60)}m` }
const dur = n => (n < 10 ? `${(Math.round(n * 10) / 10).toString()}s` : secs(n))
const kilo = n => (n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`)
const clockAt = t => { const m = 10 + Math.floor(t / 60); return `10:${String(m).padStart(2, '0')}` }

// ======================================================================= the script: what happens, and when
const hl = text => {
  const out = []
  const re = /('[^']*'|"[^"]*"|`[^`]*`|\b(?:import|from|export|function|const|return|type|for|in|do|done)\b|\/\/.*$)/gu
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push(s(text.slice(at, m.index)))
    const tok = m[0]
    out.push(s(tok, /^['"`]/u.test(tok) ? 'success' : tok.startsWith('//') ? 'faint' : 'primary'))
    at = m.index + tok.length
  }
  if (at < text.length) out.push(s(text.slice(at)))
  return out
}
const lines = (...texts) => texts.map(text => ({ text }))
const nums = (start, ...texts) => texts.map((text, i) => ({ lead: String(start + i).padStart(3), code: text }))
const hunk = (...ops) => ops.map(([sign, a, b, text]) => ({ sign, a, b, text }))

const READ = { group: 'read', unit: ['file', 'files'], title: 'Read', activity: ['Reading files', 'Preparing to read files'] }
const SEARCH = { group: 'search', unit: ['search', 'searches'], title: 'Search', activity: ['Searching code', 'Preparing to search code'] }
const COMMAND = { group: 'commands', unit: ['call', 'calls'], title: 'Bash', activity: ['Running commands', 'Preparing to run commands'] }
const WEBS = { group: 'webSearch', unit: ['search', 'searches'], title: 'WebSearch', activity: ['Searching the web', 'Preparing to search the web'] }
const WEBF = { group: 'webFetch', unit: ['page', 'pages'], title: 'WebFetch', activity: ['Visiting web pages', 'Preparing to visit web pages'] }
const EDIT = { solo: true, file: true, activity: ['Editing files', 'Preparing to edit files'] }
const WRITE = { solo: true, file: true, activity: ['Writing files', 'Preparing to write files'] }
const SPAWN = { group: 'spawn', owner: 'agents', activity: ['Coordinating subagents', 'Preparing to coordinate subagents'] }
const WORKFLOW = { solo: true, owner: 'workflow', activity: ['Running a workflow', 'Preparing a workflow'] }
const JOBPOLL = { owner: 'jobs', quiet: true, solo: true, activity: ['Checking jobs', 'Checking jobs'] }
const HIDDEN = { hidden: true, activity: ['Updating the plan', 'Updating the plan'] }
const mcp = (server, tool) => ({ server, tool, group: `mcp:${server}`, unit: ['call', 'calls'], activity: [`Calling ${server}`, `Preparing to call ${server}`] })

let nextId = 0
const call = (turn, at, end, tool, kind, facts = {}) => ({ kind: 'call', id: `c${++nextId}`, turn, at, end, tool, state: 'ok', outcome: [], ...kind, ...facts })

const TURNS = [
  { turn: 1, at: 0.5, end: 89, prompt: 'The list loses its selection after a reorder. Fix it, and check nothing else regressed.', title: 'Fix the list selection', outcome: 'Worked' },
  { turn: 2, at: 92, end: 105, prompt: 'Set a goal: ship the release notes and keep the tests green.', title: 'Ship the release notes', outcome: 'Stopped' },
]

const ENTRIES = [
  { kind: 'thinking', turn: 1, at: 1, end: 4, secs: 3, lines: ['The selection is keyed by index, so a reorder would point it at the wrong row.', 'I should read reorder() first and see who calls onSelect.', 'If the fix touches the menu too, the tests need a wider run.'] },
  call(1, 4, 4.2, 'TodoWrite', HIDDEN),

  call(1, 6, 7.2, 'Read', READ, { target: 'src/list.ts', outcome: ['120-180 of 940'], lines: 61, body: { rows: nums(120, 'export function reorder(items, from, to) {', '  const next = items.slice()', '  next.splice(to, 0, items[from])', '  next.splice(from, 1)', '  return next', '}'), total: 61 } }),
  call(1, 6, 6.6, 'Read', READ, { target: 'package.json', outcome: ['38 lines'], lines: 38, body: { rows: nums(1, '{', '  "name": "@mayfly/ui",', '  "version": "0.1.5",'), total: 38 } }),
  call(1, 6.2, 6.7, 'Read', READ, { state: 'error', target: 'src/missing.ts', outcome: ['file not found'] }),
  call(1, 7.4, 8.3, 'Grep', SEARCH, { target: '"onSelect" in src', outcome: ['12 matches in 4 files'], matches: 12, args: ['glob *.ts · case-insensitive'], body: { rows: [{ lead: 'src/list.ts:42', text: 'onSelect(item.id)' }, { lead: 'src/list.ts:97', text: 'props.onSelect?.(next)' }, { lead: 'src/menu.ts:18', text: 'const onSelect = useCallback(' }], total: 12 } }),
  call(1, 7.6, 8, 'Glob', SEARCH, { target: '**/*.spec.ts', outcome: ['38 paths'], body: { rows: lines('tests/list.spec.ts', 'tests/menu.spec.ts', 'tests/tabs.spec.ts'), total: 38 } }),

  call(1, 9, 10.1, 'github › search_issues', mcp('github', 'search_issues'), { target: 'query="is:open label:bug", per_page=30', outcome: ['12 issues', '1.1s'], body: { rows: [{ lead: '#1423', text: 'List loses selection after reorder' }, { lead: '#1419', text: 'Menu does not close on blur' }, { lead: '#1411', text: 'Tabs flicker at 40 columns' }], total: 12 } }),
  call(1, 9.2, 9.6, 'github › get_issue', mcp('github', 'get_issue'), { target: 'owner=acme, repo=web, issue_number=1423', outcome: ['2.1 KB', '0.4s'], body: { rows: lines('number: 1423', 'title: List loses selection after reorder', 'state: open', 'labels: bug, ui', '↗ Release notes (https://github.com/acme/web/releases/v0.4)'), total: 14 } }),
  call(1, 9, 12, 'linear › search_issues', mcp('linear', 'search_issues'), { target: 'list selection', outcome: ['3 issues', '3s'], body: { rows: [{ lead: 'ENG-212', text: 'Selection reset on reorder' }], total: 3 } }),
  call(1, 10.5, 12.7, 'browser › screenshot', mcp('browser', 'screenshot'), { target: 'https://pi.dev', outcome: ['1 image', 'png 800×600', '2.2s'], body: { rows: lines('[image image/png 800×600]'), total: 1 } }),

  call(1, 13, 14.4, 'WebSearch', WEBS, { target: '"keep selection after array reorder"', outcome: ['5 sources', '1.4s'], body: { rows: lines('Stable keys in lists · react.dev/learn/rendering-lists', 'Keeping selection by id · blog.example.dev/selection', 'Array.prototype.splice · developer.mozilla.org'), total: 5 } }),
  call(1, 14.5, 15.4, 'WebFetch', WEBF, { target: 'https://react.dev/learn/rendering-lists', outcome: ['200', '14 KB', 'truncated'], args: ['extract "selection keys"'], body: { rows: lines('# Rendering Lists', 'Keys tell React which array item each component corresponds to…', '## Where to get your key'), total: 120 } }),
  call(1, 15.5, 16, 'ReadImage', { ...READ, unit: ['image', 'images'], activity: ['Reading images', 'Preparing to read images'] }, { target: 'docs/shot.png', outcome: ['png', '1280×720', '84 KB'] }),
  call(1, 16, 16.3, 'Skill', { group: 'skill', unit: ['skill', 'skills'], activity: ['Loading skills', 'Loading skills'] }, { target: 'reviewer' }),

  { kind: 'say', turn: 1, at: 16.6, end: 18.2, text: 'The reorder keeps the index of the selected row instead of its id. I will key the selection by id and split the helper out.' },

  call(1, 21, 21.3, 'Edit', EDIT, { prep: 18.5, target: 'src/list.ts', stat: [4, 2], diff: hunk(['=', 121, 121, '  const next = items.slice()'], ['-', 122, null, '  next.splice(to, 0, items[from])'], ['-', 123, null, '  next.splice(from, 1)'], ['+', null, 122, '  const [moved] = next.splice(from, 1)'], ['+', null, 123, '  next.splice(to, 0, moved)'], ['+', null, 124, '  // the selection follows the id, not the index'], ['+', null, 125, '  keepSelection(next, moved.id)'], ['=', 124, 126, '  return next']) }),
  call(1, 22.1, 22.4, 'Edit', EDIT, { prep: 21.5, target: 'src/menu.ts', outcome: ['3 replaced'], stat: [3, 3], diff: hunk(['-', 18, null, '  const onPick = useCallback('], ['+', null, 18, '  const onSelect = useCallback(']) }),
  call(1, 22.6, 23, 'Edit', EDIT, { state: 'error', prep: 22.4, target: 'src/menu.ts', outcome: ['old text not found'] }),
  call(1, 25, 25.3, 'ApplyPatch', { solo: true, activity: ['Editing files', 'Preparing to edit files'] }, { prep: 23.4, outcome: ['4 files'], stat: [17, 33], patch: [
    { kind: 'M', file: 'src/list.ts', a: 4, d: 2, diff: hunk(['-', 42, null, '  select(index)'], ['+', null, 42, '  select(item.id)']) },
    { kind: 'A', file: 'src/reorder.ts', a: 12, d: 0, diff: hunk(['+', null, 1, 'export function reorder(items, from, to) {'], ['+', null, 2, '  const next = items.slice()']) },
    { kind: 'D', file: 'src/legacy-list.ts', a: 0, d: 30, diff: hunk(['-', 1, null, '// the old list']) },
    { kind: 'R', file: 'src/menu-old.ts → src/menu.ts', a: 1, d: 1, diff: hunk(['-', 3, null, "import './menu-old.css'"], ['+', null, 3, "import './menu.css'"]) },
  ] }),
  call(1, 27.6, 27.9, 'Write', WRITE, { prep: 25.4, target: 'tests/selection.spec.ts', outcome: ['created', '42 lines', '1.3 KB'], code: ["import { describe, expect, it } from 'vitest'", "import { reorder } from '../src/reorder.ts'", '', "describe('reorder', () => {", "  it('keeps the selected id', () => {", "    const items = [{ id: 'a' }, { id: 'b' }]", '    expect(reorder(items, 0, 1)[1].id).toBe(\'a\')', '  })', '})'], total: 42 }),

  call(1, 28.2, 30, 'Bash', COMMAND, { target: 'pnpm run lint', outcome: ['1.8s'], args: ['# Lint the ui package · cwd packages/ui'], body: { rows: lines('> @mayfly/ui@0.1.5 lint', '> oxlint src', 'Found 0 warnings and 0 errors.'), total: 3, tail: true } }),
  call(1, 30.2, 36, 'Bash', COMMAND, { state: 'error', target: 'pnpm test --filter ui', outcome: ['exit 1', '5.8s'], args: ['# Run the ui tests'], body: { rows: lines(' FAIL  tests/selection.spec.ts', '  ✗ keeps the selected id', '    expected "a", received "b"', 'Tests  1 failed | 41 passed'), total: 14, tail: true } }),
  call(1, 36.4, 38.2, 'Bash', COMMAND, { target: 'for f in src/*.ts; do …', command: ['for f in src/*.ts; do', '  oxlint "$f" || echo "failed: $f"', 'done'], outcome: ['1.8s'], body: { rows: lines('(no output)'), total: 1, tail: true } }),
  call(1, 38.6, 40.4, 'RunCode', { group: 'code', unit: ['run', 'runs'], activity: ['Running code', 'Preparing to run code'] }, { target: 'Count the selection call sites', outcome: ['1.8s'], sections: [
    { label: 'code', rows: nums(1, "const files = glob('src/**/*.ts')", "const hits = files.flatMap(f => grep(f, 'select('))", 'console.log(hits.length)'), total: 3 },
    { label: 'output', rows: lines('17'), total: 1 },
  ], input: ["const files = glob('src/**/*.ts')", "const hits = files.flatMap(f => grep(f, 'select('))", 'console.log(hits.length)'] }),

  call(1, 40.8, 41.1, 'Bash', { ...COMMAND, owner: 'jobs' }, { target: 'pnpm dev', outcome: ['job-3'], args: ['# Start the dev server'] }),
  call(1, 42.4, 42.7, 'JobOutput', JOBPOLL, { target: 'job-3', outcome: ['+42 lines', 'running'] }),
  call(1, 44, 44.3, 'JobOutput', JOBPOLL, { target: 'job-3', outcome: ['+3 lines', 'running'] }),

  call(1, 46, 54, 'Subagent', { ...SPAWN, blocks: true }, { target: 'Explore every caller of reorder', agent: 'explore', outcome: ['8s'] }),
  call(1, 46.2, 62, 'Subagent', { ...SPAWN, blocks: true }, { state: 'error', target: 'Sweep the oxlint findings', agent: 'lint', outcome: ['failed', '15s'] }),
  call(1, 46.4, 58, 'Subagent', { ...SPAWN, blocks: false }, { target: 'Review the diff for regressions', agent: 'review', outcome: ['11s'] }),

  call(1, 63, 82, 'Workflow', { ...WORKFLOW, blocks: true }, { target: 'audit-deps', outcome: ['7 agents', '19s'], runId: 'audit-deps' }),

  call(1, 82.4, 82.7, 'JobKill', JOBPOLL, { target: 'job-3', outcome: ['killed'] }),
  call(1, 83, 83.2, 'TodoWrite', HIDDEN),
  { kind: 'say', turn: 1, at: 83.6, end: 88.4, text: 'Done. The selection now follows the id through a reorder, the helper moved to `src/reorder.ts`, and `tests/selection.spec.ts` covers it. One lint sweep failed on its own and is listed under agents; the rest of the audit is clean.' },

  call(2, 93, 93.3, 'CreateGoal', HIDDEN),
  { kind: 'goal', turn: 2, at: 93.3, mark: '●', tone: 'accent', text: 'Goal set · Ship the release notes and keep the tests green' },
  { kind: 'round', turn: 2, at: 94, round: 1 },
  call(2, 94.4, 95, 'Read', READ, { target: 'CHANGELOG.md', outcome: ['212 lines'], lines: 212, body: { rows: nums(1, '# Changelog', '', '## 0.1.5'), total: 212 } }),
  call(2, 96.6, 96.9, 'Edit', EDIT, { prep: 95.2, target: 'CHANGELOG.md', stat: [6, 0], diff: hunk(['=', 3, 3, '## 0.1.5'], ['+', null, 4, '- The list keeps its selection through a reorder.'], ['+', null, 5, '- Selection is keyed by id.']) }),
  { kind: 'round', turn: 2, at: 97.2, round: 2 },
  call(2, 97.6, 100.4, 'Bash', COMMAND, { target: 'pnpm test --filter ui', outcome: ['2.8s'], body: { rows: lines('Tests  42 passed'), total: 12, tail: true } }),
  call(2, 100.8, 101.3, 'github › create_issue', mcp('github', 'create_issue'), { state: 'error', target: 'title="Release notes", teamId=ENG, +2', outcome: ['401 Bad credentials', '0.5s'], args: ['description="Draft the notes for 0.1.5…" · labels=["docs"]'], body: { rows: lines('401 Bad credentials', 'The token has expired or lacks the repo scope.'), total: 2 } }),
  call(2, 102, 102.2, 'UpdateGoal', HIDDEN),
  { kind: 'goal', turn: 2, at: 102.2, mark: '✕', tone: 'danger', text: 'Goal blocked · auth: the github token has expired' },
]

/** When each model step began: a step's calls were requested together, so they start together. */
const STEP_STARTS = [1, 4, 6, 7.4, 9, 10.5, 13, 14.5, 15.5, 16, 18.5, 21.5, 22.4, 23.4, 25.4, 28.2, 30.2, 36.4, 38.6, 40.8, 42.4, 44, 46, 63, 82.4, 83, 93, 94.4, 95.2, 97.6, 100.8, 102]
const stepOf = e => STEP_STARTS.findLastIndex(start => start <= (e.prep ?? e.at))

const TODOS = [
  { text: 'Find why the selection is lost', start: 4.2, done: 16.6 },
  { text: 'Key the selection by id', start: 16.6, done: 28 },
  { text: 'Cover it with a test and run the suite', start: 28, done: 46 },
  { text: 'Review the diff with subagents', start: 46, done: 63 },
  { text: 'Audit the dependencies', start: 63, done: 83 },
]
const TODO_AT = 4.2
const TODO_LINGER = 5

const AGENTS = [
  { name: 'explore', mode: 'fg', task: 'Explore every caller of reorder', at: 46, end: 54, outcome: 'ok', acts: [[46, 'Thinking…'], [47.5, 'Using grep'], [50, 'Using read'], [52, 'Writing…']], rate: [6, 0.3] },
  { name: 'lint', mode: 'fg', task: 'Sweep the oxlint findings', at: 46.2, end: 62, outcome: 'failed', acts: [[46.2, 'Thinking…'], [48, 'Using bash'], [55, 'Using edit'], [59, 'Using bash']], rate: [4, 0.2] },
  { name: 'review', mode: 'bg', task: 'Review the diff for regressions', at: 46.4, end: 58, outcome: 'ok', acts: [[46.4, 'Thinking…'], [49, 'Using read'], [53, 'Writing…']], rate: [9, 0.6] },
]

const JOBS = [{ name: 'pnpm dev', at: 41.1, end: 82.7, outcome: 'stopped', progress: [[41.1, 'starting'], [42.4, 'ready on :5173'], [58, 'rebuilt 2']] }]
const JOB_LINGER = 5

const WORKFLOWS = [{
  name: 'audit-deps', at: 63, end: 82, phases: [['scan', 63, 70], ['verify', 70, 79], ['report', 79, 82]],
  agents: [
    { label: 'scan packages/ui', phase: 'scan', at: 63.2, end: 67 }, { label: 'scan packages/host', phase: 'scan', at: 63.4, end: 69 }, { label: 'scan packages/cli', phase: 'scan', at: 63.6, end: 68 },
    { label: 'verify the licences', phase: 'verify', at: 70, end: 75 }, { label: 'verify the pins', phase: 'verify', at: 70.2, end: 78 }, { label: 'verify the exclusions', phase: 'verify', at: 70.4, end: 73 },
    { label: 'write the report', phase: 'report', at: 79, end: 81.8 },
  ],
}]
const WORKFLOW_LINGER = 5

const GOAL = { at: 93.3, objective: 'Ship the release notes and keep the tests green', rounds: 3, roundAt: [[94, 1], [97.2, 2]], blockedAt: 102.2, code: 'auth', reason: 'the github token has expired' }

const CHAPTERS = [
  { at: 0, name: 'Reasoning, then the plan', look: 'No tool line for todo_write: the plan lands only in ● todo in the status row, and its panel.', view: 'todo', until: 6 },
  { at: 6, name: 'Reads and searches', look: 'Runs merge in place: one block per kind, the read window and the match count on each item.' },
  { at: 9, name: 'MCP tools', look: 'Arguments are visible now. A run groups by server. The activity row names the mixed set, not the targets.' },
  { at: 13, name: 'Web, image, skill', look: 'Query and source count, status and size, the image facts, the skill name. One line each below Verbose.' },
  { at: 18.5, name: 'File changes', look: 'Code fills while the model writes it. A patch is a per-file tree. A failed edit keeps only its reason.' },
  { at: 28, name: 'Commands and code', look: 'The clock ticks on the line. exit 1 stays on the line. A multi-line command shows its lines while it runs. Try 3 and 4.' },
  { at: 40.5, name: 'A background job', look: 'One stream line names job-3, and ● jobs takes over. The polls are not drawn below Verbose. Compare 2 and 4.', view: 'jobs', until: 46 },
  { at: 46, name: 'Subagents', look: 'The stream says one line, ● Subagent · 1/3. Activity and tokens live in the panel. A failure turns the item ✕.', view: 'agents', until: 63 },
  { at: 63, name: 'A workflow', look: 'New: a view, not a bottom pane. The phases and members are in the panel; the stream keeps one line.', view: 'workflow', until: 87 },
  { at: 83.6, name: 'The answer', look: 'The items settle: ✓ workflow, ✓ jobs and ✓ todo are held for five seconds and leave. Agents stays.', view: null },
  { at: 92, name: 'A goal', look: 'No tool lines for the goal calls: the durable Goal rows and the round rules carry them, and ● goal the count.', view: 'goal' },
  { at: 100.8, name: 'A failure', look: 'The MCP failure keeps its reason at every level. Try 1. The blocked goal warns in the notification line.', view: 'goal' },
]

// ======================================================================= facts at a moment
const present = (e, t) => t >= (e.prep ?? e.at)
const phaseOf = (c, t) => (c.prep !== undefined && t < c.at ? 'preparing' : t < c.end ? 'running' : 'settled')
const stateOf = (c, t) => (phaseOf(c, t) === 'settled' ? c.state : 'pending')
const isHidden = (c, t) => c.hidden && !(phaseOf(c, t) === 'settled' && c.state === 'error')
const isFlight = (c, t) => c.kind === 'call' && present(c, t) && phaseOf(c, t) !== 'settled' && c.blocks !== false

/** What a call's line says after its name: while it runs its own time, unless a view owns the time. */
function outcomeOf(c, t) {
  const phase = phaseOf(c, t)
  if (phase === 'settled') return c.outcome
  if (phase === 'preparing' || c.owner) return []
  return t - c.at >= 1 ? [secs(t - c.at)] : []
}

const GLYPH = { ok: ['✓ ', 'success'], error: ['✗ ', 'danger'], cancelled: ['⊘ ', 'muted'], partial: ['⚠ ', 'warning'] }
const glyphOf = (state, frame) => (state === 'pending' ? s('● ', breath(frame)) : s(GLYPH[state][0], GLYPH[state][1]))
const miniGlyph = (state, frame) => (state === 'pending' ? [s('• ', pulse(frame))] : state === 'ok' ? [] : [s(GLYPH[state][0], GLYPH[state][1])])

function statBar(a, d, w = 8) {
  const total = a + d
  const k = total === 0 ? 0 : Math.min(w - (d > 0 ? 1 : 0), Math.max(a > 0 ? 1 : 0, Math.round(a / total * w)))
  return [...a ? [s(`+${a}`, 'success')] : [], ...a && d ? [mu(' ')] : [], ...d ? [s(`−${d}`, 'danger')] : [], mu(' '), s('▮'.repeat(k), 'success'), s('▮'.repeat(w - k), 'danger')]
}

function nameSpans(c, state) {
  const tone = state === 'cancelled' ? 'muted' : 'text'
  return c.server ? [mu(c.server), mu(' › '), s(c.tool, tone, 'b')] : [s(c.tool, tone, 'b')]
}

/** The line of a call. The target gives way before the outcome, so an exit code or a reason always survives a narrow row. */
function lineOf(c, t, frame, width, { hideTarget = false } = {}) {
  const state = stateOf(c, t)
  const outcome = outcomeOf(c, t)
  const tail = outcome.length > 0 ? ` · ${outcome.join(' · ')}` : ''
  const settled = state !== 'pending'
  const statCells = c.stat && settled ? 18 : 0
  const name = nameSpans(c, state)
  // The stream's gutter and the glyph take four cells, the parentheses two, an ellipsis one.
  const room = width - 7 - cellsOf(name) - [...tail].length - statCells
  const target = c.target === undefined || hideTarget || room < 3 ? undefined : [...c.target].length <= room ? c.target : `${[...c.target].slice(0, room).join('')}…`
  return [
    glyphOf(state, frame),
    ...name,
    ...target === undefined ? [] : [mu('('), s(target, 'accent'), mu(')')],
    ...tail === '' ? [] : [mu(tail)],
    ...c.stat && settled ? [mu(' · '), ...statBar(...c.stat)] : [],
  ]
}

// ======================================================================= bodies
const PAD = '  '
const bodyRow = (r, pad) => R([s(pad), ...r.lead ? [mu(`${r.lead} `)] : [], ...r.code !== undefined ? hl(r.code) : [s(r.text, r.tone ?? 'text')]])
const moreRow = (text, pad) => R([s(pad), mu(text)])

function diffRows(ops, pad) {
  return ops.map((op) => {
    const a = op.a === null || op.a === undefined ? '   ' : String(op.a).padStart(3)
    const b = op.b === null || op.b === undefined ? '   ' : String(op.b).padStart(3)
    const sign = op.sign === '+' ? '+' : op.sign === '-' ? '−' : ' '
    const tone = op.sign === '+' ? 'success' : op.sign === '-' ? 'danger' : 'text'
    return R([s(pad), fa(`${a} ${b} │ `), s(`${sign} `, tone), ...hl(op.text)], op.sign === '+' ? { bg: BAND.add } : op.sign === '-' ? { bg: BAND.del } : {})
  })
}

/** The rows under a call: its other arguments, then what came back, within `cap`. A view owns a spawn's and a workflow's detail, so they have no body at all. */
function bodyOf(c, t, { cap, open, pad = PAD }) {
  if (c.owner && c.owner !== 'jobs') return []
  const phase = phaseOf(c, t)
  const state = stateOf(c, t)
  const hint = open ? '' : ' · Ctrl+O'
  const out = []
  if (phase === 'preparing') {
    const k = Math.max(0, Math.min(1, (t - c.prep) / (c.at - c.prep)))
    if (c.diff) {
      const all = diffRows(c.diff, pad)
      const n = Math.ceil(all.length * k)
      const shown = all.slice(Math.max(0, n - cap), n)
      if (n > shown.length) out.push(moreRow(`… +${n - shown.length} earlier${hint}`, pad))
      out.push(...shown)
    } else if (c.code) {
      const n = Math.ceil(c.code.length * k)
      const from = Math.max(0, n - cap)
      if (from > 0) out.push(moreRow(`… +${from} earlier${hint}`, pad))
      c.code.slice(from, n).forEach((code, i) => out.push(bodyRow({ lead: String(from + i + 1).padStart(3), code }, pad)))
    } else if (c.patch) {
      const n = Math.ceil(c.patch.length * k)
      c.patch.slice(0, n).forEach(f => out.push(R([s(pad), s(f.kind, f.kind === 'A' ? 'success' : f.kind === 'D' ? 'danger' : 'warning'), s(` ${f.file}`, 'accent')])))
    }
    return out
  }
  if (phase === 'running') {
    const input = c.command ?? c.input
    if (input && cap > 0) {
      input.slice(0, cap).forEach((text, i) => out.push(R([s(pad), mu(c.command ? (i === 0 ? '$ ' : '  ') : ''), ...hl(text)])))
      if (input.length > cap) out.push(moreRow(`… +${input.length - cap} more${hint}`, pad))
    }
    return out
  }
  if (c.interrupted) return out
  // A failed read, search, or edit has only its reason, which the line already gives.
  if (state === 'error' && !c.body) return out
  if (c.args?.length) out.push(R([s(pad), mu(c.args.join(' · '))]))
  if (c.sections) {
    for (const section of c.sections) {
      const limit = open ? section.rows.length : Math.max(1, Math.floor(cap / 2))
      out.push(R([s(pad), mu(section.label)]))
      section.rows.slice(0, limit).forEach(r => out.push(bodyRow(r, `${pad}  `)))
      if (section.total > limit) out.push(moreRow(`… +${section.total - limit} more${hint}`, `${pad}  `))
    }
    return out
  }
  if (c.patch) {
    let room = cap
    for (const f of c.patch) {
      out.push(R([s(pad), s(f.kind, f.kind === 'A' ? 'success' : f.kind === 'D' ? 'danger' : 'warning'), s(` ${f.file}`, 'accent'), mu('  '), ...statBar(f.a, f.d, 6)]))
      room -= 1
      if (room > 0) { const rows = diffRows(f.diff, `${pad}  `).slice(0, room); out.push(...rows); room -= rows.length }
    }
    return out
  }
  if (c.diff) {
    const rows = diffRows(c.diff, pad)
    out.push(...rows.slice(0, cap))
    if (rows.length > cap) out.push(moreRow(`… +${rows.length - cap} rows${hint}`, pad))
    return out
  }
  if (c.code) {
    c.code.slice(0, cap).forEach((code, i) => out.push(bodyRow({ lead: String(i + 1).padStart(3), code }, pad)))
    const left = (c.total ?? c.code.length) - Math.min(cap, c.code.length)
    if (left > 0) out.push(moreRow(`… +${left} more${hint}`, pad))
    return out
  }
  const b = c.body
  if (!b) return out
  const shown = b.tail ? b.rows.slice(-cap) : b.rows.slice(0, cap)
  const left = b.total - shown.length
  if (left > 0 && b.tail) out.push(moreRow(`… +${left} earlier${hint}`, pad))
  shown.forEach(r => out.push(bodyRow(r, pad)))
  if (left > 0 && !b.tail) out.push(moreRow(`… +${left} more${hint}`, pad))
  return out
}

// ======================================================================= the stream
const LEVELS = ['compact', 'standard', 'detailed', 'verbose']
const CAP = { verbose: 6, change: 12, standardChange: 6, standardInput: 3, open: 40 }

/**
 * The stream's rows at a moment. A view-owned call is reduced by one rule: todo and goal calls are never drawn (their view
 * and the durable goal rows say it); job polls are drawn only at Verbose, as a line; spawns and workflows are one line with
 * no body and no clock, and at Compact not even that. A failure always keeps its line.
 */
function streamRows(ctx) {
  const { t, frame, width, level, openTurns, opened, ctrlO } = ctx
  const blocks = []
  const push = (rows) => { if (rows.length > 0) blocks.push(rows) }
  for (const turn of TURNS) {
    if (t < turn.at) continue
    const closed = t >= turn.end
    const open = ctrlO || openTurns.has(turn.turn)
    const entries = ENTRIES.filter(e => e.turn === turn.turn && present(e, t))
    push(wrapText(turn.prompt, width - 6).map((text, i) => R([s(i === 0 ? '» ' : '  ', 'primary', 'b'), s(text, 'text', 'b')])))
    const tierOf = (step) => {
      if (open) return 'verbose'
      if (level === 'compact') return 'compact'
      if (level === 'standard') return 'standard'
      if (level === 'verbose') return 'verbose'
      return !closed && step ? 'verbose' : 'standard'
    }
    const currentStep = Math.max(...entries.map(stepOf), -1)
    let foldDrawn = false
    let run = []
    const flushRun = () => {
      if (run.length === 0) return
      const group = run
      run = []
      const tier = group[0].tier
      if (tier === 'verbose') { for (const c of group) push(callBlock(c, ctx, open || level === 'verbose' || level === 'detailed')); return }
      if (group[0].group === 'spawn') { push(spawnHead(group, t, frame)); return }
      if (group.length === 1) { push(standardCall(group[0], ctx)); return }
      push(runBlock(group, ctx))
    }
    entries.forEach((e) => {
      const step = stepOf(e) === currentStep
      if (e.kind === 'call') {
        if (isHidden(e, t)) return
        const tier = tierOf(step)
        if (e.quiet && tier !== 'verbose' && !(stateOf(e, t) === 'error')) return
        if (tier === 'compact') {
          if (!foldDrawn) { flushRun(); foldDrawn = true; push(foldLine(turn, ctx)) }
          const state = stateOf(e, t)
          if ((state === 'pending' && !e.owner) || state === 'error') { flushRun(); push([R(lineOf(e, t, frame, width), { id: e.id })]) }
          return
        }
        const fact = { ...e, tier }
        if (run.length > 0 && (e.solo || run[0].solo || run[0].group !== e.group || (run[0].tier !== tier))) flushRun()
        run.push(fact)
        return
      }
      flushRun()
      if (e.kind === 'thinking') {
        const tier = tierOf(step)
        if (tier === 'compact') return
        const live = t < e.end
        const n = Math.ceil(e.lines.length * Math.min(1, (t - e.at) / (e.end - e.at)))
        const shown = e.lines.slice(0, n)
        const head = R([s('✻ ', 'primary'), s('Thinking', 'muted', 'i'), ...live ? [] : [mu(` · ${secs(e.secs)}`)]])
        const cap = tier === 'verbose' ? 8 : 3
        push([head, ...shown.slice(-cap).map(text => R([s(PAD), s(text, 'muted', 'i')]))])
      } else if (e.kind === 'say') {
        const k = Math.min(1, (t - e.at) / (e.end - e.at))
        const chars = [...e.text]
        const text = chars.slice(0, Math.ceil(chars.length * k)).join('')
        push(wrapText(text, width - 6).map((line, i) => R([i === 0 ? s('● ', 'primary') : s(PAD), ...inlineCode(line)])))
      } else if (e.kind === 'goal') {
        push([R([s(`${e.mark} `, e.tone), s(e.text, e.tone === 'danger' ? 'danger' : 'text')])])
      } else if (e.kind === 'round') {
        const label = ` goal round ${e.round} `
        const side = Math.max(2, Math.floor((width - 6 - label.length) / 2))
        push([R([mu('─'.repeat(side)), mu(label), mu('─'.repeat(side))])])
      }
    })
    flushRun()
    if (closed) push([R([s('✻ ', 'faint'), fa(`${turn.outcome === 'Stopped' ? 'Stopped after' : 'Worked for'} ${secs(turn.end - turn.at)} · done ${clockAt(turn.end)}`)])])
  }
  const rows = []
  blocks.forEach((block, i) => { if (i > 0) rows.push(R([])); rows.push(...block) })
  return rows
}

const inlineCode = (line) => {
  const out = []
  let at = 0
  for (const m of line.matchAll(/`[^`]+`/gu)) {
    if (m.index > at) out.push(s(line.slice(at, m.index)))
    out.push(s(m[0].slice(1, -1), 'accent'))
    at = m.index + m[0].length
  }
  if (at < line.length) out.push(s(line.slice(at)))
  return out
}

/** Compact: the turn's process in one line, where its first call was, counting up. */
function foldLine(turn, ctx) {
  const { t, frame } = ctx
  const calls = ENTRIES.filter(e => e.turn === turn.turn && e.kind === 'call' && present(e, t) && !e.hidden && !e.quiet)
  const spawns = calls.filter(c => c.group === 'spawn')
  const tools = calls.filter(c => c.group !== 'spawn')
  const failed = calls.filter(c => stateOf(c, t) === 'error').length
  const added = calls.reduce((n, c) => n + (stateOf(c, t) === 'ok' ? c.stat?.[0] ?? 0 : 0), 0)
  const removed = calls.reduce((n, c) => n + (stateOf(c, t) === 'ok' ? c.stat?.[1] ?? 0 : 0), 0)
  const pending = calls.some(c => stateOf(c, t) === 'pending')
  const elapsed = !pending && calls.length > 0 ? Math.max(...calls.map(c => c.end)) - Math.min(...calls.map(c => c.at)) : undefined
  void frame
  return [R([
    mu('▸ '),
    mu(`${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`),
    ...spawns.length ? [mu(` · ${spawns.length} ${spawns.length === 1 ? 'subagent' : 'subagents'}`)] : [],
    ...added || removed ? [mu(' · '), ...added ? [s(`+${added}`, 'success')] : [], ...added && removed ? [mu(' ')] : [], ...removed ? [s(`−${removed}`, 'danger')] : []] : [],
    ...elapsed === undefined ? [] : [mu(` · ${secs(elapsed)}`)],
    ...failed ? [s(` · ${failed} failed`, 'danger')] : [],
    mu(' · Ctrl+O to expand'),
  ], { id: `turn:${turn.turn}` })]
}

/** Verbose: one block per call. A spawn or workflow stays a line: its detail is its view's. */
function callBlock(c, ctx, verboseLevel) {
  const { t, frame, width, ctrlO, openTurns, opened } = ctx
  const open = ctrlO || openTurns.has(c.turn) || opened.has(c.id)
  const phase = phaseOf(c, t)
  const running = phase !== 'settled'
  const cap = open ? CAP.open : c.file || c.patch ? CAP.change : CAP.verbose
  void verboseLevel
  const body = bodyOf(c, t, { cap: running && !c.file && !c.patch && !c.command && !c.input ? 0 : cap, open })
  return [R(lineOf(c, t, frame, width, { hideTarget: running && c.command !== undefined }), { id: c.id }), ...body]
}

/** Standard, one call alone: its line; a file change also opens at 6 rows. A multi-line command shows its lines while it runs. */
function standardCall(c, ctx) {
  const { t, frame, width, opened } = ctx
  if (opened.has(c.id)) return callBlock(c, { ...ctx }, false)
  const phase = phaseOf(c, t)
  const state = stateOf(c, t)
  if (c.patch && phase === 'settled') {
    return [
      R([glyphOf(state, frame), ...nameSpans(c, state), mu(` · ${c.patch.length} files · `), ...statBar(...c.stat)], { id: c.id }),
      ...c.patch.map((f, i) => R([mu(i === c.patch.length - 1 ? '  └ ' : '  ├ '), s(f.kind, f.kind === 'A' ? 'success' : f.kind === 'D' ? 'danger' : 'warning'), s(` ${f.file}`, 'accent'), mu(` · ${[f.a ? `+${f.a}` : '', f.d ? `−${f.d}` : ''].filter(Boolean).join(' ')}`)])),
    ]
  }
  const line = R(lineOf(c, t, frame, width, { hideTarget: phase === 'running' && c.command !== undefined }), { id: c.id })
  if (phase === 'preparing' || (c.file && state === 'ok') || (phase === 'settled' && c.patch)) return [line, ...bodyOf({ ...c, args: undefined }, t, { cap: CAP.standardChange, open: false })]
  if (phase === 'running' && (c.command || c.input)) return [line, ...bodyOf(c, t, { cap: CAP.standardInput, open: false })]
  return [line]
}

/** A fan-out of spawns: one line. The agents view has every task, its activity, tokens and time. */
function spawnHead(group, t, frame) {
  const settled = group.filter(c => stateOf(c, t) !== 'pending')
  const failed = settled.filter(c => c.state === 'error').length
  const running = settled.length < group.length
  const state = running ? 'pending' : failed === group.length ? 'error' : failed ? 'partial' : 'ok'
  if (group.length === 1) {
    const c = group[0]
    return [R(lineOf(c, t, frame, 200), { id: c.id })]
  }
  return [R([glyphOf(state, frame), s('Subagent', 'text', 'b'), mu(` · ${settled.length}/${group.length}`), ...failed ? [s(` · ${failed} failed`, running ? 'warning' : 'danger')] : []], { id: `spawns:${group[0].id}` })]
}

/** Standard, a run of one kind: a head and a tree. An MCP run's head is its server. */
function runBlock(group, ctx) {
  const { t, frame, opened } = ctx
  const first = group[0]
  const pending = group.some(c => stateOf(c, t) === 'pending')
  const failed = group.filter(c => stateOf(c, t) === 'error').length
  const ok = group.filter(c => stateOf(c, t) === 'ok').length
  const state = pending ? 'pending' : failed === group.length ? 'error' : failed ? 'partial' : 'ok'
  const lineCount = group.reduce((n, c) => n + (stateOf(c, t) === 'ok' ? c.lines ?? 0 : 0), 0)
  const matches = group.reduce((n, c) => n + (stateOf(c, t) === 'ok' ? c.matches ?? 0 : 0), 0)
  const start = Math.min(...group.map(c => c.at))
  const span = pending ? (t - start >= 1 ? secs(t - start) : undefined) : (Math.max(...group.map(c => c.end)) - start >= 1 ? dur(Math.max(...group.map(c => c.end)) - start) : undefined)
  const names = new Set(group.map(c => c.tool))
  const name = first.server ?? (names.size === 1 ? first.tool : first.title ?? first.tool)
  const count = `${group.length} ${group.length === 1 ? first.unit[0] : first.unit[1]}`
  void ok
  const head = [count, lineCount ? `${lineCount} lines` : undefined, matches ? `${matches} ${matches === 1 ? 'match' : 'matches'}` : undefined, span].filter(Boolean).join(' · ')
  const rows = [R([glyphOf(state, frame), s(name, 'text', 'b'), mu(` · ${head}`), ...failed ? [s(` · ${failed} failed`, pending || state === 'partial' ? 'warning' : 'danger')] : []], { id: `head:${first.id}` })]
  group.forEach((c, i) => {
    const last = i === group.length - 1
    const itemState = stateOf(c, t)
    const label = c.server ? `${c.tool}(${c.target})` : phaseOf(c, t) === 'running' && c.command ? c.command[0] : c.target ?? c.tool
    const outcome = outcomeOf(c, t)
    rows.push(R([mu(last ? '  └ ' : '  ├ '), ...miniGlyph(itemState, frame), s(label, 'accent'), ...outcome.length ? [mu(` · ${outcome.join(' · ')}`)] : []], { id: c.id }))
    const pad = last ? '      ' : '  │   '
    if (opened.has(c.id)) rows.push(...bodyOf(c, t, { cap: CAP.open, open: true, pad }))
    else if (phaseOf(c, t) === 'running' && c.command) c.command.slice(1, CAP.standardInput + 1).forEach(text => rows.push(R([s(pad), ...hl(text)])))
  })
  return rows
}

// ======================================================================= the activity row
const TIPS = ['Tip: Enter on a spawn line moves to its view', 'Tip: Alt+↓ opens the view of what runs', 'Tip: Ctrl+O opens the last three turns', 'Tip: Alt+↑ selects a call; Enter opens it']
const THINK = [[0, 'Pondering', 'muted', ''], [5, 'Mulling', 'text', ''], [15, 'DeepThinking', 'primary', ''], [45, 'Fathoming', 'accent', 'b']]

function activityRow(ctx) {
  const { t, frame, rowOption } = ctx
  const turn = TURNS.find(x => t >= x.at && t < x.end)
  if (turn === undefined) return []
  const entries = ENTRIES.filter(e => e.turn === turn.turn)
  const flight = entries.filter(e => isFlight(e, t))
  const thinking = entries.find(e => e.kind === 'thinking' && t >= e.at && t < e.end)
  const saying = entries.find(e => e.kind === 'say' && t >= e.at && t < e.end)
  const elapsed = secs(t - turn.at)
  const tokens = kilo(Math.floor((t - turn.at) * 24))
  const INDENT = s('  ')
  const tip = R([mu('    ⎿ '), fa(TIPS[Math.floor(t / 15) % TIPS.length])])
  if (flight.length > 0) {
    const preparing = flight.every(c => phaseOf(c, t) === 'preparing')
    const fullName = c => (c.server ? `${c.server} › ${c.tool}` : c.tool)
    const names = []
    for (const c of flight) if (!names.includes(fullName(c))) names.push(fullName(c))
    const kinds = new Set(flight.map(c => c.activity[0]))
    const label = kinds.size === 1 ? flight[0].activity[preparing ? 1 : 0] : preparing ? `Preparing ${flight.length} tool calls` : `Running ${flight.length} tools`
    const oldest = Math.max(...flight.map(c => t - c.at))
    const header = [INDENT, s('●', 'primary'), s(' '), ...shimmer(label, frame)]
    if (rowOption === 'b') {
      const parts = flight.filter(c => c.target).map(c => (kinds.size === 1 ? c.target : `${fullName(c)} ${c.target}`))
      return [R([]), R(header), parts.length ? R([mu('    ⎿ '), s([...new Set(parts)].slice(0, 3).join(' · '))]) : tip]
    }
    const tail = [...flight.length > 1 && names.length === 1 ? [`${flight.length} in flight`] : [], ...flight.length > 1 && oldest >= 10 ? [`oldest ${secs(oldest)}`] : []]
    return [R([]), R([...header, ...tail.length ? [mu(` · ${tail.join(' · ')}`)] : []]), names.length > 1 ? R([mu('    ⎿ '), s(names.slice(0, 3).join(' · ')), ...names.length > 3 ? [mu(` +${names.length - 3} more`)] : []]) : tip]
  }
  if (thinking) {
    const since = t - thinking.at
    const stage = THINK.findLast(x => since >= x[0])
    return [R([]), R([INDENT, s(BLOOM[frame % BLOOM.length], 'primary'), s(' '), s(stage[1], stage[2], stage[3]), mu(` · ${secs(since)} · ↓${tokens} · ${38 + (frame % 5)} tok/s`)]), tip]
  }
  const label = saying ? 'Writing' : 'Deep diving'
  return [R([]), R([INDENT, s(FILL[frame % FILL.length], 'primary'), s(` ${label}`), mu(` · ${elapsed} · ↓${tokens}`)]), tip]
}

// ======================================================================= the views
const span2 = (mark, tone, name, progress) => [s(mark, tone), s(' '), mu(`${name} `), s(progress)]

function agentsItem(t) {
  const live = AGENTS.filter(a => t >= a.at)
  if (live.length === 0) return null
  const settled = live.filter(a => t >= a.end)
  const failed = settled.some(a => a.outcome === 'failed')
  const running = settled.length < live.length
  return { id: 'agents', spans: span2(failed ? '✕' : running ? '●' : '✓', failed ? 'danger' : running ? 'accent' : 'success', 'agents', `${settled.length}/${live.length}`) }
}
function jobsItem(t) {
  const started = JOBS.filter(j => t >= j.at)
  if (started.length === 0) return null
  const live = started.filter(j => t < j.end)
  if (live.length > 0) return { id: 'jobs', spans: span2('●', 'accent', 'jobs', live.length) }
  if (t < Math.max(...started.map(j => j.end)) + JOB_LINGER) return { id: 'jobs', spans: span2('✓', 'success', 'jobs', `${started.length}/${started.length}`) }
  return null
}
function workflowItem(t) {
  const run = WORKFLOWS.find(w => t >= w.at && t < w.end + WORKFLOW_LINGER)
  if (!run) return null
  const started = run.agents.filter(a => t >= a.at)
  const settled = started.filter(a => t >= a.end)
  const done = t >= run.end
  return { id: 'workflow', spans: span2(done ? '✓' : '●', done ? 'success' : 'accent', 'workflow', `${settled.length}/${started.length}`) }
}
function goalRounds(t) { return GOAL.roundAt.filter(([at]) => t >= at).length }
function goalItem(t) {
  if (t < GOAL.at) return null
  const blocked = t >= GOAL.blockedAt
  return { id: 'goal', spans: span2(blocked ? '✕' : '●', blocked ? 'danger' : 'accent', 'goal', `${goalRounds(t)}/${GOAL.rounds}`) }
}
function todoItem(t) {
  if (t < TODO_AT) return null
  const done = TODOS.filter(x => t >= x.done).length
  const lastDone = Math.max(...TODOS.map(x => x.done))
  if (done === TODOS.length) return t < lastDone + TODO_LINGER ? { id: 'todo', spans: span2('✓', 'success', 'todo', `${done}/${done}`) } : null
  return { id: 'todo', spans: span2('●', 'accent', 'todo', `${done}/${TODOS.length}`) }
}
const viewItems = t => [agentsItem(t), jobsItem(t), workflowItem(t), goalItem(t), todoItem(t)].filter(Boolean)

const VIEW_ROWS = 7
const PANEL_KEYS = {
  agents: '↑/↓ select · Enter open · x stop · Esc back',
  jobs: '↑/↓ select · Enter open · x stop · Esc back',
  workflow: '↑/↓ select · Enter open · x stop · Esc back',
  todo: '↑/↓ scroll · Esc back',
}
/** The hint row names only the keys that apply: a blocked goal resumes, an armed one pauses. */
const panelKeys = (view, t) => view !== 'goal' ? PANEL_KEYS[view] : `↑/↓ scroll · ${t >= GOAL.blockedAt ? 'r resume' : 'p pause'} · e edit · c clear · Esc back`

/** The columns of a list row: mark, name, what it does, and the figures at the right edge. */
function columnsRow({ mark, tone, name, nameW, what, right, selected, width }) {
  const lead = [s(selected ? '→ ' : '  ', 'primary'), s(`${mark} `, tone), s(name.padEnd(nameW))]
  const rightCells = [...right].length
  const room = Math.max(0, width - cellsOf(lead) - rightCells - 3)
  const text = [...what].length <= room ? what : `${[...what].slice(0, Math.max(0, room - 1)).join('')}…`
  const gap = Math.max(1, width - cellsOf(lead) - 1 - [...text].length - rightCells - 1)
  return R([...lead, s(' '), s(text, 'muted'), s(' '.repeat(gap)), mu(right)], selected ? { bg: BAND.sel } : {})
}

function panelRows(view, t, frame, cursor, width, rowsWanted) {
  const list = (rows) => {
    const start = Math.max(0, Math.min(cursor - rowsWanted + 2, rows.length - rowsWanted))
    const window = rows.slice(start, start + rowsWanted)
    if (start + rowsWanted < rows.length) window[window.length - 1] = R([mu(`  ↓ ${rows.length - start - rowsWanted + 1} more`)])
    while (window.length < rowsWanted) window.push(R([]))
    return window
  }
  void frame
  if (view === 'agents') {
    const all = AGENTS.filter(a => t >= a.at)
    const order = [...all.filter(a => t < a.end), ...all.filter(a => t >= a.end)]
    const nameW = Math.max(...order.map(a => a.name.length + 4))
    return list(order.map((a, i) => {
      const live = t < a.end
      const elapsed = (live ? t : a.end) - a.at
      const act = a.acts.findLast(x => (live ? t : a.end) >= x[0])?.[1] ?? 'Thinking…'
      const input = 8000 + elapsed * a.rate[0] * 1000
      const output = elapsed * a.rate[1] * 1000
      const rate = live ? `${String(30 + Math.floor(t * 3) % 25)} tok/s · ` : ''
      const mark = !live ? (a.outcome === 'failed' ? '✕' : '✓') : '●'
      const tone = !live ? (a.outcome === 'failed' ? 'danger' : 'success') : 'accent'
      return columnsRow({ mark, tone, name: `${a.name}(${a.mode})`, nameW, what: live ? act : a.outcome === 'failed' ? `${a.task} · failed` : a.task, right: `↑${kilo(input)}  ↓${kilo(output)}  ${rate}${live ? '' : '· '}${secs(elapsed)}`, selected: i === cursor, width })
    }))
  }
  if (view === 'jobs') {
    const live = JOBS.filter(j => t >= j.at && t < j.end)
    const rows = (live.length ? live : JOBS.filter(j => t >= j.at)).map((j, i) => {
      const running = t < j.end
      const what = running ? j.progress.findLast(x => t >= x[0])[1] : 'stopped'
      return columnsRow({ mark: running ? '●' : '⊘', tone: running ? 'accent' : 'muted', name: j.name, nameW: 12, what, right: secs((running ? t : j.end) - j.at), selected: i === cursor, width })
    })
    return list(rows)
  }
  if (view === 'workflow') {
    const run = WORKFLOWS.find(w => t >= w.at)
    if (!run) return list([])
    const done = t >= run.end
    const phaseIndex = run.phases.findLastIndex(p => t >= p[1])
    const phase = run.phases[phaseIndex]
    const head = R([s('  '), s(run.name, 'text', 'b'), mu(done ? ` · completed · ${run.agents.length} agents · ${secs(run.end - run.at)}` : ` · ${phase[0]} · phase ${phaseIndex + 1}/${run.phases.length} · ${secs(t - run.at)}`)])
    const started = run.agents.filter(a => t >= a.at)
    const order = [...started.filter(a => t < a.end), ...started.filter(a => t >= a.end).reverse()]
    const nameW = Math.max(...run.agents.map(a => a.label.length))
    const rows = order.map((a, i) => columnsRow({ mark: t < a.end ? '●' : '✓', tone: t < a.end ? 'accent' : 'success', name: a.label, nameW, what: a.phase, right: '', selected: i === cursor, width }))
    return [head, ...list(rows).slice(0, rowsWanted - 1)]
  }
  if (view === 'goal') {
    const blocked = t >= GOAL.blockedAt
    const rows = [...wrapText(GOAL.objective, width - 4).map(text => R([s('  '), s(text)])), ...blocked ? [R([s('  '), s(`blocked · ${GOAL.code}: `, 'danger'), mu(GOAL.reason)])] : []]
    while (rows.length < rowsWanted) rows.push(R([]))
    return rows.slice(0, rowsWanted)
  }
  const live = TODOS.filter(x => t < x.done)
  const rows = live.map((x) => {
    const on = t >= x.start
    return R([s('  '), on ? s('● ', 'primary', 'b') : mu('○ '), s(x.text, on ? 'text' : 'muted', on ? 'b' : '')])
  })
  while (rows.length < rowsWanted) rows.push(R([]))
  return rows.slice(0, rowsWanted)
}

const panelCount = (view, t) => {
  if (view === 'agents') return AGENTS.filter(a => t >= a.at).length
  if (view === 'jobs') return Math.max(1, JOBS.filter(j => t >= j.at && t < j.end).length)
  if (view === 'workflow') return WORKFLOWS.find(w => t >= w.at)?.agents.filter(a => t >= a.at).length ?? 0
  return 0
}

// ======================================================================= the status row
const FACTS = [
  { id: 'model', cells: [s('deepseek-flash', 'text'), s(' High', 'muted')], drop: 9 },
  { id: 'dir', cells: [mu('~/work/mayfly')], drop: 2 },
  { id: 'git', cells: [mu('main ±3')], drop: 1 },
]

function statusRow(t, width, active) {
  const items = viewItems(t)
  const ctx = Math.min(95, 12 + Math.floor(t * 0.6))
  const cache = 34 + Math.floor(t / 4) % 40
  const bar = (v, n) => { const k = Math.round(v / 100 * n); return '▰'.repeat(k) + '▱'.repeat(n - k) }
  const rights = [
    [mu('cache '), s(bar(cache, 5), 'primary'), mu(` ${cache}%  `), mu('ctx '), s(bar(ctx, 10), ctx >= 90 ? 'danger' : ctx >= 70 ? 'warning' : 'primary'), mu(` ${ctx}%`)],
    [mu('ctx '), s(bar(ctx, 10), ctx >= 90 ? 'danger' : ctx >= 70 ? 'warning' : 'primary'), mu(` ${ctx}%`)],
    [mu(`ctx ${ctx}%`)],
    [],
  ]
  const itemCells = items.reduce((n, item) => n + cellsOf(item.spans) + 2, 0)
  let facts = [...FACTS]
  let right = rights[0]
  const need = () => facts.reduce((n, f) => n + cellsOf(f.cells) + 2, 0) + itemCells + cellsOf(right) + 1
  for (const r of rights) { right = r; if (need() <= width) break }
  while (need() > width && facts.length > 0) { facts = facts.toSorted((a, b) => b.drop - a.drop); facts.pop(); facts = FACTS.filter(f => facts.includes(f)) }
  const left = []
  let column = 0
  let mark
  const add = (spans) => { for (const span of spans) left.push(span); column += cellsOf(spans) }
  for (const f of facts) { add(f.cells); add([s('  ')]) }
  for (const item of items) {
    if (item.id === active) mark = { from: column, cells: cellsOf(item.spans) }
    add(item.spans)
    add([s('  ')])
  }
  const gap = Math.max(1, width - column - cellsOf(right))
  const main = R([...left, s(' '.repeat(gap)), ...right])
  const under = mark ? R([s(' '.repeat(mark.from)), s('━'.repeat(mark.cells), 'primary', 'b')]) : null
  return { main, under }
}

// ======================================================================= the screen
function notification(ctx) {
  const { t, width, focus, flash } = ctx
  const blocked = t >= GOAL.blockedAt
  const running = TURNS.some(x => t >= x.at && t < x.end)
  const left = flash ? [s('ℹ ', 'primary'), s(flash)]
    : blocked ? [s('⚠ ', 'warning'), s('Goal blocked · auth: the github token has expired', 'warning')]
      : []
  const hint = focus === 'stream' ? '↑/↓ move · Enter open or close · Esc back'
    : focus === 'views' ? ''
      : running ? 'Alt+↑ conversation · Alt+↓ view · Esc interrupt' : 'Alt+↑ conversation · Alt+↓ view'
  const fits = cellsOf(left) === 0 || cellsOf(left) + [...hint].length + 6 <= width
  const gap = fits ? Math.max(0, width - 2 - cellsOf(left) - [...hint].length - 2) : 0
  return R([s('  '), ...left, s(' '.repeat(gap)), ...fits ? [fa(hint)] : []])
}

function editorRows(ctx) {
  const { t, width, focus } = ctx
  const turn = TURNS.findLast(x => t >= x.at)
  const title = turn ? ` ${turn.title} ` : ''
  const inner = width - 2
  const top = `╭${'─'.repeat(Math.max(0, inner - [...title].length))}`
  const caret = focus === 'editor' ? s('▌', 'primary') : s(' ')
  const hint = [...'Ask anything · / commands · @ files · # skills · ! shell'].slice(0, Math.max(0, inner - 6)).join('')
  const fill = Math.max(0, inner - 5 - [...hint].length)
  return [
    R([s(top, 'border'), s(title, 'muted'), s('╮', 'border')]),
    R([s('│ ', 'border'), s('> ', 'primary'), caret, fa(hint), s(' '.repeat(fill)), s(' │', 'border')]),
    R([s(`╰${'─'.repeat(Math.max(0, inner))}╯`, 'border')]),
  ]
}

function chromeRows(ui, width) {
  const chapter = CHAPTERS.findLast(c => ui.t >= c.at) ?? CHAPTERS[0]
  const index = CHAPTERS.indexOf(chapter) + 1
  const total = TURNS.at(-1).end + 2
  const play = ui.paused ? '❚❚' : ui.t >= total ? '■' : '▶'
  const time = `${Math.floor(ui.t / 60)}:${String(Math.floor(ui.t % 60)).padStart(2, '0')}`
  return [
    R([s(` ${play} ${time} ×${ui.speed}`, 'warning', 'b'), mu('  '), s(`${index}/${CHAPTERS.length} ${chapter.name}`, 'strong', 'b'), mu('  level '), s(`${LEVELS.indexOf(ui.level) + 1} ${ui.level}`, 'accent', 'b'), ...ui.ctrlO ? [s(' + Ctrl+O', 'accent')] : [], mu('  row '), s(ui.rowOption.toUpperCase(), 'accent'), mu('  tour '), s(ui.tour ? 'on' : 'off', 'accent')], { bg: BAND.chrome }),
    R([s(' look: ', 'warning'), s(chapter.look, 'text')], { bg: BAND.chrome }),
    R([fa(' 1-4 level · Ctrl+O open · Alt+↓/v view · Alt+↑/s select · space pause · , . chapter · [ ] seek · + - speed · a row · t tour · c hide · r restart · q quit')], { bg: BAND.chrome }),
  ]
}

/** One whole frame: exactly `height` rows of exactly `width` cells. */
function compose(ui, width, height) {
  const ctx = {
    t: ui.t, frame: ui.frame, width, level: ui.level, ctrlO: ui.ctrlO, openTurns: ui.openTurns, opened: ui.opened,
    rowOption: ui.rowOption, focus: ui.focus, flash: ui.flash,
  }
  const chrome = ui.chrome ? chromeRows(ui, width) : []
  const activity = activityRow(ctx)
  const notify = [notification(ctx)]
  const editor = editorRows(ctx)
  const active = ui.focus === 'views' ? ui.view : undefined
  const status = statusRow(ui.t, width, active)
  const laneRows = Math.max(3, Math.min(VIEW_ROWS, Math.floor(height / 3) - 2))
  const lane = status.under
    ? [status.under, ...panelRows(ui.view, ui.t, ui.frame, ui.cursor[ui.view] ?? 0, width, laneRows), R([fa(`  ${panelKeys(ui.view, ui.t)}`)])]
    : []
  const bottom = [...activity, ...notify, ...editor, status.main, ...lane]
  const room = Math.max(1, height - chrome.length - bottom.length)
  const all = streamRows(ctx).map(row => R([s('  '), ...row.spans], row))
  // The cursor of the stream: the selected row wears the → in the gutter.
  const selectable = all.map((row, i) => [row, i]).filter(([row]) => row.id !== undefined)
  ui.selectable = selectable.map(([row]) => row.id)
  let selectedIndex = -1
  if (ui.focus === 'stream' && selectable.length > 0) {
    let pos = selectable.findIndex(([row]) => row.id === ui.selected)
    if (pos < 0) pos = selectable.length - 1
    ui.selected = selectable[pos][0].id
    selectedIndex = selectable[pos][1]
    const row = all[selectedIndex]
    all[selectedIndex] = R([s('→ ', 'primary', 'b'), ...row.spans.slice(1)], { ...row, bg: BAND.sel })
  }
  const maxBack = Math.max(0, all.length - room)
  if (selectedIndex >= 0) {
    const end = all.length - ui.scrollBack
    const start = end - room
    if (selectedIndex < start) ui.scrollBack = all.length - selectedIndex - room
    else if (selectedIndex >= end) ui.scrollBack = all.length - selectedIndex - 1
  }
  ui.scrollBack = Math.max(0, Math.min(ui.scrollBack, maxBack))
  const end = all.length - ui.scrollBack
  const shown = all.slice(Math.max(0, end - room), end)
  const pad = Array.from({ length: Math.max(0, room - shown.length) }, () => R([]))
  const rows = [...chrome, ...shown, ...pad, ...bottom]
  return rows.slice(0, height).map(row => paintRow(row, width))
}

// ======================================================================= state and keys
const END = TURNS.at(-1).end + 2

function newState() {
  return {
    t: 0, frame: 0, speed: 1, paused: false, level: LEVELS.includes(opt('level')) ? opt('level') : 'standard', ctrlO: false, openTurns: new Set(), opened: new Set(),
    rowOption: opt('row', 'a') === 'b' ? 'b' : 'a', tour: true, focus: 'editor', view: 'todo', cursor: {}, scrollBack: 0, selected: undefined, selectable: [], chrome: !flag('no-chrome'), flash: undefined, flashUntil: 0, tourView: undefined,
  }
}

/** The tour opens the view its chapter is about, while the chapter lasts and the view exists. */
function applyTour(ui) {
  if (!ui.tour) return
  const chapter = CHAPTERS.findLast(c => ui.t >= c.at)
  const wanted = chapter?.view && ui.t < (chapter.until ?? Infinity) && viewItems(ui.t).some(item => item.id === chapter.view) ? chapter.view : undefined
  if (wanted) { ui.focus = 'views'; ui.view = wanted; ui.tourView = wanted } else if (ui.tourView) { ui.tourView = undefined; if (ui.focus === 'views') ui.focus = 'editor' }
}

function keepView(ui) {
  if (ui.focus !== 'views') return
  const items = viewItems(ui.t)
  if (items.length === 0) { ui.focus = 'editor'; return }
  if (!items.some(item => item.id === ui.view)) ui.view = items[0].id
  const n = panelCount(ui.view, ui.t)
  ui.cursor[ui.view] = Math.max(0, Math.min(ui.cursor[ui.view] ?? 0, Math.max(0, n - 1)))
}

function say(ui, text) { ui.flash = text; ui.flashUntil = Date.now() + 2600 }

function seek(ui, t) { ui.t = Math.max(0, Math.min(END, t)); ui.scrollBack = 0 }

function onKey(ui, key) {
  if (key === 'q' || key === '\x03') return 'quit'
  if (key === ' ') { ui.paused = !ui.paused; if (ui.t >= END) { seek(ui, 0); ui.paused = false } return }
  if (key === 'r') { seek(ui, 0); ui.paused = false; ui.tour = true; ui.focus = 'editor'; ui.opened.clear(); ui.openTurns.clear(); ui.ctrlO = false; return }
  if (key === '1' || key === '2' || key === '3' || key === '4') { ui.level = LEVELS[Number(key) - 1]; ui.scrollBack = 0; return }
  if (key === '\x0f') { ui.ctrlO = !ui.ctrlO; ui.scrollBack = 0; return }
  if (key === 'a') { ui.rowOption = ui.rowOption === 'a' ? 'b' : 'a'; return }
  if (key === 't') { ui.tour = !ui.tour; if (!ui.tour) ui.tourView = undefined; return }
  if (key === 'c') { ui.chrome = !ui.chrome; return }
  if (key === '+' || key === '=') { ui.speed = Math.min(8, ui.speed * 2); return }
  if (key === '-') { ui.speed = Math.max(0.25, ui.speed / 2); return }
  if (key === ',' || key === '.') {
    const i = CHAPTERS.findLastIndex(c => ui.t >= c.at)
    const at = key === '.' ? CHAPTERS[Math.min(CHAPTERS.length - 1, i + 1)].at : ui.t - CHAPTERS[i].at > 1.5 ? CHAPTERS[i].at : CHAPTERS[Math.max(0, i - 1)].at
    seek(ui, at); return
  }
  if (key === '[' || key === ']') { seek(ui, ui.t + (key === ']' ? 5 : -5)); return }
  if (key === '\x1b[5~') { ui.scrollBack += 10; return }
  if (key === '\x1b[6~') { ui.scrollBack = Math.max(0, ui.scrollBack - 10); return }
  const altDown = key === '\x1b[1;3B' || key === '\x1b\x1b[B' || key === '\x1b[17~' || (key === 'v' && ui.focus !== 'views')
  const altUp = key === '\x1b[1;3A' || key === '\x1b\x1b[A' || (key === 's' && ui.focus !== 'stream')
  if (altDown) {
    ui.tour = false; ui.tourView = undefined
    const items = viewItems(ui.t)
    if (items.length === 0) { say(ui, 'No view yet: nothing runs or is planned at this moment'); return }
    ui.focus = 'views'
    if (!items.some(item => item.id === ui.view)) ui.view = items[0].id
    return
  }
  if (altUp) { ui.focus = 'stream'; ui.tour = false; ui.tourView = undefined; return }
  if (key === '\x1b') {
    if (ui.focus === 'views') { ui.tour = false; ui.tourView = undefined }
    ui.focus = 'editor'; return
  }
  const up = key === '\x1b[A', down = key === '\x1b[B', left = key === '\x1b[D', right = key === '\x1b[C', enter = key === '\r' || key === '\n'
  if (ui.focus === 'views') {
    ui.tour = false; ui.tourView = undefined
    const items = viewItems(ui.t)
    const i = items.findIndex(item => item.id === ui.view)
    if (left && i > 0) ui.view = items[i - 1].id
    if (right && i < items.length - 1) ui.view = items[i + 1].id
    const n = panelCount(ui.view, ui.t)
    if (up) ui.cursor[ui.view] = Math.max(0, (ui.cursor[ui.view] ?? 0) - 1)
    if (down) ui.cursor[ui.view] = Math.min(Math.max(0, n - 1), (ui.cursor[ui.view] ?? 0) + 1)
    if (enter && n > 0) say(ui, ui.view === 'jobs' ? 'Enter opens the job output in the reader (not drawn here)' : 'Enter opens that child conversation; F7 returns (not drawn here)')
    if (key === 'x' && n > 0) say(ui, ui.view === 'workflow' ? 'x stops a background run behind Yes/No; a foreground run stops with Esc' : 'x stops it behind the shared Yes/No (not drawn here)')
    return
  }
  if (ui.focus === 'stream') {
    const ids = ui.selectable
    const i = ids.indexOf(ui.selected)
    if (up && i > 0) ui.selected = ids[i - 1]
    if (down && i < ids.length - 1) ui.selected = ids[i + 1]
    if (enter && ui.selected !== undefined) {
      const id = ui.selected
      const c = ENTRIES.find(e => e.id === id)
      if (id.startsWith('spawns:') || c?.owner === 'agents') { ui.focus = 'views'; ui.view = 'agents'; ui.tour = false; ui.tourView = undefined; return }
      if (c?.owner === 'workflow') { ui.focus = 'views'; ui.view = 'workflow'; ui.tour = false; ui.tourView = undefined; return }
      if (id.startsWith('turn:')) { const n = Number(id.slice(5)); if (ui.openTurns.has(n)) ui.openTurns.delete(n); else ui.openTurns.add(n); return }
      if (id.startsWith('head:')) return
      if (ui.opened.has(id)) ui.opened.delete(id); else ui.opened.add(id)
    }
  }
}

// ======================================================================= entry points
function printChapters() {
  CHAPTERS.forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}  ${`${Math.floor(c.at / 60)}:${String(Math.floor(c.at % 60)).padStart(2, '0')}`.padStart(5)}  ${c.name.padEnd(26)} ${c.look}`)
  })
}

function smoke() {
  let frames = 0
  let bad = 0
  const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '')
  for (const [width, height] of [[40, 24], [60, 24], [80, 24], [100, 30], [120, 40], [160, 50]]) {
    for (const level of LEVELS) {
      for (let t = 0; t <= END; t += 0.5) {
        for (const focus of ['editor', 'views', 'stream']) {
          const ui = newState()
          Object.assign(ui, { t, frame: Math.floor(t * 12), level, focus })
          if (focus === 'views') {
            const items = viewItems(t)
            if (items.length === 0) continue
            for (const item of items) {
              ui.view = item.id
              check(compose(ui, width, height), width, height, `${width}x${height} ${level} t=${t} view=${item.id}`)
            }
            continue
          }
          check(compose(ui, width, height), width, height, `${width}x${height} ${level} t=${t} ${focus}`)
        }
      }
    }
  }
  function check(rows, width, height, where) {
    frames += 1
    if (rows.length !== height) { bad += 1; console.error(`rows ${rows.length} != ${height}: ${where}`) }
    for (const row of rows) {
      const cells = [...strip(row)].length
      if (cells !== width) { bad += 1; console.error(`cells ${cells} != ${width}: ${where}: ${strip(row)}`); break }
    }
  }
  console.log(`${frames} frames, ${bad} bad`)
  process.exit(bad === 0 ? 0 : 1)
}

function printFrame(t) {
  const ui = newState()
  ui.t = t
  ui.frame = Math.floor(t * 12)
  ui.ctrlO = flag('open')
  const view = opt('view')
  if (view) { ui.focus = 'views'; ui.view = view }
  if (flag('select')) ui.focus = 'stream'
  const width = Number(opt('width', 100))
  const height = Number(opt('height', 34))
  for (const row of compose(ui, width, height)) console.log(row.trimEnd())
}

function play() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('This plays in a terminal. Without one, use --frame <seconds>, --chapters, or --smoke.')
    process.exit(1)
  }
  const ui = newState()
  const out = process.stdout
  const leave = () => { out.write('\x1b[?2026l\x1b[?7h\x1b[?25h\x1b[?1049l'); process.stdin.setRawMode(false) }
  process.on('exit', leave)
  process.on('SIGTERM', () => process.exit(0))
  out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J')
  out.on('resize', () => out.write('\x1b[2J'))
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (chunk) => {
    const keys = chunk.toString('utf8').match(/\x1b\x1b\[[0-9;:]*[A-Za-z~]|\x1b\[[0-9;:]*[A-Za-z~]|\x1bO[\s\S]|\x1b[\s\S]|[\s\S]/gu) ?? []
    for (const key of keys) if (onKey(ui, key) === 'quit') process.exit(0)
    draw()
  })
  let last = Date.now()
  function draw() {
    if (ui.flash && Date.now() > ui.flashUntil) ui.flash = undefined
    applyTour(ui)
    keepView(ui)
    const width = out.columns || 100
    const height = out.rows || 30
    const rows = compose(ui, width, height)
    out.write(`\x1b[?2026h\x1b[H${rows.join('\r\n')}\x1b[?2026l`)
  }
  setInterval(() => {
    const now = Date.now()
    if (!ui.paused && ui.t < END) ui.t = Math.min(END, ui.t + (now - last) / 1000 * ui.speed)
    last = now
    ui.frame += 1
    draw()
  }, 80)
  draw()
}

if (flag('chapters')) printChapters()
else if (flag('smoke')) smoke()
else if (opt('frame') !== undefined) printFrame(Number(opt('frame')))
else play()
