/**
 * Mayfly's own components: the status bar, the editor, the activity row, panes, the tray, the transcript,
 * and the panels behind each command.
 *
 * The rule this file exists to prove: **every Mayfly component is built from the basic components and
 * nothing else.** It imports only `ui-kit.mjs`, never paints a character itself, never reads a terminal
 * width, and never touches key handling. A downstream plugin has the same API, so a plugin can build any
 * of these. `ui-preview.mjs --audit` checks the import rule and prints which basic components each
 * Mayfly component uses.
 *
 * Each component is a pure function from facts (plain data) to a node tree.
 *
 * @module docs/design/prototypes/mayfly-components
 */

import { ui, patterns, defineComponent, fmtDur } from './ui-kit.mjs'

const M = (name, render) => defineComponent(`mayfly.${name}`, 'mayfly', render)
const span = (text, tone, styles) => ({ text, ...(tone ? { tone } : {}), ...(styles ? { styles } : {}) })
const muted = text => span(text, 'muted')

// ======================================================================= status bar
/**
 * Status row 1 is facts: model, mode chips, context, directory, git, balance. Each entry is a rich-text node with a
 * band and a priority; the row admits them in priority order and drops what does not fit. Row 2 is the views
 * (`ViewRow`: agents, jobs, goal, todo); both rows are separate components that a plugin can reorder or extend.
 */
export const StatusBar = M('StatusBar', ({ facts, extra = [] }) => {
  const f = facts
  const chips = []
  if (f.plan) chips.push(span(f.planPending ? 'PLAN…' : 'PLAN', 'primary', ['strong']))
  if (f.yolo) chips.push(span('YOLO', 'warning', ['strong']))
  const entries = [
    { id: 'basic', priority: 0, band: 'left', spans: [span(`${f.model}${f.effort ? ' ' + f.effort : ''}`)] },
    chips.length ? { id: 'mode', priority: 1, band: 'left', spans: chips.flatMap((c, i) => (i ? [span('  '), c] : [c])) } : null,
    { id: 'context', priority: 4, band: 'right', overflow: 'hide', spans: [muted(`cache ${f.cache}%  context: ${f.context}% (${f.tokens})`)] },
    { id: 'cwd', priority: 5, band: 'left', overflow: 'truncate', spans: [muted(f.cwd)] },
    { id: 'git', priority: 10, band: 'left', spans: [muted(f.git)] },
    f.balanceLow ? { id: 'balance', priority: 6, band: 'right', spans: [span(`⚠ ${f.balanceLow}`, 'warning')] } : null,
    ...extra,
  ].filter(Boolean)
  return ui.stack.row(entries.map(e => ui.child(ui.richText(e.spans), { priority: e.priority, band: e.band, overflow: e.overflow })), { gap: 2 })
})

// ======================================================================= editor
/**
 * The prompt: a rounded frame with the conversation title in its top-right corner. The mode shows as the frame's
 * border color (shell mode) and the prompt symbol, never as text in the status bar. Images, pasted content, and
 * @ mentions are tokens inside the input (`[Image #1 84 KB ×]`); the first Backspace selects the last token and the
 * second removes it. Queued messages are one truncated line above the frame. Up and Down on an empty prompt recall
 * the queue first, then the history.
 */
export const Editor = M('Editor', ({ title, mode = 'prompt', tokens = [], queued = [], recall = [], placeholder, completions, value = '', reset, autofocus = true }) => ui.stack.column([
  queued.length ? ui.richText([muted(`queued (${queued.length})  `), ...queued.slice(0, 3).flatMap((q, i) => [muted('⏎ '), span(`"${q.length > 22 ? q.slice(0, 21) + '…' : q}"`), span('  ')]), ...(queued.length > 3 ? [muted(`+${queued.length - 3}`)] : []), muted(' ↑ recall')], { overflow: 'truncate' }) : null,
  ui.surface({ title, titleAlign: 'right', chrome: 'surface', hint: 'completions', border: mode === 'shell' ? 'accent' : undefined, child: ui.prompt({ id: 'prompt', autofocus, symbol: mode === 'shell' ? '! ' : '> ', symbolTone: mode === 'shell' ? 'accent' : undefined, value, tokens, recall, placeholder, completions, reset, recallLabel: 'history' }) }),
]))

// ======================================================================= activity row and tool rows
const COUNTS = ({ elapsed, up, down, rate }) => [elapsed != null ? fmtDur(elapsed) : null, up != null ? `↑${up} ↓${down ?? 0}` : null, rate ? `${rate} tok/s` : null].filter(Boolean).join(' · ')

/**
 * The single present-tense row. One motion channel per row: the glyph or the label animates, never both.
 * Detail lines describe the one action running now, under `⎿`.
 */
export const ActivityRow = M('ActivityRow', ({ phase, label, detail = [], counts = {}, tip, gap, narrow }) => {
  if (phase === 'idle') return null
  const glyph = {
    thinking: ui.loader({ variant: 'bloom' }), working: ui.loader({ variant: 'fill' }), waiting: ui.loader({ variant: 'breath' }),
    tool: ui.richText([span('●', 'primary')]), user: ui.richText([span('?', 'warning', ['strong'])]), stopping: ui.richText([span('■', 'danger', ['strong'])]),
  }[phase]
  const text = phase === 'tool' ? ui.richText([{ text: label, motion: 'shimmer' }]) : ui.richText([span(label, phase === 'user' ? 'default' : 'default', phase === 'user' ? ['strong'] : [])])
  const tail = COUNTS(counts)
  const right = phase === 'working' && tip ? [muted(`Tip: ${tip}`)] : gap ? [muted(gap)] : null
  const header = ui.stack.row([
    ui.child(glyph, { priority: 0 }),
    ui.child(text, { priority: 0 }),
    tail ? ui.child(ui.richText([muted(`· ${tail}`)]), { priority: 2, overflow: 'hide' }) : null,
    right ? ui.child(ui.richText(right), { priority: 1, band: 'right', overflow: 'hide' }) : null,
  ].filter(Boolean), { gap: 1 })
  const lines = detail.slice(0, 3)
  return ui.stack.column([
    header,
    ...lines.map((l, i) => ui.richText([muted(i === 0 ? '  ⎿ ' : '    '), span(l)], { overflow: 'truncate' })),
  ])
})

/** A settled call is one static past-tense line: glyph, verb, target, outcome. */
export const ToolLine = M('ToolLine', ({ ok = true, cancelled, verb, target, outcome, folded }) => ui.richText([
  folded ? muted('▸ ') : span(cancelled ? '⊘' : ok ? '✓' : '✗', cancelled ? 'muted' : ok ? 'success' : 'danger'), span(folded ? '' : ' '),
  span(verb, cancelled ? 'muted' : 'default', folded ? [] : []), span(target ? ` ${target}` : '', 'accent'), ...(outcome ? [muted(` · ${outcome}`)] : []),
]))

/** An edit card: the header, a diffstat, and a numbered diff. */
export const EditCard = M('EditCard', ({ file, added, removed, before, after, start = 1, maxRows, status = 'done', multi }) => ui.stack.column([
  ui.richText([span(status === 'failed' ? '✗' : '✓', status === 'failed' ? 'danger' : 'success'), span(' '), span(multi ? `Edited ${multi.length} files` : 'Edited', 'default', ['strong']), span(multi ? '' : ` ${file}`, 'accent'), span('  '), span(`+${added}`, 'success'), span(' '), span(`−${removed}`, 'danger'), span('  '), ...stat(added, removed)]),
  multi ? ui.stack.column(multi.map((m, i) => ui.richText([muted(i === multi.length - 1 ? '  └ ' : '  ├ '), span(m.kind, m.kind === 'A' ? 'success' : m.kind === 'D' ? 'danger' : 'warning'), span(` ${m.file}   `), span(`+${m.a}`, 'success'), span(' '), span(`−${m.d}`, 'danger')]))) : null,
  status === 'failed' ? ui.richText([muted('  ⎿ '), span('old text not found (expected at line 41)', 'danger')]) : (before != null ? ui.diff(before, after, { start, context: 1, numbered: true }) : null),
]))
const stat = (a, d, w = 8) => { const k = Math.max(1, Math.round(a / (a + d || 1) * w)); return [span('▮'.repeat(k), 'success'), span('▮'.repeat(w - k), 'danger')] }

/** Write is not a diff: collapsed it is one line, expanded it is the file with syntax highlighting and line numbers. */
export const WriteCard = M('WriteCard', ({ path, code, language, size, expanded }) => ui.stack.column([
  ui.richText([span('✓', 'success'), span(' '), span('Wrote', 'default', ['strong']), span(` ${path}`, 'accent'), muted(` · ${code.split('\n').length} lines · ${size}`), ...(expanded ? [] : [muted(' · Ctrl+O expand')])]),
  expanded ? ui.code(code, { language, numbered: true }) : null,
]))

// ======================================================================= status area: row 2, the views
/** At most five rows: in-progress first, then the earliest pending, one slot for the latest completed. */
export function visibleTodos(statuses, max = 5) {
  if (statuses.length <= max) return { rows: statuses.map((_, i) => i), hidden: { done: 0, pending: 0 } }
  const prog = [], pend = [], done = []
  statuses.forEach((s, i) => (s === 'progress' ? prog : s === 'pending' ? pend : done).push(i))
  const picked = new Set(prog.slice(0, max)), remaining = max - picked.size, doneC = done.toReversed()
  let d, p
  if (!doneC.length) { d = 0; p = Math.min(remaining, pend.length) } else if (!pend.length) { p = 0; d = Math.min(remaining, doneC.length) } else { d = 1; p = Math.min(remaining - 1, pend.length); if (p < remaining - 1) d = Math.min(doneC.length, remaining - p) }
  doneC.slice(0, d).forEach(i => picked.add(i)); pend.slice(0, p).forEach(i => picked.add(i))
  const hidden = { done: 0, pending: 0 }
  statuses.forEach((s, i) => { if (!picked.has(i)) hidden[s === 'pending' ? 'pending' : 'done']++ })
  return { rows: [...picked].toSorted((a, b) => a - b), hidden }
}
/** The heading rule is the progress bar. */
const RuleHeading = (value, max, width, title, tone) => ui.stack.row([
  ui.child(ui.progress({ style: 'rule', value, max, width, tone }), { basis: width }),
  ui.child(ui.richText(title), { grow: 1 }),
], { gap: 2 })

const TodoView = M('TodoView', ({ items }) => {
  const done = items.filter(i => i.status === 'done').length
  const { rows, hidden } = visibleTodos(items.map(i => i.status))
  const counts = [hidden.done && `${hidden.done} done`, hidden.pending && `${hidden.pending} pending`].filter(Boolean).join(' · ')
  return ui.stack.column([
    RuleHeading(done, items.length, 40, [span('Todo', 'primary', ['strong']), span(` ${done} of ${items.length}`)], 'primary'),
    ...rows.map(i => { const it = items[i]; return ui.richText(it.status === 'done' ? [span('  ✓ ', 'success'), span(it.text, 'muted', ['strike'])] : it.status === 'progress' ? [span('  ● ', 'primary', ['strong']), span(it.text, 'default', ['strong'])] : [muted('  ○ '), span(it.text)]) }),
    counts ? ui.richText([muted(`  … +${items.length - rows.length} more (${counts})`)]) : null,
  ])
})
const GoalView = M('GoalView', ({ goal }) => {
  const tone = goal.state === 'paused' ? 'muted' : goal.state === 'blocked' ? 'danger' : 'primary'
  return ui.stack.column([
    RuleHeading(goal.round, goal.rounds, 40, [span('Goal', 'primary', ['strong']), span(' '), goal.state === 'paused' ? muted('❚❚ paused') : goal.state === 'blocked' ? span('✕ blocked', 'danger') : span('● active', 'primary'), muted(` · round ${goal.round} of ${goal.rounds}`)], tone),
    ui.richText([muted(`  ${goal.text}`)]),
    goal.state === 'blocked' ? ui.richText([span('  blocked: ', 'danger'), muted(goal.reason ?? '')]) : null,
  ])
})

/**
 * Row 2 of the status area is the **view row**: one chip per view (agents, jobs, goal, todo), each a rich-text summary
 * admitted by priority like a row 1 entry. A plugin contributes a view the same way. Moving into the row opens the
 * focused view's panel; `Esc` returns to the prompt.
 */
const viewSummary = (v, f) => ({
  agents: [span(`Agents ${f.agents.length}`), ...(f.agents.some(a => a.state === 'wait') ? [span(' ● ', 'warning'), span(`${f.agents.filter(a => a.state === 'wait').length} waiting`)] : [])],
  jobs: [span(`Jobs ${f.jobs.length}`), ...(f.jobs.some(j => j.state === 'job') ? [span(' ⏵ ', 'primary'), span(`${f.jobs.filter(j => j.state === 'job').length} running`)] : [])],
  goal: f.goal ? [span('Goal ', 'default'), f.goal.state === 'paused' ? muted('❚❚') : f.goal.state === 'blocked' ? span('✕', 'danger') : span('●', 'primary'), span(` ${f.goal.round}/${f.goal.rounds}`)] : null,
  todo: f.todo.length ? [span(`Todo ${f.todo.filter(i => i.status === 'done').length}/${f.todo.length}`), ...(f.todo.find(i => i.status === 'progress') ? [span(' ● ', 'primary'), span(f.todo.find(i => i.status === 'progress').text)] : [])] : null,
}[v])
export const VIEWS = ['agents', 'jobs', 'goal', 'todo']
export const ViewRow = M('ViewRow', ({ facts, conversations = 1 }) => ui.stack.row([
  ...VIEWS.map((v, i) => { const sp = viewSummary(v, facts); return sp ? ui.child(ui.richText(sp, { overflow: 'truncate' }), { priority: i, band: 'left', overflow: v === 'todo' ? 'truncate' : 'hide' }) : null }),
  ui.child(ui.richText([muted(conversations > 1 ? 'F7 switch · F8 close' : '↓ views')]), { priority: 9, band: 'right', overflow: 'hide' }),
].filter(Boolean), { gap: 3 }))

const glyphTone = { run: ['●', 'primary'], wait: ['●', 'warning'], done: ['✓', 'success'], stopped: ['⊘', 'muted'], job: ['⏵', 'primary'] }
export const ViewPanel = M('ViewPanel', ({ active, facts }) => {
  const rows = { agents: facts.agents, jobs: facts.jobs }[active]
  const items = [{ id: 'agents', label: 'Agents', count: facts.agents.length }, { id: 'jobs', label: 'Jobs', count: facts.jobs.length }, ...(facts.goal ? [{ id: 'goal', label: 'Goal' }] : []), ...(facts.todo.length ? [{ id: 'todo', label: 'Todo', count: `${facts.todo.filter(i => i.status === 'done').length}/${facts.todo.length}` }] : [])]
  const body = active === 'goal' ? ui.scroll({ id: 'views.goal', autofocus: true, height: 4, fit: true, child: GoalView({ goal: facts.goal }) }) : active === 'todo' ? ui.scroll({ id: 'views.todo', autofocus: true, height: 7, fit: true, child: TodoView({ items: facts.todo }) })
    : ui.list({ id: `views.${active}`, autofocus: true, role: 'browse', maxRows: 4, items: rows.map(r => ({ id: r.id, label: [span(`${glyphTone[r.state][0]} `, glyphTone[r.state][1]), span(r.name.padEnd(8))], detail: [{ text: r.task }], right: r.meta })) })
  return ui.surface({
    chrome: 'none', child: ui.stack.column([
      ui.tabs({ id: 'views.tabs', activeId: active, items }), body,
      active === 'agents' || active === 'jobs' ? ui.actions({ id: 'views.keys', scope: `views.${active}`, items: [{ id: 'stop', semantic: 'delete', label: 'Stop', hintLabel: 'stop', hidden: true, confirm: { title: 'Stop this?', detail: 'The agent or job ends now.', tone: 'danger' } }] }) : null,
    ]),
  })
})

// ======================================================================= compaction
export const CompactionRow = M('CompactionRow', ({ stage, percent, items, before, after, auto = true }) => {
  if (stage === 'failed') return ui.richText([span('✗ ', 'danger'), span('Compaction failed: context still over budget after summary', 'danger')])
  if (stage === 'done') return ui.stack.column([
    ui.stack.row([ui.child(ui.richText([span('✓ ', 'success'), span(`Compacted ${items} items`, 'default', ['strong'])])), ui.child(ui.progress({ value: after, max: 100, width: 10, tone: 'success', showCount: false })), ui.child(ui.richText([muted(`${before}% → ${after}% · ~148k → ~12k tokens${auto ? ' · auto' : ''}`)]))], { gap: 1 }),
    ui.richText([muted('  ⎿ Ctrl+O summary')]),
  ])
  return ui.stack.row([
    ui.child(ui.loader({ variant: stage === 1 ? 'gap' : 'gap' })), ui.child(ui.richText([span('Compacting context')])),
    ui.child(ui.progress({ value: percent, max: 100, width: 10, showCount: false })),
    ui.child(ui.richText([muted(`${percent}%  ${stage}/2 ${stage === 1 ? 'summarizing' : 'applying'}${auto ? ' · auto' : ''}`)])),
  ], { gap: 1 })
})

// ======================================================================= decisions: approval, plan review, permission
const PLAN_MD = '# Plan\n1. Add activeCalls to the facts projection\n2. Wrap the detail into ⎿ lines in the activity row\n3. Replace the moon frames with the glyph table\n4. Move subagents into the tabbed views row\n5. Restyle approvals and questions\n6. Screenshots, width scans, docs'
export const DECISION_CARDS = ['command', 'edit', 'plan', 'permission']
/**
 * The decision itself is a lane card at the foot of the stream. Variant A puts the safest option first and a digit moves
 * the cursor; variant B puts the common grant first and a digit chooses at once. Edits and plans add an
 * open-in-editor key (`external`, default Ctrl+G) and plans a copy key.
 */
export const DecisionCard = M('DecisionCard', ({ card, variant = 'A' }) => {
  const A = variant === 'A'
  if (card === 'permission') {
    return patterns.decisionPanel({
      id: 'decision', title: 'Permission preset', badges: [muted('current: Default')], escapeLabel: 'close', instant: true,
      preview: [ui.text('Choose how much the agent may do without asking.', { tone: 'muted' })],
      options: [{ id: 'default', label: 'Default', detail: 'ask before writes', badge: 'current' }, { id: 'accept', label: 'Accept edits', detail: 'apply file edits freely' }, { id: 'full', label: 'Full access', detail: [span('— no prompts   '), span('⚠ asks first', 'warning')], confirm: { title: 'Really choose Full access?', detail: 'The agent will run commands without asking.', tone: 'danger' } }],
    })
  }
  const spec = {
    command: { grants: [['once', 'Allow once'], ['session', 'Allow bash for this session']], input: { id: 'feedback', label: 'Feedback', placeholder: 'type to explain…' }, accel: [] },
    edit: { grants: [['once', 'Allow once'], ['session', 'Allow edits this session']], input: { id: 'feedback', label: 'Feedback', placeholder: 'type to explain…' }, accel: [{ id: 'open', semantic: 'external', label: 'Open diff', hintLabel: 'open diff' }] },
    plan: { grants: [['start', 'Approve and start'], ['auto', 'Approve and auto-accept edits'], ['keep', 'Keep planning…']], input: { id: 'revise', label: 'Revise', placeholder: 'type the revision in place' }, accel: [{ id: 'copy', semantic: 'copy', label: 'Copy plan', hintLabel: 'copy plan' }, { id: 'open', semantic: 'external', label: 'Open plan', hintLabel: 'open plan' }] },
  }[card]
  const reject = { id: 'reject', label: A ? 'Reject' : (card === 'plan' ? 'Reject' : 'Reject and tell the agent why…') }
  const grants = spec.grants.map(([id, label]) => ({ id, label }))
  return patterns.decisionPanel({ id: 'decision', chrome: 'lane', title: 'Decide', options: A ? [reject, ...grants] : [...grants, reject], input: spec.input, instant: !A, accelerators: spec.accel, escapeLabel: 'reject' })
})

// ======================================================================= questions
export const QuestionsPanel = M('QuestionsPanel', ({ questions, step, answers, other, feedback }) => {
  const steps = [...questions.map(q => ({ id: q.id, label: q.tab })), { id: 'review', label: 'Review' }]
  const idx = steps.findIndex(s => s.id === step)
  const text = id => { const a = answers[id]; return a && a.length ? a.join(' · ') : null }
  const body = step === 'review'
    ? ui.stack.column([
      ui.text('Review your answers', { styles: ['strong'] }), ui.spacer(),
      ui.list({ id: 'review', role: 'choose', numbered: 'focus', items: [...questions.map(q => ({ id: q.id, label: q.tab, detail: text(q.id) ? text(q.id) : [span('— skipped', 'warning')] })), { id: 'submit', label: 'Submit answers', strong: true }] }),
    ])
    : (() => {
      const q = questions[idx]
      return ui.stack.column([
        ui.text(q.text, { styles: ['strong'] }), q.multi ? ui.text('select all that apply · Space toggles', { tone: 'muted' }) : null,
        ui.list({ id: `q.${q.id}`, autofocus: true, role: 'choose', numbered: !q.multi, mode: q.multi ? 'multiple' : 'single', marks: true, selectedIds: [], items: q.options.map(o => ({ id: o.label, label: o.label, detail: o.detail })) }),
        ui.form({ id: `q.${q.id}.other`, enterSubmits: 'other', fields: [{ id: 'other', kind: 'input', label: 'Other', value: other ?? '', placeholder: 'type your own answer' }] }),
      ])
    })()
  return ui.surface({ title: 'Questions', chrome: 'overlay', badges: [muted(`${Math.min(idx + 1, steps.length - 1) || 1} of ${steps.length - 1}`)], footer: feedback, child: ui.stack.column([ui.tabs({ id: 'qtabs', mode: 'wizard', items: steps, activeId: step, hintLabel: 'question' }), ui.spacer(), body]) })
})

// ======================================================================= model and effort pickers
export const ModelPicker = M('ModelPicker', ({ models }) => ui.surface({
  title: 'Select a model', chrome: 'overlay', child: ui.list({
    id: 'selection', role: 'browse', filterable: true, acceptVerb: 'choose', empty: ui.empty('No models match'),
    items: models.map(m => ({ id: m.id, label: `${m.provider}/${m.name}`, group: m.provider, detail: `${m.ctx} context`, ...(m.live ? { badge: m.liveEffort ? `current · ${m.liveEffort}` : 'current' } : {}), ...(m.efforts ? { segment: { label: 'Thinking', options: m.efforts.map(id => ({ id, label: id })), ...(m.defaultEffort ? { inheritedId: m.defaultEffort } : {}) } } : {}) })),
  }),
}))
export const EffortPicker = M('EffortPicker', ({ model, levels, current, defaultLevel }) => ui.surface({
  title: model, chrome: 'overlay', child: ui.list({
    id: 'effort', role: 'choose', numbered: true,
    items: [{ id: 'default', label: `Provider default (${defaultLevel})`, ...(current === 'default' ? { badge: 'current' } : {}) }, ...levels.map(l => ({ id: l, label: l, ...(current === l ? { badge: 'current' } : {}) }))],
  }),
}))

// ======================================================================= sessions, settings, status
const baseName = p => p.split('/').filter(Boolean).at(-1)
/** Workspace labels: the basename, plus the shortest distinguishing parent when two collide. */
export const workspaceLabels = paths => paths.map(p => {
  const segs = p.split('/').filter(Boolean), dup = paths.filter(q => baseName(q) === baseName(p)).length > 1
  return dup ? segs.slice(-2).join('/') : baseName(p)
})
export const SessionsPanel = M('SessionsPanel', ({ workspaces, active, feedback }) => {
  const labels = workspaceLabels(workspaces.map(w => w.path))
  const total = workspaces.reduce((a, w) => a + w.count, 0)
  const ws = workspaces.find(w => w.path === active)
  const rail = [{ id: 'all', label: 'All', count: total }, ...workspaces.map((w, i) => ({ id: w.path, label: labels[i], count: w.count, clip: 'start' }))]
  const sessions = (active === 'all' ? workspaces.flatMap(w => w.sessions) : ws.sessions)
  return patterns.railPanel({
    title: 'Sessions', badges: [muted(`${total} total`)], railWidth: 26, escapeLabel: 'close',
    rail: { id: 'workspaces', items: rail, activeId: active },
    content: ui.stack.column([
      ui.text(active === 'all' ? 'All workspaces' : active.replace('/home/ubuntu', '~'), { styles: ['strong'], overflow: 'middle' }),
      ui.list({ id: `sessions.${active}`, role: 'browse', filterable: true, filterMode: 'slash', expandFocused: true, items: sessions.map(s => ({ id: s.title, label: s.title, right: [muted(`${s.branch}  ${s.turns} turns  ${s.age}`)], body: `${s.prompt}\n${s.outcome}` })), empty: ui.empty('No sessions here yet', { description: 'start one with n' }) }),
      ui.actions({ id: 'keys', items: [{ id: 'copy', semantic: 'copy', label: 'Copy path', hintLabel: 'copy path', hidden: true }, { id: 'new', label: 'New', key: 'n', hintLabel: 'new', hidden: true }, { id: 'delete', semantic: 'delete', label: 'Delete', hintLabel: 'delete', hidden: true, confirm: { title: 'Delete this session?', detail: 'It cannot be recovered after the undo window.', tone: 'danger' } }] }),
      feedback,
    ]),
  })
})
export const SettingsPanel = M('SettingsPanel', ({ groups, active, feedback }) => patterns.railPanel({
  title: 'Settings', railWidth: 20,
  rail: { id: 'settings.rail', items: groups.map(g => ({ id: g.id, label: g.label })), activeId: active },
  content: ui.stack.column([ui.text(groups.find(g => g.id === active).label, { tone: 'primary', styles: ['strong'] }), ui.spacer(), ui.form({ id: `settings.${active}`, fields: groups.find(g => g.id === active).fields }), feedback]),
}))
export const StatusPanel = M('StatusPanel', ({ tab, balance, activity }) => {
  const bal = { ok: [[span('✓ ', 'success'), span('¥ 128.40', 'default', ['strong']), muted(' available')], 'topped-up ¥ 100.00 · granted ¥ 28.40'], low: [[span('⚠ ', 'warning'), span('¥ 6.20', 'warning', ['strong']), span(' low balance', 'warning'), muted(' · below ¥ 10.00')], 'topped-up ¥ 0.00 · granted ¥ 6.20'], loading: [[{ motion: 'loader', variant: 'gap', text: '' }, muted(' checking balance…')], ''], error: [[muted('— unavailable (network)  r retry')], ''], none: [null, ''] }[balance]
  const rows = {
    overview: [{ label: 'Model', value: 'deepseek-chat · High effort' }, { label: 'Provider', value: 'DeepSeek (api.deepseek.com)' }, { label: 'Directory', value: '~/work/mayfly  main ±3' }, { label: 'Mode', value: 'Default permissions · plan off' }, { label: 'Session', value: 'Update landing page hero · 12 turns · 18m' }, ...(bal[0] ? [{ label: 'Balance', value: bal[0] }] : [])],
    usage: [],
    account: [{ label: 'Provider', value: 'DeepSeek' }, ...(bal[0] ? [{ label: 'Balance', value: bal[0] }, { label: '', value: [muted(bal[1])] }] : []), { label: 'Checked', value: [muted('2 min ago · r refresh')] }, { label: 'Top up', value: [muted('platform.deepseek.com  ·  o open in browser')] }],
    connections: [{ label: '✓ filesystem', value: '4 tools · 120 ms' }, { label: '✓ github', value: '12 tools · 340 ms' }, { label: '✗ postgres', value: 'auth failed — run /mcp to fix' }],
    about: [{ label: 'Mayfly', value: '0.1.3-rc.2' }, { label: 'Install', value: '~/.local/share/mayfly' }],
  }[tab]
  const levels = [{ value: 0, label: 'none', tone: 'muted' }, { value: 1, label: 'light', tone: 'accent' }, { value: 2, label: 'some', tone: 'success' }, { value: 3, label: 'busy', tone: 'warning' }, { value: 4, label: 'peak', tone: 'primary' }]
  const usageBody = tab === 'usage' && activity ? ui.stack.column([
    ui.fields([{ label: 'Session', value: '148.2k in · 50.4k cached · 18.9k out · 31 requests · ≈ ¥ 3.02' }, { label: 'Today', value: '≈ ¥ 13.40 · 4 sessions' }]),
    ui.spacer(), ui.richText([span('Activity', 'default', ['strong']), muted('  turns per day, last 26 weeks')]),
    ui.chart({ chart: 'heatmap', cell: 1, columns: activity.weeks.map(() => ''), columnLabels: activity.monthLabels, rows: ['Mon', 'Wed', 'Fri', 'Sun'], values: activity.values, levels }),
    ui.spacer(), ui.richText([span('Conversation statistics', 'default', ['strong'])]),
    ui.fields([{ label: 'Sessions', value: '25 · 312 turns · 1,204 messages' }, { label: 'Tool calls', value: '1,873 · 94% succeeded' }, { label: 'Avg turn', value: '38s · longest session 2h 14m' }, { label: 'Streak', value: '6 days · best 19' }]),
    ui.chart({ chart: 'bar', orientation: 'horizontal', layout: 'grouped', title: 'top tools', categories: ['bash', 'read', 'edit', 'grep'], series: [{ id: 'calls', values: [612, 481, 203, 177] }] }),
    ui.chart({ chart: 'sparkline', values: activity.recent, label: 'turns/day (last 14)' }),
  ]) : undefined
  return patterns.statusPage({
    title: 'Status', badges: [muted('read-only')], body: usageBody,
    tabs: { id: 'status.tabs', activeId: tab, items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }, { id: 'account', label: 'Account', attention: balance === 'low' }, { id: 'connections', label: 'Connections', attention: true }, { id: 'about', label: 'About' }] },
    rows,
  })
})

// ======================================================================= /plugin marketplace
const STATUS_CHIP = { stable: null, beta: span('beta', 'primary'), unstable: span('unstable', 'warning'), deprecated: span('deprecated', 'warning'), removed: span('removed', 'danger') }
const pluginRow = e => ({
  id: e.id, label: [span(e.name.padEnd(16), e.status === 'removed' || e.status === 'deprecated' ? 'muted' : 'default', e.status === 'removed' || e.status === 'deprecated' ? [] : ['strong'])],
  detail: [...(STATUS_CHIP[e.status] ? [STATUS_CHIP[e.status], span(' ')] : []), muted(e.src.padEnd(9)), span(' '), e.tui ? span('T', 'default', ['strong']) : muted('·'), span(' '), e.web ? span('W', 'default', ['strong']) : muted('·')],
  right: e.update ? [span(`update ${e.update}`, 'warning')] : [muted(e.ver)],
})
const pluginDetail = (e, source) => ui.stack.column([
  ui.richText([span(e.name, 'default', ['strong']), muted(`  ${e.src} · ${e.cat}`)]), ui.text(e.desc, { tone: 'muted' }),
  e.note ? ui.richText([span('⚠ ', 'warning'), span(e.note)]) : null, ui.spacer(),
  ui.fields([
    { label: 'Status', value: e.installed ? (e.update ? [span(`installed ${e.ver} · update ${e.update}`, 'warning')] : [span(`✓ installed ${e.ver}`, 'success')]) : e.status === 'removed' ? [span('removed from the market', 'danger')] : [muted(`not installed · ${e.ver}`)] },
    { label: 'Surfaces', value: [span('TUI '), e.tui ? span('✓ works here', 'success') : span('✗ no contribution in this terminal', 'danger')] },
    { label: '', value: [span('Web '), e.web ? span('✓ works on dsh Web', 'success') : muted('— none')] },
    ...(e.tools.length || e.cmds.length ? [{ label: 'Provides', value: [...e.cmds, ...e.tools].join(' · ') }] : []),
    ...(e.eng ? [{ label: 'Engines', value: e.eng }] : []), ...(e.caps.length ? [{ label: 'Needs', value: e.caps.join(', ') }] : []), ...(e.verified ? [{ label: 'Verified', value: e.verified }] : []),
    ...(e.srcs.length > 1 && !e.installed ? [{ label: 'Source', value: [span(`‹ ${source} ›`, 'primary'), muted(' s cycles')] }] : e.srcs.length ? [{ label: 'Source', value: e.srcs[0] }] : []),
  ]),
])
export const PluginMarketplace = M('PluginMarketplace', ({ tab, entries, source, op, pending, offline, refreshing, feedback, selected }) => {
  const inst = entries.filter(e => e.installed), brow = entries.filter(e => !e.installed)
  const list = tab === 'installed' ? inst : brow
  const sel = list.find(e => e.id === selected) ?? list[0]
  const meta = offline ? [span('⚠ offline · showing cached data from 2d ago', 'warning')] : refreshing ? [{ motion: 'loader', variant: 'gap', text: '' }, muted(' refreshing catalog…')] : [muted(`index updated 2h ago · ${entries.length} entries`)]
  return ui.surface({
    title: 'Plugin marketplace', chrome: 'overlay', escapeLabel: 'close', child: ui.stack.column([
      ui.stack.row([ui.child(ui.tabs({ id: 'market.tabs', activeId: tab, items: [{ id: 'installed', label: 'Installed', count: inst.length }, { id: 'browse', label: 'Browse', count: brow.length }] })), ui.child(ui.richText(meta), { grow: 1 })], { gap: 4 }),
      ui.spacer(),
      patterns.splitView({
        listWidth: 58, breakpoint: 100,
        list: ui.list({ id: `market.${tab}`, autofocus: true, role: 'browse', marker: 'selection', filterable: true, filterMode: 'slash', items: list.map(pluginRow), empty: ui.empty(tab === 'installed' ? 'No plugins installed — press → to browse' : 'Nothing matches') }),
        detail: sel ? pluginDetail(sel, source) : ui.text('Nothing selected', { tone: 'muted' }),
      }),
      ui.actions({ id: 'market.keys', items: [{ id: 'install', label: 'Install', key: 'i', hidden: true, hintLabel: 'install' }, { id: 'update', label: 'Update', key: 'u', hidden: true, hintLabel: 'update' }, { id: 'remove', semantic: 'delete', label: 'Remove', hidden: true, hintLabel: 'remove', confirm: { title: 'Remove this plugin?', detail: 'Removal applies after restarting Mayfly.', tone: 'danger' } }, { id: 'source', label: 'Source', key: 's', hidden: true, hintLabel: 'source' }, { id: 'refresh', semantic: 'refresh', label: 'Refresh', hidden: true, hintLabel: 'refresh' }] }),
      op ? ui.loader({ variant: 'gap', message: `${op.kind === 'install' ? 'Installing' : op.kind === 'update' ? 'Updating' : 'Removing'} ${op.name} via ${source}…`, elapsedMs: op.elapsed, cancelActionId: 'cancel' }) : feedback,
      pending ? ui.richText([span('↻ ', 'warning'), span(`${pending} change${pending > 1 ? 's apply' : ' applies'} after you restart Mayfly and start a new session`)]) : null,
    ]),
  })
})

// ======================================================================= account and onboarding
const link = 'https://platform.deepseek.com/oauth/authorize?…'
/** One panel for every sign-in state; the primary choice is the focused row, secondary operations are keys. */
export const AccountContent = M('AccountContent', ({ state, balance = 'ok', expand, remaining }) => {
  const kv = rows => ui.fields(rows)
  const keys = items => ui.actions({ id: 'account.keys', items: items.map(i => ({ ...i, hidden: true })) })
  const pick = (id, items) => ui.list({ id, autofocus: true, role: 'choose', numbered: false, items })
  switch (state) {
    case 'signed-out': return ui.stack.column([kv([{ label: 'Status', value: 'Not signed in' }]), ui.spacer(), ui.text('Sign in with your DeepSeek account — models are billed to it and need no API key.', { tone: 'muted' }), ui.spacer(), pick('account.choice', [{ id: 'sign-in', label: 'Sign in', strong: true }, { id: 'use-key', label: 'Use an API key instead' }])])
    case 'waiting': return ui.stack.column([
      kv([{ label: 'Status', value: 'Not signed in' }, { label: 'Sign-in', value: [{ motion: 'loader', variant: 'breath', text: '' }, span(' Waiting for you in the browser')] }, { label: 'Expires', value: remaining ?? '4:41' }]), ui.spacer(),
      ui.text('Approve in the browser — on this machine sign-in finishes by itself.', { tone: 'muted' }), kv([{ label: 'Sign-in link', value: [muted(link)] }]),
      ui.list({ id: 'account.other', role: 'browse', items: [{ id: 'paste', label: 'Browser on another machine?', expandable: true, body: [] .length ? '' : 'Callback link: http://localhost:4710/oauth/callback?code=…' }] }),
      keys([{ id: 'copy', label: 'Copy link', key: 'ctrl+y', hintLabel: 'copy link' }, { id: 'new', label: 'New link', key: 'ctrl+r', hintLabel: 'new link' }]),
    ])
    case 'expired': return ui.stack.column([kv([{ label: 'Status', value: 'Not signed in' }, { label: 'Sign-in', value: [span('⚠ The sign-in link expired — try again', 'warning')] }]), ui.spacer(), pick('account.choice', [{ id: 'retry', label: 'Try again', strong: true }])])
    case 'network': return ui.stack.column([kv([{ label: 'Status', value: 'Not signed in' }, { label: 'Sign-in', value: [span('✗ Could not reach DeepSeek — try again', 'danger')] }]), ui.spacer(), pick('account.choice', [{ id: 'retry', label: 'Try again', strong: true }])])
    case 'no-server': return ui.stack.column([kv([{ label: 'Status', value: 'Not signed in' }]), ui.spacer(), ui.text('Browser sign-in needs the local web server, which this setup does not run. Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts.', { tone: 'muted' }), ui.spacer(), pick('account.choice', [{ id: 'use-key', label: 'Use an API key instead', strong: true }])])
    default: {
      const low = state === 'low'
      const bal = { ok: [[span('¥ 128.40', 'default', ['strong']), muted(' available')], 'topped-up ¥ 100.00 · granted ¥ 28.40'], loading: [[{ motion: 'loader', variant: 'gap', text: '' }, muted(' checking balance…')], ''], error: [[muted('— unavailable (network)  r retry')], ''] }[balance] ?? [[muted('')], '']
      return ui.stack.column([
        kv([{ label: 'Status', value: [span('✓ ', 'success'), span('Signed in')] }, { label: 'Balance', value: low ? [span('⚠ ', 'warning'), span('¥ 6.20', 'warning', ['strong']), span(' low balance', 'warning'), muted(' · below ¥ 10.00')] : bal[0] }, ...(low ? [{ label: '', value: [muted('topped-up ¥ 0.00 · granted ¥ 6.20')] }] : bal[1] ? [{ label: '', value: [muted(bal[1])] }] : []), { label: 'Models', value: [muted('account models need no API key')] }, { label: 'Checked', value: [muted('2 min ago')] }]),
        keys([{ id: 'refresh', semantic: 'refresh', label: 'Refresh', hintLabel: 'refresh' }, { id: 'topup', label: 'Top up', key: 'o', hintLabel: 'top up in browser' }, { id: 'signout', semantic: 'delete', label: 'Sign out', hintLabel: 'sign out', confirm: { title: 'Sign out of the DeepSeek account?', detail: 'Account models stop working until you sign in again.', tone: 'danger' } }]),
      ])
    }
  }
})
export const AccountPanel = M('AccountPanel', ({ state, balance, expand, feedback }) => ui.surface({
  title: 'DeepSeek Account', chrome: 'overlay', badges: [muted(state === 'signed-in' || state === 'low' ? '' : 'not connected')], footer: feedback, child: AccountContent({ state, balance, expand }),
}))

export const Onboarding = M('Onboarding', ({ step, sub, state, other, perm, welcome, feedback }) => {
  const steps = [{ id: 'language', label: 'Language' }, { id: 'connect', label: 'Connect' }, { id: 'permissions', label: 'Permissions' }, { id: 'ready', label: 'Ready' }]
  const strip = ui.tabs({ id: 'onboarding.steps', mode: 'wizard', items: steps, activeId: step })
  const frame = (title, child) => ui.surface({ title, chrome: 'overlay', badges: [muted(`step ${steps.findIndex(s => s.id === step) + 1} of 4`)], footer: feedback, child })
  let body
  if (step === 'language') body = frame('Welcome to Mayfly', ui.stack.column([
    ui.richText([span('✻ ', 'primary', ['strong']), span('Mayfly', 'default', ['strong']), muted('  a quiet terminal UI for DeepSeek Harness')]), ui.spacer(),
    ui.text('Pick a language and a color theme. You can change both later in /settings.'), ui.spacer(),
    ui.form({ id: 'welcome', autofocus: true, enterSubmits: 'continue', fields: [{ id: 'lang', kind: 'select', label: 'Language', value: welcome.lang, options: [{ id: 'English' }, { id: '简体中文' }] }, { id: 'theme', kind: 'select', label: 'Theme', value: welcome.theme, options: ['dark', 'light', 'ocean', 'paper', 'auto'].map(id => ({ id })) }] }),
    ui.spacer(), ui.richText([muted('preview  '), span('Overview', 'primary', ['strong']), span('   '), muted('Usage 3'), span('   '), span('!', 'warning', ['strong']), span('   '), span('✓ ', 'success'), muted('done')]),
  ]))
  else if (step === 'connect' && sub === 'choose') body = frame('Connect to DeepSeek', ui.stack.column([
    ui.text('Mayfly needs a DeepSeek connection to start.'), ui.spacer(),
    ui.list({ id: 'connect', autofocus: true, role: 'choose', numbered: true, items: [{ id: 'account', label: 'Sign in with a DeepSeek account', badge: 'recommended', body: 'browser sign-in, no API key to manage', bodyAlways: true }, { id: 'key', label: 'Enter a DeepSeek API key', body: 'paste a key from platform.deepseek.com', bodyAlways: true }, { id: 'skip', label: 'Skip for now', body: 'connect later with /account or /provider', bodyAlways: true }] }),
  ]))
  else if (step === 'connect' && sub === 'account') body = frame('DeepSeek Account', AccountContent({ state }))
  else if (step === 'connect') body = frame('Enter your API key', ui.stack.column([ui.text('Your key is saved as a credential, not as a setting.'), ui.spacer(), ui.form({ id: 'apikey', autofocus: true, enterSubmits: 'save', fields: [{ id: 'key', kind: 'secret', label: 'API key', value: other ?? '', required: true, help: 'Paste a key from platform.deepseek.com' }] })]))
  else if (step === 'permissions') body = frame('Permissions', ui.stack.column([ui.text('How much may the agent do without asking?'), ui.spacer(), ui.list({ id: 'perm', autofocus: true, role: 'choose', numbered: true, items: [{ id: 'default', label: 'Default', badge: 'recommended', body: 'ask before writes and commands', bodyAlways: true }, { id: 'accept', label: 'Accept edits', body: 'apply file edits freely, still ask for commands', bodyAlways: true }, { id: 'full', label: 'Full access', body: [].length ? '' : '⚠ no prompts at all — only in a sandbox', bodyAlways: true, confirm: { title: 'Really allow everything without prompts?', tone: 'danger' } }] })]))
  else body = frame('Ready', ui.stack.column([
    ui.richText([span('✓ ', 'success'), span(`Language   ${welcome.lang}`)]), ui.richText([span('✓ ', 'success'), span(`Theme      ${welcome.theme}`)]),
    state === 'connected' ? ui.richText([span('✓ ', 'success'), span('DeepSeek   connected')]) : ui.richText([span('○ ', 'warning'), span('DeepSeek   not connected '), muted('· /account to sign in')]),
    ui.richText([span('✓ ', 'success'), span(`Permissions ${perm}`)]), ui.spacer(), ui.text('Things to try', { styles: ['strong'] }),
    ...[['/', 'commands', 'run a command, such as /model or /sessions'], ['@', 'files', 'mention a file to attach it to your message'], ['#', 'skills', 'select a skill (a saved playbook) to guide the agent'], ['!', 'shell', 'run a shell command and share its output'], ['Shift+Tab', 'plan mode', 'let the agent plan first; you approve before it acts']].map(([k, n, d]) => ui.richText([span(`  ${k.padEnd(10)}`, 'primary', ['strong']), span(n.padEnd(11)), muted(d)])),
    ui.actions({ id: 'ready.keys', items: [{ id: 'start', semantic: 'save', label: 'Start chatting', hidden: true, hintLabel: 'start chatting' }] }),
  ]))
  return ui.stack.column([strip, ui.spacer(), body])
})

// ======================================================================= command surfaces
export const CommandPalette = M('CommandPalette', ({ commands }) => ui.surface({
  title: 'Commands', chrome: 'overlay', child: ui.list({ id: 'palette', role: 'choose', filterable: true, empty: ui.empty('No command matches'), items: commands.map(c => ({ id: c.name, label: c.name, detail: c.what, right: c.key ? [muted(c.key)] : undefined })) }),
}))
export const FilePicker = M('FilePicker', ({ files }) => ui.surface({
  title: 'Files', chrome: 'overlay', badges: [muted('recent first')], child: ui.list({ id: 'files', role: 'choose', filterable: true, items: files.map(f => ({ id: f.name, label: f.name, detail: f.dir, rightFocus: [span('↗ code', 'accent')] })) }),
}))
export const ChangedFiles = M('ChangedFiles', ({ files }) => ui.surface({
  title: 'Changed files', chrome: 'overlay', badges: [muted(`${files.length} this session`)], child: ui.stack.column([
    ui.list({ id: 'changed', autofocus: true, role: 'browse', items: files.map(f => ({ id: f.name, label: [span(f.kind, f.kind === 'A' ? 'success' : f.kind === 'D' ? 'danger' : 'warning'), span(`  ${f.name}`)], right: [span(`+${f.a}`, 'success'), span(' '), span(`−${f.d}`, 'danger')], rightFocus: [span(`+${f.a}`, 'success'), span(' '), span(`−${f.d}`, 'danger'), muted(`   ↗ code :${f.line}`)] })) }),
    ui.actions({ id: 'changed.keys', items: [{ id: 'diff', label: 'Diff', key: 'd', hidden: true, hintLabel: 'diff' }] }),
  ]),
}))
export const RewindPanel = M('RewindPanel', ({ checkpoints }) => ui.surface({
  title: 'Rewind', chrome: 'overlay', badges: [muted(`${checkpoints.length} checkpoints`)], child: ui.list({ id: 'rewind', role: 'browse', acceptVerb: 'restore', items: checkpoints.map(c => ({ id: c.id, label: c.label, detail: c.when, segment: { label: 'Restore', options: [{ id: 'both', label: 'conversation + code' }, { id: 'chat', label: 'conversation only' }, { id: 'code', label: 'code only' }], selectedId: 'both' } })) }),
}))
export const KeyHelp = M('KeyHelp', ({ groups, context }) => ui.surface({
  title: 'Keys', chrome: 'overlay', badges: [muted(context)], child: ui.stack.column(groups.flatMap(g => [ui.divider(g.title), ui.fields(g.rows.map(([k, v]) => ({ label: k, value: v })))])),
}))
export const HunkReview = M('HunkReview', ({ file, index, total, before, after }) => ui.surface({
  title: `Review ${file}`, chrome: 'overlay', badges: [muted(`hunk ${index} of ${total}`)], child: ui.stack.column([
    ui.diff(before, after, { start: 41, context: 1, hunkHeader: true }),
    ui.actions({ id: 'hunk.keys', items: [{ id: 'accept', label: 'Accept', key: 'a', hintLabel: 'accept', hidden: true }, { id: 'reject', label: 'Reject', key: 'r', hintLabel: 'reject', hidden: true }, { id: 'all', label: 'Accept all', key: 'A', hintLabel: 'accept all', hidden: true }, { id: 'next', label: 'Next', key: 'n', hintLabel: 'next hunk', hidden: true }] }),
  ]),
}))
export const JobOutput = M('JobOutput', ({ name, status, lines, follow }) => ui.surface({
  title: `Job · ${name}`, chrome: 'overlay', badges: [muted(status)], child: ui.stack.column([
    ui.scroll({ id: 'job.log', follow: follow ? 'end' : 'none', height: 8, expandedHeight: 14, child: ui.stack.column(lines.map(l => ui.richText([muted(`${l.t}  `), l.tone ? span(`${l.tag}  `, l.tone) : span(''), span(l.text)]))) }),
    ui.actions({ id: 'job.keys', items: [{ id: 'follow', label: 'Follow', key: 'f', hintLabel: follow ? 'follow off' : 'follow on', hidden: true }, { id: 'stop', semantic: 'delete', label: 'Stop', hintLabel: 'stop', hidden: true, confirm: { title: 'Stop this job?', detail: 'The process receives a terminate signal.', tone: 'danger' } }] }),
  ]),
}))
export const Banner = M('Banner', ({ severity, title, detail, tail }) => ui.richText([span({ warning: '⚠', error: '✗', info: 'ℹ' }[severity] + ' ', { warning: 'warning', error: 'danger', info: 'primary' }[severity]), span(title, 'default', ['strong']), muted(` ${detail}`), ...(tail ? [muted(` · ${tail}`)] : [])]))

// ======================================================================= conversation stream
const lvStat = t => t.steps.filter(s => s.t === 'edit').reduce(([a, d], s) => [a + s.a, d + s.d], [0, 0])
const lvCalls = t => t.steps.filter(s => s.t !== 'think').length
const groupsOf = steps => {
  const out = []; let cur = null
  for (const s of steps) { if (s.t === 'edit') { if (cur) { out.push(cur); cur = null } out.push({ edit: s }) } else { cur ??= { steps: [] }; cur.steps.push(s) } }
  if (cur) out.push(cur)
  return out
}
const groupTitle = g => {
  const reads = g.steps.filter(s => s.t === 'read').length, searches = g.steps.filter(s => s.t === 'search').length
  const bashes = g.steps.filter(s => s.t === 'bash'), failed = bashes.filter(s => s.ok === false).length
  const parts = []
  if (reads && searches) parts.push('Read files and searched code'); else if (reads) parts.push('Read files'); else if (searches) parts.push('Searched code')
  if (bashes.length) parts.push('Ran commands' + (failed ? ` · ${failed} failed` : ''))
  return { text: parts.join(' · ') || 'Thought', failed }
}
const tail = lines => ui.stack.column(lines.map(l => ui.richText([muted('  ⎿ '), muted(l)])))

/** One stream row: a caret when it has details, the details when they are open. Every row is a selectable item. */
const row = (id, spans, o = {}) => ({ id, label: [...(o.body ? [span(o.open ? '▾ ' : '▸ ', 'muted')] : [span('  ')]), ...spans], ...(o.wrap ? { wrap: true, wrapMax: o.wrapMax } : {}), ...(o.body && o.open ? { body: o.body, bodyAlways: true } : {}), copy: o.copy })
/** The stream rows of one turn at one level of detail: four levels, each a distinct, predictable amount. */
const turnItemsRaw = (t, EL, toggled, running) => {
  const isOpen = (id, dflt) => dflt !== toggled.has(id)
  const [a, d] = lvStat(t)
  const items = [row(t.id, [span('» ', 'user'), span(t.user, 'default', ['strong'])], { copy: t.user })]
  const editRow = s => { const id = `${t.id}.${s.file}`; return row(id, [span('✓ ', 'success'), span('Edited ', 'default', ['strong']), span(s.file, 'accent'), span(`  +${s.a}`, 'success'), span(` −${s.d}  `, 'danger'), ...stat(s.a, s.d)], { body: ui.diff(s.before, s.after, { start: s.start ?? 1, context: 1, maxRows: EL === 3 ? 12 : 6 }), open: isOpen(id, EL >= 1), copy: s.after }) }
  if (running) {
    const done = t.steps.filter(s => !s.running)
    if (EL === 0) return items
    if (EL === 1) { groupsOf(done).forEach(g => items.push(g.edit ? editRow(g.edit) : row(`${t.id}.g${items.length}`, [muted('  ⎿ '), muted(groupTitle(g).text)]))); return items }
    t.steps.forEach((s, i) => {
      const id = `${t.id}.s${i}`
      if (s.t === 'think') items.push(row(id, [muted('✻ '), span(s.text, 'muted', ['italic'])], { copy: s.text }))
      else if (s.t === 'bash') items.push(row(id, [s.running ? span('● ', 'primary') : span(s.ok ? '✓ ' : '✗ ', s.ok ? 'success' : 'danger'), span(s.running ? 'Running ' : 'Ran '), span(s.cmd, 'accent'), muted(s.running ? ' · 8s' : ` · ${s.secs}`)], { body: tail(s.running ? s.live : s.tail.slice(-2)), open: isOpen(id, EL === 3), copy: s.cmd }))
      else if (s.t === 'edit') items.push(editRow(s))
      else items.push(row(id, [span('✓ ', 'success'), span(s.t === 'read' ? 'Read ' : 'Searched '), span(s.label, 'accent'), muted(` · ${s.out}`)]))
    })
    return items
  }
  const hid = `${t.id}.hdr`
  items.push(t.fail
    ? row(hid, [span('✗ ', 'danger'), span('Failed', 'danger', ['strong']), muted(` · ${t.fail} · ${t.secs} · ${lvCalls(t)} tool calls`)])
    : row(hid, [muted(`${EL >= 2 ? '▾' : '▸'} Took ${t.secs} · ${lvCalls(t)} tool calls`), ...(a || d ? [muted(' · '), span(`+${a}`, 'success'), span(' '), span(`−${d}`, 'danger')] : []), ...(EL <= 1 ? [muted(' · Ctrl+O expand')] : [])]))
  if (EL === 0) { if (t.fail) items.push(row(`${t.id}.why`, [muted('  ⎿ '), muted('last step: Ran pnpm run verify:full ✗ exit 124')])) }
  else if (EL === 1) t.steps.filter(s => s.t === 'edit').forEach(s => items.push(editRow(s)))
  else if (EL === 2) {
    const first = t.steps.find(s => s.t === 'think')
    groupsOf(t.steps).forEach((g, i) => {
      if (g.edit) items.push(editRow(g.edit))
      else { const gt = groupTitle(g); if (i === 0 && first) items.push(row(`${t.id}.think`, [muted('✻ '), span(first.text, 'muted', ['italic'])], { copy: first.text })); items.push(row(`${t.id}.g${i}`, [muted('  ⎿ '), span(gt.text, gt.failed ? 'warning' : 'muted')])) }
    })
  } else t.steps.forEach((s, i) => {
    const id = `${t.id}.s${i}`
    if (s.t === 'think') items.push(row(id, [muted('✻ Thinking'), span('  '), span(s.text, 'muted', ['italic'])], { copy: s.text }))
    else if (s.t === 'bash') items.push(row(id, [span(s.ok ? '✓ ' : '✗ ', s.ok ? 'success' : 'danger'), span('Ran '), span(s.cmd, 'accent'), muted(` · ${s.secs}${s.ok ? '' : ' · exit 1'}`)], { body: tail(s.tail), open: isOpen(id, true), copy: s.cmd }))
    else if (s.t === 'edit') items.push(editRow(s))
    else items.push(row(id, [span('✓ ', 'success'), span(s.t === 'read' ? 'Read ' : 'Searched '), span(s.label, 'accent'), muted(` · ${s.out}`)]))
  })
  t.answer.forEach((l, i) => items.push(row(`${t.id}.a${i}`, [span(i === 0 ? '● ' : '  '), span(l)], { wrap: true, copy: l })))
  return items
}
const USER_BAND = [34, 36, 60]
/**
 * How the user's own words stand out from the output. The design uses `rule`: a blank row and a muted rule with the
 * time before every turn after the first, then the bold `»` prompt. `plain` is today's single row; the others are the
 * alternatives the Prompt styles scene compares: a hanging indent (`indent`), a quote bar (`bar`), a background band
 * (`band`), a titled card (`card`), and `recommended` (blank row, indent, bar, and band).
 */
export const PROMPT_STYLES = ['plain', 'rule', 'indent', 'bar', 'band', 'card', 'recommended']
/** A prompt shows at most this many lines; Enter on it (or a search hit inside it) opens the rest. */
export const PROMPT_MAX_LINES = 4
const userItems = (t, ps, first, toggled, hit) => {
  const maxLines = toggled.has(t.id) || hit ? undefined : PROMPT_MAX_LINES, copy = t.user
  const gap = first ? [] : [{ id: `${t.id}.gap`, label: '', disabled: true, gap: true }]
  const rule = first ? [] : [...gap, { id: `${t.id}.rule`, label: '', disabled: true, rule: t.time ?? '' }]
  const words = [span('» ', 'user'), span(t.user, 'default', ['strong'])]
  if (ps === 'rule') return [...rule, row(t.id, words, { copy, wrap: true, wrapMax: maxLines })]
  if (ps === 'indent') return [{ id: t.id, label: words, wrap: true, wrapMax: maxLines, copy }]
  if (ps === 'bar') return [{ id: t.id, label: t.user, block: { bar: 'user', maxLines }, copy }]
  if (ps === 'band') return [{ id: t.id, label: t.user, block: { lead: [span('» ', 'user')], band: USER_BAND, maxLines }, copy }]
  if (ps === 'card') return [{ id: t.id, label: t.user, block: { card: `You · ${t.time ?? ''}`, maxLines }, copy }]
  if (ps === 'recommended') return [...gap, { id: t.id, label: t.user, block: { bar: 'user', band: USER_BAND, maxLines }, copy }]
  return [row(t.id, words, { copy, wrap: true, wrapMax: maxLines })]
}
const turnItems = (t, EL, toggled, running, ps = 'plain', first = true, hit = false) => {
  const [, ...rest] = turnItemsRaw(t, EL, toggled, running)
  const hang = ps === 'indent' || ps === 'recommended' ? 2 : 0
  return [...userItems(t, ps, first, toggled, hit), ...rest.map(it => (hang ? { ...it, indent: hang } : it))]
}
/** The agent's request, as the newest stream rows with today's content (command, diff, or the whole plan). */
const requestItem = ({ card, diffBefore, diffAfter }) => {
  if (card === 'command') return row('request', [span('? ', 'warning', ['strong']), span('Approve command', 'default', ['strong']), muted('  bash · 1 of 3 waiting')], { body: ui.stack.column([ui.richText([muted('$ '), span('rm -rf build && pnpm build')]), ui.richText([muted('in ~/work/mayfly   '), span('⚠ deletes files', 'warning')])]), open: true, copy: 'rm -rf build && pnpm build' })
  if (card === 'edit') return row('request', [span('? ', 'warning', ['strong']), span('Approve edit', 'default', ['strong']), span('  pane-activity.ts', 'accent'), span('  +2', 'success'), span(' −1', 'danger')], { body: ui.diff(diffBefore, diffAfter, { start: 41, context: 1 }), open: true, copy: diffAfter })
  return row('request', [span('? ', 'warning', ['strong']), span('Plan ready for review', 'default', ['strong']), muted('  6 steps')], { body: ui.markdown(PLAN_MD), open: true, copy: PLAN_MD })
}
/**
 * The conversation stream is one browse list of rows. Alt+Up from the prompt selects a row; the selected row can be
 * expanded, copied, or opened in the editor, and the whole stream is searchable. Search highlights matches and opens a
 * row whose hidden details match.
 */
export const TranscriptView = M('TranscriptView', ({ turns, level, toggled = new Set(), forceVerbose = new Set(), running, request, focusItem, query, promptStyle = 'rule' }) => {
  const items = turns.flatMap((t, i) => turnItems(t, forceVerbose.has(t.id) ? 3 : level, toggled, running && t.live, promptStyle, i === 0, !!query && t.user.toLowerCase().includes(query.toLowerCase())))
  if (request) items.push(requestItem(request))
  const re = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null
  const hl = it => !re || it.gap || it.rule !== undefined ? it : { ...it, label: (typeof it.label === 'string' ? [{ text: it.label }] : it.label).flatMap(s => { const sp = typeof s === 'string' ? { text: s } : s; const out = []; let last = 0, m; re.lastIndex = 0; while ((m = re.exec(sp.text))) { out.push({ ...sp, text: sp.text.slice(last, m.index) }, { text: m[0], tone: 'warning', styles: ['strong'] }); last = m.index + m[0].length; if (!m[0]) break } out.push({ ...sp, text: sp.text.slice(last) }); return out }) }
  return ui.stack.column([
    ui.list({ id: 'stream', hintLabel: 'stream', role: 'browse', acceptVerb: 'expand', focusItem, items: items.map(hl) }),
    ui.actions({ id: 'stream.keys', scope: 'stream', items: [{ id: 'copy', semantic: 'copy', label: 'Copy', hintLabel: 'copy', hidden: true }, { id: 'open', semantic: 'external', label: 'Open in editor', hintLabel: 'open in editor', hidden: true }] }),
  ])
})
export const StreamSearch = M('StreamSearch', ({ query, count, cur }) => ui.stack.column([
  ui.form({ id: 'search', enterSubmits: 'next', submitLabel: 'next match', fields: [{ id: 'q', kind: 'input', label: '⌕', value: query ?? '', placeholder: 'search the whole conversation' }] }),
  ui.richText([muted(query ? (count ? `${cur + 1}/${count} matches` : 'no matches') : ''), muted('   matches open the rows that hide them')]),
]))

// ======================================================================= /trace
const SURFACE_TONE = { main: 'primary', subagent: 'accent', tool: 'warning', system: 'muted' }
/**
 * The session execution trace as a tree: turns, then the events inside each turn, with a duration meter and a surface
 * badge. The detail pane shows the selected event's raw JSON with syntax highlighting. `c` copies the item, `a` all,
 * `Ctrl+G` opens the JSON in the editor, `f` limits the tree to failures.
 */
export const TracePanel = M('TracePanel', ({ turns, failuresOnly, detail, feedback }) => {
  const shown = turns.map(t => ({ ...t, events: failuresOnly ? t.events.filter(e => e.failed) : t.events })).filter(t => !failuresOnly || t.events.length)
  const items = shown.flatMap(t => [
    { id: `turn.${t.n}`, label: [span(`Turn ${t.n}  `, 'default', ['strong']), muted(`${t.start}  ${t.dur}  ↑${t.up} ↓${t.down}`)], expanded: true, right: t.failed ? [span('✗ failed', 'danger')] : [span('✓', 'success')] },
    ...t.events.map(e => ({ id: String(e.seq), parentId: `turn.${t.n}`, label: [muted(`${e.time} #${e.seq}  `), span(`${e.glyph} `, e.failed ? 'danger' : 'default'), span(e.title, e.failed ? 'danger' : 'default')], detail: [muted(e.summary)], badge: e.surface, meter: { value: e.ms, max: t.maxMs, width: 6, tone: e.failed ? 'danger' : 'primary' } })),
  ])
  return ui.surface({
    title: 'Trace · session 4f2a9', chrome: 'overlay', badges: [muted(`${turns.reduce((a, t) => a + t.events.length, 0)} events`)], footer: feedback, child: ui.stack.column([
      patterns.splitView({
        listWidth: 62, breakpoint: 110,
        list: ui.list({ id: 'trace.events', autofocus: true, role: 'browse', marker: 'selection', filterable: true, filterMode: 'slash', tree: true, maxRows: 14, items, empty: ui.empty('no trace events yet') }),
        detail: ui.stack.column([
          ui.fields([{ label: 'Type', value: detail?.type ?? '—' }, { label: 'Surface', value: detail?.surface ?? '—' }, { label: 'Took', value: detail?.took ?? '—' }]),
          ui.scroll({ id: 'trace.detail', height: 9, expandedHeight: 16, child: ui.code(detail?.json ?? '', { language: 'json', numbered: true }) }),
        ]),
      }),
      ui.actions({ id: 'trace.keys', items: [{ id: 'copy', semantic: 'copy', label: 'Copy item', hintLabel: 'copy item', hidden: true }, { id: 'copy-all', action: 'trace.copy-all', label: 'Copy all', key: 'a', hintLabel: 'copy all', hidden: true }, { id: 'failures', action: 'trace.failures', label: 'Failures only', key: 'f', hintLabel: failuresOnly ? 'all events' : 'failures only', hidden: true }, { id: 'open', semantic: 'external', label: 'Open JSON', hintLabel: 'open JSON', hidden: true }] }),
    ]),
  })
})

// ======================================================================= /keys: rebinding
/** Every action with its effective key. A consumer rebinds any of them at runtime; the hint rows follow. */
export const KeybindingsPanel = M('KeybindingsPanel', ({ actions, capturing, feedback }) => ui.surface({
  title: 'Keys', chrome: 'overlay', escapeLabel: 'close', badges: [muted(capturing ? 'press the new key · Esc cancels' : 'Enter rebinds · Delete restores the default')], footer: feedback, child: ui.list({
    id: 'keys.list', autofocus: true, role: 'browse', filterable: true, filterMode: 'slash', maxRows: 12,
    items: actions.map(a => ({ id: a.id, label: [span(a.label.padEnd(18), a.modified ? 'primary' : 'default'), muted(a.id)], right: [span(a.keys.join(' / ') || 'unbound', a.modified ? 'primary' : 'default', ['strong']), ...(a.modified ? [muted(`  default ${a.defaults.join(' / ')}`)] : [])], group: a.group })),
  }),
}))
