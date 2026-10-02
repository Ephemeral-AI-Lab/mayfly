#!/usr/bin/env node
/**
 * Terminal prototype of the Mayfly UI redesign round (docs/design/component-library.md, §8).
 * A standalone script with no dependencies: it draws its own colors and does not use the
 * Mayfly renderer, so it shows design intent (motion, layout, keys), not shipped rendering.
 *
 *   node docs/design/prototypes/ui-preview.mjs [scene-number]
 *   ] or Tab next scene · [ or Shift+Tab previous · q or Ctrl+C quit
 *   While a text field has focus the scene keeps every key; Esc stops typing.
 *
 * @module docs/design/prototypes/ui-preview
 */

const V = [154, 134, 230]
const c = (col, s) => `\x1b[38;2;${col[0]};${col[1]};${col[2]}m${s}\x1b[0m`
const acc = s => c(V, s)
const grn = s => c([110, 200, 140], s)
const red = s => c([230, 110, 110], s)
const yel = s => c([230, 190, 90], s)
const dim = s => `\x1b[2m${s}\x1b[0m`
const bold = s => `\x1b[1m${s}\x1b[0m`
const inv = s => `\x1b[7m${s}\x1b[0m`
const ital = s => `\x1b[3m${s}\x1b[0m`
const strikeDim = s => `\x1b[9m\x1b[2m${s}\x1b[0m`
const mix = k => V.map(v => Math.round(60 + (v - 60) * k))
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const vlen = s => [...strip(s)].length
const pick = (arr, f, every = 1) => arr[Math.floor(f / every) % arr.length]
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - vlen(s)))
const right = (l, r, w = 78) => l + ' '.repeat(Math.max(2, w - vlen(l) - vlen(r))) + r
const flash = s => `\x1b[1;7m${strip(s)}\x1b[0m`
const bar = (n, total, w = 10, tone = acc) => {
  const k = Math.round(n / total * w)
  return tone('▰'.repeat(k)) + dim('▱'.repeat(w - k))
}
const rule = (n, total, w = 40, tone = acc) => {
  const k = Math.round(n / total * w)
  return tone('━'.repeat(k)) + dim('─'.repeat(w - k))
}
const cut = (s, w) => vlen(s) <= w ? s : [...strip(s)].slice(0, w - 1).join('') + '…'
const columns = (l, r, lw, gap = ' │ ', min = 8) => {
  const n = Math.max(l.length, r.length, min)
  return Array.from({ length: n }, (_, i) => pad(l[i] ?? '', lw) + dim(gap) + (r[i] ?? ''))
}


// ---- theme / pill / contrast helpers
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
// Tabs and lists colour only the TEXT (never a filled background). The `ref` colour is the
// assumed terminal background and is used only to compute contrast.
const THEMES = {
  dark: { ref: [30, 30, 46], active: [154, 134, 230], selected: [176, 160, 236], rule: [110, 98, 170],
    idle: [150, 146, 175], attn: [230, 190, 90], disabled: [100, 97, 120] },
  light: { ref: [251, 250, 255], active: [96, 74, 190], selected: [112, 90, 200], rule: [170, 160, 220],
    idle: [104, 100, 130], attn: [150, 100, 0], disabled: [150, 146, 170] },
}
const tc = (T, key, s, b = false) => `${b ? '\x1b[1m' : ''}\x1b[38;2;${T[key].join(';')}m${s}\x1b[0m`

// ---- path helpers
const HOME = '/home/ubuntu'
const tildify = p => p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p
function midCut(path, w) {
  const p = tildify(path)
  if ([...p].length <= w) return p
  const segs = p.split('/')
  const head = p.startsWith('~') ? '~' : '/' + segs[1]
  const rest = segs.slice(p.startsWith('~') ? 1 : 2)
  let tail = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const cand = `${head}/…/${[rest[i], ...tail].join('/')}`
    if ([...cand].length > w) break
    tail = [rest[i], ...tail]
  }
  return tail.length ? `${head}/…/${tail.join('/')}` : '…' + [...rest.at(-1)].slice(-(w - 1)).join('')
}

const bloom = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const fillGlyph = ['⡀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿', '⣷', '⣶', '⣦', '⣤', '⣄']
const orbit = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈']
const classic = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const gap = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']
const clock = ['◴', '◷', '◶', '◵']
const breath = [0.25, 0.5, 0.8, 1, 0.8, 0.5]
const TIPS = ['/ commands', '@ files', '# skills', '! shell', 'Shift+Tab plan mode', 'Alt+M switch model', 'Ctrl+O expand output']
function shimmer(text, f) {
  const pos = (f % (text.length + 6)) - 3
  return [...text].map((ch, i) => Math.abs(i - pos) <= 1 ? bold(acc(ch)) : dim(ch)).join('')
}
function box(title, rightText, body, w = 74) {
  const inner = w - 2
  const head = rightText ? `╭ ${title} ${'─'.repeat(Math.max(1, inner - vlen(title) - vlen(rightText) - 4))} ${rightText} ╮` : `╭ ${title} ${'─'.repeat(Math.max(1, inner - vlen(title) - 2))}╮`
  return [acc(head), ...body.map(l => acc('│') + ` ${pad(l, inner - 1)}` + acc('│')), acc(`╰${'─'.repeat(inner)}╯`)]
}
function diff(rows) {
  const gw = Math.max(3, ...rows.map(r => String(Math.max(r.o ?? 0, r.n ?? 0)).length))
  return rows.map(r => {
    if (r.gap) return `  ${dim('⋯')}`
    const o = r.o == null ? ' '.repeat(gw) : String(r.o).padStart(gw)
    const n = r.n == null ? ' '.repeat(gw) : String(r.n).padStart(gw)
    const sign = r.s === '-' ? red('−') : r.s === '+' ? grn('+') : ' '
    return `  ${dim(o + ' ' + n + ' │')} ${sign} ${r.s === '-' ? red(r.t) : r.s === '+' ? grn(r.t) : r.t}`
  })
}
const stat = (a, d, w = 8) => {
  const k = Math.max(1, Math.round(a / (a + d || 1) * w))
  return `${grn('+' + a)} ${red('−' + d)} ${grn('▮'.repeat(k))}${red('▮'.repeat(w - k))}`
}
const EDIT_ROWS = [
  { o: 41, n: 41, t: "  const moon = state.mode === 'waiting'" },
  { o: 42, s: '-', t: '  const frame = moon' },
  { n: 42, s: '+', t: '  const frame = glyphFor(state)' },
  { o: 43, n: 43, t: '  const now = activityNow()' },
  { gap: true },
  { o: 118, n: 118, t: "  return { kind: 'stack', direction: 'column'," },
]

const scenes = []
const scene = s => scenes.push(s)
const last = () => scenes.at(-1)
const printable = k => k.length === 1 && k >= ' ' && k !== '\x7f'

// ================================================================ 1 activity
scene({ name: 'Activity', render: (f) => {
  const esc = dim('Esc interrupt · Ctrl+O expand')
  return [
    dim('one motion channel per row: glyph OR label, never both'), '',
    dim('thinking → bloom glyph, label still'),
    right(`${acc(pick(bloom, f))} Thinking ${dim('· 8s · ↑30.2k ↓1.1k')}`, esc),
    `  ${dim('⎿')} Checking whether facts.activity can carry more than the latest tool name,`,
    `    since every tool/call overwrites the previous one…`, '',
    dim('tool running → static ●, label shimmers'),
    right(`${acc('●')} ${shimmer('Running commands', f)} ${dim('· 12s · ↑30.2k ↓4.1k · 38 tok/s')}`, esc),
    `  ${dim('⎿')} pnpm run verify:changed -- --plan`, '',
    dim('working on the model (was "Deep diving") → braille fill glyph, label still; the tip lives in the gap'),
    right(`${acc(pick(fillGlyph, f))} Working ${dim('· 2s')}`, dim('Tip: ' + pick(TIPS, f, 30))), '',
    dim('waiting on an external action → slow breath, label still'),
    right(`${c(mix(pick(breath, f, 4)), '●')} Waiting for authorization ${dim('· 45s')}`, dim('Esc cancel')), '',
    dim('waiting on YOU → nothing moves'),
    `${yel('?')} ${bold('Waiting for your action')} ${dim('· 8s')}`, '',
    dim('stopping → static'),
    `${red(bold('■'))} ${dim('interrupting…')}`, '',
    dim('idle → nothing is rendered (no tips here)'),
  ]
}})

// ================================================================ 2 loader
scene({ name: 'Loader', render: (f, t) => {
  const MSG = 'Discovering models from api.example.com'
  const n = Math.min(10, Math.floor(t / 600) % 12)
  const g = acc(pick(gap, f))
  return [
    dim('indeterminate: the gap spinner ⣾⣽⣻⢿⡿⣟⣯⣷ (chosen)'), '',
    `${g} ${MSG} ${dim('12s')}`, '',
    dim('inside a dialog, with its cancel action'),
    ...box('Add provider', '', [`${g} ${MSG} ${dim('12s')}`, '', dim('Esc cancel')], 64), '',
    dim('as a pane head / inline status'),
    `${g} ${dim('Loading sessions…')}`,
    `${g} ${dim('Checking balance…')}`, '',
    dim('determinate (total known)'),
    `Building ${bar(n, 10)} ${n}/10`, '',
    dim('waiting on an external action (kept)'),
    `${c(mix(pick(breath, f, 4)), '●')} Waiting for authorization ${dim('· open the URL in your browser · 45s')}`,
    `  ${dim('[ Cancel ]')}`, '',
    dim('settled'),
    `${grn('✓')} ${dim('Discovered 14 models · 2.1s')}`,
    `${red('✗')} ${red('Discovery failed: 401 Unauthorized')}   ${dim('[ Retry ]')}`,
    dim('⊘ Cancelled'),
  ]
}})

// ================================================================ 3 tools
scene({ name: 'Tools', render: (f, t) => {
  const cats = [
    ['Running commands', 'pnpm run verify:changed -- --plan', 'tool'],
    ['Reading files', 'packages/mayfly/src/transcript/pane-activity.ts', 'tool'],
    ['Searching code', '"liveProcessDetail" in packages/', 'tool'],
    ['Visiting web pages', 'https://pi.dev/docs/latest/tui', 'tool'],
    ['Updating the plan', '3 of 5 items done', 'tool'],
    ['Waiting for your action', 'Which release channel should this go to?', 'user'],
  ]
  const [label, detail, kind] = cats[Math.floor(t / 1600) % cats.length]
  return [
    dim('running (category picks label + detail; cycles every 1.6s)'),
    kind === 'user' ? `${yel('?')} ${bold(label)} ${dim('· 8s')}` : `${acc('●')} ${shimmer(label, f)} ${dim('· 12s')}`,
    `  ${dim('⎿')} ${detail}`, '',
    dim('settled: one static line per call'),
    `${grn('✓')} Read ${acc('pane-activity.ts')} ${dim('· 481 lines')}`,
    `${grn('✓')} Searched ${acc('"activity"')} ${dim('· 47 matches in 12 files')}`,
    `${grn('✓')} Ran ${acc('pnpm run check:lib')} ${dim('· 4.2s')}`,
    `${red('✗')} Ran ${acc('pnpm run lint')} ${red('· exit 1')} ${dim('· 3s')}`,
    `${grn('✓')} Fetched ${acc('pi.dev/docs/latest/tui')} ${dim('· 200 · 18 KB')}`,
    `${grn('✓')} Updated plan ${dim('· 3/5 done')}`,
    `${dim('⊘ Cancelled')} Ran ${dim('pnpm run build')}`, '',
    dim('folded turn summary (Ctrl+O expands)'),
    dim('▸ Read 3 files · Searched code · Ran 2 commands · 6s'),
  ]
}})

// ================================================================ 4 edit / write
scene({ name: 'Edit/Write', render: (f, t) => {
  const T = t % 9000
  const path = 'packages/mayfly/src/transcript/pane-activity.ts'
  const live = T < 2500
    ? [dim('Edit · phase 1 · arguments streaming'), `${acc('●')} ${shimmer('Preparing to edit files', f)} ${dim('· 3s · ↓' + (0.4 + T / 900).toFixed(1) + 'k')}`, `  ${dim('⎿')} ${path}`]
    : T < 5000
      ? [dim('Edit · phase 2 · applying, diffstat ticks up'), `${acc('●')} ${shimmer('Editing files', f)} ${dim('· 5s')}`, `  ${dim('⎿')} ${path}  ${stat(Math.min(12, Math.floor((T - 2500) / 150)), Math.min(3, Math.floor((T - 2500) / 600)))}`]
      : [dim(T < 5400 ? 'Edit · phase 3 · settle flash (400 ms)' : 'Edit · settled: numbered diff (old, new columns)'),
        T < 5400 ? flash('✓ Edited pane-activity.ts  +12 −3') : `${grn('✓')} ${bold('Edited')} ${acc('pane-activity.ts')}  ${stat(12, 3)}`,
        ...diff(EDIT_ROWS)]
  return [
    ...live, '',
    dim('Edit · multi-file (apply_patch)'),
    `${grn('✓')} ${bold('Edited 3 files')}  ${stat(58, 21)}`,
    `  ├ ${yel('M')} pane-activity.ts    ${stat(34, 12, 6)}`,
    `  ├ ${grn('A')} frame-table.ts      ${stat(18, 0, 6)}`,
    `  └ ${red('D')} moon-frames.ts      ${stat(0, 9, 6)}`, '',
    dim('Edit · failed'),
    `${red('✗')} ${red('Edit failed')} pane-activity.ts`,
    `  ${dim('⎿')} ${red('old text not found (expected at line 41)')}`, '',
    dim('Write · never a diff: one line, plain preview only on Ctrl+O'),
    `${grn('✓')} ${bold('Wrote')} ${acc('packages/mayfly/src/transcript/frame-table.ts')} ${dim('· 84 lines · 3.1 KB')}`,
  ]
}})

// ================================================================ 5 tray
const tray = {}
scene({ name: 'Tray', keys: '↓ enter tray · ←/→ Agents/Jobs · ↑↓ select · Enter view · x stop · Esc back',
  init: () => Object.assign(tray, {
    tabs: ['Agents', 'Jobs'], tab: 0, sel: 0, mode: 'editor', note: '', confirm: false,
    data: {
      Agents: [
        { g: acc('●'), name: 'review', task: 'Audit facts projection', meta: '41s · 6 tools · ↓6.4k' },
        { g: yel('●'), name: 'plan', task: 'Draft migration plan', meta: 'waiting · reply needed' },
        { g: grn('✓'), name: 'explore', task: 'Map transcript files', meta: '12s · 8 tools' },
        { g: grn('✓'), name: 'lint', task: 'Sweep oxlint findings', meta: '9s · 3 tools' },
        { g: grn('✓'), name: 'docs', task: 'Update README variants', meta: '20s · 5 tools' },
      ],
      Jobs: [
        { g: acc('⏵'), name: 'dev', task: 'pnpm run dev', meta: 'running 4m 2s' },
        { g: acc('⏵'), name: 'watch', task: 'pnpm run test -- --watch', meta: 'running 1m 9s' },
        { g: grn('✓'), name: 'build', task: 'pnpm run build', meta: 'exited 0 · 22s' },
      ],
    } }),
  render: (f) => {
    const rows = tray.data[tray.tabs[tray.tab]]
    const out = [
      right(`${acc(pick(fillGlyph, f))} Working ${dim('· 2s')}`, dim('Tip: ' + pick(TIPS, f, 30)), 76),
      dim('╭' + '─'.repeat(76) + '╮'),
      dim('│') + pad(` > ${tray.mode === 'editor' ? '▌' : ''}`, 76) + dim('│'),
      dim('╰' + '─'.repeat(76) + '╯'),
      '  ' + right(dim('deepseek-chat High  ~/work/mayfly  main ±3'), dim('cache 34%  context: 18%'), 74),
    ]
    if (tray.mode === 'editor') {
      out.push('  ' + right(`Agents ${tray.data.Agents.length} ${yel('● 1 waiting')} ${dim('·')} Jobs ${tray.data.Jobs.length} ${acc('⏵')} ${dim('2 running')}`, dim('↓ manage'), 74))
    } else {
      const tabsLine = tray.tabs.map((n, i) => i === tray.tab ? bold(acc(`‹ ${n} ${tray.data[n].length} ›`)) : dim(`  ${n} ${tray.data[n].length}  `)).join('')
      out.push('  ' + right(tabsLine, tray.confirm ? yel(`Stop ${rows[tray.sel].name}? `) + inv(' No ') + ' Yes  ' + dim('y/n') : dim('←/→ tab · ↑↓ select · Enter view · x stop · Esc back'), 74))
      const start = Math.min(Math.max(0, tray.sel - 3), Math.max(0, rows.length - 4))
      rows.slice(start, start + 4).forEach((r, k) => {
        const line = `${strip(r.g)} ${r.name.padEnd(8)} ${r.task.padEnd(26)} ${r.meta}`
        out.push(start + k === tray.sel ? ` ${acc('▸')}${inv(' ' + line + ' ')}` : `   ${r.g} ${r.name.padEnd(8)} ${r.task.padEnd(26)} ${dim(r.meta)}`)
      })
      if (rows.length > 4) out.push('   ' + dim(`↑ ${start} more · ↓ ${rows.length - start - 4} more`))
    }
    out.push('  ' + (tray.note ? grn(tray.note) : ''))
    return [dim('single-line status bar · tray row only while agents/jobs exist · at most 4 rows, rest counted'), '', ...out]
  },
  onKey: (k) => {
    const rows = tray.data[tray.tabs[tray.tab]]
    tray.note = ''
    if (tray.confirm) { if (k === 'y') { tray.note = `stopped ${rows[tray.sel].name}`; rows[tray.sel].g = dim('⊘') } tray.confirm = false; return }
    if (tray.mode === 'editor') { if (k === '\x1b[B') { tray.mode = 'tray'; tray.sel = 0 } return }
    if (k === '\x1b[C' || k === '\x1b[D') { tray.tab = (tray.tab + 1) % 2; tray.sel = 0 }
    else if (k === '\x1b[B') tray.sel = Math.min(rows.length - 1, tray.sel + 1)
    else if (k === '\x1b[A') tray.sel = Math.max(0, tray.sel - 1)
    else if (k === '\x1b') tray.mode = 'editor'
    else if (k === '\r') tray.note = tray.tab === 0 ? `→ opened conversation "${rows[tray.sel].name}" (F7 returns)` : `→ opened job "${rows[tray.sel].name}" detail (Esc closes)`
    else if (k === 'x') tray.confirm = true
  } })

// ================================================================ 6 todo / goal
scene({ name: 'Todo/Goal', render: (f, t) => {
  const T = t % 12000
  const done = T < 3000 ? 2 : T < 6000 ? 3 : T < 9000 ? 4 : 5
  const just = [3000, 6000, 9000].some(k => T >= k && T < k + 400)
  const items = ['Audit current hero copy', 'Update landing page hero', 'Run the tests', 'Update screenshots', 'Bump changelog', 'Open the PR']
  const start = Math.max(0, done - 2)
  const row = i => i < done
    ? (just && i === done - 1 ? `  ${inv(grn('✓'))} ${items[i]}` : `  ${grn('✓')} ${strikeDim(items[i])}`)
    : i === done ? `  ${bold(acc('●'))} ${bold(items[i])}` : `  ${dim('○')} ${items[i]}`
  return [
    dim('full card: the heading rule is the progress bar (an item completes every 3s)'),
    `${rule(2, 8, 56)}  ${bold(acc('Goal'))} ${acc('●')} active ${dim('· round 2 of 8')}`,
    `  ${dim('Ship the hero refresh and keep all 214 tests green')}`,
    `${rule(done, 6, 56)}  ${bold(acc('Todo'))} ${done} of 6`,
    ...[0, 1, 2, 3].map(k => row(start + k)),
    `  ${dim(`… +${Math.max(0, 6 - start - 4)} more · ctrl+t`)}`, '',
    dim('collapsed one-liner'),
    `${rule(done, 6, 24)}  ${bold(acc('Todo'))} ${done} of 6 ${dim('·')} ${acc('●')} ${items[done]}`, '',
    dim('goal states'),
    `${rule(4, 8, 24, x => c([150, 150, 150], x))}  ${bold(acc('Goal'))} ${dim('❚❚ paused · round 4 of 8')}`,
    `${rule(8, 8, 24, red)}  ${bold(acc('Goal'))} ${red('✕ blocked')} ${dim('· round 8 of 8')}`,
    `  ${red('blocked:')} ${dim('needs a decision on the release channel')}`,
    T > 11000 ? `${grn('✓')} ${bold('Todo done 6/6')} ${dim('· 4m 12s — pane closes')}` : '',
  ]
}})

// ================================================================ 7 decisions
const dec = { v: 0, sel: 0, note: '', confirm: false }
const DECISIONS = [
  { title: 'Approve command', right: 'bash · 1 of 3 waiting',
    preview: () => [`${dim('$')} rm -rf build && pnpm build`, dim('in ~/work/mayfly') + '        ' + yel('⚠ deletes files'), ''],
    opts: ['Allow once', 'Allow bash for this session', 'Reject and tell the agent why…'], feedback: 'Feedback' },
  { title: 'Approve edit', right: 'pane-activity.ts  +2 −1',
    preview: () => [...diff(EDIT_ROWS).map(l => l.slice(2)), ''],
    opts: ['Allow once', 'Allow edits this session', 'Reject and tell the agent why…'], feedback: 'Feedback' },
  { title: 'Plan ready for review', right: '6 steps · ↑↓ scroll',
    preview: () => ['1. Add activeCalls to the facts projection', '2. Wrap the detail into ⎿ lines in the activity row', '3. Replace the moon frames with the glyph table', '4. Move subagents into the tabbed tray', '5. Restyle approvals and questions', '6. Screenshots, width scans, docs', ''],
    opts: ['Approve and start', 'Approve and auto-accept edits', 'Keep planning…', 'Reject'], feedback: 'Revise' },
  { title: 'Permission preset', right: 'current: Default',
    preview: () => [dim('Choose how much the agent may do without asking.'), ''],
    opts: ['Default — ask before writes  [current]', 'Accept edits — apply file edits freely', 'Full access — no prompts   ⚠ asks first'], danger: 2 },
]
scene({ name: 'Approval', keys: 'v next variant · ↑↓ or 1-4 · Enter confirm · y/n on the danger row',
  init: () => Object.assign(dec, { v: 0, sel: 0, note: '', confirm: false }),
  render: () => {
    const d = DECISIONS[dec.v]
    const body = [...d.preview(), ...d.opts.map((o, i) => `${dec.sel === i ? acc('▸') : ' '} ${dim(String(i + 1))}  ${dec.sel === i ? bold(o) : o}`)]
    if (d.feedback) body.push(`  ${dim(d.feedback + ':')} ${dim('type to explain…')}`)
    body.push('')
    body.push(dec.confirm ? `${yel('Really choose Full access?')}  ${inv(' No ')}  Yes   ${dim('y/n')}` : dim(`Esc ${d.title.startsWith('Approve') ? 'reject' : 'close'} · 1-${d.opts.length} choose · Enter confirm`))
    return [dim(`variant ${dec.v + 1}/${DECISIONS.length}: ${DECISIONS.map((x, i) => i === dec.v ? bold(x.title) : x.title).join(' · ')}`), '', ...box(d.title, d.right, body), '  ' + (dec.note ? grn(dec.note) : '')]
  },
  onKey: (k) => {
    const d = DECISIONS[dec.v]
    dec.note = ''
    if (dec.confirm) { if (k === 'y') dec.note = '→ Full access granted'; dec.confirm = false; return }
    if (k === 'v') { dec.v = (dec.v + 1) % DECISIONS.length; dec.sel = 0 }
    else if (k === '\x1b[A') dec.sel = Math.max(0, dec.sel - 1)
    else if (k === '\x1b[B') dec.sel = Math.min(d.opts.length - 1, dec.sel + 1)
    else if (/^[1-9]$/.test(k) && Number(k) <= d.opts.length) { dec.sel = Number(k) - 1; k = '\r' }
    if (k === '\r') {
      if (d.danger === dec.sel) dec.confirm = true
      else dec.note = `→ ${d.opts[dec.sel].replace(/\s+\[.*$/, '')}`
    }
  } })

// ================================================================ 8 questions
const qs = {}
const Q = [
  { tab: 'Auth', text: 'Which auth method should the CLI use?', multi: false, opts: [['OAuth', 'browser sign-in, tokens refresh automatically'], ['API key', 'paste a token; you rotate it yourself']] },
  { tab: 'Region', text: 'Which region should the service deploy to?', multi: false, opts: [['us-east-1', 'lowest latency to most users'], ['eu-west-1', 'GDPR data residency'], ['ap-south-1', 'closest to the pilot customers']] },
  { tab: 'Scopes', text: 'Which scopes should the token carry?', multi: true, opts: [['read', 'list and fetch resources'], ['write', 'create and update resources'], ['admin', 'manage members and billing']] },
]
const answerText = i => {
  const parts = [...qs.ans[i]].sort().map(k => k === 'other' ? 'Other' : Q[i].opts[k][0])
  return parts.length ? parts.join(' · ') : null
}
const toggleAns = (i, key) => { qs.ans[i].has(key) ? qs.ans[i].delete(key) : qs.ans[i].add(key) }
scene({ name: 'Questions', keys: '1-4 choose · ↑↓ move · Space toggle · Enter next · ←/→ switch question',
  init: () => Object.assign(qs, { qi: 0, oi: 0, done: false, ans: Q.map(() => new Set()) }),
  render: () => {
    if (qs.done) return box('Questions', 'submitted', ['', grn('✓ Answers sent to the agent.'), '  (press ] for the next scene)', ''])
    const strip3 = Q.map((q, i) => {
      const a = answerText(i)
      return `${a ? grn('✓') : i === qs.qi ? acc('●') : dim('○')} ${i === qs.qi ? bold(acc(q.tab)) : a ? q.tab : dim(q.tab)}`
    }).join(dim('  │  ')) + dim('  │  ') + (qs.qi === Q.length ? `${acc('●')} ${bold(acc('Review'))}` : `${dim('○')} ${dim('Review')}`)
    let body
    if (qs.qi === Q.length) {
      body = [strip3, '', bold('Review your answers'), '',
        ...Q.map((q, i) => `${dim(String(i + 1))}  ${q.tab.padEnd(8)} ${answerText(i) ?? yel('— skipped')}`), '',
        `${qs.oi === 0 ? acc('▸') : ' '} ${qs.oi === 0 ? bold('Submit answers') : 'Submit answers'}     ${qs.oi === 1 ? acc('▸ ') : ''}Back to edit`, '',
        dim('1-3 jump to a question · ←/→ move · Enter confirm')]
    } else {
      const q = Q[qs.qi], a = qs.ans[qs.qi]
      const mark = key => q.multi ? (a.has(key) ? '[x]' : '[ ]') : (a.has(key) ? '●' : ' ')
      body = [strip3, '', bold(q.text), q.multi ? dim('select all that apply · Space toggles') : '',
        ...q.opts.map(([n, d], i) => `${qs.oi === i ? acc('▸') : ' '} ${dim(String(i + 1))}  ${mark(i)} ${bold(n)}  ${dim(d)}`),
        `${qs.oi === q.opts.length ? acc('▸') : ' '} ${dim(String(q.opts.length + 1))}  ${mark('other')} Other  ${dim('type your own answer')}${qs.oi === q.opts.length ? '▌' : ''}`, '',
        dim(`←/→ question · ${q.multi ? 'Space toggle · ' : `1-${q.opts.length + 1} choose · `}Enter ${qs.qi === Q.length - 1 ? 'review' : 'next'}`)]
    }
    return box('Questions', `${Math.min(qs.qi + 1, Q.length)} of ${Q.length}`, body)
  },
  onKey: (k) => {
    if (qs.done) return
    const q = Q[qs.qi]
    const max = qs.qi === Q.length ? 1 : q.opts.length
    if (k === '\x1b[C') { qs.qi = Math.min(Q.length, qs.qi + 1); qs.oi = 0 }
    else if (k === '\x1b[D') { qs.qi = Math.max(0, qs.qi - 1); qs.oi = 0 }
    else if (qs.qi === Q.length) {
      if (/^[1-3]$/.test(k)) { qs.qi = Number(k) - 1; qs.oi = 0 }
      else if (k === '\x1b[A') qs.oi = 0
      else if (k === '\x1b[B') qs.oi = 1
      else if (k === '\r') { if (qs.oi === 0) qs.done = true; else { qs.qi = 0; qs.oi = 0 } }
    } else if (k === '\x1b[A') qs.oi = Math.max(0, qs.oi - 1)
    else if (k === '\x1b[B') qs.oi = Math.min(max, qs.oi + 1)
    else if (/^[1-9]$/.test(k) && Number(k) <= max + 1) {
      const i = Number(k) - 1
      const key = i === q.opts.length ? 'other' : i
      qs.oi = i
      if (q.multi) toggleAns(qs.qi, key)
      else { qs.ans[qs.qi] = new Set([key]); qs.qi++; qs.oi = 0 }
    } else if (k === ' ' && q.multi) toggleAns(qs.qi, qs.oi === q.opts.length ? 'other' : qs.oi)
    else if (k === '\r') {
      if (!q.multi) qs.ans[qs.qi] = new Set([qs.oi === q.opts.length ? 'other' : qs.oi])
      qs.qi++; qs.oi = 0
    }
  } })

// ================================================================ 9 compaction
scene({ name: 'Compaction', render: (f, t) => {
  const T = t % 10000
  const label = 'Compacting context'
  const head = dim('the bar is the real context occupancy (contextTokens / contextWindow)')
  if (T < 5000) {
    const edge = mix(pick([0.35, 0.6, 1, 0.6], f, 3))
    return [head, '', dim('stage 1/2 · summarizing (model call running; the edge cell breathes)'),
      `${acc('●')} ${label} ${acc('▰'.repeat(8))}${c(edge, '▰')}${dim('▱')} ${dim('91%')}  ${dim(`1/2 summarizing · ${Math.floor(T / 1000) + 1}s · auto`)}`]
  }
  if (T < 5800) {
    const k = (T - 5000) / 800
    return [head, '', dim('stage 2/2 · summary landed: the bar drains (one-shot 800 ms, 148k → 12k)'),
      `${acc('●')} ${label} ${bar(Math.max(1, Math.round(9 - k * 8)), 10)} ${dim(Math.round(91 - k * 82) + '%')}  ${dim('2/2 applying · auto')}`]
  }
  return [head, '', dim('settled (static)'),
    `${grn('✓')} ${bold('Compacted 84 items')} ${bar(1, 10, 10, grn)} ${dim('91% → 9% · ~148k → ~12k tokens · auto')}`,
    `  ${dim('⎿ Ctrl+O summary')}`, '',
    dim('expanded (Ctrl+O)'),
    `  ${dim('│')} ${dim(ital('Goal: unify the Activity pane with a multi-line detail layout.'))}`,
    `  ${dim('│')} ${dim(ital('Decisions: bloom / fill / shimmer; ⎿ detail lines; tabbed tray.'))}`, '',
    dim('narrow terminals drop the bar first, then the token pair'),
    `${grn('✓')} ${bold('Compacted 84 items')} ${dim('· 91% → 9%')}`, '',
    dim('failed'),
    `${red('✗')} ${red('Compaction failed: context still over budget after summary')}`]
}})

// ================================================================ 10 tabs (pills)
const tb = {}
const HT = [['Overview'], ['Usage', 3], ['Connections', '!'], ['Skills', 12], ['About']]
const VR = [
  { group: 'Session' }, { id: 'General' }, { id: 'Model' }, { id: 'Permissions', n: 2 },
  { group: 'Integrations' }, { id: 'Providers', n: '!' }, { id: 'MCP', n: 4 }, { id: 'Skills', n: 12 },
  { group: 'Interface' }, { id: 'Appearance' }, { id: 'Keys' },
]
const VRI = VR.filter(r => r.id)
const RAIL_BODY = {
  General: ['Language: ‹ English ›', 'Notifications: [on]', 'Telemetry: [off]'],
  Model: ['Model: ‹ deepseek-chat ›', 'Effort: ‹ medium ›', 'Context window: 128k'],
  Permissions: ['Preset: ‹ Default ›', 'Allowed: bash, read', 'Denied: none'],
  Providers: ['! 1 provider needs attention', 'DeepSeek ✓', 'Local ✗ unreachable'],
  MCP: ['filesystem ✓ 4 tools', 'github ✓ 12 tools', 'postgres ✗', 'browser …'],
  Skills: ['12 installed', 'plugin-author · preset-author · …'],
  Appearance: ['Theme: ‹ dark ›', 'Density: ‹ comfortable ›'],
  Keys: ['Editor mode: ‹ emacs ›', 'See all shortcuts: ?'],
}
function hStrip(T, active, focused) {
  const labels = HT.map(t => t[0] + (t[1] !== undefined ? ' ' + t[1] : ''))
  const words = HT.map((t, i) => {
    const on = i === active
    const name = on ? tc(T, focused ? 'active' : 'selected', t[0], focused) : tc(T, 'idle', t[0])
    const badge = t[1] === undefined ? '' : t[1] === '!' ? ' ' + tc(T, 'attn', '!', true) : ' ' + tc(T, 'idle', String(t[1]))
    return name + badge
  })
  let off = 0
  for (let i = 0; i < active; i++) off += vlen(labels[i]) + 3
  const rule = ' '.repeat(off) + (focused ? tc(T, 'active', '━'.repeat(vlen(labels[active])), true) : tc(T, 'rule', '━'.repeat(vlen(labels[active]))))
  return [words.join('   '), rule]
}
function vRail(T, activeIdx, focused, w = 22) {
  return VR.map(r => {
    if (r.group) return tc(T, 'idle', ' ' + r.group.toUpperCase())
    const on = VRI.indexOf(r) === activeIdx
    const n = r.n === undefined ? '' : r.n === '!' ? tc(T, 'attn', '!', true) : tc(T, 'idle', String(r.n))
    const cell = pad(n, 3)
    if (on) return `${tc(T, focused ? 'active' : 'rule', '▌', true)} ${tc(T, focused ? 'active' : 'selected', pad(r.id, w - 7), focused)} ${cell}`
    return `  ${tc(T, 'idle', pad(r.id, w - 7))} ${cell}`
  })
}
const sampleRow = T => [tc(T, 'active', 'Active', true), tc(T, 'selected', 'Selected, focus elsewhere'), tc(T, 'idle', 'Idle'), tc(T, 'idle', '12'), tc(T, 'attn', '!', true), tc(T, 'disabled', 'Disabled')].join('   ')
function contrastLine(name, T) {
  const items = [['active', T.active], ['selected', T.selected], ['idle/count', T.idle], ['attn', T.attn]]
  const cells = items.map(([n, col]) => { const r = contrast(col, T.ref); return `${n} ${r.toFixed(1)}${r >= 4.5 ? grn('✓') : red('✗')}` })
  return `${pad(name, 6)} ${cells.join('  ')}  ${dim('disabled ' + contrast(T.disabled, T.ref).toFixed(1) + ' (exempt)')}`
}
scene({ name: 'Tabs', keys: 'h/v choose the focused demo · h: ←/→ · v: ↑↓ · t toggle the dark/light text palette',
  init: () => Object.assign(tb, { focus: 'h', h: 1, v: 3, theme: 'dark' }),
  render: () => {
    const T = THEMES[tb.theme]
    const [words, rule] = hStrip(T, tb.h, tb.focus === 'h')
    const rail = vRail(T, tb.v, tb.focus === 'v')
    const cur = VRI[tb.v]
    const content = [bold(cur.id), '', ...(RAIL_BODY[cur.id] ?? []).map(l => '  ' + l)]
    return [
      dim(`text colour only, no filled backgrounds · palette ${tb.theme} (t; the light palette assumes a light terminal)`), '',
      dim(`horizontal · focus ${tb.focus === 'h' ? '●' : '○'} (h): the focused tab is bold with a heavy rule; without focus it keeps its colour but loses weight and the rule dims`),
      '  ' + words, '  ' + rule, '',
      dim(`vertical rail · focus ${tb.focus === 'v' ? '●' : '○'} (v) · content follows the cursor live`),
      ...columns(rail, content, 22, ' ', 11).map(r => ' ' + r), '',
      dim('wizard steps'), '  ' + ['Kind', 'Connection', 'Models', 'Review'].map((n, i) => i < 2 ? `${grn('✓')} ${n}` : i === 2 ? `${tc(T, 'active', '●', true)} ${tc(T, 'active', n, true)}` : `${tc(T, 'idle', '○ ' + n)}`).join(dim('  ›  ')), '',
      dim('narrow (40 columns): the active tab always stays visible, the rest folds to +N'), `  ${tc(T, 'idle', '‹')} ${tc(T, 'active', HT[tb.h][0] + (HT[tb.h][1] !== undefined ? ' ' + HT[tb.h][1] : ''), true)}  ${tc(T, 'idle', HT[(tb.h + 1) % HT.length][0])}  ${tc(T, 'idle', '+' + (HT.length - 2))} ${tc(T, 'idle', '›')}`, '',
      dim('text states'), '  ' + sampleRow(THEMES.dark), '  ' + sampleRow(THEMES.light) + dim('   ← light palette, for light terminals'), '',
      dim('WCAG contrast of each text colour against its assumed terminal background (need ≥ 4.5)'),
      contrastLine('dark', THEMES.dark), contrastLine('light', THEMES.light), '',
      dim('NO_COLOR fallback: weight and the rule carry the state'),
      '  ' + bold('Overview') + '   Usage 3   Connections !   Skills 12   About', '  ' + '━'.repeat(8),
    ]
  },
  onKey: (k) => {
    if (k === 'h') tb.focus = 'h'
    else if (k === 'v') tb.focus = 'v'
    else if (k === 't') tb.theme = tb.theme === 'dark' ? 'light' : 'dark'
    else if (tb.focus === 'h') {
      if (k === '\x1b[C') tb.h = Math.min(HT.length - 1, tb.h + 1)
      if (k === '\x1b[D') tb.h = Math.max(0, tb.h - 1)
    } else {
      if (k === '\x1b[B') tb.v = Math.min(VRI.length - 1, tb.v + 1)
      if (k === '\x1b[A') tb.v = Math.max(0, tb.v - 1)
    }
  } })

// ================================================================ 11 expandable lists
const ex = {}
const EXP = [
  { group: 'MCP SERVERS', count: 4 },
  { id: 'fs', kind: 'tree', label: 'filesystem', st: 'ok', stText: 'connected · 120ms', kids: [['read_file', 1, 'Read a file from disk'], ['write_file', 1, 'Create or overwrite a file'], ['delete_file', 0, 'Remove a file', 'dangerous'], ['list_dir', 1, 'List a directory']] },
  { id: 'gh', kind: 'tree', label: 'github', st: 'ok', stText: 'connected · 340ms', kids: [['create_issue', 1, 'Open an issue'], ['list_prs', 1, 'List pull requests'], ['merge_pr', 0, 'Merge a pull request', 'dangerous'], ['comment', 1, 'Comment on an issue or PR'], ['+8 more', null]] },
  { id: 'pg', kind: 'tree', label: 'postgres', st: 'fail', stText: 'auth failed', kids: [['query', 0, 'Run a read-only query'], ['schema', 0, 'Describe tables']] },
  { id: 'br', kind: 'tree', label: 'browser', st: 'load', stText: 'connecting…', kids: [] },
  { group: 'SKILLS', count: 2 },
  { id: 'sk1', kind: 'acc', label: 'plugin-author', st: 'meta', stText: 'preset', text: ['Prototype a Cordis plugin in-process,', 'then promote it to a durable external plugin.'] },
  { id: 'sk2', kind: 'acc', label: 'preset-author', st: 'meta', stText: 'preset', text: ['Compose user-owned presets on the native', 'dsh services and the four UI services.'] },
]
function exRows() {
  const rows = []
  EXP.forEach(n => {
    if (n.group) { rows.push({ group: n }); return }
    rows.push({ n, top: true })
    if (ex.open.has(n.id)) {
      if (n.kind === 'tree') n.kids.forEach((k, i) => rows.push({ n, k, last: i === n.kids.length - 1 }))
      else n.text.forEach((t, i) => rows.push({ n, text: t, last: i === n.text.length - 1 }))
    }
  })
  return rows
}
const sel = r => r.top || r.k
const isOn = (n, k) => ex.on[n.id + k[0]] ?? k[1]
const triState = n => { const real = n.kids.filter(k => k[1] !== null); const on = real.filter(k => isOn(n, k)).length; return on === 0 ? 'none' : on === real.length ? 'all' : 'some' }
const NAME_W = 15, ST_W = 26, RIGHT_W = 9
scene({ name: 'Expandable', keys: '↑↓ move · →/Space expand · ← collapse · Enter toggle · * expand all · - collapse all',
  init: () => Object.assign(ex, { open: new Set(['fs']), cur: 0, on: {}, note: '' }),
  render: (f) => {
    const rows = exRows()
    const selectable = rows.filter(sel)
    const out = []
    rows.forEach(r => {
      if (r.group) { out.push(out.length ? '' : null, dim(` ${r.group.group}  ${r.group.count}`)); return }
      const on = sel(r) && selectable.indexOf(r) === ex.cur
      if (r.top) {
        const n = r.n
        const chev = ex.open.has(n.id) ? '▾' : '▸'
        const tri = n.kind === 'tree' && n.kids.length ? { all: '[x]', some: '[-]', none: '[ ]' }[triState(n)] : '   '
        const stG = n.st === 'ok' ? '✓' : n.st === 'fail' ? '✗' : n.st === 'load' ? pick(gap, f) : ' '
        const st = `${stG} ${n.stText}`
        const right2 = n.kind === 'tree' ? (n.kids.length ? `${n.kids.length} tools` : '') : ''
        const summary = n.kind === 'acc' ? cut(n.text[0], 34) : ''
        const plain = n.kind === 'acc' ? `${chev}     ${pad(n.label, NAME_W)} ${pad(n.stText, 10)} ${ex.open.has(n.id) ? '' : summary}` : `${chev} ${tri} ${pad(n.label, NAME_W)} ${pad(st, ST_W)} ${right2.padStart(RIGHT_W)}`
        if (on) { out.push(acc('▌') + inv(' ' + plain + ' ')); return }
        const stPaint = n.st === 'ok' ? grn(stG) + dim(' ' + n.stText) : n.st === 'fail' ? red(stG) + red(' ' + n.stText) : n.st === 'load' ? acc(stG) + dim(' ' + n.stText) : dim(st)
        const triPaint = tri.trim() === '' ? tri : tri === '[x]' ? acc(tri) : tri === '[-]' ? yel(tri) : dim(tri)
        if (n.kind === 'acc') { out.push(`  ${dim(chev)}     ${bold(pad(n.label, NAME_W))} ${dim(pad(n.stText, 10))} ${ex.open.has(n.id) ? '' : dim(summary)}`); return }
        out.push(`  ${dim(chev)} ${triPaint} ${bold(pad(n.label, NAME_W))} ${pad(stPaint, ST_W)} ${dim(right2.padStart(RIGHT_W))}`)
      } else if (r.k) {
        const [name, def, desc, badge] = r.k
        const enabled = isOn(r.n, r.k)
        const guide = r.last ? '╰' : '│'
        const box2 = enabled === null ? '   ' : enabled ? '[x]' : '[ ]'
        const tail = enabled === null ? 'Enter loads the next page' : desc
        const plain = `  ${guide} ${box2} ${pad(name, NAME_W)} ${cut(tail, ST_W + 2).padEnd(ST_W)}${badge ? ' ⚠ ' + badge : ''}`
        if (on) { out.push(acc('▌') + inv(' ' + plain + ' ')); return }
        out.push(`   ${dim(guide)} ${enabled ? acc(box2) : dim(box2)} ${enabled ? pad(name, NAME_W) : dim(pad(name, NAME_W))} ${dim(cut(tail, ST_W + 2).padEnd(ST_W))}${badge ? ' ' + yel('⚠ ' + badge) : ''}`)
      } else out.push(`     ${dim((r.last ? '╰' : '│') + ' ' + r.text)}`)
    })
    return [
      dim('tree with tri-state parents, aligned status and count columns, tool descriptions · accordion for skills'), '',
      ...out.filter(l => l !== null), '',
      ex.note ? grn(ex.note) : '',
    ]
  },
  onKey: (k) => {
    const rows = exRows()
    const selectable = rows.filter(sel)
    const r = selectable[ex.cur]
    ex.note = ''
    if (k === '\x1b[B') ex.cur = Math.min(selectable.length - 1, ex.cur + 1)
    else if (k === '\x1b[A') ex.cur = Math.max(0, ex.cur - 1)
    else if (k === '*') EXP.filter(n => n.id).forEach(n => ex.open.add(n.id))
    else if (k === '-') { ex.open.clear(); ex.cur = 0 }
    else if (r?.top && (k === '\x1b[C' || k === ' ')) ex.open.has(r.n.id) ? ex.open.delete(r.n.id) : ex.open.add(r.n.id)
    else if (k === '\x1b[D') {
      if (r?.top) ex.open.delete(r.n.id)
      else if (r?.k) { ex.open.delete(r.n.id); ex.cur = selectable.findIndex(x => x.top && x.n === r.n) }
    } else if (k === '\r' && r) {
      if (r.top && r.n.kind === 'tree') {
        const all = triState(r.n) !== 'all'
        r.n.kids.forEach(kid => { if (kid[1] !== null) ex.on[r.n.id + kid[0]] = all ? 1 : 0 })
        ex.note = `${all ? 'enabled' : 'disabled'} all tools of ${r.n.label}`
      } else if (r.top) ex.open.has(r.n.id) ? ex.open.delete(r.n.id) : ex.open.add(r.n.id)
      else if (r.k[1] !== null) { const key = r.n.id + r.k[0]; ex.on[key] = isOn(r.n, r.k) ? 0 : 1 }
      else ex.note = '(loads the next page of tools)'
    }
  } })

// ================================================================ form engine
const DIRS = ['~/work/mayfly', '~/work/website', '~/work/dsh', '~/notes', '~/Downloads']
function makeForm(fields) {
  fields.forEach(f => { f.v = structuredClone(f.value); f.init = structuredClone(f.value) })
  const F = { i: fields.findIndex(f => f.type !== 'section'), editing: false, picker: null, note: '', fields }
  const focusable = () => fields.map((f, i) => f.type === 'section' ? -1 : i).filter(i => i >= 0)
  const differs = f => JSON.stringify(f.v) !== JSON.stringify(f.init)
  const isText = f => ['input', 'secret', 'textarea'].includes(f.type)
  const err = f => {
    if (f.required && (f.v === '' || f.v == null)) return 'Required'
    if (f.id === 'url' && f.v && !/^https?:\/\/\S+$/.test(f.v)) return 'Must be an http(s) URL'
    return null
  }
  const move = d => { const fs = focusable(); const at = fs.indexOf(F.i); F.i = fs[Math.max(0, Math.min(fs.length - 1, at + d))] }
  const enabledOpts = f => f.options.filter(o => !o.disabled)
  F.capture = () => F.editing || F.picker !== null
  F.render = (focused = true) => {
    const out = []
    fields.forEach((f, i) => {
      if (f.type === 'section') { out.push(dim(`── ${f.label} ${'─'.repeat(Math.max(2, 40 - f.label.length))}`)); return }
      const foc = focused && i === F.i
      const ed = foc && F.editing
      const label = pad(f.label + ':', 13)
      const mark = foc ? acc('▸') : differs(f) ? acc('•') : ' '
      let val
      if (f.type === 'input') val = ed ? f.v + '▌' : f.v ? f.v : dim(f.placeholder ?? '')
      else if (f.type === 'secret') val = ed ? '•'.repeat(f.v.length) + '▌' : f.v ? '•'.repeat(Math.min(10, f.v.length)) + dim(' (saved)') : dim('not set')
      else if (f.type === 'number') val = ed ? String(f.v) + '▌' : foc ? `‹ ${f.v} ›${f.unit ? ' ' + f.unit : ''}${dim(`  ${f.min}–${f.max}`)}` : `${f.v}${f.unit ? ' ' + f.unit : ''}`
      else if (f.type === 'select') val = foc && !F.picker ? `‹ ${f.v} ›` : f.v
      else if (f.type === 'toggle') val = f.v ? acc('[on]') : dim('[off]')
      else if (f.type === 'multiselect') val = f.v.length ? f.v.join(', ') : dim('None selected')
      else if (f.type === 'textarea') val = foc || ed ? '' : (f.v.split('\n')[0] || dim('empty')) + (f.v.includes('\n') ? dim(' …') : '')
      else if (f.type === 'actions') { out.push(`${foc ? acc('▸') : ' '} ${foc ? inv(' Save ') : '[ Save ]'}  [ Cancel ]`); return }
      const origin = f.inherited ? (differs(f) ? dim('  (override)') : dim('  (inherited)')) : ''
      out.push(`${mark} ${foc ? bold(label) : label}${val}${origin}`)
      if (f.type === 'textarea' && (foc || ed)) {
        const lines = f.v.split('\n')
        const w = 42
        out.push(`    ${dim('┌' + '─'.repeat(w) + '┐')}`)
        for (let n = 0; n < Math.max(3, lines.length); n++) {
          const text = (lines[n] ?? '') + (ed && n === lines.length - 1 ? '▌' : '')
          out.push(`    ${dim('│')} ${pad(text, w - 1)}${dim('│')}`)
        }
        out.push(`    ${dim('└' + '─'.repeat(w) + '┘')}`)
      }
      const e = err(f)
      if (e && (differs(f) || ed)) out.push(`    ${red('! ' + e)}`)
      if (foc && f.help && !F.picker) out.push(`    ${dim(f.help)}`)
      if (ed && f.id === 'workdir') {
        const hits = DIRS.filter(d => d.startsWith(f.v)).slice(0, 3)
        hits.forEach((d, n) => out.push(`    ${dim(n === 0 ? '⇥ ' : '  ')}${dim(d)}`))
      }
      if (foc && F.picker) {
        f.options.forEach((o, n) => {
          const cur = n === F.picker.idx
          const on = f.type === 'multiselect' ? F.picker.set.has(o.id) : o.id === f.v
          out.push(`    ${cur ? acc('>') : ' '} ${o.disabled ? dim(`[ ] ${o.id} — ${o.disabled}`) : `${on ? '[x]' : '[ ]'} ${o.id}`}`)
        })
      }
    })
    return out
  }
  F.hint = () => {
    const f = fields[F.i]
    if (F.picker) return f.type === 'multiselect' ? '↑↓ move · Space toggle · Enter apply · Esc cancel' : '↑↓ move · Enter apply · Esc cancel'
    if (F.editing) return `Enter commit · Esc done${f.type === 'textarea' ? ' · Alt+Enter newline' : ''}${f.id === 'workdir' ? ' · Tab complete' : ''}`
    const parts = ['↑↓ field']
    if (f.type === 'select') parts.push('←/→ cycle', 'Enter list')
    else if (f.type === 'number') parts.push('←/→ step', 'Enter type')
    else if (f.type === 'toggle') parts.push('Space flip')
    else if (f.type === 'multiselect') parts.push('Enter open')
    else if (f.type === 'actions') parts.push('Enter save')
    else parts.push('Enter or type to edit')
    if (f.type !== 'actions' && differs(f)) parts.push('Delete reset')
    parts.push('Esc close')
    return parts.join(' · ')
  }
  F.key = (k) => {
    const f = fields[F.i]
    F.note = ''
    if (F.picker) {
      const opts = f.options
      const step = d => { let n = F.picker.idx; do { n += d } while (opts[n] && opts[n].disabled); if (opts[n]) F.picker.idx = n }
      if (k === '\x1b[A') step(-1)
      else if (k === '\x1b[B') step(1)
      else if (k === ' ' && f.type === 'multiselect') { const id = opts[F.picker.idx].id; F.picker.set.has(id) ? F.picker.set.delete(id) : F.picker.set.add(id) }
      else if (k === '\r') { f.v = f.type === 'multiselect' ? opts.filter(o => F.picker.set.has(o.id)).map(o => o.id) : opts[F.picker.idx].id; F.picker = null }
      else if (k === '\x1b') F.picker = null
      return
    }
    if (F.editing) {
      if (k === '\r') { if (f.type === 'number') f.v = Math.max(f.min, Math.min(f.max, Number(f.v) || f.min)); F.editing = false; move(1) }
      else if (k === '\x1b\r' && f.type === 'textarea') f.v += '\n'
      else if (k === '\x1b') { if (f.type === 'number') f.v = Math.max(f.min, Math.min(f.max, Number(f.v) || f.min)); F.editing = false }
      else if (k === '\x7f') f.v = f.type === 'number' ? Number(String(f.v).slice(0, -1)) || 0 : f.v.slice(0, -1)
      else if (k === '\t' && f.id === 'workdir') { const hit = DIRS.find(d => d.startsWith(f.v)); if (hit) f.v = hit }
      else if (printable(k)) { if (f.type === 'number') { if (/\d/.test(k)) f.v = Number(String(f.v) + k) } else f.v += k }
      return
    }
    if (k === '\x1b[A') move(-1)
    else if (k === '\x1b[B') move(1)
    else if (k === '\x1b[3~' && differs(f) && f.type !== 'actions') f.v = structuredClone(f.init)
    else if (f.type === 'select' && (k === '\x1b[C' || k === '\x1b[D')) {
      const opts = enabledOpts(f).map(o => o.id); const at = opts.indexOf(f.v)
      f.v = opts[Math.max(0, Math.min(opts.length - 1, (at < 0 ? (k === '\x1b[C' ? 0 : opts.length - 1) : at + (k === '\x1b[C' ? 1 : -1))))]
    } else if (f.type === 'number' && (k === '\x1b[C' || k === '\x1b[D')) f.v = Math.max(f.min, Math.min(f.max, f.v + (k === '\x1b[C' ? f.step : -f.step)))
    else if (f.type === 'toggle' && (k === ' ' || k === '\r')) f.v = !f.v
    else if ((f.type === 'select' || f.type === 'multiselect') && (k === '\r' || (k === ' ' && f.type === 'multiselect'))) F.picker = { idx: Math.max(0, f.options.findIndex(o => o.id === (f.type === 'select' ? f.v : f.v[0]))), set: new Set(f.type === 'multiselect' ? f.v : []) }
    else if (f.type === 'actions' && k === '\r') F.note = fields.some(x => err(x) && x.type !== 'actions') ? 'fix the errors first' : '→ saved'
    else if (isText(f) || f.type === 'number') { if (k === '\r') F.editing = true; else if (printable(k)) { F.editing = true; if (f.type === 'number') { if (/\d/.test(k)) f.v = Number(k) } else f.v = (f.type === 'secret' ? '' : f.v) + k } }
  }
  return F
}
const mkFields = () => [
  { type: 'section', label: 'Connection' },
  { id: 'name', type: 'input', label: 'Name', value: 'production', placeholder: 'e.g. production', required: true },
  { id: 'url', type: 'input', label: 'Endpoint', value: 'https://api.example.com/v1', help: 'Base URL, including the version path' },
  { id: 'key', type: 'secret', label: 'API key', value: 'sk-live-0123456789', help: 'Never shown again after saving' },
  { type: 'section', label: 'Behaviour' },
  { id: 'model', type: 'select', label: 'Model', value: 'deepseek-chat', inherited: true, options: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'custom-model', disabled: 'not in this plan' }] },
  { id: 'effort', type: 'select', label: 'Effort', value: 'medium', inherited: true, options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
  { id: 'timeout', type: 'number', label: 'Timeout', value: 30, min: 5, max: 120, step: 5, unit: 's', inherited: true },
  { id: 'stream', type: 'toggle', label: 'Streaming', value: true },
  { id: 'channels', type: 'multiselect', label: 'Channels', value: ['mentions', 'errors'], options: [{ id: 'mentions' }, { id: 'errors' }, { id: 'digest', disabled: 'enterprise only' }] },
  { id: 'workdir', type: 'input', label: 'Directory', value: '~/work/may', placeholder: '~/…', help: 'Type a path; Tab completes' },
  { id: 'notes', type: 'textarea', label: 'Notes', value: 'Prefer small diffs.\nAlways run the width scan.' },
  { type: 'section', label: 'Finish' },
  { type: 'actions', label: '' },
]
const form = { F: null }
scene({ name: 'Forms', keys: 'see the hint row under the form (it follows the focused field)',
  init: () => { form.F = makeForm(mkFields()) },
  capture: () => form.F.capture(),
  render: () => [
    dim('every field kind · no per-field buttons · secondary ops live in the hint row · ‹ › marks what ←/→ changes'),
    dim('• edited   ▸ focused   (inherited)/(override) is implicit state, not a button'), '',
    ...box('Edit provider', 'unsaved changes', [...form.F.render(), '', form.F.note ? grn(form.F.note) : '', dim(form.F.hint())], 74),
  ],
  onKey: k => form.F.key(k) })

// ================================================================ 13 panels
const pn = { v: 0, focus: 'rail', rail: 1, row: 0, tab: 0, filter: '', typing: false, bal: 0 }
const CWD = '/home/ubuntu/work/mayfly'
const S1 = [
  ['Update landing page hero', 'main', 12, '2m', true, 'Update the landing page hero copy and run the tests.', 'Done — the hero now reads "Ship agent UI in a keystroke".'],
  ['Fix width scan for tool rows', 'fix/width', 4, '1h', false, 'The tool rows overflow at 60 columns.', 'Added a truncate variant; scan passes.'],
  ['Release 0.1.3-rc.2', 'release', 9, '1d', false, 'Prepare the rc.2 release notes.', 'Tarballs verified.'],
]
const WS = [
  { name: 'All', n: 25 },
  { path: CWD, s: S1 },
  { path: '/home/ubuntu/dev/clients/acme/monorepo/packages/mayfly', s: [['Port the tray to acme layout', 'feat/tray', 6, '3h', false, 'Port the tray design to the acme fork.', 'Rebased; specs pass.'], ['Bump harness pins', 'main', 3, '2d', false, 'Update the harness line pins.', 'Pins updated.']] },
  { path: '/home/ubuntu/dev/experiments/very-long-project-name-here', s: [['Spike: session graph', 'spike', 2, '9d', false, 'Sketch a session graph view.', 'Parked.']] },
  { path: '/home/ubuntu/work/website', s: [['Add pricing page', 'main', 7, '4h', false, 'Add a pricing page under docs.', 'Preview is up.'], ['Fix dark-mode logo', 'fix/logo', 2, '2d', false, 'The logo is illegible in dark mode.', 'Swapped the asset.']] },
  { path: '/home/ubuntu/notes', s: [['Weekly review', '—', 6, '6d', false, 'Summarize the week.', 'Saved to notes.'], ['Reading list', '—', 3, '8d', false, 'Collect articles.', 'Done.']] },
]
WS.slice(1).forEach(w => { w.n = w.s.length + (w.path === CWD ? 5 : 3) })
const RAIL_W = 26
function wsLabel(w, all) {
  const segs = w.path.split('/').filter(Boolean)
  const base = segs.at(-1)
  const dup = all.filter(x => x.path && x.path.split('/').filter(Boolean).at(-1) === base).length > 1
  const label = dup ? segs.slice(-2).join('/') : base
  return [...label].length > RAIL_W - 9 ? '…' + [...label].slice(-(RAIL_W - 10)).join('') : label
}
const settingsForms = {}
const SETTINGS_GROUPS = ['General', 'Model', 'Permissions', 'Providers', 'MCP', 'Appearance', 'Keys']
const mkSettings = g => makeForm(({
  General: [{ id: 'lang', type: 'select', label: 'Language', value: 'English', options: [{ id: 'English' }, { id: '简体中文' }] }, { id: 'notif', type: 'toggle', label: 'Notifications', value: true }, { id: 'tele', type: 'toggle', label: 'Telemetry', value: false }],
  Model: [{ id: 'model', type: 'select', label: 'Model', value: 'deepseek-chat', inherited: true, options: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }, { id: 'effort', type: 'select', label: 'Effort', value: 'medium', inherited: true, options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }, { id: 'ctx', type: 'number', label: 'Context', value: 128, min: 32, max: 256, step: 32, unit: 'k', inherited: true }],
  Permissions: [{ id: 'preset', type: 'select', label: 'Preset', value: 'Default', options: [{ id: 'Default' }, { id: 'Accept edits' }, { id: 'Full access' }] }, { id: 'allow', type: 'multiselect', label: 'Auto-allow', value: ['read', 'grep'], options: [{ id: 'read' }, { id: 'grep' }, { id: 'bash' }, { id: 'write', disabled: 'needs Accept edits' }] }],
  Providers: [{ id: 'p', type: 'select', label: 'Provider', value: 'DeepSeek', options: [{ id: 'DeepSeek' }, { id: 'Local' }] }, { id: 'k', type: 'secret', label: 'API key', value: 'sk-0123456789' }],
  MCP: [{ id: 'auto', type: 'toggle', label: 'Auto-connect', value: true }, { id: 'to', type: 'number', label: 'Timeout', value: 20, min: 5, max: 60, step: 5, unit: 's' }],
  Appearance: [{ id: 'theme', type: 'select', label: 'Theme', value: 'dark', options: [{ id: 'dark' }, { id: 'light' }, { id: 'ocean' }, { id: 'paper' }] }, { id: 'dens', type: 'select', label: 'Density', value: 'comfortable', options: [{ id: 'compact' }, { id: 'comfortable' }] }],
  Keys: [{ id: 'mode', type: 'select', label: 'Editor mode', value: 'emacs', options: [{ id: 'emacs' }, { id: 'vim' }] }, { id: 'paste', type: 'select', label: 'Paste backend', value: 'auto', options: [{ id: 'auto' }, { id: 'osc52' }, { id: 'native' }] }],
})[g])
const sessionsOf = () => {
  const w = WS[pn.rail]
  const list = w.name === 'All' ? WS.slice(1).flatMap(x => x.s) : w.s
  return list.filter(x => x[0].toLowerCase().includes(pn.filter.toLowerCase()))
}
const BAL = ['ok', 'low', 'loading', 'error', 'none']
const balanceRow = (f) => {
  const st = BAL[pn.bal]
  if (st === 'ok') return [`${grn('✓')} ${bold('¥ 128.40')} ${dim('available')}`, `${dim('topped-up ¥ 100.00 · granted ¥ 28.40')}`]
  if (st === 'low') return [`${yel('⚠')} ${bold(yel('¥ 6.20'))} ${yel('low balance')} ${dim('· below ¥ 10.00')}`, `${dim('topped-up ¥ 0.00 · granted ¥ 6.20')}`]
  if (st === 'loading') return [`${acc(pick(gap, f))} ${dim('checking balance…')}`, '']
  if (st === 'error') return [`${dim('—')} ${dim('unavailable (network)')}  ${dim('r retry')}`, '']
  return [dim('not supported by this provider'), '']
}
scene({ name: 'Panels', keys: 'v switch panel · Sessions: ↑↓ ←/→ / filter · Settings: rail then form · Status: ←/→ tabs, b balance state, r refresh',
  init: () => { Object.assign(pn, { v: 0, focus: 'rail', rail: 1, row: 0, tab: 0, filter: '', typing: false, bal: 0 }); SETTINGS_GROUPS.forEach(g => { settingsForms[g] = mkSettings(g) }) },
  capture: () => pn.typing || (pn.v === 1 && pn.focus === 'content' && settingsForms[SETTINGS_GROUPS[pn.rail]]?.capture()),
  render: (f) => {
    const names = ['Sessions', 'Settings', 'Status']
    const head = dim('panel ') + names.map((n, i) => i === pn.v ? bold(acc(n)) : dim(n)).join(dim(' · ')) + dim('   (v)')
    if (pn.v === 0) {
      const list = sessionsOf()
      const row = Math.min(pn.row, Math.max(0, list.length - 1))
      const w = WS[pn.rail]
      const rail = ['', ...WS.map((x, i) => {
        const name = x.name ?? wsLabel(x, WS)
        const on = i === pn.rail
        return `${on ? acc('▌') : ' '} ${on ? (pn.focus === 'rail' ? inv(bold(` ${pad(name, RAIL_W - 9)}`)) : bold(' ' + pad(name, RAIL_W - 9))) : ' ' + pad(name, RAIL_W - 9)} ${dim(String(x.n).padStart(2))}`
      })]
      const pathLine = w.path ? `${dim('⌂')} ${dim(midCut(w.path, 52))}` : dim('all workspaces')
      const content = [pathLine, `${dim('/')} ${pn.typing ? pn.filter + '▌' : pn.filter || dim('filter…')}`, dim('Recent')]
      if (!list.length) content.push(dim(pn.filter ? `  No sessions match "${pn.filter}" — Esc clears the filter` : '  No sessions here yet — start one with n'))
      list.forEach((x, i) => {
        const on = pn.focus === 'content' && i === row
        const line = `${cut(x[0], 30).padEnd(30)} ${dim(x[1].padEnd(10) + String(x[2]).padStart(2) + ' turns ' + x[3].padStart(3))}`
        content.push(on ? acc('▌') + inv(strip(line)) : ' ' + line)
        if (on) { content.push(dim('    │ ') + cut(x[5], 50)); content.push(dim('    │ ') + dim(cut(x[6], 50))) }
      })
      const foot = pn.typing ? 'Enter apply · Esc clear' : pn.focus === 'rail' ? '↑↓ workspace · → sessions · / filter · y copy path · Esc close' : '↑↓ move · ← workspaces · Enter resume · n new · x delete · Esc close'
      return [head, '', ...box('Sessions', `${WS[0].n} total`, [...columns(rail, content, RAIL_W, ' │ ', 9), '', dim(foot)], 96),
        '', dim('labels: basename, plus the shortest distinguishing parent when names collide, ellipsised at the start'),
        dim(`full path of the selected workspace is the first line of the content (middle-ellipsised); y copies it`)]
    }
    if (pn.v === 1) {
      const g = SETTINGS_GROUPS[Math.min(pn.rail, SETTINGS_GROUPS.length - 1)]
      const F = settingsForms[g]
      const rail = SETTINGS_GROUPS.map((n, i) => `${i === pn.rail ? acc('▌') : ' '} ${i === pn.rail ? (pn.focus === 'rail' ? inv(bold(` ${n} `)) : bold(n)) : n}`)
      const content = [bold(acc(g)), '', ...F.render(pn.focus === 'content')]
      return [head, '', ...box('Settings', 'saved', [...columns(rail, content, 16), '', dim(pn.focus === 'rail' ? '↑↓ group · → edit · Esc close' : F.hint() + ' · ← groups')], 80)]
    }
    const tabs = ['Overview', 'Usage', 'Account', 'Connections', 'About']
    const label = i => tabs[i] === 'Connections' ? 'Connections ' + yel('!') : tabs[i] === 'Account' && BAL[pn.bal] === 'low' ? 'Account ' + yel('!') : tabs[i]
    const off = tabs.slice(0, pn.tab).reduce((a2, n, i) => a2 + vlen(label(i)) + 3, 0)
    const [balMain, balSub] = balanceRow(f)
    const bodies = [
      [['Model', 'deepseek-chat · High effort'], ['Provider', 'DeepSeek (api.deepseek.com)'], ['Directory', '~/work/mayfly  main ±3'], ['Mode', 'Default permissions · plan off'], ['Session', 'Update landing page hero · 12 turns · 18m'], ['Context', `${bar(2, 10)} 18%  22.9k / 128k · cache 34%`], ...(BAL[pn.bal] === 'none' ? [] : [['Balance', balMain]])],
      [['Input', '148.2k tokens  ·  cache read 50.4k'], ['Output', '18.9k tokens'], ['Requests', '31  ·  0 failed'], ['Cost', '≈ ¥ 3.02 this session'], ['Today', '≈ ¥ 13.40  ·  4 sessions']],
      [['Provider', 'DeepSeek'], ['Balance', balMain], ['', balSub], ['Checked', BAL[pn.bal] === 'loading' ? dim('now') : dim('2 min ago · r refresh')], ['Top up', dim('platform.deepseek.com  ·  o open in browser')]],
      [[grn('✓') + ' filesystem', '4 tools · 120 ms'], [grn('✓') + ' github', '12 tools · 340 ms'], [red('✗') + ' postgres', 'auth failed — run /mcp to fix'], [acc(pick(gap, f)) + ' browser', 'connecting…']],
      [['Mayfly', '0.1.3-rc.2'], ['Harness', 'line 0.x pinned'], ['Node', process.version], ['Install', '~/.local/share/mayfly'], ['Docs', 'docs/README.md']],
    ]
    return [head, '', ...box('Status', 'read-only', [
      '  ' + tabs.map((n, i) => i === pn.tab ? bold(acc(label(i))) : dim(label(i))).join('   '),
      '  ' + ' '.repeat(off) + acc('━'.repeat(vlen(label(pn.tab)))),
      '',
      ...bodies[pn.tab].map(([k, v]) => `  ${dim(pad(k, 12))} ${v}`),
      '', dim(`←/→ tab · r refresh${pn.tab === 2 ? ' · o top up' : ''} · Esc close`),
    ], 84),
      dim(`[demo] b cycles the balance state: ${BAL[pn.bal]}`),
      '', dim('balance = one read-only provider query, cached, shown only when the provider supports it; a failed check never affects chat. When low, the status bar can carry a small ⚠ ¥6.2 chip.')]
  },
  onKey: (k) => {
    if (pn.typing) {
      if (k === '\r') pn.typing = false
      else if (k === '\x1b') { pn.typing = false; pn.filter = '' }
      else if (k === '\x7f') pn.filter = pn.filter.slice(0, -1)
      else if (printable(k)) { pn.filter += k; pn.row = 0 }
      return
    }
    if (k === 'v' && !(pn.v === 1 && pn.focus === 'content')) { pn.v = (pn.v + 1) % 3; pn.focus = 'rail'; pn.rail = pn.v === 0 ? 1 : 0; pn.row = 0; return }
    if (pn.v === 0) {
      if (k === '/') pn.typing = true
      else if (k === '\x1b[C') pn.focus = 'content'
      else if (k === '\x1b[D') pn.focus = 'rail'
      else if (k === '\x1b[B') { if (pn.focus === 'rail') { pn.rail = Math.min(WS.length - 1, pn.rail + 1); pn.row = 0 } else pn.row = Math.min(sessionsOf().length - 1, pn.row + 1) }
      else if (k === '\x1b[A') { if (pn.focus === 'rail') { pn.rail = Math.max(0, pn.rail - 1); pn.row = 0 } else pn.row = Math.max(0, pn.row - 1) }
    } else if (pn.v === 1) {
      const F = settingsForms[SETTINGS_GROUPS[pn.rail]]
      if (pn.focus === 'rail') {
        if (k === '\x1b[B') pn.rail = Math.min(SETTINGS_GROUPS.length - 1, pn.rail + 1)
        else if (k === '\x1b[A') pn.rail = Math.max(0, pn.rail - 1)
        else if (k === '\x1b[C' || k === '\r') pn.focus = 'content'
      } else if (k === '\x1b[D' && !F.editing && F.fields[F.i].type !== 'select' && F.fields[F.i].type !== 'number') pn.focus = 'rail'
      else if (k === '\x1b' && !F.editing && !F.picker) pn.focus = 'rail'
      else F.key(k)
    } else {
      if (k === '\x1b[C') pn.tab = Math.min(4, pn.tab + 1)
      else if (k === '\x1b[D') pn.tab = Math.max(0, pn.tab - 1)
      else if (k === 'b') pn.bal = (pn.bal + 1) % BAL.length
    }
  } })

// ================================================================ 14 interaction gallery
const gl = { v: 0, q: '', typing: false, sel: 0, note: '', yes: false }
const CMDS = [['/model', 'Switch model', 'Alt+M'], ['/effort', 'Set thinking effort', ''], ['/compact', 'Compact the context', ''], ['/clear', 'Start a fresh conversation', ''], ['/rewind', 'Restore a checkpoint', 'Esc Esc'], ['/sessions', 'Browse and resume sessions', ''], ['/settings', 'Edit settings', ''], ['/jobs', 'Browse background jobs', ''], ['/agents', 'Browse subagents', 'F7'], ['/status', 'Show session status', ''], ['/schedule', 'Show scheduled reminders', ''], ['/btw', 'Ask a side question', '']]
const FILES = [['pane-activity.ts', 'packages/mayfly/src/transcript/', 42], ['pane-agents.ts', 'packages/mayfly/src/transcript/', 1], ['activity-detail.ts', 'packages/mayfly/src/conversation/', 1]]
const CHANGED = [['M', 'pane-activity.ts', 12, 3, 42], ['A', 'frame-table.ts', 18, 0, 1], ['D', 'moon-frames.ts', 0, 9, 1]]
const moveSel = (k, n) => { if (k === '\x1b[B') gl.sel = Math.min(n - 1, gl.sel + 1); else if (k === '\x1b[A') gl.sel = Math.max(0, gl.sel - 1) }
const G = [
  { t: 'Command palette (press / then type)', r: () => {
    const q = gl.q.replace(/^\//, '')
    const hits = CMDS.filter(c2 => c2[0].slice(1).includes(q)).slice(0, 6)
    const hl = s2 => q ? s2.replace(q, m => bold(acc(m))) : s2
    return [...box('Commands', `${hits.length} match${hits.length === 1 ? '' : 'es'}`, hits.length ? hits.map((h, i) => `${i === 0 ? acc('▸') : ' '} ${pad(hl(h[0]), 11)} ${pad(dim(h[1]), 32)} ${dim(pad(h[2], 8))}`) : [dim('No command matches')], 64), `  ${dim('> ')}${gl.q}${gl.typing ? '▌' : dim('  press / to type · Tab complete · Enter run · Esc close')}`]
  } },
  { t: '@ file picker — Enter opens in the external editor', k: k => {
    gl.note = ''
    moveSel(k, FILES.length)
    if (k === '\r') gl.note = `↗ opened ${FILES[gl.sel][0]}:${FILES[gl.sel][2]} in code`
    else if (k === '\t') gl.note = `inserted @${FILES[gl.sel][1]}${FILES[gl.sel][0]} into the prompt`
  }, r: () => [...box('Files', 'recent first', [...FILES.map((x, i) => `${i === gl.sel ? acc('▸') : ' '} ${i === gl.sel ? bold(pad(x[0], 20)) : pad(x[0], 20)} ${dim(pad(x[1], 34))}${i === gl.sel ? dim('↗ code') : ''}`), '', dim('↑↓ · Enter open in code · Tab insert @mention · Esc close')], 76), `  ${dim('>')} explain @pane-act▌`, '  ' + (gl.note ? grn(gl.note) : '')] },
  { t: 'Changed files — same keys', k: k => {
    gl.note = ''
    moveSel(k, CHANGED.length)
    if (k === '\r') gl.note = `↗ opened ${CHANGED[gl.sel][1]}:${CHANGED[gl.sel][4]} in code (first changed line)`
    else if (k === 'd') gl.note = `(shows the diff of ${CHANGED[gl.sel][1]})`
  }, r: () => [...box('Changed files', '3 this session', [...CHANGED.map((x, i) => `${i === gl.sel ? acc('▸') : ' '} ${x[0] === 'M' ? yel('M') : x[0] === 'A' ? grn('A') : red('D')} ${pad(x[1], 20)} ${grn('+' + x[2])} ${red('−' + x[3])}${i === gl.sel ? dim('   ↗ code :' + x[4]) : ''}`), '', dim('↑↓ · Enter open in code at the first change · d diff · Esc close')], 76), '  ' + (gl.note ? grn(gl.note) : ''), dim('  GUI editors open detached; terminal editors (vim, nvim, hx) suspend Mayfly and restore it after. No editor set → hint to /settings.')] },
  { t: 'Notifications and undo', r: () => [
    right(`${acc(pick(fillGlyph, 0))} Working ${dim('· 4s')}`, `${grn('✓')} build finished · 22s  ${dim('Ctrl+J view')}`, 76),
    right('', `${yel('●')} plan is waiting for your reply  ${dim('F7')}`, 76), '',
    dim('after a destructive action, an undo toast (8 s):'),
    right(`${dim('⊘')} Deleted session "Docs sync"`, `${dim('u undo · 8s')}`, 76)] },
  { t: 'Queued messages and attachments', r: () => [
    `${dim('queued (2)')}  ${dim('⏎')} "also update the docs"   ${dim('⏎')} "then run lint"      ${dim('↑ edit · Esc clear')}`,
    dim('╭' + '─'.repeat(76) + '╮'), dim('│') + pad(' > ▌', 76) + dim('│'), dim('╰' + '─'.repeat(76) + '╯'), '',
    dim('attachments'), `  ${dim('[')}${acc('Image #1')} ${dim('84 KB')} ${dim('×]')}  ${dim('[')}${acc('notes.md')} ${dim('2 KB')} ${dim('×]')}     ${dim('Backspace removes the last chip')}`] },
  { t: 'Rewind / checkpoints', r: () => box('Rewind', '5 checkpoints', [`${acc('▸')} ${bold('Before "Run the tests"')}      ${dim('12m ago · 2 files changed after')}`, `  Before "Update landing page hero"  ${dim('18m ago · 5 files')}`, `  Session start                      ${dim('24m ago')}`, '', `${dim('Restore:')} ${bold(acc('‹ conversation + code ›'))}  ${dim('conversation only · code only')}`, dim('↑↓ checkpoint · ←/→ scope · Enter restore · Esc close')], 74) },
  { t: 'Diff hunk review (per-hunk accept)', r: () => [`${dim('hunk 1 of 3')}   ${yel('pane-activity.ts')}  ${stat(2, 1)}`, ...diff(EDIT_ROWS.slice(0, 4)), '', `${inv(' a accept ')}  r reject  ${dim('A accept all · R reject all · n/p next/prev hunk · Esc later')}`] },
  { t: 'Errors and connection banners', r: () => [
    `${yel('⚠')} ${bold('Rate limited')} ${dim('· retrying in')} ${bold(String(12 - (Math.floor(Date.now() / 1000) % 12)))}s ${dim('· attempt 2 of 5 · Esc cancel')}`,
    `${red('✗')} ${bold('Offline')} ${dim('· cannot reach api.deepseek.com · r retry · /settings provider')}`,
    `${yel('⚠')} ${bold('Context 92% full')} ${dim('· /compact now, or it will compact automatically at 95%')}`,
    `${yel('⚠')} ${bold('Balance low')} ${dim('· ¥ 6.20 left · /status account')}`,
    `${acc('ℹ')} ${dim('Resumed session · 24 turns · last active 2h ago')}`] },
  { t: 'Key help (?) — contextual, grouped', r: () => box('Keys', 'while typing a prompt', [bold('Send') + '      Enter send · Alt+Enter newline', bold('Complete') + '  / commands · @ files · # skills · ! shell', bold('Model') + '     Alt+M cycle · /model pick · /effort', bold('Modes') + '     Shift+Tab plan · Ctrl+Y yolo', bold('View') + '      Ctrl+O expand · Ctrl+T todo · F6 panes · F7 switch · Ctrl+F search', '', dim('Esc close · / search keys')], 76) },
  { t: 'Job output viewer with follow', r: () => box('Job · dev', 'running 4m 2s', [dim('12:01:02') + '  ready in 412 ms', dim('12:01:05') + '  GET /  200  8ms', dim('12:01:09') + '  GET /api/models  200  22ms', dim('12:01:14') + '  ' + yel('warn') + '  slow query 380ms', dim('12:01:20') + '  GET /  200  6ms', '', right(dim('f follow on · ↑ scroll (follow off)'), dim('x stop · Esc back'), 70)], 74) },
  { t: 'Delete session — just Yes / No', k: k => {
    gl.note = ''
    if (k === '\x1b[C' || k === '\x1b[D') gl.yes = !gl.yes
    else if (k === 'y') { gl.yes = true; gl.note = '⊘ Deleted "Docs sync" (undo with u for 8s)' }
    else if (k === 'n' || k === '\x1b') { gl.yes = false; gl.note = 'cancelled' }
    else if (k === '\r') gl.note = gl.yes ? '⊘ Deleted "Docs sync" (undo with u for 8s)' : 'cancelled'
  }, r: () => [...box('Delete session', '', ['Delete "Docs sync" and its 3 turns?', dim('This cannot be undone.'), '', `${gl.yes ? '[ No ]' : inv(' No ')}  ${gl.yes ? inv(' Yes ') : '[ Yes ]'}`, dim('←/→ or n/y · Enter confirm · Esc cancel')], 60), '  ' + (gl.note ? grn(gl.note) : ''), dim('  No is focused first (the shared confirm). Optional: soft-delete with an 8 s undo toast makes even this prompt unnecessary.')] },
]
scene({ name: 'Scenarios', keys: 'v/V next/previous scenario · per scenario: ↑↓ Enter Tab d y n ←/→ · palette: / then type, Esc stops',
  init: () => Object.assign(gl, { v: 0, q: '', typing: false, sel: 0, note: '', yes: false }),
  capture: () => gl.typing,
  render: () => [dim(`scenario ${gl.v + 1}/${G.length}: `) + bold(G[gl.v].t), dim(G.map((_, i) => i === gl.v ? '●' : '○').join(' ')), '', ...G[gl.v].r()],
  onKey: (k) => {
    if (gl.typing) {
      if (k === '\x1b' || k === '\r') gl.typing = false
      else if (k === '\x7f') gl.q = gl.q.slice(0, -1)
      else if (printable(k)) gl.q += k
      return
    }
    if (k === 'v') { gl.v = (gl.v + 1) % G.length; gl.sel = 0; gl.note = '' }
    else if (k === 'V') { gl.v = (gl.v + G.length - 1) % G.length; gl.sel = 0; gl.note = '' }
    else if (k === '/' && gl.v === 0) { gl.typing = true; gl.q = '/' }
    else G[gl.v].k?.(k)
  } })

// ================================================================ 15 transcript scroll + search
const TL = [
  '» Update the landing page hero copy and run the width scan.',
  '● I will start by reading the hero component.',
  '  ✓ Read Hero.tsx · 96 lines',
  '● The heading is set in two places; I will unify them.',
  '  ✓ Edited Hero.tsx  +4 −2',
  '● Now the tests. The width scan covers every row renderer.',
  '  ✓ Ran pnpm run test · 12.1s',
  '● 213 passed, 1 failed: the width scan overflows at 60 columns.',
  '  ✗ Ran pnpm run test:width · exit 1',
  '● The failing row is the tool-line renderer; I will truncate its detail.',
  '  ✓ Edited tool-line.ts  +6 −1',
  '» Also make sure the width scan runs for the new panels.',
  '● Adding the panels to the width scan spec.',
  '  ✓ Read width-scan.spec.ts · 210 lines',
  '  ✓ Edited width-scan.spec.ts  +18 −0',
  '● Running the width scan again to confirm.',
  '  ✓ Ran pnpm run test:width · 3.4s',
  '● All width scan cases pass, including 40 and 24 columns.',
  '» Great. Now update the screenshots.',
  '● Regenerating the screenshots with shots:sync.',
  '  ✓ Ran pnpm run shots:sync · 8.0s',
  '● Screenshots are fresh. Checking that shots:check agrees.',
  '  ✓ Ran pnpm run shots:check · 1.2s',
  '» Bump the changelog too.',
  '● Adding a changelog entry under Unreleased.',
  '  ✓ Edited CHANGELOG.md  +3 −0',
  '● Running the full gate one more time, width scan included.',
  '  ✓ Ran pnpm run verify:full · 4m 12s',
  '● Everything is green. Summary:',
  '  - hero copy updated in one place',
  '  - width scan now covers the panels',
  '  - screenshots and changelog updated',
  '● Ready for review.',
]
const tv = {}
const VH = 12
const escRe = q => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const allMatches = () => {
  if (!tv.q) return []
  const re = new RegExp(escRe(tv.q), 'gi'); const out = []
  TL.forEach((line, li) => { let m; while ((m = re.exec(line))) out.push({ li, col: m.index, len: m[0].length }) })
  return out
}
const clampTop = t => Math.max(0, Math.min(TL.length - VH, t))
const jump = m => { tv.top = clampTop(m.li - Math.floor(VH / 2)) }
scene({ name: 'Transcript', keys: '↑↓ PgUp PgDn Home End scroll · / or Ctrl+F search · n/N next/prev · Tab list · Esc back a layer',
  init: () => Object.assign(tv, { top: TL.length - VH, q: '', typing: false, open: false, idx: 0, list: false, since: Date.now() }),
  capture: () => tv.typing,
  render: () => {
    const ms = allMatches()
    const cur = ms[Math.min(tv.idx, ms.length - 1)]
    const bottom = TL.length - VH
    const atBottom = tv.top >= bottom
    if (atBottom) tv.since = Date.now()
    const fresh = atBottom ? 0 : Math.min(9, Math.floor((Date.now() - tv.since) / 3000))
    const thumb = Math.max(1, Math.round(VH * VH / TL.length))
    const thumbAt = bottom === 0 ? 0 : Math.round(tv.top / bottom * (VH - thumb))
    const tickRows = new Map()
    ms.forEach(m => tickRows.set(Math.min(VH - 1, Math.floor(m.li / TL.length * VH)), m === cur ? 'cur' : 'tick'))
    const paintLine = (li, text) => {
      const line = text ?? TL[li] ?? ''
      if (!tv.q) return line
      const re = new RegExp(escRe(tv.q), 'gi'); let out = '', last = 0, m
      while ((m = re.exec(line))) {
        const isCur = cur && cur.li === li && cur.col === m.index
        out += line.slice(last, m.index) + (isCur ? `\x1b[48;2;230;190;90m\x1b[38;2;20;15;0m${m[0]}\x1b[0m` : `\x1b[1;4m${yel(m[0])}`)
        last = m.index + m[0].length
      }
      return out + line.slice(last)
    }
    const W = 70
    const rows = []

    if (tv.list && tv.open) {
      const shown = ms.slice(0, VH)
      for (let r = 0; r < VH; r++) {
        const m = shown[r]
        rows.push(m ? `${r === tv.idx ? acc('▸') : ' '} ${dim('L' + String(m.li + 1).padStart(2))}  ${cut(strip(paintLine(m.li)), W - 10).replace(new RegExp(escRe(tv.q), 'i'), x => bold(yel(x)))}` : '')
      }
    } else {
      for (let r = 0; r < VH; r++) {
        const li = tv.top + r
        let line = pad(paintLine(li), W)
        if (r === VH - 1 && !atBottom) {
          const pill = `\x1b[48;2;154;134;230m\x1b[38;2;22;16;44m\x1b[1m ↓ ${fresh ? fresh + ' new · ' : ''}End \x1b[0m`
          line = pad(paintLine(li, cut(TL[li] ?? '', W - vlen(pill) - 1)), W - vlen(pill)) + pill
        }
        const inThumb = r >= thumbAt && r < thumbAt + thumb
        const tk = tickRows.get(r)
        const bar2 = tk === 'cur' ? acc('◆') : tk ? yel('▪') : inThumb ? acc('█') : dim('░')
        rows.push(`${line} ${bar2}`)
      }
    }
    const pct = Math.round((tv.top + VH) / TL.length * 100)
    const top = dim(`┌ Transcript ${'─'.repeat(W - 34)} L${tv.top + 1}–${tv.top + VH} of ${TL.length} · ${pct}% ┐`)
    const out = [top, ...rows.map(r => dim('│') + ' ' + r), dim('└' + '─'.repeat(W + 2) + '┘')]
    if (tv.open) {
      const count = ms.length ? `${Math.min(tv.idx, ms.length - 1) + 1}/${ms.length}` : red('no matches')
      out.push(`${acc('⌕')} ${tv.q}${tv.typing ? '▌' : ''}   ${bold(String(count))}   ${dim('Aa \\b')}   ${dim(tv.typing ? 'Enter next · Tab list · Esc keep matches' : 'n next · N prev · Tab list · Esc close')}`)
    } else out.push(dim('/ search · PgUp/PgDn scroll'))
    return [dim('scroll-away pill (bottom-right), scrollbar with match ticks (▪ ◆), incremental search, match list'), '', ...out]
  },
  onKey: (k) => {
    const ms = allMatches()
    if (tv.typing) {
      if (k === '\x1b') tv.typing = false
      else if (k === '\r') { if (ms.length) { tv.idx = (tv.idx + 1) % ms.length; jump(ms[tv.idx]) } }
      else if (k === '\t') tv.list = !tv.list
      else if (k === '\x7f') tv.q = tv.q.slice(0, -1)
      else if (printable(k)) { tv.q += k; const m2 = allMatches(); tv.idx = Math.max(0, m2.findIndex(m => m.li >= tv.top)); if (m2.length) jump(m2[tv.idx]) }
      return
    }
    if (k === '/' || k === '\x06') { tv.open = true; tv.typing = true; tv.q = ''; tv.idx = 0 }
    else if (k === '\x1b') { if (tv.list) tv.list = false; else if (tv.open) { tv.open = false; tv.q = '' } }
    else if (tv.open && k === 'n' && ms.length) { tv.idx = (tv.idx + 1) % ms.length; jump(ms[tv.idx]) }
    else if (tv.open && k === 'N' && ms.length) { tv.idx = (tv.idx + ms.length - 1) % ms.length; jump(ms[tv.idx]) }
    else if (tv.open && k === '\t') tv.list = !tv.list
    else if (tv.list && k === '\r' && ms.length) { jump(ms[Math.min(tv.idx, ms.length - 1)]); tv.list = false }
    else if (tv.list && (k === '\x1b[B' || k === '\x1b[A')) tv.idx = Math.max(0, Math.min(ms.length - 1, tv.idx + (k === '\x1b[B' ? 1 : -1)))
    else if (k === '\x1b[A') tv.top = clampTop(tv.top - 1)
    else if (k === '\x1b[B') tv.top = clampTop(tv.top + 1)
    else if (k === '\x1b[5~') tv.top = clampTop(tv.top - VH + 1)
    else if (k === '\x1b[6~') tv.top = clampTop(tv.top + VH - 1)
    else if (k === '\x1b[H') tv.top = 0
    else if (k === '\x1b[F') tv.top = TL.length - VH
  } })

// ================================================================ 16 plugin marketplace
const pm = {}
const MARKET = [
  { id: 'loop', name: 'Loop', src: 'official', status: 'stable', cat: 'Automation', desc: 'Repeat a prompt on an interval.', ver: '1.4.0', tui: true, web: true, tools: ['loop_start', 'loop_stop'], cmds: ['/loop'], eng: 'dsh ^0.2 · mayfly ^0.1', caps: ['schedule'], verified: '2026-09-20', installed: true, srcs: ['npm', 'github'] },
  { id: 'git-helper', name: 'Git Helper', src: 'community', status: 'stable', cat: 'Dev', desc: 'Branch, commit and PR helpers.', ver: '1.2.1', tui: true, web: true, tools: ['git_status', 'git_commit'], cmds: ['/git'], eng: 'dsh ^0.2', caps: ['shell'], verified: '2026-09-02', installed: true, update: '1.3.0', srcs: ['npm', 'github'] },
  { id: 'legacy-search', name: 'Legacy Search', src: 'community', status: 'deprecated', cat: 'Search', desc: 'Superseded by built-in web search.', ver: '0.9.4', tui: true, web: false, tools: ['lsearch'], cmds: [], eng: 'dsh ^0.1', caps: [], verified: '2026-03-11', installed: true, srcs: ['npm'], note: 'Use the built-in web_search tool.' },
  { id: 'agent-team', name: 'Agent Team', src: 'official', status: 'beta', cat: 'Collaboration', desc: 'A team of cooperating agents.', ver: '0.6.0', tui: true, web: true, tools: ['team_spawn', 'team_message'], cmds: ['/team'], eng: 'dsh ^0.2 · mayfly ^0.1', caps: ['agents'], verified: '2026-09-25', installed: false, srcs: ['npm', 'github'] },
  { id: 'notify', name: 'Desktop Notify', src: 'dsh', status: 'stable', cat: 'Utilities', desc: 'Desktop notification when a turn ends.', ver: '1.0.2', tui: true, web: false, tools: [], cmds: [], eng: 'dsh ^0.2', caps: ['notify'], verified: '2026-08-30', installed: false, srcs: ['npm'] },
  { id: 'mermaid', name: 'Mermaid Preview', src: 'dsh', status: 'stable', cat: 'Docs', desc: 'Render Mermaid diagrams in the web UI.', ver: '2.1.0', tui: false, web: true, tools: ['mermaid_render'], cmds: [], eng: 'dsh ^0.2', caps: [], verified: '2026-09-11', installed: false, srcs: ['npm'] },
  { id: 'jobs-board', name: 'Jobs Board', src: 'community', status: 'unstable', cat: 'Dev', desc: 'A live board of background jobs.', ver: '0.3.0', tui: true, web: true, tools: [], cmds: ['/board'], eng: 'dsh ^0.2', caps: ['jobs'], verified: '2026-09-18', installed: false, srcs: ['github'] },
  { id: 'old-theme', name: 'Neon Theme', src: 'community', status: 'removed', cat: 'Themes', desc: 'Removed from the market.', ver: '—', tui: true, web: false, tools: [], cmds: [], eng: '', caps: [], verified: '', installed: false, srcs: [], note: 'Removed by the author.' },
]
const STATUS_STYLE = { stable: s => '', beta: s => acc('beta'), unstable: s => yel('unstable'), deprecated: s => yel('deprecated'), removed: s => red('removed') }
const pmList = () => MARKET.filter(e => (pm.tab === 0 ? e.installed : !e.installed) && (e.name + e.desc + e.cat).toLowerCase().includes(pm.filter.toLowerCase()))
function pmTick() {
  if (pm.op && Date.now() - pm.op.t0 > 3200) {
    const e = MARKET.find(x => x.id === pm.op.id)
    if (pm.op.kind === 'install') { e.installed = true; pm.pending.add(e.id) }
    if (pm.op.kind === 'update') { e.ver = e.update; delete e.update; pm.pending.add(e.id) }
    if (pm.op.kind === 'remove') { e.installed = false; pm.pending.add(e.id) }
    pm.toast = `${pm.op.kind === 'remove' ? 'Removed' : pm.op.kind === 'update' ? 'Updated' : 'Installed'} ${e.name} · restart Mayfly to apply`
    pm.op = null
  }
  if (pm.refresh && Date.now() - pm.refresh > 1400) { pm.refresh = 0; pm.toast = `refreshed ${MARKET.length} entries` }
}
function pmRow(e, on, w) {
  const chip = e.update ? yel(`update ${e.update}`) : STATUS_STYLE[e.status](e.status)
  const surf = `${e.tui ? bold('T') : dim('·')} ${e.web ? bold('W') : dim('·')}`
  const plain = `${pad(e.name, 16)} ${pad(strip(chip), 13)} ${pad(e.src, 9)} ${surf}  ${(e.ver).padStart(6)}`
  if (on) return acc('▌') + inv(' ' + plain + ' ')
  return `  ${e.installed && pm.tab === 1 ? '' : ''}${e.status === 'removed' || e.status === 'deprecated' ? dim(pad(e.name, 16)) : bold(pad(e.name, 16))} ${pad(chip, 13)} ${dim(pad(e.src, 9))} ${surf}  ${dim(e.ver.padStart(6))}`
}
function pmDetail(e, w) {
  if (!e) return [dim('Nothing selected')]
  const lines = []
  lines.push(`${bold(e.name)}  ${dim(e.src + ' · ' + e.cat)}`)
  lines.push(dim(e.desc))
  if (e.note) lines.push(`${yel('⚠')} ${e.note}`)
  lines.push('')
  const state = e.installed ? (e.update ? yel(`installed ${e.ver} · update ${e.update}`) : grn(`✓ installed ${e.ver}`)) : e.status === 'removed' ? red('removed from the market') : dim(`not installed · ${e.ver}`)
  lines.push(`${dim(pad('Status', 10))} ${state}`)
  lines.push(`${dim(pad('Surfaces', 10))} TUI ${e.tui ? grn('✓ works here') : red('✗ no contribution in this terminal')}`)
  lines.push(`${dim(pad('', 10))} Web ${e.web ? grn('✓ works on dsh Web') : dim('— none')}`)
  if (e.tools.length || e.cmds.length) lines.push(`${dim(pad('Provides', 10))} ${[...e.cmds, ...e.tools].join(' · ')}`)
  if (e.eng) lines.push(`${dim(pad('Engines', 10))} ${e.eng}`)
  if (e.caps.length) lines.push(`${dim(pad('Needs', 10))} ${e.caps.join(', ')}`)
  if (e.verified) lines.push(`${dim(pad('Verified', 10))} ${e.verified}`)
  if (e.srcs.length > 1 && !e.installed) lines.push(`${dim(pad('Source', 10))} ‹ ${pm.source} › ${dim('s cycles')}`)
  else if (e.srcs.length) lines.push(`${dim(pad('Source', 10))} ${e.srcs[0]}`)
  return lines
}
scene({ name: 'Plugins', keys: '←/→ tab · ↑↓ · / filter · Enter details · i install · u update · x remove · s source · r refresh · w width · o offline (demo)',
  init: () => Object.assign(pm, { tab: 0, sel: 0, filter: '', typing: false, wide: true, detail: false, offline: false, op: null, pending: new Set(), toast: '', warn: '', confirm: false, source: 'npm', refresh: 0 }),
  capture: () => pm.typing,
  render: (f) => {
    pmTick()
    const list = pmList()
    const sel = Math.min(pm.sel, Math.max(0, list.length - 1))
    const e = list[sel]
    const inst = MARKET.filter(x => x.installed).length, brow = MARKET.length - inst
    const tabs = ['Installed ' + dim(String(inst)), 'Browse ' + dim(String(brow))].map((t, i) => i === pm.tab ? bold(acc(strip(t))) : dim(strip(t)))
    const underline = ' '.repeat(pm.tab === 0 ? 0 : strip(tabs[0]).length + 3) + acc('━'.repeat(strip(tabs[pm.tab]).length))
    const meta = pm.offline ? yel('⚠ offline · showing cached data from 2d ago') : pm.refresh ? `${acc(pick(gap, f))} ${dim('refreshing catalog…')}` : dim(`index updated 2h ago · ${MARKET.length} entries`)
    const body = []
    body.push('  ' + tabs.join('   ') + '    ' + meta, '  ' + underline)
    body.push(`  ${dim('/')} ${pm.typing ? pm.filter + '▌' : pm.filter || dim('filter plugins…')}`)
    const LW = 58
    const rows = list.length ? list.map((x, i) => pmRow(x, i === sel, LW)) : [dim(pm.tab === 0 ? '  No plugins installed — press → to browse' : '  Nothing matches')]
    if (pm.wide) {
      const detail = pmDetail(e, 40)
      body.push(...columns(rows, detail, LW, ' │ ', 9))
    } else if (pm.detail && e) body.push('', ...pmDetail(e, 70).map(l => '  ' + l))
    else body.push(...rows)
    body.push('')
    if (pm.confirm) body.push(`${yel(`Remove ${e.name}?`)} ${dim('Removal applies after restarting Mayfly.')}  ${inv(' No ')}  Yes   ${dim('n/y')}`)
    else if (pm.op) body.push(`${acc(pick(gap, f))} ${pm.op.kind === 'install' ? 'Installing' : pm.op.kind === 'update' ? 'Updating' : 'Removing'} ${bold(MARKET.find(x => x.id === pm.op.id).name)} via ${pm.source}… ${dim(Math.floor((Date.now() - pm.op.t0) / 1000) + 's · Esc cancel')}`)
    else if (pm.warn) body.push(yel('⚠ ' + pm.warn))
    else if (pm.toast) body.push(grn('✓ ' + pm.toast))
    else body.push(dim(pm.typing ? 'Enter apply · Esc clear' : `↑↓ move · ←/→ tab · ${pm.wide ? '' : 'Enter details · '}${!e ? '' : !e.installed ? (e.status === 'removed' ? '' : 'i install · ') : e.update ? 'u update · x remove · ' : 'x remove · '}/ filter · r refresh · Esc close`))
    if (pm.pending.size) body.push(`${yel('↻')} ${pm.pending.size} change${pm.pending.size > 1 ? 's apply' : ' applies'} after you restart Mayfly and start a new session`)
    return [dim(`${pm.wide ? 'split view (≥100 cols): list + live detail' : 'single column (<100 cols): Enter opens the detail'} · mock catalog data`), '', ...box('Plugin marketplace', pm.wide ? '' : 'narrow', body, pm.wide ? 108 : 86)]
  },
  onKey: (k) => {
    if (pm.typing) {
      if (k === '\r') pm.typing = false
      else if (k === '\x1b') { pm.typing = false; pm.filter = '' }
      else if (k === '\x7f') pm.filter = pm.filter.slice(0, -1)
      else if (printable(k)) { pm.filter += k; pm.sel = 0 }
      return
    }
    const list = pmList(); const e = list[Math.min(pm.sel, Math.max(0, list.length - 1))]
    pm.toast = ''; pm.warn = ''
    if (pm.confirm) { if (k === 'y') { pm.op = { kind: 'remove', id: e.id, t0: Date.now() } } pm.confirm = false; return }
    if (pm.op) { if (k === '\x1b') pm.op = null; return }
    if (k === '/') pm.typing = true
    else if (k === '\x1b[C') { pm.tab = 1; pm.sel = 0 }
    else if (k === '\x1b[D') { pm.tab = 0; pm.sel = 0 }
    else if (k === '\x1b[B') pm.sel = Math.min(list.length - 1, pm.sel + 1)
    else if (k === '\x1b[A') pm.sel = Math.max(0, pm.sel - 1)
    else if (k === '\r') pm.detail = !pm.detail
    else if (k === 'w') pm.wide = !pm.wide
    else if (k === 'o') pm.offline = !pm.offline
    else if (k === 's') pm.source = pm.source === 'npm' ? 'github' : 'npm'
    else if (k === 'r') pm.refresh = Date.now()
    else if (e && k === 'i' && !e.installed && e.status === 'removed') pm.warn = `${e.name}: ${e.note ?? 'removed from the market'}`
    else if (e && k === 'i' && !e.installed && !e.tui) pm.warn = 'web-only plugin: it contributes nothing in this terminal frontend'
    else if (e && k === 'i' && !e.installed) { pm.op = { kind: 'install', id: e.id, t0: Date.now() } }
    else if (e && k === 'u' && e.update) pm.op = { kind: 'update', id: e.id, t0: Date.now() }
    else if (e && k === 'x' && e.installed) pm.confirm = true
  } })

// ================================================================ 17 onboarding
const ob = {}
const OB_STEPS = ['Language', 'Connect', 'Permissions', 'Ready']
const OB_PERMS = [['Default', 'ask before writes and commands'], ['Accept edits', 'apply file edits freely, still ask for commands'], ['Full access', '⚠ no prompts at all — only in a sandbox']]
const THEME_SAMPLE = { dark: THEMES.dark, light: THEMES.light }
function obStrip(step) {
  const words = OB_STEPS.map((n, i) => i < step ? `${grn('✓')} ${n}` : i === step ? `${acc('●')} ${bold(acc(n))}` : `${dim('○')} ${dim(n)}`)
  const off = words.slice(0, step).reduce((a, w) => a + vlen(w) + 5, 0)
  return ['  ' + words.join(dim('  ›  ')), '  ' + ' '.repeat(off) + acc('━'.repeat(vlen(words[step])))]
}
scene({ name: 'Onboarding', keys: 'Enter continue · Esc back · step 1: 1-3 choose · step 1b: c copy link, r new link, p paste-back · step 2: ↑↓ or 1-3',
  init: () => { Object.assign(ob, { step: 0, sub: 'choose', sel: 0, t0: 0, perm: 0, connected: null, expand: false, confirm: false, note: '' }); ob.welcome = makeForm([{ id: 'lang', type: 'select', label: 'Language', value: 'English', options: [{ id: 'English' }, { id: '简体中文' }] }, { id: 'theme', type: 'select', label: 'Theme', value: 'dark', options: [{ id: 'dark' }, { id: 'light' }, { id: 'ocean' }, { id: 'paper' }, { id: 'auto' }] }]); ob.key = makeForm([{ id: 'key', type: 'secret', label: 'API key', value: '', required: true, help: 'Paste a key from platform.deepseek.com' }]) },
  capture: () => (ob.step === 0 && ob.welcome.capture()) || (ob.step === 1 && ob.sub === 'key' && ob.key.capture()),
  render: (f) => {
    const [words, rule] = obStrip(ob.step)
    let body = []
    let title = 'Welcome to Mayfly', hint = ''
    if (ob.step === 0) {
      const th = ob.welcome.fields[1].v
      const T = THEMES[th === 'light' ? 'light' : 'dark']
      body = [bold(acc('✻')) + ' ' + bold('Mayfly') + dim('  a quiet terminal UI for DeepSeek Harness'), '', 'Pick a language and a color theme. You can change both later in /settings.', '', ...ob.welcome.render(), '',
        dim('preview  ') + tc(T, 'active', 'Overview', true) + '   ' + tc(T, 'idle', 'Usage 3') + '   ' + tc(T, 'attn', '!', true) + '   ' + grn('✓') + ' ' + dim('done')]
      hint = '↑↓ field · ←/→ change · Enter continue'
    } else if (ob.step === 1 && ob.sub === 'choose') {
      title = 'Connect to DeepSeek'
      body = ['Mayfly needs a DeepSeek connection to start.', '',
        `${ob.sel === 0 ? acc('▸') : ' '} ${dim('1')}  ${bold('Sign in with a DeepSeek account')}  ${grn('recommended')}`, `       ${dim('browser sign-in, no API key to manage')}`,
        `${ob.sel === 1 ? acc('▸') : ' '} ${dim('2')}  ${bold('Enter a DeepSeek API key')}`, `       ${dim('paste a key from platform.deepseek.com')}`,
        `${ob.sel === 2 ? acc('▸') : ' '} ${dim('3')}  ${bold('Skip for now')}`, `       ${dim('connect later with /account or /provider')}`]
      hint = '↑↓ or 1-3 choose · Enter continue · Esc back'
    } else if (ob.step === 1 && ob.sub === 'account') {
      title = 'DeepSeek Account'
      const left = Math.max(0, 300 - Math.floor((Date.now() - ob.t0) / 1000))
      if (ob.connected === 'account') body = [`${grn('✓')} ${bold('Connected')} ${dim('— account models need no API key.')}`, '', `${dim(pad('Status', 12))} Signed in`, `${dim(pad('Balance', 12))} ${bold('¥ 128.40')} ${dim('available')}`]
      else body = [`${c(mix(pick(breath, f, 4)), '●')} ${bold('Waiting for you in the browser')} ${dim('· finishes by itself on this machine')}`, '',
        `${dim(pad('Expires', 12))} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, `${dim(pad('Sign-in link', 12))} ${dim('https://platform.deepseek.com/oauth/authorize?…')}`, '',
        `${ob.expand ? acc('▾') : dim('▸')} ${dim('Browser on another machine?')}`, ...(ob.expand ? [`    ${dim('Paste the address it ends on (the page may fail to load):')}`, `    ${dim('Callback link:')} ${dim('http://localhost:4710/oauth/callback?code=…')}▌`] : [])]
      hint = ob.connected ? 'Enter start chatting' : 'Ctrl+Y copy link · Ctrl+R new link · p other machine · Esc cancel'
    } else if (ob.step === 1 && ob.sub === 'key') {
      title = 'Enter your API key'
      body = ['Your key is saved as a credential, not as a setting.', '', ...ob.key.render(), '', ob.note ? grn(ob.note) : '']
      hint = 'Enter save · Esc back'
    } else if (ob.step === 2) {
      title = 'Permissions'
      body = ['How much may the agent do without asking?', ...OB_PERMS.flatMap(([n, d], i) => [`${ob.perm === i ? acc('▸') : ' '} ${dim(String(i + 1))}  ${bold(n)}${i === 0 ? '  ' + dim('[recommended]') : ''}`, `       ${i === 2 ? yel(d) : dim(d)}`]), '',
        ob.confirm ? `${yel('Really allow everything without prompts?')}  ${inv(' No ')}  Yes   ${dim('n/y')}` : '']
      hint = '↑↓ or 1-3 choose · Enter continue · Esc back'
    } else {
      title = 'Ready'
      body = [`${grn('✓')} Language   ${ob.welcome.fields[0].v}`, `${grn('✓')} Theme      ${ob.welcome.fields[1].v}`, ob.connected ? `${grn('✓')} DeepSeek   ${ob.connected === 'account' ? 'account' : 'API key'}` : `${yel('○')} DeepSeek   not connected ${dim('· /account to sign in')}`, `${grn('✓')} Permissions ${OB_PERMS[ob.perm][0]}`, '',
        bold('Three things to try'), `  ${acc('/')}  commands          ${acc('@')}  attach a file          ${acc('Shift+Tab')}  plan mode first`]
      hint = 'Enter start chatting'
    }
    return [dim('first run: Language → Connect → Permissions (new) → Ready · each step reversible with Esc · skip never blocks'), '', words, rule, '', ...box(title, `step ${Math.min(ob.step + 1, 4)} of 4`, [...body, '', dim(hint)], 78)]
  },
  onKey: (k) => {
    ob.note = ''
    if (ob.step === 0) {
      if (k === '\r' && !ob.welcome.capture()) { ob.step = 1; ob.sub = 'choose'; ob.sel = 0 }
      else ob.welcome.key(k)
    } else if (ob.step === 1) {
      if (ob.sub === 'choose') {
        if (k === '\x1b[B') ob.sel = Math.min(2, ob.sel + 1)
        else if (k === '\x1b[A') ob.sel = Math.max(0, ob.sel - 1)
        else if (/^[1-3]$/.test(k)) { ob.sel = Number(k) - 1; k = '\r' }
        if (k === '\r') { if (ob.sel === 0) { ob.sub = 'account'; ob.t0 = Date.now(); ob.connected = null; setTimeout(() => { if (ob.sub === 'account') ob.connected = 'account' }, 4500) } else if (ob.sel === 1) ob.sub = 'key'; else { ob.step = 2; ob.connected = null } }
        else if (k === '\x1b') ob.step = 0
      } else if (ob.sub === 'account') {
        if (k === '\x1b') { ob.sub = 'choose'; ob.connected = null }
        else if (k === 'p') ob.expand = !ob.expand
        else if (k === '\r' && ob.connected) ob.step = 2
      } else {
        if (k === '\x1b' && !ob.key.capture()) ob.sub = 'choose'
        else if (k === '\r' && !ob.key.capture() && ob.key.fields[0].v) { ob.connected = 'key'; ob.step = 2 }
        else ob.key.key(k)
      }
    } else if (ob.step === 2) {
      if (ob.confirm) { if (k === 'y') { ob.confirm = false; ob.step = 3 } else ob.confirm = false; return }
      if (k === '\x1b[B') ob.perm = Math.min(2, ob.perm + 1)
      else if (k === '\x1b[A') ob.perm = Math.max(0, ob.perm - 1)
      else if (/^[1-3]$/.test(k)) { ob.perm = Number(k) - 1; k = '\r' }
      if (k === '\r') { if (ob.perm === 2) ob.confirm = true; else ob.step = 3 }
      else if (k === '\x1b') ob.step = 1
    } else if (k === '\x1b') ob.step = 2
    else if (k === '\r') ob.note = '(starts chatting)'
  } })

// ================================================================ 18 account panel
const ac = { s: 0 }
const AC_STATES = ['signed-out', 'waiting', 'expired', 'network', 'no-server', 'signed-in', 'low', 'sign-out?']
scene({ name: 'Account', keys: 's cycle the demo state · b balance state (signed in) · see the hint row for the state keys',
  init: () => Object.assign(ac, { s: 0, bal: 0 }),
  render: (f) => {
    const st = AC_STATES[ac.s]
    const fld = (k, v) => `${dim(pad(k, 13))} ${v}`
    let body = [], hint = '', right2 = ''
    if (st === 'signed-out') { body = [fld('Status', 'Not signed in'), '', dim('Sign in with your DeepSeek account — models are billed to it and need no API key.'), '', `${acc('▸')} ${bold('Sign in')}`, `  ${dim('Use an API key instead')}`]; hint = 'Enter sign in · k use an API key · Esc close' }
    else if (st === 'waiting') { body = [fld('Status', 'Not signed in'), fld('Sign-in', `${c(mix(pick(breath, f, 4)), '●')} Waiting for you in the browser`), fld('Expires', '4:41'), '', dim('Approve in the browser — on this machine sign-in finishes by itself.'), fld('Sign-in link', dim('https://platform.deepseek.com/oauth/authorize?…')), `${dim('▸')} ${dim('Browser on another machine?')}`]; hint = 'Ctrl+Y copy link · Ctrl+R new link · p other machine · Esc cancel' }
    else if (st === 'expired') { body = [fld('Status', 'Not signed in'), fld('Sign-in', yel('⚠ The sign-in link expired — try again')), '', `${acc('▸')} ${bold('Try again')}`]; hint = 'Enter try again · Esc close' }
    else if (st === 'network') { body = [fld('Status', 'Not signed in'), fld('Sign-in', red('✗ Could not reach DeepSeek — check the connection and try again')), '', `${acc('▸')} ${bold('Try again')}`]; hint = 'Enter try again · Esc close' }
    else if (st === 'no-server') { body = [fld('Status', 'Not signed in'), '', dim('Browser sign-in needs the local web server, which this setup does not run.'), dim('Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts.'), '', `${acc('▸')} ${bold('Use an API key instead')}`]; hint = 'Enter use an API key · Esc close' }
    else if (st === 'signed-in' || st === 'low') {
      const low = st === 'low'
      const balSt = ['ok', 'loading', 'error'][ac.bal % 3]
      const bal = low ? `${yel('⚠')} ${bold(yel('¥ 6.20'))} ${yel('low balance')} ${dim('· below ¥ 10.00')}` : balSt === 'ok' ? `${bold('¥ 128.40')} ${dim('available')}` : balSt === 'loading' ? `${acc(pick(gap, f))} ${dim('checking balance…')}` : `${dim('— unavailable (network)')}  ${dim('r retry')}`
      body = [fld('Status', `${grn('✓')} Signed in`), fld('Balance', bal), ...(low ? [fld('', dim('topped-up ¥ 0.00 · granted ¥ 6.20'))] : balSt === 'ok' ? [fld('', dim('topped-up ¥ 100.00 · granted ¥ 28.40'))] : []), fld('Models', dim('account models need no API key')), fld('Checked', dim('2 min ago')), '']
      hint = 'r refresh · o top up in browser · x sign out · Esc close'
    } else { body = [fld('Status', `${grn('✓')} Signed in`), '', `${yel('Sign out of the DeepSeek account?')} ${dim('Account models stop working until you sign in again.')}`, '', `${inv(' No ')}  Yes`]; hint = '←/→ or n/y · Enter confirm · Esc cancel' }
    return [dim(`state ${ac.s + 1}/${AC_STATES.length}: ${AC_STATES.map((x, i) => i === ac.s ? bold(x) : x).join(' · ')}`), '', ...box('DeepSeek Account', st.startsWith('signed') || st === 'low' ? '' : 'not connected', [...body, '', dim(hint)], 82),
      '', dim('button-free: the primary action is the focused row, secondary operations are keys in the hint row; the sign-out confirm is the shared Yes/No (No first).')]
  },
  onKey: (k) => { if (k === 's') ac.s = (ac.s + 1) % AC_STATES.length; else if (k === 'S') ac.s = (ac.s + AC_STATES.length - 1) % AC_STATES.length; else if (k === 'b') ac.bal = (ac.bal + 1) % 3 } })

// ================================================================ 19 design system reference
const ds = { v: 0 }
const DSP = [
  ['Selection and focus vocabulary', () => [
    `${acc('▌')} ${bold('Permissions')}     ${dim('persistent selection in a rail or browse list: bar + bold (inverse only while the control has focus)')}`,
    `${acc('▸')} ${dim('1')}  ${bold('Allow once')}    ${dim('cursor in a choose / decision list: the row that Enter will pick')}`,
    `  ${acc('[x]')} read_file      ${dim('checked')}      ${dim('[ ] unchecked · [-] some children')}`,
    `  ${bold('‹ medium ›')}          ${dim('a value ←/→ changes (select, number, tab strip)')}`,
    `  ${acc('•')} Timeout          ${dim('edited field (implicit override)')}`,
    `  ${dim('Local — unreachable')}  ${dim('disabled: dimmed, with its reason after a dash')}`,
    `  Default ${dim('[current]')}      ${dim('current marker is always the muted [current] badge')}`,
    '', dim('rule: one persistent-selection mark (▌), one transient cursor (▸), one focus effect (inverse). Never two of them on a row at once except ▌ + inverse.')] ],
  ['State matrix: every panel answers the same five states', () => [
    `${dim(pad('state', 14))} ${dim(pad('pattern', 40))} ${dim('example')}`,
    `${pad('loading', 14)} ${pad('gap spinner + what + (elapsed)', 40)} ${acc('⣾')} Loading sessions…`,
    `${pad('empty', 14)} ${pad('what is missing + the next action', 40)} No plugins installed — press → to browse`,
    `${pad('error', 14)} ${pad('✗ reason + the retry key', 40)} ${red('✗')} Could not reach the market  ${dim('r retry')}`,
    `${pad('stale/offline', 14)} ${pad('⚠ + age of the data, content stays usable', 40)} ${yel('⚠')} offline · showing cached data from 2d ago`,
    `${pad('unavailable', 14)} ${pad('— + reason, no retry offered', 40)} ${dim('—')} not supported by this provider`,
    '', dim('a failed or slow secondary read (balance, catalog refresh) never blocks or alters the primary content')] ],
  ['Feedback severities', () => [
    `${grn('✓')} success   ${dim('3 s, auto-dismiss')}        Installed Git Helper · restart Mayfly to apply`,
    `${acc('ℹ')} info      ${dim('5 s, auto-dismiss')}        Resumed session · 24 turns`,
    `${yel('⚠')} warning   ${dim('stays until acted on')}     Balance low · ¥ 6.20 left`,
    `${red('✗')} error     ${dim('stays, offers retry')}      Sign-in failed — try again  ${dim('Enter')}`,
    '', dim('inline (in the surface footer) when a surface is open; a toast in the activity row gap when none is. Glyph + word, never colour alone.')] ],
  ['Breakpoints: one panel at three widths', () => {
    const rows = ['Loop', 'Git Helper', 'Legacy Search']
    return [dim('≥ 100 cols  split view'), `  ${rows.map(r => pad(r, 14)).join('')}${dim('│')} ${bold('Loop')} ${dim('official · Automation')}`, `  ${' '.repeat(42)}${dim('│')} ${grn('✓ installed 1.4.0')} · TUI ✓ Web ✓`, '',
      dim('60–99 cols  single column, Enter opens the detail'), `  ${acc('▌')} ${bold('Loop')}            stable   official   T W   1.4.0`, `    Git Helper      update 1.3.0 community T W   1.2.1`, '',
      dim('< 60 cols  compact: name + one status, detail on Enter'), `  ${acc('▌')} ${bold('Loop')}          ${grn('✓')}`, `    Git Helper    ${yel('↑')}`, `    Legacy Search ${yel('⚠')}`] }],
  ['Keyboard parity: the same key means the same thing everywhere', () => {
    const cols = ['↑↓', '←/→', 'Enter', 'Space', '/', 'r', 'x', 'Esc']
    const rows = [['Sessions', 'move', 'rail ⇄ list', 'resume', '—', 'filter', '—', 'delete', 'close'], ['Plugins', 'move', 'tab', 'details', '—', 'filter', 'refresh', 'remove', 'close'], ['Settings', 'field', 'cycle', 'edit', 'toggle', '—', '—', '—', 'back'], ['Tray', 'move', 'tab', 'view', '—', '—', '—', 'stop', 'back'], ['Account', 'row', '—', 'primary', '—', '—', 'refresh', 'sign out', 'close']]
    return [`${dim(pad('', 10))}${cols.map(x => dim(pad(x, 12))).join('')}`, ...rows.map(r => `${pad(r[0], 10)}${r.slice(1).map(x => pad(x, 12)).join('')}`), '', dim('destructive keys always open the shared Yes/No (No first); undo toasts replace the prompt only when the action is reversible')] }],
  ['Policies: confirm vs undo, time and number formats', () => [
    bold('confirm or undo'),
    `  reversible, local       ${dim('→ do it, offer')} ${bold('u undo · 8s')}   ${dim('(delete a session, remove a queued message)')}`,
    `  irreversible or outside ${dim('→ shared Yes/No, No first')}        ${dim('(sign out, remove a plugin, full access, stop a job)')}`,
    `  never                   ${dim('→ typed confirmation phrases')}`, '',
    bold('formats'),
    `  ${dim(pad('durations', 12))} 4s · 2m 10s · 4m 12s · 1h 5m        ${dim(pad('ages', 8))} 2m ago · 1h ago · 3d ago`,
    `  ${dim(pad('tokens', 12))} 148k · ~12k · 22.9k / 128k           ${dim(pad('money', 8))} ¥ 128.40 (provider currency, two decimals)`,
    `  ${dim(pad('paths', 12))} ~ for home, middle-ellipsis (~/dev/…/mayfly) ${dim(pad('counts', 8))} 12 turns · 4 tools · +3 more`] ],
]
scene({ name: 'System', keys: 'v/V next/previous reference page',
  init: () => Object.assign(ds, { v: 0 }),
  render: () => [dim(`reference ${ds.v + 1}/${DSP.length}: `) + bold(DSP[ds.v][0]), dim(DSP.map((_, i) => i === ds.v ? '●' : '○').join(' ')), '', ...DSP[ds.v][1]()],
  onKey: (k) => { if (k === 'v') ds.v = (ds.v + 1) % DSP.length; else if (k === 'V') ds.v = (ds.v + DSP.length - 1) % DSP.length } })

// ================================================================ 20 transcript levels
const LVN = ['Compact', 'Standard', 'Detailed', 'Verbose']
const lv = {}
const HERO_ROWS = [
  { o: 12, n: 12, t: '  return (' },
  { o: 13, s: '-', t: '    <h1>Build agents faster</h1>' },
  { n: 13, s: '+', t: '    <h1>Ship agent UI in a keystroke</h1>' },
  { o: 14, n: 14, t: '    <p>{sub}</p>' },
]
const TL_ROWS = [
  { o: 87, n: 87, t: '  const full = toolDetail(call)' },
  { o: 88, s: '-', t: '  const detail = full' },
  { n: 88, s: '+', t: '  const detail = truncate(full, width - 4)' },
]
const CL_ROWS = [
  { n: 6, s: '+', t: '## Unreleased' },
  { n: 7, s: '+', t: '- Hero copy now reads "Ship agent UI in a keystroke".' },
  { n: 8, s: '+', t: '- Width scan covers the new panels.' },
]
const TURNS = [
  { id: 1, user: 'Update the landing page hero copy and run the tests.', secs: '38s', steps: [
    { t: 'think', text: 'I will read the hero component, unify the heading, then run the tests.' },
    { t: 'read', label: 'Hero.tsx', out: '96 lines' },
    { t: 'search', label: '"heading"', out: '7 matches in 3 files' },
    { t: 'edit', file: 'Hero.tsx', a: 4, d: 2, rows: HERO_ROWS },
    { t: 'bash', cmd: 'pnpm run test', ok: false, secs: '12.1s', tail: ['FAIL width-scan.spec.ts', '  tool-line row is 62 cells, expected ≤ 60', '1 failed · 213 passed'] },
    { t: 'edit', file: 'tool-line.ts', a: 6, d: 1, rows: TL_ROWS },
    { t: 'bash', cmd: 'pnpm run test', ok: true, secs: '11.8s', tail: ['214 passed'] },
  ], answer: ['Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.', 'The one failure was a truncation bug in the tool-line row, fixed in the same change.'] },
  { id: 2, user: 'Now bump the changelog and run the full gate.', secs: '4m 12s', fail: 'verify:full timed out after 4m', steps: [
    { t: 'read', label: 'CHANGELOG.md', out: '210 lines' },
    { t: 'edit', file: 'CHANGELOG.md', a: 3, d: 0, rows: CL_ROWS },
    { t: 'bash', cmd: 'pnpm run verify:full', ok: false, secs: '4m 0s', tail: ['…', 'coverage: 100% (214 files)', 'timed out'] },
  ], answer: [] },
  { id: 3, user: 'Regenerate the screenshots and check that they are fresh.', secs: '21s', live: true, steps: [
    { t: 'think', text: 'Run shots:sync first, then shots:check to confirm.' },
    { t: 'bash', cmd: 'pnpm run shots:sync', ok: true, secs: '8.0s', tail: ['wrote 14 screenshots'] },
    { t: 'bash', cmd: 'pnpm run shots:check', ok: true, secs: '1.2s', tail: ['14 files up to date'], running: true, live: ['checking 14 files…', 'framed.svg  ok'] },
  ], answer: ['Screenshots are fresh: shots:sync wrote 14 files and shots:check agrees.'] },
]
const lvStat = t => t.steps.filter(s => s.t === 'edit').reduce(([a, d], s) => [a + s.a, d + s.d], [0, 0])
const lvCalls = t => t.steps.filter(s => s.t !== 'think').length
function groupsOf(steps) {
  const out = []; let cur = null
  const flush = () => { if (cur) { out.push(cur); cur = null } }
  for (const s of steps) {
    if (s.t === 'edit') { flush(); out.push({ edit: s }) } else { cur ??= { steps: [] }; cur.steps.push(s) }
  }
  flush()
  return out
}
function groupTitle(g) {
  const reads = g.steps.filter(s => s.t === 'read').length, searches = g.steps.filter(s => s.t === 'search').length
  const bashes = g.steps.filter(s => s.t === 'bash'), failed = bashes.filter(s => s.ok === false).length
  const parts = []
  if (reads && searches) parts.push('Read files and searched code'); else if (reads) parts.push('Read files'); else if (searches) parts.push('Searched code')
  if (bashes.length) parts.push('Ran commands' + (failed ? ` · ${failed} failed` : ''))
  return { text: parts.join(' · ') || 'Thought', failed }
}
const diffCard = (rows, max) => { const d = diff(rows); return d.length > max ? [...d.slice(0, max), dim(`  … +${d.length - max} rows · Ctrl+O`)] : d }
function renderTurn(t, L, sel, runState) {
  const out = []
  const running = t.live && runState === 'running'
  const EL = lv.open.has(t.id) ? 3 : L
  const g = sel ? acc('▌') : ' '
  const [a, d] = lvStat(t)
  const stat2 = (a || d) ? ` · ${grn('+' + a)} ${red('−' + d)}` : ''
  out.push(`${g}${dim('»')} ${bold(EL === 0 ? cut(t.user, 62) : t.user)}`)
  const steps = running ? t.steps : t.steps
  if (running) {
    const done = t.steps.filter(s => !s.running)
    if (EL === 0) return out
    if (EL === 1) {
      groupsOf(done).forEach(gr => { if (gr.edit) { out.push(`  ${grn('✓')} ${bold('Edited')} ${gr.edit.file}  ${stat(gr.edit.a, gr.edit.d)}`, ...diffCard(gr.edit.rows, 6)) } else out.push(`  ${dim('⎿')} ${dim(groupTitle(gr).text)}`) })
      return out
    }
    t.steps.forEach(s => {
      if (s.t === 'think') out.push(`  ${dim('✻')} ${dim(ital(EL === 3 ? s.text : cut(s.text, 56)))}`)
      else if (s.t === 'bash') {
        out.push(`  ${s.running ? acc('●') : s.ok ? grn('✓') : red('✗')} ${s.running ? 'Running' : 'Ran'} ${acc(s.cmd)} ${dim(s.running ? '· 8s' : '· ' + s.secs)}`)
        if (EL === 3) (s.running ? s.live : s.tail.slice(-2)).forEach(l => out.push(`    ${dim('⎿ ' + l)}`))
      } else if (s.t === 'edit') out.push(`  ${grn('✓')} ${bold('Edited')} ${s.file}  ${stat(s.a, s.d)}`, ...diffCard(s.rows, EL === 3 ? 12 : 6))
      else out.push(`  ${grn('✓')} ${s.t === 'read' ? 'Read' : 'Searched'} ${acc(s.label)} ${dim('· ' + s.out)}`)
    })
    return out
  }
  // settled header
  if (t.fail) out.push(`${g === ' ' ? ' ' : ' '} ${red('✗')} ${bold(red('Failed'))} ${dim('·')} ${t.fail} ${dim('· ' + t.secs + ' · ' + lvCalls(t) + ' tool calls')}`)
  else out.push(`  ${dim(EL >= 2 ? '▾' : '▸')} ${dim('Took ' + t.secs + ' · ' + lvCalls(t) + ' tool calls')}${stat2}${EL <= 1 ? dim(' · Ctrl+O expand') : ''}`)
  if (EL === 0) {
    if (t.fail) out.push(`    ${dim('⎿')} ${dim('last step: Ran pnpm run verify:full ✗ exit 124')}`)
  } else if (EL === 1) {
    t.steps.filter(s => s.t === 'edit').forEach(s => out.push(`  ${grn('✓')} ${bold('Edited')} ${s.file}  ${stat(s.a, s.d)}`, ...diffCard(s.rows, 6)))
  } else if (EL === 2) {
    const first = t.steps.find(s => s.t === 'think')
    groupsOf(t.steps).forEach((gr, i) => {
      if (gr.edit) out.push(`  ${grn('✓')} ${bold('Edited')} ${gr.edit.file}  ${stat(gr.edit.a, gr.edit.d)}`, ...diffCard(gr.edit.rows, 6))
      else {
        const gt = groupTitle(gr)
        if (i === 0 && first) out.push(`    ${dim('✻')} ${dim(ital(cut(first.text, 58)))}`)
        out.push(`    ${dim('⎿')} ${gt.failed ? yel(gt.text) : dim(gt.text)}`)
      }
    })
  } else {
    t.steps.forEach(s => {
      if (s.t === 'think') out.push(`    ${dim('✻ Thinking')}`, `      ${dim(ital(s.text))}`)
      else if (s.t === 'bash') out.push(`  ${s.ok ? grn('✓') : red('✗')} Ran ${acc(s.cmd)} ${dim('· ' + s.secs)}${s.ok ? '' : red(' · exit 1')}`, ...s.tail.map(l => `    ${dim('⎿ ' + l)}`))
      else if (s.t === 'edit') out.push(`  ${grn('✓')} ${bold('Edited')} ${s.file}  ${stat(s.a, s.d)}`, ...diffCard(s.rows, 12))
      else out.push(`  ${grn('✓')} ${s.t === 'read' ? 'Read' : 'Searched'} ${acc(s.label)} ${dim('· ' + s.out)}`)
    })
  }
  t.answer.forEach((l, i) => out.push(`  ${i === 0 ? '●' : ' '} ${l}`))
  return out
}
function lvAll(L, runState, sel = -1) {
  const rows = []; const starts = []
  TURNS.forEach((t, i) => { starts.push(rows.length); rows.push(...renderTurn(t, L, i === sel, runState)); rows.push('') })
  return { rows, starts }
}
scene({ name: 'Levels', keys: '←/→ or 1-4 level · ↑↓ turn · Enter open/close that turn (Verbose) · o Ctrl+O recent 3 turns · s running/settled',
  init: () => Object.assign(lv, { L: 1, cur: 2, open: new Set(), runState: 'running', ctrlO: false }),
  render: (f) => {
    const counts = [0, 1, 2, 3].map(L => lvAll(L, lv.runState).rows.filter(r => r !== '').length)
    const saved = Math.round((1 - counts[lv.L] / counts[3]) * 100)
    const T = THEMES.dark
    const labels = LVN.map((n, i) => `${i + 1} ${n}`)
    const words = labels.map((l, i) => i === lv.L ? tc(T, 'active', l, true) : tc(T, 'idle', l)).join('   ')
    let off = 0; for (let i = 0; i < lv.L; i++) off += labels[i].length + 3
    const rule = ' '.repeat(off) + tc(T, 'active', '━'.repeat(labels[lv.L].length), true)
    const { rows, starts } = lvAll(lv.L, lv.runState, lv.cur)
    const H = 30
    const total = rows.length
    const start = Math.max(0, Math.min(total - H, starts[lv.cur] - 1))
    const view = rows.slice(start, start + H)
    const above = start, below = Math.max(0, total - start - H)
    const body = [above ? dim(`  ↑ ${above} more rows`) : '', ...view, below ? dim(`  ↓ ${below} more rows`) : ''].filter((l, i, arr) => !(l === '' && (i === 0 || i === arr.length - 1)))
    const activity = []
    const flashed = lv.flash && Date.now() - lv.flash < 2200 ? dim(`view: ${LVN[lv.L]} · ${counts[lv.L]} rows`) : ''
    if (lv.runState === 'running') {
      const e = lv.L
      activity.push(right(`${acc('●')} ${shimmer('Running commands', f)} ${dim('· 8s · ↑30.2k ↓4.1k')}`, flashed || dim('Esc interrupt · Ctrl+O expand'), 74))
      if (e <= 1) activity.push(`  ${dim('⎿')} pnpm run shots:check`)
    }
    if (!activity.length && flashed) activity.push(right(dim(''), flashed, 74))
    return [
      dim('four levels of the same conversation · setting mayfly.transcriptView · red ✗ and failures are never folded away'), '',
      '  ' + words + dim(`        rows ${counts[lv.L]}${lv.L < 3 ? ` · ${saved}% fewer than Verbose` : ' · everything open'}`), '  ' + rule,
      dim('  rows by level: ' + counts.map((n, i) => `${LVN[i]} ${n}`).join(' · ')), '',
      ...body.map(l => '  ' + l), '',
      ...(activity.length ? activity.map(l => '  ' + l) : [dim('  (activity row: idle, nothing rendered)')]),
      dim('  ╭' + '─'.repeat(70) + '╮'), dim('  │') + pad(' > ▌', 70) + dim('│'), dim('  ╰' + '─'.repeat(70) + '╯'),
      lv.L >= 2 && lv.runState === 'running' ? dim('  Detailed/Verbose: the running card shows the detail, so the activity row drops its ⎿ line (one place only).') : dim('  Compact/Standard: the activity row carries the ⎿ detail.'),
    ]
  },
  onKey: (k) => {
    const before = lv.L
    if (k === '\x1b[C') lv.L = Math.min(3, lv.L + 1)
    else if (k === '\x1b[D') lv.L = Math.max(0, lv.L - 1)
    else if (/^[1-4]$/.test(k)) lv.L = Number(k) - 1
    else if (k === '\x1b[B') lv.cur = Math.min(TURNS.length - 1, lv.cur + 1)
    else if (k === '\x1b[A') lv.cur = Math.max(0, lv.cur - 1)
    else if (k === '\r') { const id = TURNS[lv.cur].id; lv.open.has(id) ? lv.open.delete(id) : lv.open.add(id) }
    else if (k === 'o') { lv.ctrlO = !lv.ctrlO; if (lv.ctrlO) TURNS.slice(-3).forEach(t => lv.open.add(t.id)); else lv.open.clear() }
    else if (k === 's') { lv.runState = lv.runState === 'running' ? 'settled' : 'running'; TURNS[2].live = true }
    if (lv.L !== before) lv.flash = Date.now()
  } })

// ================================================================ runtime
let cur = Math.max(0, Math.min(scenes.length - 1, Number(process.argv[2] ?? 1) - 1))
let f = 0, sceneStart = Date.now(), drawn = 0
const enter = i => { cur = (i + scenes.length) % scenes.length; scenes[cur].init?.(); sceneStart = Date.now(); f = 0 }
const quit = () => { process.stdout.write('\x1b[?25h\n'); process.exit(0) }
process.on('SIGINT', quit)
function draw() {
  const nav = scenes.map((s, i) => i === cur ? inv(` ${i + 1} ${s.name} `) : dim(` ${i + 1} `)).join('')
  const footer = dim(`] next · [ previous · q quit${scenes[cur].keys ? ' · ' + scenes[cur].keys : ''}`)
  const lines = [nav, '', ...scenes[cur].render(f, Date.now() - sceneStart), '', footer]
  if (drawn) process.stdout.write(`\x1b[${drawn}A`)
  process.stdout.write(lines.map(l => `\x1b[2K${l}`).join('\n') + '\n\x1b[J')
  drawn = lines.length
}
enter(cur)
process.stdout.write('\x1b[?25l')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on('data', d => {
  const k = d.toString()
  if (k === '\x03') return quit()
  const capturing = scenes[cur].capture?.()
  if (!capturing) {
    if (k === 'q') return quit()
    if (k === ']' || k === '\t') return enter(cur + 1)
    if (k === '[' || k === '\x1b[Z') return enter(cur - 1)
  }
  scenes[cur].onKey?.(k)
  draw()
})
setInterval(() => { f++; draw() }, 100)
