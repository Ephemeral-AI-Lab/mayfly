/**
 * The Mayfly UI kit prototype: the *basic components*.
 *
 * Everything on screen in this prototype is built from the builders exported here (`ui.*`) and
 * painted by one renderer (`render`), whether it is a plugin-style panel or a Mayfly core
 * component such as the status bar. The Mayfly components in `mayfly-components.mjs` import only
 * this module, and `ui-preview.mjs --audit` proves it. This is the design's claim made
 * executable: one UI API, used by core and by downstream plugins alike.
 *
 * Nodes are plain frozen data (no functions, no ANSI, no widths). Renderer state (cursor, focus,
 * drafts, scroll, clocks) lives in the runtime (`mount`), never in a node. The builder names follow
 * `@ephemeral-ai/mayfly-ui`'s `ui.*` where one exists; the few that do not exist yet are marked
 * "proposed" in docs/design/component-library.md.
 *
 * Dependency-free. It shows the design, not the shipped renderer.
 *
 * @module docs/design/prototypes/ui-kit
 */

// ======================================================================= paint and measure
export const V = [154, 134, 230]
const TONE_RGB = {
  primary: V, accent: [120, 190, 230], user: [130, 160, 240], success: [110, 200, 140], warning: [230, 190, 90], danger: [230, 110, 110],
}
export const theme = { mono: false, highlight: true }

/** Paint text with a tone and styles. `muted` is the dim attribute; in mono mode only weight survives. */
export function paint(text, tone = 'default', styles = []) {
  if (text === '') return ''
  let pre = ''
  if (styles.includes('strong')) pre += '\x1b[1m'
  if (styles.includes('italic')) pre += '\x1b[3m'
  if (styles.includes('strike')) pre += '\x1b[9m'
  if (tone === 'muted') pre += '\x1b[2m'
  else if (!theme.mono && TONE_RGB[tone]) pre += `\x1b[38;2;${TONE_RGB[tone].join(';')}m`
  else if (theme.mono && tone !== 'default' && tone !== 'muted') pre += tone === 'primary' || tone === 'danger' || tone === 'warning' ? '\x1b[1m' : ''
  return pre ? `${pre}${text}\x1b[0m` : text
}
/** Paint a whole row with a background tint (diff bands); ignored in a monochrome terminal. */
export const bgPaint = (text, rgb) => {
  if (theme.mono) return text
  const bg = `\x1b[48;2;${rgb.join(';')}m`
  // every inner paint ends with a full reset, so the background is re-applied after each one
  return bg + text.replace(/\x1b\[0m/g, `\x1b[0m${bg}`) + '\x1b[0m'
}
export const inverse = s => `\x1b[7m${strip(s)}\x1b[0m`
export const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠]/
export const cells = s => [...strip(s)].reduce((a, ch) => a + (WIDE.test(ch) ? 2 : 1), 0)
export const pad = (s, w) => s + ' '.repeat(Math.max(0, w - cells(s)))
export const padStart = (s, w) => ' '.repeat(Math.max(0, w - cells(s))) + s

/** Cut a painted string to `w` cells, keeping its ANSI state closed. */
export function clip(s, w, ellipsis = true) {
  if (cells(s) <= w) return s
  const limit = ellipsis ? Math.max(0, w - 1) : w
  let out = '', used = 0, i = 0
  while (i < s.length && used < limit) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
    if (m) { out += m[0]; i += m[0].length; continue }
    const ch = [...s.slice(i)][0]
    const cw = WIDE.test(ch) ? 2 : 1
    if (used + cw > limit) break
    out += ch; used += cw; i += ch.length
  }
  return out + (ellipsis ? '…' : '') + '\x1b[0m'
}
/** Cut the middle (or the start) of a plain string so both ends, or the distinguishing end, stay visible. */
export function clipMiddle(s, w, where = 'middle') {
  const chars = [...s]
  if (chars.length <= w) return s
  if (where === 'start') return '…' + chars.slice(-(w - 1)).join('')
  const head = Math.ceil((w - 1) / 2), tail = Math.floor((w - 1) / 2)
  return chars.slice(0, head).join('') + '…' + chars.slice(chars.length - tail).join('')
}
/** Word-wrap a painted string to `w` cells. */
export function wrap(s, w) {
  if (w <= 0) return [s]
  const out = []
  for (const para of s.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (line !== '' && cells(line) + 1 + cells(word) > w) { out.push(line); line = word } else line = line === '' ? word : `${line} ${word}`
      while (cells(line) > w) { out.push(clip(line, w, false)); line = line.slice(strip(clip(line, w, false)).length) }
    }
    out.push(line)
  }
  return out
}

// ======================================================================= node builders
const frozen = x => Object.freeze(x)
const spanOf = s => (typeof s === 'string' ? { text: s } : s)
const calls = { stack: [], log: new Map() }
/** Record that the running component used a builder (feeds `--audit`). */
const note = kind => { const top = calls.stack.at(-1); if (top) top.add(kind) }

const node = (kind, props) => { note(kind); return frozen({ kind, ...props }) }
const text = (content, o = {}) => node('text', { content, ...o })
const richText = (spans, o = {}) => node('rich-text', { spans: spans.map(spanOf), ...o })
const fields = rows => node('fields', { rows })
const markdown = source => node('markdown', { source })
const code = (src, o = {}) => node('code', { code: src, ...o })
const diff = (before, after, o = {}) => node('diff', { before, after, ...o })
const sections = list => node('sections', { sections: list })
const chart = o => node('chart', o)
const diagram = (source, o = {}) => node('diagram', { diagram: 'mermaid', source, ...o })
const spacer = (size = 1) => node('spacer', { size })
const divider = label => node('divider', { label })
const child = (n, o = {}) => frozen({ node: n, ...o })
const asChild = c => (c && c.node ? c : child(c))
const stack = direction => (children, o = {}) => node('stack', { direction, children: children.filter(Boolean).map(asChild), ...o })
const surface = o => node('surface', o)
const scroll = o => node('scroll', o)
const tabs = o => node('tabs', o)
const list = o => node('list', o)
const form = o => node('form', o)
const actions = o => node('actions', o)
const loader = o => node('loader', o)
const progress = o => node('progress', o)
const empty = (title, o = {}) => node('empty', { title, ...o })
const prompt = o => node('prompt', o)

export const ui = frozen({
  text, richText, fields, markdown, code, diff, sections, chart, diagram, spacer, divider, child,
  stack: frozen({ row: stack('row'), column: stack('column') }),
  surface, scroll, tabs, list, form, actions, loader, progress, empty, prompt,
})

/** Define a component: a pure function from props to a node. The kit records which builders it used. */
export function defineComponent(name, layer, render) {
  const fn = (props = {}) => {
    const set = new Set()
    calls.stack.push(set)
    try { return render(props) } finally {
      calls.stack.pop()
      const entry = calls.log.get(name) ?? { layer, uses: new Set(), nested: new Set() }
      for (const k of set) entry.uses.add(k)
      calls.log.set(name, entry)
      const parent = calls.stack.at(-1)
      if (parent) { calls.log.get(name).parentSeen = true; parent.add(`component:${name}`) }
    }
  }
  fn.componentName = name
  return fn
}
export const usage = () => calls.log

// ======================================================================= clocks and glyph tables
export const FRAMES = {
  bloom: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'],
  fill: ['⡀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿', '⣷', '⣶', '⣦', '⣤', '⣄'],
  gap: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
}
export const BREATH = [0.25, 0.5, 0.8, 1, 0.8, 0.5]
const mix = k => V.map(v => Math.round(60 + (v - 60) * k))
const glyphFor = (variant, ctx) => {
  if (variant === 'breath') return theme.mono ? '●' : `\x1b[38;2;${mix(BREATH[Math.floor(ctx.frame / 4) % BREATH.length]).join(';')}m●\x1b[0m`
  const set = FRAMES[variant === 'tide' || variant === 'braille' ? 'gap' : variant] ?? FRAMES.gap
  return paint(set[ctx.reduceMotion ? 0 : ctx.frame % set.length], 'primary')
}
/** The shimmer of a running tool label: a three-letter window sweeps the text. */
export function shimmer(label, frame) {
  const pos = (frame % ([...label].length + 6)) - 3
  return [...label].map((ch, i) => (Math.abs(i - pos) <= 1 ? paint(ch, 'primary', ['strong']) : paint(ch, 'muted'))).join('')
}

// ======================================================================= span painting
export const spansText = (spans, ctx) => spans.map(s => {
  const sp = spanOf(s)
  if (sp.motion === 'shimmer') return shimmer(sp.text, ctx.frame)
  if (sp.motion === 'loader') return glyphFor(sp.variant, ctx)
  return paint(sp.text, sp.tone ?? 'default', sp.styles ?? [])
}).join('')

// ======================================================================= content renderers
const TONE_NAMES = ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger']
export { TONE_NAMES }

function renderText(n, ctx) {
  const painted = paint(n.content, n.tone ?? 'default', n.styles ?? [])
  if (n.overflow === 'middle' || n.overflow === 'start') return [paint(clipMiddle(n.content, ctx.width, n.overflow), n.tone ?? 'default', n.styles ?? [])]
  return n.overflow === 'truncate' ? [clip(painted, ctx.width)] : n.content.split('\n').flatMap(l => wrap(paint(l, n.tone ?? 'default', n.styles ?? []), ctx.width))
}
function renderRich(n, ctx) {
  const line = spansText(n.spans, ctx)
  return n.overflow === 'truncate' ? [clip(line, ctx.width)] : wrap(line, ctx.width)
}
function renderFields(n, ctx) {
  const lw = Math.max(0, ...n.rows.map(r => cells(r.label))) + 1
  return n.rows.flatMap(r => {
    const value = typeof r.value === 'string' ? paint(r.value) : spansText(r.value, ctx)
    return wrap(paint(pad(r.label === '' ? '' : `${r.label}:`, lw), 'muted') + ' ' + value, ctx.width)
  })
}
function renderMarkdown(n, ctx) {
  const inline = s => s.replace(/\*\*([^*]+)\*\*/g, (_, t) => paint(t, 'default', ['strong'])).replace(/(?<![*\w])\*([^*]+)\*/g, (_, t) => paint(t, 'default', ['italic'])).replace(/`([^`]+)`/g, (_, t) => paint(t, 'accent'))
  const out = []
  let fence = null
  for (const raw of n.source.split('\n')) {
    if (/^```/.test(raw)) { if (fence) { out.push(...renderCode({ code: fence.lines.join('\n'), language: fence.lang }, ctx)); fence = null } else fence = { lang: raw.slice(3).trim(), lines: [] }; continue }
    if (fence) { fence.lines.push(raw); continue }
    if (/^#{1,3} /.test(raw)) out.push(paint(raw.replace(/^#+ /, ''), 'primary', ['strong']))
    else if (/^[-*] /.test(raw)) out.push(...wrap(`${paint('•', 'muted')} ${inline(raw.slice(2))}`, ctx.width))
    else if (/^> /.test(raw)) out.push(...wrap(`${paint('│', 'muted')} ${paint(raw.slice(2), 'muted', ['italic'])}`, ctx.width))
    else out.push(...wrap(inline(raw), ctx.width))
  }
  return out
}
const KEYWORDS = /\b(const|let|return|function|if|else|import|from|export|type|interface|new|await|async)\b/g
function renderCode(n, ctx) {
  const heading = n.language ? [paint(n.language, 'muted')] : []
  const nw = String(n.code.split('\n').length).length
  const lines = n.code.split('\n').flatMap((l, li) => {
    const body = theme.highlight && !theme.mono
      ? l.replace(KEYWORDS, m => paint(m, 'primary')).replace(/'[^']*'|"[^"]*"/g, m => paint(m, 'success'))
      : paint(l, 'default')
    const gutter = n.numbered ? paint(String(li + 1).padStart(nw) + ' │ ', 'muted') : ''
    return wrap(gutter + (theme.highlight ? body : paint(strip(body), 'user')), ctx.width)
  })
  return [...heading, ...lines]
}
/** Line diff by longest common subsequence; rows carry old/new numbers. */
export function alignLines(before, after, start = 1) {
  const a = before === '' ? [] : before.split('\n'), b = after === '' ? [] : after.split('\n')
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const rows = []; let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ o: start + i, n: start + j, t: a[i] }); i++; j++ }
    else if (i < a.length && (j >= b.length || dp[i + 1][j] >= dp[i][j + 1])) { rows.push({ o: start + i, s: '-', t: a[i] }); i++ }
    else { rows.push({ n: start + j, s: '+', t: b[j] }); j++ }
  }
  return rows
}
function renderDiff(n, ctx) {
  const rows = alignLines(n.before, n.after, n.start ?? 1)
  const keep = new Set(); const ctxLines = n.context ?? 1
  rows.forEach((r, k) => { if (r.s) for (let d = -ctxLines; d <= ctxLines; d++) keep.add(k + d) })
  const maxNo = Math.max(3, ...rows.map(r => String(Math.max(r.o ?? 0, r.n ?? 0)).length))
  const out = []
  if (n.hunkHeader) out.push(paint(`@@ -${n.start ?? 1},${rows.filter(r => r.o).length} +${n.start ?? 1},${rows.filter(r => r.n).length} @@`, 'muted'))
  let skipped = false, shown = 0
  rows.forEach((r, k) => {
    if (!keep.has(k)) { if (!skipped) out.push('  ' + paint('⋯', 'muted')); skipped = true; return }
    skipped = false
    if (n.maxRows && shown >= n.maxRows) { if (shown === n.maxRows) { out.push('  ' + paint(`… +${[...keep].filter(x => x >= k && x < rows.length).length} rows · Ctrl+O`, 'muted')); shown++ } return }
    shown++
    const gutter = n.numbered === false ? '' : paint(`${r.o == null ? ' '.repeat(maxNo) : String(r.o).padStart(maxNo)} ${r.n == null ? ' '.repeat(maxNo) : String(r.n).padStart(maxNo)} │`, 'muted') + ' '
    const sign = r.s === '-' ? paint('−', 'danger') : r.s === '+' ? paint('+', 'success') : ' '
    const head = `  ${gutter}`
    const code = `${sign} ${r.s === '-' ? paint(r.t, 'danger') : r.s === '+' ? paint(r.t, 'success') : r.t}`
    // the band is behind the code only (the sign and the text, to the full width); the line-number gutter stays plain
    const room = Math.max(0, ctx.width - cells(head))
    out.push(r.s ? head + bgPaint(pad(clip(code, room), room), r.s === '-' ? [66, 30, 36] : [28, 58, 40]) : clip(head + code, ctx.width))
  })
  return out
}
function renderSections(n, ctx) {
  return n.sections.flatMap(s => {
    const title = s.title ? [paint(s.title, 'primary', ['strong'])] : []
    if (s.collapsed) return title.length ? [...title, paint('  …', 'muted')] : [paint('...', 'muted')]
    return [...title, ...render(s.body, ctx).map(l => (title.length ? '  ' + l : l))]
  })
}
function renderChart(n, ctx) {
  const t = n.title ? [paint(n.title, 'muted')] : []
  const tone = (name, i) => name ?? ['accent', 'success', 'warning', 'danger', 'muted', 'default'][i % 6]
  if (n.chart === 'sparkline') {
    const vals = n.values.map(v => (v == null ? 0 : v)), max = Math.max(...vals, 1)
    return [`${n.label ? paint(n.label + ' ', 'muted') : ''}${paint(vals.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(v / max * 8 - 0.0001))] ?? '▁').join(''), tone(n.tone, 0))}`]
  }
  if (n.chart === 'bar' && (n.orientation ?? 'vertical') === 'horizontal') {
    const W = Math.max(8, Math.min(24, ctx.width - 20)), lw = Math.max(...n.categories.map(cells))
    const vals = ci => n.series.map(s => s.values[ci] ?? 0)
    const maxCell = Math.max(...n.series.flatMap(s => s.values.map(v => v ?? 0)), 1)
    const maxTotal = Math.max(...n.categories.map((_, ci) => vals(ci).reduce((a, b) => a + b, 0)), 1)
    return [...t, ...n.categories.map((c, ci) => {
      if (n.layout === 'stacked' || n.layout === 'normalized') {
        const total = vals(ci).reduce((a, b) => a + b, 0) || 1, scale = n.layout === 'normalized' ? W / total : W / maxTotal
        return `${pad(c, lw)} ${n.series.map((s, si) => paint('█'.repeat(Math.round((s.values[ci] ?? 0) * scale)), tone(s.tone, si))).join('')}`
      }
      return `${pad(c, lw)} ${n.series.map((s, si) => { const v = s.values[ci]; const k = Math.round((v ?? 0) / maxCell * W); return `${paint('█'.repeat(k), tone(s.tone, si))}${paint('░'.repeat(W - k), 'muted')} ${v ?? '—'}` }).join('  ')}`
    })]
  }
  if (n.chart === 'bar') {
    const H = n.height ?? 5, max = Math.max(...n.series.flatMap(s => s.values.map(v => v ?? 0)), 1)
    const cols = n.categories.map((c, ci) => n.series.map((s, si) => ({ h: Math.round((s.values[ci] ?? 0) / max * H), tone: tone(s.tone, si) })))
    const rows = Array.from({ length: H }, (_, r) => cols.map(group => group.map(b => (b.h >= H - r ? paint('██', b.tone) : '  ')).join('')).join('  '))
    return [...t, ...rows, n.categories.map(c => pad(c.slice(0, 2 * n.series.length), 2 * n.series.length)).join('  ')]
  }
  if (n.chart === 'line' || n.chart === 'point') {
    const H = n.height ?? 7, W = Math.min(ctx.width - 8, 44)
    const pts = n.series[0].points, xs = pts.map(p => p.x), ys = pts.map(p => p.y ?? 0)
    const minY = Math.min(...ys), maxY = Math.max(...ys, minY + 1)
    const grid = Array.from({ length: H }, () => Array(W).fill(' '))
    pts.forEach(p => { const x = Math.round((p.x - Math.min(...xs)) / (Math.max(...xs) - Math.min(...xs) || 1) * (W - 1)); const y = Math.round(((p.y ?? 0) - minY) / (maxY - minY) * (H - 1)); grid[H - 1 - y][x] = n.chart === 'line' ? '─' : '●' })
    return [...t, ...grid.map((r, i) => `${paint(String(Math.round(maxY - (maxY - minY) * i / (H - 1))).padStart(4) + ' │', 'muted')}${paint(r.join(''), tone(n.series[0].tone, 0))}`), paint(`     └${'─'.repeat(W)}`, 'muted'), ...(n.xLabel ? [paint(`      ${n.xLabel} →`, 'muted')] : [])]
  }
  if (n.chart === 'heatmap') {
    const lv = v => n.levels.findIndex(l => l.value === v)
    const one = n.cell === 1
    const sets = one ? ['·', '░', '▒', '▓', '█'] : ['░░', '▒▒', '▓▓', '██']
    const glyphOf = i => (n.levels.length === 3 && !one ? ['░░', '▒▒', '██'][i] : one ? sets[Math.min(i, 4)] : sets[Math.min(i, 3)])
    const cellText = v => { const i = lv(v); return i < 0 ? ' '.repeat(one ? 1 : 2) : paint(glyphOf(i), n.levels[i].tone ?? 'default') }
    const gap = one ? '' : '  '
    const header = n.columnLabels && one ? '     ' + (() => { const cs = Array(n.columnLabels.length).fill(' '); n.columnLabels.forEach((l, i) => { if (l) [...l].forEach((ch, k) => { if (i + k < cs.length) cs[i + k] = ch }) }); return cs.join('').replace(/\s+$/, '') })() : n.columnLabels ? '     ' + n.columnLabels.map(c => pad(c, 4)).join('').replace(/\s+$/, '') : '     ' + n.columns.map(c => pad(c, 4)).join('')
    return [...t, header, ...n.rows.map((r, ri) => `${pad(r, 4)} ${n.values[ri].map(v => cellText(v) + gap).join('')}`), `${paint('legend:', 'muted')} ${n.levels.map((l, i) => paint(glyphOf(i), l.tone ?? 'default') + ' ' + l.label).join('  ')}`]
  }
  return [paint('chart', 'muted')]
}
const MERMAID = { bytes: 8 * 1024, lines: 100, nodes: 25 }
function renderDiagram(n, ctx) {
  const lines = n.source.split('\n').map(l => l.trim()).filter(Boolean)
  const edges = lines.filter(l => /-->/.test(l)).map(l => l.split('-->').map(s => s.trim().replace(/\[(.+)\]/, '$1')))
  const names = [...new Set(edges.flat())]
  const linear = edges.length > 0 && edges.every(e => e.length >= 2) && names.length <= MERMAID.nodes
  const over = n.source.length > MERMAID.bytes || lines.length > MERMAID.lines || names.length > MERMAID.nodes
  if (over || !linear) return ['```mermaid', ...lines.slice(0, 5), lines.length > 5 ? `… ${lines.length - 5} more lines` : '', '```'].filter(Boolean).map(l => paint(l, 'muted'))
  const chain = [...new Set(edges.flatMap(e => e))]
  const box = nm => [`┌${'─'.repeat(cells(nm) + 2)}┐`, `│ ${nm} │`, `└${'─'.repeat(cells(nm) + 2)}┘`]
  const parts = chain.map(box)
  return [0, 1, 2].map(r => parts.map((p, i) => p[r] + (i < parts.length - 1 ? (r === 1 ? '────►' : '     ') : '')).join(''))
}
export const spacerLines = n => Array(n.size ?? 1).fill('')
function renderDivider(n, ctx) {
  const w = ctx.width
  return [paint(n.label ? `── ${n.label} ${'─'.repeat(Math.max(2, w - cells(n.label) - 4))}` : '─'.repeat(w), 'muted')]
}

// ======================================================================= layout renderers
const whenOk = (w, ctx) => !w || ((w.minWidth == null || ctx.viewport.width >= w.minWidth) && (w.maxWidth == null || ctx.viewport.width <= w.maxWidth) && (w.minHeight == null || ctx.viewport.height >= w.minHeight) && (w.maxHeight == null || ctx.viewport.height <= w.maxHeight))
/** The width a node wants when nothing constrains it: structural for containers, measured for leaves. */
function naturalWidth(n, ctx) {
  if (n.kind === 'surface') {
    const inner = Math.max(n.child ? naturalWidth(n.child, ctx) : 0, n.footer ? naturalWidth(n.footer, ctx) : 0, cells(n.title ?? '') + (n.badges ? cells(spansText(n.badges, ctx)) + 4 : 0))
    return n.chrome === 'none' || n.chrome === 'lane' ? inner : inner + 4
  }
  if (n.kind === 'stack') {
    const kids = n.children.filter(c => whenOk(c.when, ctx)).map(c => (typeof c.basis === 'number' ? c.basis : naturalWidth(c.node, ctx)))
    return n.direction === 'row' ? kids.reduce((a, b) => a + b, 0) + (n.gap ?? 1) * Math.max(0, kids.length - 1) : Math.max(0, ...kids)
  }
  return Math.min(400, Math.max(0, ...render(n, { ...ctx, width: 120 }).map(l => cells(l.trimEnd()))))
}

function renderStack(n, ctx) {
  const kids = n.children.filter(c => whenOk(c.when, ctx))
  if (n.direction === 'column') {
    const out = []
    kids.forEach((c, i) => { if (i && n.gap) out.push(...Array(n.gap).fill('')); out.push(...render(c.node, { ...ctx, width: ctx.width })) })
    return out
  }
  if (kids.some(c => c.priority != null)) return renderAdmit(n, kids, ctx)
  const gap = n.gap ?? 1, W = ctx.width
  let widths = kids.map(c => (c.basis === undefined || c.basis === 'auto' ? naturalWidth(c.node, ctx) : c.basis))
  const gaps = gap * Math.max(0, kids.length - 1)
  let free = W - gaps - widths.reduce((a, b) => a + b, 0)
  if (free > 0) {
    const gw = kids.map(c => c.grow ?? 0), tot = gw.reduce((a, b) => a + b, 0)
    if (tot) { let given = 0; widths = widths.map((w, i) => { const add = i === gw.lastIndexOf(gw.findLast(g => g > 0)) ? free - given : Math.floor(free * gw[i] / tot); given += gw[i] ? add : 0; return gw[i] ? w + add : w }) }
  } else if (free < 0) {
    let need = -free
    const order = kids.map((c, i) => i).filter(i => (kids[i].shrink ?? (kids[i].grow ? 1 : 0)) > 0).toSorted((a, b) => (kids[b].shrink ?? 1) - (kids[a].shrink ?? 1))
    for (const i of order) { const min = kids[i].minSize ?? 0; const cut = Math.min(need, Math.max(0, widths[i] - min)); widths[i] -= cut; need -= cut; if (!need) break }
    if (need) { for (let i = widths.length - 1; i >= 0 && need > 0; i--) { const cut = Math.min(need, Math.max(0, widths[i] - 1)); widths[i] -= cut; need -= cut } }
  }
  const blocks = kids.map((c, i) => render(c.node, { ...ctx, width: Math.max(1, widths[i]) }).map(l => clip(l, widths[i])))
  const h = Math.max(1, ...blocks.map(b => b.length))
  return Array.from({ length: h }, (_, r) => blocks.map((b, i) => pad(b[r] ?? '', widths[i])).join(' '.repeat(gap)).trimEnd())
}

/**
 * Priority admission in a row: children with a `priority` (lower is kept first) are admitted while they
 * fit; a child marked `overflow: 'hide'` drops out instead of truncating, and once the row is full later
 * children are dropped. Admitted children then lay out in their `band` (left, right).
 */
function renderAdmit(n, kids, ctx) {
  const gap = n.gap ?? 2, W = ctx.width
  const nat = kids.map(c => naturalWidth(c.node, ctx))
  const admitted = new Map()
  kids.forEach((c, i) => { if (c.priority == null) admitted.set(i, nat[i]) })
  let used = [...admitted.values()].reduce((a, b) => a + b, 0) + (admitted.size ? gap * admitted.size : 0), full = false
  const order = kids.map((c, i) => ({ c, i })).filter(x => x.c.priority != null).toSorted((a, b) => a.c.priority - b.c.priority || a.i - b.i)
  for (const x of order) {
    const need = nat[x.i] + (admitted.size ? gap : 0)
    if (!full && used + need <= W) { admitted.set(x.i, nat[x.i]); used += need }
    else if (!full && x.c.overflow === 'truncate' && W - used - gap >= 8) { admitted.set(x.i, W - used - gap); used = W; full = true }
    else if (x.c.overflow !== 'hide') full = true
  }
  const place = band => kids.map((c, i) => ({ c, i })).filter(x => admitted.has(x.i) && (x.c.band ?? 'left') === band)
  const lines = list => list.map(x => render(x.c.node, { ...ctx, width: admitted.get(x.i) }).map(l => clip(l, admitted.get(x.i)))[0] ?? '')
  const left = lines(place('left')), right = lines(place('right'))
  const L = left.join(' '.repeat(gap)), R = right.join(' '.repeat(gap))
  return [L + ' '.repeat(Math.max(gap, W - cells(L) - cells(R))) + R].map(l => (R ? l : l.trimEnd()))
}

function borderPaint(chrome, tone) { return tone ? s => paint(s, tone) : chrome === 'overlay' ? s => paint(s, 'primary') : s => paint(s, 'muted') }
function renderSurface(n, ctx) {
  const chrome = n.chrome ?? 'surface', W = Math.max(ctx.width, 8)
  const owner = ctx.hintOwner === n
  const decision = owner && ctx.decisionLines ? ctx.decisionLines : []
  // `hint: 'none'` draws no hint row; `hint: 'completions'` draws one only while a completion list is open (the editor)
  const hintOn = n.hint === 'none' ? false : n.hint === 'completions' ? !!ctx.hintCompletions : true
  const hint = owner && ctx.hintLine && hintOn ? [paint('  ', 'muted') + ctx.hintLine] : []
  if (chrome === 'none' || chrome === 'lane') {
    const title = n.title ? [chrome === 'lane' ? paint(`── ${n.title} ${'─'.repeat(Math.max(2, W - cells(n.title) - 4 - (n.badges ? cells(spansText(n.badges, ctx)) + 1 : 0)))}${n.badges ? ' ' + spansText(n.badges, ctx) : ''}`, 'muted') : paint(n.title, 'default', ['strong'])] : []
    return [...title, ...(n.subtitle ? [paint(n.subtitle, 'muted')] : []), ...render(n.child, ctx), ...(n.footer ? render(n.footer, ctx) : []), ...decision, ...hint]
  }
  const b = borderPaint(chrome, n.border), inner = W - 4
  const badge = n.badges ? spansText(n.badges, ctx) : ''
  const titleText = n.title ?? ''
  const titleRoom = W - 2 - (badge ? cells(badge) + 2 : 0) - 2
  const shownTitle = n.titleAlign === 'right' && cells(titleText) > titleRoom ? clipMiddle(titleText, Math.max(4, titleRoom), 'start') : titleText
  const room = Math.max(1, W - 2 - (shownTitle ? cells(shownTitle) + 2 : 0) - (badge ? cells(badge) + 2 : 0))
  const titleP = shownTitle ? b(' ') + paint(shownTitle, 'default', ['strong']) + b(' ') : ''
  const badgeP = badge ? b(' ') + badge + b(' ') : ''
  // a right-aligned title sits in the top-right corner (the editor); a left title follows the corner
  const top = n.titleAlign === 'right' ? b('╭') + badgeP + b('─'.repeat(room)) + titleP + b('╮') : b('╭') + titleP + b('─'.repeat(room)) + badgeP + b('╮')
  const body = [...(n.subtitle ? [paint(n.subtitle, 'muted')] : []), ...render(n.child, { ...ctx, width: inner }), ...(n.footer ? render(n.footer, { ...ctx, width: inner }) : []), ...decision, ...hint]
  const rows = body.map(l => b('│') + ' ' + pad(clip(l, inner), inner) + ' ' + b('│'))
  return [top, ...rows, b('╰' + '─'.repeat(W - 2) + '╯')]
}

function renderScroll(n, ctx) {
  const st = ctx.state(n.id ?? 'scroll')
  const H0 = st.expanded ? (n.expandedHeight ?? 14) : (n.height ?? 6)
  const lines = render(n.child, { ...ctx, width: ctx.width - (n.scrollbar === false || (n.fit && render(n.child, { ...ctx, width: ctx.width }).length <= H0) ? 0 : 2) })
  // `fit` shrinks the viewport to short content and drops the scrollbar until the content overflows
  const H = n.fit ? Math.min(H0, Math.max(1, lines.length)) : H0
  const max = Math.max(0, lines.length - H)
  if (n.reveal && st.rev !== n.reveal.rev) { st.rev = n.reveal.rev; st.follow = false; st.top = Math.max(0, Math.min(max, n.reveal.line - Math.floor(H / 2))) }
  const follow = st.follow ?? (n.follow === 'end')
  const top = follow ? max : Math.min(st.top ?? 0, max)
  const view = lines.slice(top, top + H)
  while (view.length < H) view.push('')
  if (n.scrollbar === false || (n.fit && lines.length <= H)) return view
  const thumb = Math.max(1, Math.round(H * H / Math.max(H, lines.length))), at = max ? Math.round(top / max * (H - thumb)) : 0
  const ticks = new Map()
  ;(n.marks ?? []).forEach(m => ticks.set(Math.min(H - 1, Math.floor(m / Math.max(1, lines.length) * H)), m === n.currentMark ? 'cur' : 'tick'))
  const atEnd = top >= max
  return view.map((l, r) => {
    let text = l
    if (n.pill && !atEnd && r === H - 1) { const pill = inverse(` ${n.pill} `); text = pad(clip(l, ctx.width - 2 - cells(pill) - 1), ctx.width - 2 - cells(pill)) + pill }
    const tk = ticks.get(r)
    const bar = tk === 'cur' ? paint('◆', 'primary') : tk ? paint('▪', 'warning') : r >= at && r < at + thumb && lines.length > H ? paint('█', 'primary') : paint('░', 'muted')
    return `${pad(clip(text, ctx.width - 2), ctx.width - 2)} ${bar}`
  })
}

// ======================================================================= tabs
function renderTabs(n, ctx) {
  const focused = ctx.focusId === n.id
  const items = n.items
  const lab = it => it.label + (it.count != null ? ` ${it.count}` : '')
  if (n.orientation === 'vertical') {
    const W = ctx.width
    const out = []; let group = null
    for (const it of items) {
      if (it.group && it.group !== group) { group = it.group; out.push(paint(' ' + it.group.toUpperCase(), 'muted')) }
      const on = it.id === n.activeId
      const right = it.attention ? paint('!', 'warning', ['strong']) : it.count != null ? paint(String(it.count), 'muted') : ''
      const room = W - cells(right) - 4
      const lbl = it.clip === 'start' ? clipMiddle(it.label, room, 'start') : it.label
      // the selected label keeps the same `→` as a cursor: primary while the rail has focus, muted once focus is in the content
      const left = `${on ? paint('→', focused ? 'primary' : 'muted', ['strong']) : ' '} ${on ? paint(lbl, focused ? 'primary' : 'default', ['strong']) : paint(lbl, it.disabled ? 'muted' : 'default')}`
      out.push(pad(left, W - cells(right) - 1) + ' ' + right)
    }
    return out
  }
  if (n.mode === 'wizard') {
    const idx = items.findIndex(i => i.id === n.activeId)
    const toks = items.map((it, i) => (i < idx ? `${paint('✓', 'success')} ${it.label}` : i === idx ? `${paint('●', 'primary')} ${paint(it.label, 'primary', ['strong'])}` : paint(`○ ${it.label}`, 'muted')))
    const line = toks.join(paint('  ›  ', 'muted'))
    const off = toks.slice(0, idx).reduce((a, t) => a + cells(t) + 5, 0)
    return [clip(line, ctx.width), ' '.repeat(off) + paint('━'.repeat(cells(toks[idx] ?? '')), focused ? 'primary' : 'muted')]
  }
  const toks = items.map(it => {
    const on = it.id === n.activeId
    const badge = it.attention ? ' ' + paint('!', 'warning', ['strong']) : ''
    const count = it.count != null && !it.attention ? ' ' + paint(String(it.count), 'muted') : ''
    return { it, on, plain: lab(it) + (it.attention ? ' !' : ''), text: (on ? paint(it.label, 'primary', focused ? ['strong'] : []) : paint(it.label, it.disabled ? 'muted' : 'muted')) + (on ? (it.count != null ? ' ' + paint(String(it.count), 'primary') : '') + badge : count + badge) }
  })
  const gap = 3
  const total = toks.reduce((a, t) => a + cells(t.plain), 0) + gap * (toks.length - 1)
  if (total > ctx.width) {
    const i = toks.findIndex(t => t.on)
    const shown = [toks[i], toks[i + 1]].filter(Boolean)
    const rest = toks.length - shown.length
    return [paint('‹ ', 'muted') + shown.map(t => t.text).join('  ') + (rest > 0 ? paint(`  +${rest} ›`, 'muted') : paint(' ›', 'muted'))]
  }
  const line = toks.map(t => t.text).join(' '.repeat(gap))
  const off = toks.slice(0, toks.findIndex(t => t.on)).reduce((a, t) => a + cells(t.plain) + gap, 0)
  const act = toks.find(t => t.on)
  return [line, ' '.repeat(off) + paint('━'.repeat(cells(act?.plain ?? '')), focused ? 'primary' : 'muted', focused ? ['strong'] : [])]
}

// ======================================================================= actions
export function actionTokens(n, un = {}) {
  return n.items.filter(i => !i.hidden).map(raw => {
    const it = un[raw.id] ? { ...raw, disabled: true, disabledReason: un[raw.id] } : raw
    const label = it.label + (it.key && !/^ctrl|^alt/.test(it.key) ? ` (${it.key})` : it.key ? ` (${it.key.replace(/^ctrl\+/, 'Ctrl+')})` : '')
    const text = it.busy ? `… ${it.label}` : it.disabled ? `${it.label} — ${it.disabledReason ?? 'unavailable'}` : it.intent === 'danger' ? `! ${label}` : it.intent === 'primary' ? `[ ${label} ]` : label
    return { it, text }
  })
}
function renderActions(n, ctx) {
  const st = ctx.state(n.id)
  if (st.confirm) {
    const c = st.confirm
    const lines = [paint(c.title, 'default', ['strong'])]
    if (c.detail) lines.push(paint(c.detail, c.tone === 'danger' ? 'warning' : 'warning'))
    const yes = st.yes
    lines.push(`${yes ? '  ' : paint('→ ', 'primary')}${yes ? paint('[No]', 'muted') : inverse(' No ')}   ${yes ? paint('→ ', 'primary') + inverse(' Yes ') : paint('[Yes]', 'muted')}`)
    return lines
  }
  const toks = actionTokens(n, ctx.unavailable ?? {})
  if (!toks.length) return []
  const focused = ctx.focusId === n.id
  const idx = st.focus ?? Math.max(0, n.items.filter(i => !i.hidden).findIndex(i => i.defaultFocus))
  let used = 0; const parts = []
  let shown = toks.length
  const widths = toks.map(t => cells(t.text))
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (toks.length - 1)
  if (total > ctx.width - 4) { let acc = 0; shown = 0; for (const w of widths) { if (acc + w + 3 > ctx.width - 6) break; acc += w + 3; shown++ } shown = Math.max(1, shown) }
  toks.slice(0, shown).forEach((t, i) => {
    const disabled = t.it.disabled, busy = t.it.busy
    let s = t.text
    if (focused && i === idx) s = inverse(' ' + s + ' ')
    else if (disabled || busy) s = paint(s, 'muted')
    else if (t.it.intent === 'danger') s = paint(s, 'danger')
    else if (t.it.intent === 'primary') s = paint(s, 'primary')
    parts.push(s)
  })
  return [' ' + parts.join('   ') + (shown < toks.length ? '   ' + paint(`+${toks.length - shown}`, 'muted') : '')]
}

// ======================================================================= loader, progress, empty
function renderLoader(n, ctx) {
  const g = glyphFor(n.variant ?? 'gap', ctx)
  const msg = n.message ? ' ' + paint(n.message, n.messageTone ?? 'default') : ''
  const el = n.elapsedMs != null ? ' ' + paint(fmtDur(n.elapsedMs), 'muted') : ''
  return [g + msg + el, ...(n.cancelActionId ? ['  ' + paint('Esc cancel', 'muted')] : [])]
}
export const fmtDur = ms => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` }
function renderProgress(n, ctx) {
  const k = n.max ? n.value / n.max : 0
  if (n.style === 'rule') {
    const w = n.width ?? 24, hv = Math.round(k * w)
    return [paint('━'.repeat(hv), n.tone ?? 'primary') + paint('─'.repeat(w - hv), 'muted')]
  }
  const w = n.width ?? 10, f = Math.round(k * w)
  return [`${n.label ? n.label + ' ' : ''}${paint('▰'.repeat(f), n.tone ?? 'primary')}${paint('▱'.repeat(w - f), 'muted')}${n.showCount === false ? '' : ` ${n.value}/${n.max}`}${n.showPercent ? ` ${Math.round(k * 100)}%` : ''}`]
}
function renderEmpty(n, ctx) {
  return [paint(n.title, 'muted'), ...(n.description ? [paint(n.description, 'muted')] : [])]
}

// ======================================================================= list
/** The visible rows of a list given its renderer state: filter, tree expansion, depth, groups. */
export function listRows(n, st = {}) {
  const q = (st.query ?? '').toLowerCase()
  const labelText = it => (typeof it.label === 'string' ? it.label : it.label.map(s => spanOf(s).text).join(''))
  const items = n.items.filter(it => !q || `${labelText(it)} ${it.detail ?? ''} ${it.searchText ?? ''}`.toLowerCase().includes(q))
  const expanded = st.expanded ?? new Set(n.items.filter(i => i.expanded).map(i => i.id))
  const kids = new Map()
  items.forEach(it => { if (it.parentId) kids.set(it.parentId, [...(kids.get(it.parentId) ?? []), it]) })
  const rows = []
  let group = null
  const first = items.find(i => !i.disabled)?.id
  const focusId = st.cursor ?? first
  const push = (it, depth, last) => {
    if (it.group && it.group !== group) { group = it.group; rows.push({ type: 'group', label: it.group }) }
    const children = kids.get(it.id) ?? []
    const always = it.bodyAlways === true
    const expandable = !always && (children.length > 0 || it.body != null || it.expandable)
    const open = always || expanded.has(it.id) || !!q || (n.expandFocused === true && focusId === it.id)
    rows.push({ type: 'item', item: it, depth, last, expandable, open, children })
    if (open && children.length) children.forEach((c, i) => push(c, depth + 1, i === children.length - 1))
    if (open && it.body != null) rows.push({ type: 'body', item: it, always, lines: typeof it.body === 'object' ? [] : String(it.body).split('\n') })
  }
  items.filter(it => !it.parentId || !items.some(p => p.id === it.parentId)).forEach(it => push(it, 0, false))
  return rows
}
export const listItemRows = (n, st) => listRows(n, st).filter(r => r.type === 'item')
export function segState(it, st = {}) {
  const seg = it.segment
  if (!seg) return null
  const pinned = st.seg && it.id in st.seg ? st.seg[it.id] : seg.selectedId
  const active = pinned ?? seg.inheritedId
  return { seg, pinned: pinned ?? null, active }
}
const stripText = (it, ss, withDefault) => ss.seg.options.map(o => {
  const on = o.id === ss.active
  const tag = withDefault && !ss.pinned && o.id === ss.seg.inheritedId ? ' (default)' : ''
  return on ? paint(`‹ ${o.label}${tag} ›`, 'primary', ['strong']) : paint(o.label, o.disabled ? 'muted' : 'muted')
}).join(' ')

/**
 * A list row that is a block of text rather than one line: the text wraps to the width, and the block may carry a bar
 * down every line, a background band, or a rounded card with a title. `maxLines` cuts a long block with a "more lines"
 * row that Enter opens (a plain `wrap` row takes `wrapMax` the same way). Used for the user's own words in the stream.
 *   item.block = { bar?: tone, band?: [r, g, b], card?: title, lead?: spans, maxLines? }
 */
function renderBlock(it, on, mark, W, ctx) {
  const b = it.block, gutter = (on ? mark : ' ') + ' '
  const room = W - 2 - (b.bar ? 2 : 0) - (b.card ? 4 : 0)
  const lead = b.lead ? spansText(b.lead, ctx) : '', leadW = cells(lead)
  const text = typeof it.label === 'string' ? paint(it.label, 'default', ['strong']) : spansText(it.label, ctx)
  let lines = wrap(text, Math.max(8, room - leadW)).map((l, i) => (i ? ' '.repeat(leadW) : lead) + l)
  let more = ''
  if (b.maxLines && lines.length > b.maxLines) { more = paint(`${' '.repeat(leadW)}▸ ${lines.length - b.maxLines} more lines · Enter`, 'muted'); lines = lines.slice(0, b.maxLines) }
  if (more) lines.push(more)
  if (b.card) {
    const t = ` ${b.card} `, w = W - 2
    return [gutter + paint('╭' + t + '─'.repeat(Math.max(0, w - 2 - cells(t))) + '╮', 'muted'), ...lines.map(l => gutter + paint('│', 'muted') + ' ' + pad(l, w - 4) + ' ' + paint('│', 'muted')), gutter + paint('╰' + '─'.repeat(w - 2) + '╯', 'muted')]
  }
  return lines.map(l => {
    const line = (b.bar ? paint('▎', b.bar, ['strong']) + ' ' : '') + l
    return gutter + (b.band ? bgPaint(pad(line, W - 2), b.band) : line)
  })
}
function renderList(n, ctx) {
  const st = ctx.state(n.id), focused = ctx.focusId === n.id, W = ctx.width
  if (n.focusItem && st.focusRev !== n.focusItem.rev) { st.focusRev = n.focusItem.rev; st.cursor = n.focusItem.id; const it = n.items.find(i => i.id === n.focusItem.id); if (it?.parentId && st.expanded) st.expanded.add(it.parentId); if (n.focusItem.open && st.expanded) st.expanded.add(n.focusItem.id) }
  const rows = listRows(n, st)
  const itemRows = rows.filter(r => r.type === 'item')
  const cursorId = st.cursor ?? itemRows.find(r => !r.item.disabled)?.item.id
  const selected = st.selected ?? new Set(n.selectedIds ?? [])
  const marker = n.marker ?? (n.role === 'browse' && n.rail ? 'selection' : 'cursor')
  const multi = n.mode === 'multiple'
  const numbered = n.numbered
  const out = []
  if (n.filterable && (st.searching || st.query)) {
    const count = itemRows.length
    const left = paint('/', 'muted') + ' ' + (st.query ?? '') + (st.searching ? '▌' : '')
    const rt = paint(`${count} match${count === 1 ? '' : 'es'}`, 'muted')
    out.push(pad(left, W - cells(rt)) + rt)
  }
  const headOf = (it, row, on) => {
    const parts = []
    // a cursor shows only while its list has focus; a `selection` list (one whose detail follows it) keeps a muted arrow
    parts.push(on && (focused || marker === 'selection') ? paint('→', focused ? 'primary' : 'muted', ['strong']) : ' ')
    parts.push(' ')
    if (it.indent) parts.push(' '.repeat(it.indent))
    if (row.depth) parts.push('  '.repeat(row.depth - 1) + paint(row.last ? '╰ ' : '│ ', 'muted'))
    if (row.expandable) parts.push(paint(row.open ? '▾' : '▸', on ? 'primary' : 'muted') + ' ')
    if (numbered) parts.push(paint(String(itemRows.indexOf(row) + 1), 'muted') + '  ')
    if (multi || n.marks) {
      let mark
      if (row.children.length && multi) { const c = row.children.filter(k => selected.has(k.id)).length; mark = c === 0 ? '○' : c === row.children.length ? '●' : '◐' }
      else mark = selected.has(it.id) ? '●' : '○'
      parts.push(paint(mark, mark === '○' ? 'muted' : 'primary') + ' ')
    }
    const labelTone = it.disabled ? 'muted' : 'default'
    parts.push(typeof it.label === 'string' ? paint(it.label, labelTone, on || it.strong ? ['strong'] : []) : spansText(it.label, ctx))
    if (it.badge) parts.push(' ' + paint(`[${it.badge}]`, 'muted'))
    if (it.meter) parts.push(' ' + renderProgress({ value: it.meter.value, max: it.meter.max, width: it.meter.width ?? 8, tone: it.meter.tone, showCount: false }, ctx)[0])
    if (it.detail) parts.push(' ' + (typeof it.detail === 'string' ? paint(it.detail.startsWith('—') ? it.detail : `— ${it.detail}`, 'muted') : spansText(it.detail, ctx)))
    if (it.disabled && it.disabledReason) parts.push(' ' + paint(`— ${it.disabledReason}`, 'muted'))
    return parts.join('')
  }
  // The strip never moves a row: the footer line is reserved once any row's strip might not fit.
  const inner = W
  const fits = (it, row, v) => { const ss = segState(it, st); return ss ? cells(headOf(it, row, true)) + 2 + cells(stripText(it, ss, v)) <= inner : true }
  const needsFooter = itemRows.some(r => r.item.segment && !fits(r.item, r, false))
  let footerStrip = ''
  let windowed = rows, hiddenAbove = 0, hiddenBelow = 0
  if (n.maxRows && rows.filter(r => r.type === 'item').length > n.maxRows) {
    const at = Math.max(0, rows.findIndex(r => r.type === 'item' && r.item.id === cursorId))
    const start = Math.max(0, Math.min(rows.length - n.maxRows, at - Math.floor(n.maxRows / 2)))
    windowed = rows.slice(start, start + n.maxRows); hiddenAbove = start; hiddenBelow = rows.length - start - n.maxRows
  }
  windowed.forEach(row => {
    if (row.type === 'group') { out.push(paint(row.label, 'muted')); return }
    if (row.type === 'body') {
      const ind = ' '.repeat(row.item.indent ?? 0)
      if (row.always) { out.push(...(typeof row.item.body === 'string' ? row.lines.map(l => ind + '       ' + paint(l, 'muted')) : render(row.item.body, { ...ctx, width: W - 2 - ind.length }).map(l => ind + '  ' + l))); return }
      const bodyLines = typeof row.item.body === 'object' ? render(row.item.body, { ...ctx, width: W - 6 - ind.length }) : row.lines
      bodyLines.forEach((l, i) => out.push(ind + '    ' + paint(i === bodyLines.length - 1 ? '╰ ' : '│ ', 'muted') + (typeof row.item.body === 'object' ? l : paint(l, 'muted'))))
      return
    }
    const it = row.item, on = it.id === cursorId
    if (it.gap) { out.push(''); return }
    if (it.rule !== undefined) { const t = it.rule ? ' ' + it.rule : ''; out.push(paint('  ' + '─'.repeat(Math.max(2, W - 2 - cells(t))) + t, 'muted')); return }
    if (it.block) { out.push(...renderBlock(it, on && (focused || marker === 'selection'), paint('→', focused ? 'primary' : 'muted', ['strong']), W, ctx)); return }
    let line = headOf(it, row, on)
    const ss = segState(it, st)
    if (on && ss && focused) {
      const variant = [true, false].find(v => fits(it, row, v))
      if (variant !== undefined) line = pad(line, inner - cells(stripText(it, ss, variant))) + stripText(it, ss, variant)
      else footerStrip = `${paint('Thinking:'.replace('Thinking', ss.seg.label ?? 'Thinking'), 'muted')} ${stripText(it, ss, true)}`
    }
    const rightNow = on && it.rightFocus ? it.rightFocus : it.right
    if (rightNow) { const r = typeof rightNow === 'string' ? paint(it.right, 'muted') : spansText(rightNow, ctx); line = pad(clip(line, W - cells(r) - 1), W - cells(r)) + r }
    if (it.wrap) {
      // wrapping keeps the row's own indent (the cursor gutter and the caret column) on every line
      const lead0 = strip(line).match(/^ */)[0].length, lead = strip(line).match(/^[ →]*/)[0].length, lines = wrap(line, W - lead)
      const hang = /^\S /.test(strip(line).slice(lead)) ? 2 : 0 // continuation lines align under the text, not under the glyph
      const shown = lines.map((l, i) => ' '.repeat(i ? lead + hang : lead0) + l)
      // `wrapMax` hides the lines beyond the limit behind one row that Enter opens
      if (it.wrapMax && shown.length > it.wrapMax) { out.push(...shown.slice(0, it.wrapMax), ' '.repeat(lead + hang) + paint(`▸ ${shown.length - it.wrapMax} more lines · Enter`, 'muted')) }
      else out.push(...shown)
    }
    else out.push(clip(line, W))
  })
  if (hiddenAbove || hiddenBelow) out.push('   ' + paint(`↑ ${hiddenAbove} more · ↓ ${hiddenBelow} more`, 'muted'))
  if (!itemRows.length) out.push(...(n.empty ? render(n.empty, ctx) : [paint('Nothing to show', 'muted')]))
  if (needsFooter) out.push('', footerStrip ? '  ' + footerStrip : '')
  return out
}

// ======================================================================= form
export function formValue(n, f, st = {}) { return st.values && f.id in st.values ? st.values[f.id] : f.value }
export const isEdited = (n, f, st = {}) => JSON.stringify(formValue(n, f, st)) !== JSON.stringify(f.resetValue ?? f.value)
export function fieldError(n, f, st = {}) {
  const v = formValue(n, f, st)
  if (st.errors?.[f.id]) return st.errors[f.id]
  if (f.error) return f.error
  if (isEdited(n, f, st) || st.editing === f.id) {
    if (f.required && (v === '' || v == null)) return 'Required'
    if (f.pattern && v && !new RegExp(f.pattern).test(v)) return f.patternMessage ?? 'Invalid value'
  }
  return null
}
function renderForm(n, ctx) {
  const st = ctx.state(n.id), focused = ctx.focusId === n.id
  const lw = Math.max(...n.fields.map(f => cells(f.label))) + 1
  const out = []; let group = null
  const fi = st.focus ?? 0
  n.fields.forEach((f, i) => {
    if (f.group && f.group !== group) { group = f.group; out.push(paint(`── ${f.group} ${'─'.repeat(Math.max(2, Math.min(ctx.width, 44) - cells(f.group) - 4))}`, 'muted')) }
    const foc = focused && i === fi, ed = foc && st.editing === f.id
    const v = formValue(n, f, st), edited = isEdited(n, f, st)
    const mark = foc ? paint('→', 'primary') : edited ? paint('•', 'primary') : ' '
    const label = pad(`${f.label}:`, lw + 1)
    let val
    switch (f.kind) {
      case 'secret': val = ed ? '•'.repeat(String(v).length) + '▌' : v ? '•'.repeat(Math.min(10, String(v).length)) + paint(' (saved)', 'muted') : paint('not set', 'muted'); break
      case 'number': val = ed ? String(v) + '▌' : foc ? `${paint(`‹ ${v} ›`, 'primary')}${f.unit ? ' ' + f.unit : ''}${f.min != null ? paint(`  ${f.min}–${f.max}`, 'muted') : ''}` : `${v}${f.unit ? ' ' + f.unit : ''}`; break
      case 'select': val = foc && !st.picker ? paint(`‹ ${optLabel(f, v)} ›`, 'primary') : v == null ? paint('Choose…', 'muted') : optLabel(f, v); break
      case 'toggle': val = v ? paint('[on]', 'primary') : paint('[off]', 'muted'); break
      case 'multiselect': val = v.length ? v.join(', ') : paint('None selected', 'muted'); break
      case 'textarea': val = foc || ed ? '' : (String(v).split('\n')[0] || paint('empty', 'muted')) + (String(v).includes('\n') ? paint(' …', 'muted') : ''); break
      default: val = ed ? v + '▌' : v ? v : paint(f.placeholder ?? '', 'muted')
    }
    const origin = f.origin === 'inherited' ? paint(edited ? '  (override)' : '  (inherited)', 'muted') : ''
    out.push(clip(`${mark} ${foc ? paint(label, 'default', ['strong']) : label}${val}${origin}`, ctx.width))
    if (f.kind === 'textarea' && (foc || ed)) {
      const lines = String(v).split('\n'), w = Math.min(42, ctx.width - 6)
      out.push('    ' + paint('┌' + '─'.repeat(w) + '┐', 'muted'))
      for (let k = 0; k < Math.max(3, lines.length); k++) out.push('    ' + paint('│', 'muted') + ' ' + pad(clip((lines[k] ?? '') + (ed && k === lines.length - 1 ? '▌' : ''), w - 1), w - 1) + paint('│', 'muted'))
      out.push('    ' + paint('└' + '─'.repeat(w) + '┘', 'muted'))
    }
    const err = fieldError(n, f, st)
    if (err) out.push('    ' + paint(`! ${err}`, 'danger'))
    if (foc && f.help && !st.picker) out.push('    ' + paint(f.help, 'muted'))
    if (ed && f.suggestions) f.suggestions.filter(s => s.startsWith(v)).slice(0, 3).forEach((s, k) => out.push('    ' + paint((k === 0 ? '⇥ ' : '  ') + s, 'muted')))
    if (foc && st.picker && (f.kind === 'select' || f.kind === 'multiselect')) {
      f.options.forEach((o, k) => {
        const on = f.kind === 'multiselect' ? st.picker.set.has(o.id) : o.id === v
        out.push('    ' + `${k === st.picker.idx ? paint('→', 'primary') : ' '} ${o.disabled ? paint(`○ ${o.label ?? o.id} — ${o.disabledReason}`, 'muted') : `${on ? paint('●', 'primary') : paint('○', 'muted')} ${o.label ?? o.id}`}`)
      })
    }
  })
  return out
}
const optLabel = (f, v) => f.options?.find(o => o.id === v)?.label ?? v

// ======================================================================= prompt
/**
 * The prompt: one multi-line text input with a symbol, inline tokens (`[Image #1 84 KB ×]`, `[@file ×]`), a
 * placeholder ladder, history/queue recall, and a completion list. Tokens live in the input, not around it.
 */
function renderPrompt(n, ctx) {
  const st = ctx.state(n.id), focused = ctx.focusId === n.id, W = ctx.width
  if (n.reset && st.resetRev !== n.reset.rev) { st.resetRev = n.reset.rev; st.text = n.reset.value; st.selectedToken = null }
  const sym = n.symbol ?? '> ', symW = cells(sym)
  const text = st.text ?? ''
  const toks = (n.tokens ?? []).map((tk, i) => (i === st.selectedToken ? inverse(`[${tk.label}${tk.size ? ' ' + tk.size : ''} ×]`) : paint('[', 'muted') + paint(tk.label, 'accent') + (tk.size ? paint(` ${tk.size}`, 'muted') : '') + paint(' ×]', 'muted')))
  const caret = focused ? '▌' : ''
  const recall = st.recallIdx != null && n.recall?.[st.recallIdx] ? paint(`↑ ${n.recall[st.recallIdx].kind} ${st.recallIdx + 1}/${n.recall.length}`, 'muted') : ''
  const lines = text.split('\n')
  const first = text === '' && !toks.length
    ? caret + paint((() => { const vs = Array.isArray(n.placeholder) ? n.placeholder : [n.placeholder ?? '']; return vs.find(v => cells(v) <= W - symW - 2) ?? clip(vs.at(-1), W - symW - 2) })(), 'muted')
    : toks.join(' ') + (toks.length ? ' ' : '') + lines[0] + (lines.length === 1 ? caret : '')
  const head = paint(sym, n.symbolTone ?? 'default', n.symbolTone ? ['strong'] : []) + first
  const out = [recall ? pad(clip(head, W - cells(recall) - 1), W - cells(recall)) + recall : clip(head, W)]
  lines.slice(1).forEach((l, i) => out.push(' '.repeat(symW) + l + (i === lines.length - 2 ? caret : '')))
  const items = n.completions?.items ?? []
  if (items.length) {
    items.slice(0, 5).forEach((it, i) => out.push(`${i === (st.cIdx ?? 0) ? paint('→', 'primary', ['strong']) : ' '} ${paint(it.label, 'default', i === (st.cIdx ?? 0) ? ['strong'] : [])}${it.detail ? paint(` — ${it.detail}`, 'muted') : ''}`))
  }
  return out
}

// ======================================================================= dispatcher
const RENDER = {
  text: renderText, 'rich-text': renderRich, fields: renderFields, markdown: renderMarkdown, code: renderCode, diff: renderDiff,
  sections: renderSections, chart: renderChart, diagram: renderDiagram, spacer: n => spacerLines(n), divider: renderDivider,
  stack: renderStack, surface: renderSurface, scroll: renderScroll, tabs: renderTabs, list: renderList, form: renderForm,
  actions: renderActions, loader: renderLoader, progress: renderProgress, empty: renderEmpty, prompt: renderPrompt,
}
const noState = () => ({})
/** Paint a node to lines at a width. Pure: renderer state comes in through `ctx.state`, never from the node. */
export function render(n, ctx = {}) {
  const c = { width: 80, frame: 0, t: 0, state: noState, focusId: null, ...ctx }
  c.viewport = ctx.viewport ?? { width: c.width, height: 40 }
  const fn = RENDER[n.kind]
  if (!fn) throw new TypeError(`unknown node kind ${n.kind}`)
  return fn(n, c)
}

// ======================================================================= runtime: one key grammar
const KEYS = new Map([
  ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'], ['\r', 'enter'], ['\x1b', 'esc'], ['\t', 'tab'], ['\x1b[Z', 'shift+tab'],
  [' ', 'space'], ['\x7f', 'backspace'], ['\x1b[3~', 'delete'], ['\x1b[5~', 'pgup'], ['\x1b[6~', 'pgdn'], ['\x1b[H', 'home'], ['\x1b[F', 'end'],
  ['\x1b[1;3C', 'alt+right'], ['\x1b\x1b[C', 'alt+right'], ['\x1bf', 'alt+right'], ['\x1b[1;3D', 'alt+left'], ['\x1b\x1b[D', 'alt+left'], ['\x1bb', 'alt+left'],
  ['\x1b\r', 'alt+enter'], ['\x15', 'ctrl+u'], ['\x05', 'ctrl+e'], ['\x19', 'ctrl+y'], ['\x12', 'ctrl+r'], ['\x0b', 'ctrl+k'], ['\x06', 'ctrl+f'],
])
const CSI_LETTER = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }
const CSI_TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pgup', 6: 'pgdn', 7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' }
const CODE_KEY = { 9: 'tab', 13: 'enter', 27: 'esc', 32: 'space', 127: 'backspace' }
const withMods = (key, mod) => {
  // xterm and kitty report modifiers as 1 + bitmask: shift 1, alt 2, ctrl 4, meta 8 (meta counts as alt)
  const m = mod - 1, parts = []
  if (m & 4) parts.push('ctrl')
  if (m & 10) parts.push('alt')
  if ((m & 1) && !(key.length === 1 && /[a-z]/.test(key) && !(m & 14))) parts.push('shift')
  return [...parts, (m & 1) && key.length === 1 && !(m & 14) ? key.toUpperCase() : key].join('+')
}
/**
 * Decode the byte sequences terminals and multiplexers send for a key: the plain table above, the xterm modifier form
 * (`ESC [ 1 ; 3 A`), the SS3 form, the kitty keyboard protocol (`ESC [ 13 ; 3 u`, with an optional event type), the
 * modifyOtherKeys form (`ESC [ 27 ; 3 ; 13 ~`), and a bare ESC prefix for Alt. A key release reports as `release`.
 */
function parseKey(raw) {
  let m
  if ((m = /^\x1b\[(\d*)(?:;(\d+)(?::(\d+))?)?([A-Za-z~])$/.exec(raw))) {
    const [, c, mod, ev, fin] = m
    if (ev === '3') return 'release'
    const base = fin === 'u' ? (CODE_KEY[+c] ?? (+c >= 32 ? String.fromCodePoint(+c) : null)) : fin === '~' ? CSI_TILDE[+c] : fin === 'Z' ? 'tab' : CSI_LETTER[fin]
    if (!base) return null
    return fin === 'Z' ? 'shift+tab' : withMods(base, +(mod || 1))
  }
  if ((m = /^\x1b\[27;(\d+);(\d+)~$/.exec(raw))) { const base = CODE_KEY[+m[2]] ?? String.fromCodePoint(+m[2]); return withMods(base, +m[1]) }
  if ((m = /^\x1bO(?:1;)?(\d)?([A-DHFPQRS])$/.exec(raw))) return withMods(CSI_LETTER[m[2]], +(m[1] || 1))
  if ((m = /^\x1b\x1b(\[.*|O.)$/.exec(raw))) { const inner = parseKey('\x1b' + m[1]); return inner && !inner.startsWith('alt+') ? `alt+${inner}` : inner }
  if (raw.length === 2 && raw[0] === '\x1b') {
    const ch = raw[1]
    if (ch === '\x7f') return 'alt+backspace'
    if (ch === '\r') return 'alt+enter'
    if (ch >= ' ') return `alt+${ch === ' ' ? 'space' : ch}`
    if (ch >= '\x01' && ch <= '\x1a') return `ctrl+alt+${String.fromCharCode(ch.charCodeAt(0) + 96)}`
  }
  return null
}
export const keyName = raw => KEYS.get(raw) ?? parseKey(raw) ?? raw
/** Split a read chunk into keys: a terminal may deliver several (a fast typist, a paste, a batching multiplexer) at once. */
export const splitKeys = chunk => chunk.match(/\x1b\x1b\[[0-9;:]*[A-Za-z~]|\x1b\[[0-9;:]*[A-Za-z~]|\x1bO[\s\S]|\x1b[\s\S]|[\s\S]/gu) ?? []
KEYS.set('\x1b[1;3A', 'alt+up'); KEYS.set('\x1b[1;3B', 'alt+down'); KEYS.set('\x1b\x1b[A', 'alt+up'); KEYS.set('\x1b\x1b[B', 'alt+down'); KEYS.set('\x13', 'ctrl+s'); KEYS.set('\x07', 'ctrl+g')

/**
 * The keymap: every operation is a named action with a default key, and every action is rebindable at runtime
 * by whoever hosts the UI. Common actions (`ui.save`, `ui.copy`, `ui.delete`, the cursor and focus keys …) have
 * defaults here; a component declares its own (`plugin.install`, default `i`) with `key`. `keymap.bind` changes
 * either kind; the hint rows read the effective key, so a rebound key is what the user sees.
 */
export const DEFAULT_KEYMAP = {
  'ui.up': ['up'], 'ui.down': ['down'], 'ui.left': ['left'], 'ui.right': ['right'], 'ui.accept': ['enter'], 'ui.cancel': ['esc'], 'ui.toggle': ['space'],
  'ui.next-group': ['tab'], 'ui.prev-group': ['shift+tab'], 'ui.page-up': ['pgup'], 'ui.page-down': ['pgdn'], 'ui.home': ['home'], 'ui.end': ['end'],
  'ui.reset': ['delete'], 'ui.filter': ['/'], 'ui.clear': ['ctrl+u'], 'ui.expand': ['ctrl+e'], 'ui.newline': ['alt+enter', 'ctrl+j'],
  // every Alt binding has a second default that survives a terminal or multiplexer that swallows Alt
  'ui.tab-prev': ['alt+left', 'f2'], 'ui.tab-next': ['alt+right', 'f3'], 'ui.focus-prev': ['alt+up', 'f4'], 'ui.focus-next': ['alt+down', 'f5'],
  'ui.save': ['ctrl+s'], 'ui.copy': ['c'], 'ui.delete': ['x'], 'ui.refresh': ['r'], 'ui.external': ['ctrl+g'], 'ui.search': ['ctrl+f'],
}
// the engine's internal name for each navigation action (what listKey, formKey … switch on)
const NAV = { 'ui.up': 'up', 'ui.down': 'down', 'ui.left': 'left', 'ui.right': 'right', 'ui.accept': 'enter', 'ui.cancel': 'esc', 'ui.toggle': 'space', 'ui.next-group': 'tab', 'ui.prev-group': 'shift+tab', 'ui.page-up': 'pgup', 'ui.page-down': 'pgdn', 'ui.home': 'home', 'ui.end': 'end', 'ui.reset': 'delete', 'ui.clear': 'ctrl+u', 'ui.expand': 'ctrl+e', 'ui.newline': 'alt+enter', 'ui.tab-prev': 'alt+left', 'ui.tab-next': 'alt+right', 'ui.focus-prev': 'alt+up', 'ui.focus-next': 'alt+down' }
const SHOWN = { up: '↑', down: '↓', left: '←', right: '→', enter: 'Enter', esc: 'Esc', tab: 'Tab', 'shift+tab': 'Shift+Tab', space: 'Space', delete: 'Delete', pgup: 'PgUp', pgdn: 'PgDn', home: 'Home', end: 'End', backspace: 'Backspace' }
export const showKey = key => key.split('+').map((part, i, all) => (SHOWN[part] ?? (part.length === 1 && all.length > 1 ? part.toUpperCase() : part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part))).join('+')
class Keymap {
  overrides = new Map()
  seen = new Map()
  version = 0
  /** The effective keys of an action: the runtime override, else the default. */
  /** When the host cannot deliver Alt (a multiplexer, a terminal setting), hints show the key that does work first. */
  preferPlain = false
  keys(id, fallback) {
    const ks = this.overrides.get(id) ?? (DEFAULT_KEYMAP[id] ?? (fallback ? [fallback] : []))
    return this.preferPlain ? ks.toSorted((x, y) => x.includes('alt+') - y.includes('alt+')) : ks
  }
  defaults(id, fallback) { return DEFAULT_KEYMAP[id] ?? (fallback ? [fallback] : []) }
  bind(id, keys) { this.overrides.set(id, Array.isArray(keys) ? keys : [keys]); this.version++ }
  reset(id) { this.overrides.delete(id); this.version++ }
  resetAll() { this.overrides.clear(); this.version++ }
  /** Every action the runtime has seen, with its label, default keys, and effective keys. */
  list() { return [...new Set([...Object.keys(DEFAULT_KEYMAP), ...this.seen.keys()])].map(id => ({ id, label: this.seen.get(id)?.label ?? id.replace(/^ui\./, ''), defaults: this.defaults(id, this.seen.get(id)?.key), keys: this.keys(id, this.seen.get(id)?.key) })) }
  /** The key engine's internal name for a physical key, or null when its navigation action was rebound away from it. */
  canon(name) {
    for (const [id, internal] of Object.entries(NAV)) { if (this.keys(id).includes(name)) return internal }
    for (const [id, internal] of Object.entries(NAV)) { if (internal === name || DEFAULT_KEYMAP[id].includes(name)) return this.overrides.has(id) && !this.overrides.get(id).includes(name) ? `unbound:${name}` : name }
    return name
  }
}
export const keymap = new Keymap()
const kd = id => showKey(keymap.keys(id)[0] ?? '')
const kpair = (a, b) => { const x = kd(a), y = kd(b); const m = /^(Alt|Ctrl)\+/.exec(x); return m && y.startsWith(m[0]) ? `${x}/${y.slice(m[0].length)}` : `${x}/${y}` }
const printable = k => k.length === 1 && k >= ' ' && k !== '\x7f'
const isPrintableKey = key => key.length === 1
const T = (k, label, priority, order) => ({ keys: k, label, priority, order })

/**
 * Mount a component tree. `build(rt)` returns the current node tree (called on every render and key,
 * so app state lives in the caller); `onEvent(event)` receives structured events and may return a
 * reply (`invalid`, `failed`, `completed`, `accepted`, `cancelled`). The runtime owns focus, drafts,
 * cursors, scroll positions, and the hint row; none of that ever enters a node.
 */
export function mount(build, opts = {}) {
  const store = new Map()
  const feedback = []
  let focusId = null, decision = null, closed = false, controls = [], root = null, viewport = { width: 80, height: 40 }
  const get = id => store.get(id) ?? {}
  const rt = {
    get closed() { return closed }, set closed(v) { closed = v }, get focusId() { return focusId }, feedback, store,
    state: get,
    reset() { store.clear(); focusId = null; decision = null; closed = false; feedback.length = 0 },
    setFocus(id) { focusId = id }, setState(id, patch) { store.set(id, { ...(store.get(id) ?? {}), ...patch }) },
    say(message, severity = 'info') { feedback.length = 0; feedback.push({ message, severity, at: Date.now() }) },
    feedbackNode() {
      const f = feedback.at(-1)
      if (!f) return null
      if ((f.severity === 'success' || f.severity === 'info') && Date.now() - f.at > 5000) return null
      const glyph = { success: ['✓', 'success'], info: ['ℹ', 'primary'], warning: ['⚠', 'warning'], error: ['✗', 'danger'] }[f.severity]
      return ui.richText([{ text: glyph[0] + ' ', tone: glyph[1] }, { text: f.message, tone: f.severity === 'info' || f.severity === 'success' ? 'default' : glyph[1] }])
    },
    get decision() { return decision },
  }

  // ---- tree walk
  const collect = (n, out, vp) => {
    if (!n) return out
    switch (n.kind) {
      case 'stack': n.children.forEach(c => { if (whenOk(c.when, { viewport: vp })) collect(c.node, out, vp) }); break
      case 'surface': collect(n.child, out, vp); collect(n.footer, out, vp); break
      case 'scroll': if (n.id) out.push({ kind: 'scroll', node: n }); collect(n.child, out, vp); break
      case 'tabs': case 'list': case 'form': case 'actions': case 'prompt': out.push({ kind: n.kind, node: n }); break
      case 'empty': break
      default: break
    }
    return out
  }
  const ensure = c => {
    const n = c.node, id = n.id
    if (store.has(id)) return store.get(id)
    const init = {
      list: () => ({ cursor: undefined, query: '', searching: false, expanded: new Set((n.items ?? []).filter(i => i.expanded).map(i => i.id)), selected: new Set(n.selectedIds ?? []), seg: {} }),
      form: () => ({ focus: 0, editing: null, values: {}, errors: {}, picker: null }),
      actions: () => ({ focus: Math.max(0, (n.items ?? []).filter(i => !i.hidden).findIndex(i => i.defaultFocus)) }),
      prompt: () => ({ text: n.value ?? '', selectedToken: null, recallIdx: null, draft: '', cIdx: 0 }),
      tabs: () => ({}), scroll: () => ({ top: 0, follow: n.follow === 'end', expanded: false }),
    }[c.kind]()
    store.set(id, init)
    return init
  }
  const refresh = (width = viewport.width) => {
    viewport = { width, height: viewport.height }
    const tree = build(rt)
    root = tree
    controls = collect(tree, [], viewport)
    controls.forEach(ensure)
    validate(tree)
    const focusable = controls.filter(c => c.kind !== 'actions' || c.node.items.some(i => !i.hidden && !i.busy))
    if (!focusable.some(c => c.node.id === focusId)) focusId = (focusable.find(c => c.node.autofocus) ?? focusable[0])?.node.id ?? null
    return tree
  }
  const focusables = () => controls.filter(c => c.kind !== 'actions' || c.node.items.some(i => !i.hidden && !i.busy))
  const actionId = it => it.action ?? (it.semantic ? `ui.${it.semantic}` : it.id)
  const effKey = it => keymap.keys(actionId(it), it.key)[0]
  const validate = tree => {
    controls.filter(c => c.kind === 'actions').forEach(c => c.node.items.forEach(it => { keymap.seen.set(actionId(it), { label: it.label, key: it.key }) }))
    const typeFilter = controls.some(c => c.kind === 'list' && c.node.filterable && c.node.filterMode !== 'slash')
    if (!typeFilter) return
    controls.filter(c => c.kind === 'actions').forEach(c => c.node.items.forEach(it => {
      const k = effKey(it)
      if (k && isPrintableKey(k)) throw new Error(`action "${it.id}": printable key "${k}" on a surface with a type-to-filter list; use filterMode: 'slash' or a modifier key`)
    }))
  }
  const homeControl = () => { const f = focusables(); return f.find(c => c.node.autofocus) ?? f[0] }
  const cur = () => controls.find(c => c.node.id === focusId)
  /** The surface that owns the hint row: the root surface, else the nearest surface around the focused control. */
  const ownerOf = (n, id, vp) => {
    if (!n) return null
    if (n.kind === 'stack') { for (const c of n.children) { if (!whenOk(c.when, { viewport: vp })) continue; const f = ownerOf(c.node, id, vp); if (f) return f } return null }
    if (n.kind === 'surface') { const inner = ownerOf(n.child, id, vp) ?? ownerOf(n.footer, id, vp); if (inner) return inner; return collect(n, [], vp).some(c => c.node.id === id) ? n : null }
    return null
  }
  const surfaceNode = () => (root && root.kind === 'surface' ? root : ownerOf(root, focusId, viewport))
  /** Actions a row marks unavailable while it is the cursor row: `{ actionId: reason }`. */
  const unavailable = () => Object.assign({}, ...controls.filter(c => c.kind === 'list').map(c => {
    const s = store.get(c.node.id), rows = listItemRows(c.node, s), row = rows.find(r => r.item.id === s.cursor) ?? rows.find(r => !r.item.disabled)
    return row?.item.unavailableActions ?? {}
  }))

  // ---- events and replies
  const emit = (event) => {
    const reply = opts.onEvent?.(event, rt)
    if (!reply) return reply
    if (reply.kind === 'invalid') {
      const f = controls.find(c => c.kind === 'form' && (!reply.formId || c.node.id === reply.formId)) ?? controls.find(c => c.kind === 'form')
      if (f) store.get(f.node.id).errors = { ...(reply.errors ?? {}) }
      rt.say(reply.message ?? 'Fix the highlighted fields', 'warning')
    } else if (reply.kind === 'failed') rt.say(reply.message ?? 'Failed', 'error')
    else if (reply.kind === 'completed') { if (reply.feedback) rt.say(reply.feedback.message, reply.feedback.severity ?? 'success'); if (reply.dismiss) closed = true }
    return reply
  }
  const askYesNo = (confirm, onYes) => { decision = { confirm: typeof confirm === 'string' ? { title: confirm } : confirm, yes: false, onYes } }

  // ---- list
  const moveCursor = (c, s, rows, to) => { const r = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (r) s.cursor = r.item.id }
  const stepDisabled = (rows, from, d) => { let i = from + d; while (rows[i] && rows[i].item.disabled) i += d; return rows[i] ? i : from }
  const doAccept = (c, s, row) => {
    const n = c.node, it = row.item
    const ss = segState(it, s)
    if (n.mode === 'multiple') { emit({ kind: 'selection-accept', controlId: n.id, selectedIds: [...s.selected], actionId: n.acceptActionId }); return }
    if (n.marks || n.mode !== 'multiple') s.selected = new Set([it.id])
    const reply = emit({ kind: 'selection-accept', controlId: n.id, selectedIds: [it.id], itemId: it.id, segmentId: ss ? ss.pinned : undefined, actionId: n.acceptActionId })
    return reply
  }
  const toggleCheck = (c, s, row) => {
    const n = c.node, id = row.item.id
    const ids = row.children.length ? row.children.filter(k => !k.disabled).map(k => k.id) : [id]
    const all = ids.every(i => s.selected.has(i))
    ids.forEach(i => (all ? s.selected.delete(i) : s.selected.add(i)))
    emit({ kind: 'selection-toggle', controlId: n.id, selectedIds: [...s.selected] })
  }
  const listKey = (c, name, raw) => {
    const n = c.node, s = store.get(n.id), rows = listItemRows(n, s)
    const idx = Math.max(0, rows.findIndex(r => r.item.id === (s.cursor ?? rows.find(x => !x.item.disabled)?.item.id)))
    const row = rows[idx]
    if (s.searching) {
      if (name === 'esc') { s.searching = false; return true }
      if (name === 'enter') { s.searching = false; if (row) act(c, s, row); return true }
      if (name === 'backspace') { s.query = s.query.slice(0, -1); s.cursor = undefined; return true }
      if (name === 'ctrl+u') { s.query = ''; return true }
      if (name === 'up') { moveCursor(c, s, rows, stepDisabled(rows, idx, -1)); return true }
      if (name === 'down') { moveCursor(c, s, rows, stepDisabled(rows, idx, 1)); return true }
      if ((name === 'left' || name === 'right') && row?.item.segment) return segStep(s, row.item, name === 'right' ? 1 : -1)
      if (printable(raw)) { s.query += raw; s.cursor = undefined; return true }
      return false
    }
    const edge = d => { const f = focusables(), i = f.findIndex(x => x.node.id === n.id); const to = f[i + d]; if (to) { focusId = to.node.id; return true } return false }
    switch (name) {
      case 'up': return idx === 0 ? edge(-1) : (moveCursor(c, s, rows, stepDisabled(rows, idx, -1)), true)
      case 'down': return idx >= rows.length - 1 ? edge(1) : (moveCursor(c, s, rows, stepDisabled(rows, idx, 1)), true)
      case 'pgup': moveCursor(c, s, rows, idx - 8); return true
      case 'pgdn': moveCursor(c, s, rows, idx + 8); return true
      case 'home': moveCursor(c, s, rows, 0); return true
      case 'end': moveCursor(c, s, rows, rows.length - 1); return true
      case 'enter': if (row) act(c, s, row); return true
      case 'space':
        if (!row) return true
        if (n.mode === 'multiple') { toggleCheck(c, s, row); return true }
        if (row.expandable) { s.expanded.has(row.item.id) ? s.expanded.delete(row.item.id) : s.expanded.add(row.item.id); return true }
        return false
      case 'left': case 'right': {
        if (row?.item.segment) return segStep(s, row.item, name === 'right' ? 1 : -1)
        if (row?.expandable) { name === 'right' ? s.expanded.add(row.item.id) : s.expanded.delete(row.item.id); return true }
        if (name === 'left' && row?.item.parentId) { s.cursor = row.item.parentId; return true }
        return false
      }
      case 'delete': if (row?.item.segment && segState(row.item, s).pinned != null) { delete s.seg[row.item.id]; s.seg[row.item.id] = null; return true } return false
      case 'ctrl+u': s.query = ''; return true
      default: break
    }
    if (n.numbered && /^[1-9]$/.test(raw) && !n.filterable) {
      const i = Number(raw) - 1
      if (rows[i] && !rows[i].item.disabled) { moveCursor(c, s, rows, i); if (n.numbered === true) act(c, s, rows[i]) }
      return true
    }
    if (n.tree && raw === '*') { n.items.forEach(i => s.expanded.add(i.id)); return true }
    if (n.tree && raw === '-') { s.expanded.clear(); return true }
    if (n.filterable && raw === '/') { s.searching = true; return true }
    if (n.filterable && n.filterMode !== 'slash' && printable(raw)) { s.searching = true; s.query += raw; s.cursor = undefined; return true }
    return false
  }
  const act = (c, s, row) => {
    const n = c.node, it = row.item
    if (it.disabled) { rt.say(it.disabledReason ?? 'Unavailable', 'warning'); return }
    if (row.expandable && (n.tree || it.body != null)) { s.expanded.has(it.id) ? s.expanded.delete(it.id) : s.expanded.add(it.id); return }
    if (n.mode === 'multiple' && n.tree) { toggleCheck(c, s, row); return }
    if (it.confirm) { askYesNo(it.confirm, () => doAccept(c, s, row)); return }
    doAccept(c, s, row)
  }
  const segStep = (s, it, d) => {
    const ss = segState(it, s), opts2 = ss.seg.options, E = opts2.filter(o => !o.disabled)
    const at = E.findIndex(o => o.id === ss.active)
    const next = at < 0 ? (d > 0 ? 0 : E.length - 1) : Math.max(0, Math.min(E.length - 1, at + d))
    const id = E[next]?.id
    if (id === ss.active) return false
    s.seg[it.id] = ss.seg.inheritedId != null && id === ss.seg.inheritedId ? null : id
    return true
  }

  // ---- form
  const FIELD_TEXT = ['input', 'secret', 'textarea', 'number']
  const setVal = (c, s, f, v) => { s.values[f.id] = v; emit({ kind: 'value-change', controlId: c.node.id, fieldId: f.id, value: v }) }
  const clampNum = (f, v) => Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, Number(v) || (f.min ?? 0)))
  const formKey = (c, name, raw) => {
    const n = c.node, s = store.get(n.id), fi = Math.min(s.focus, n.fields.length - 1), f = n.fields[fi]
    const v = formValue(n, f, s)
    const move = d => { let i = fi + d; while (n.fields[i]?.disabled) i += d; if (n.fields[i]) { s.focus = i; return true } const fs = focusables(), k = fs.findIndex(x => x.node.id === n.id), to = fs[k + d]; if (to) { focusId = to.node.id; return true } return true }
    if (s.picker) {
      const opts2 = f.options
      const step = d => { let i = s.picker.idx + d; while (opts2[i]?.disabled) i += d; if (opts2[i]) s.picker.idx = i }
      if (name === 'up') step(-1); else if (name === 'down') step(1)
      else if (name === 'space' && f.kind === 'multiselect') { const id = opts2[s.picker.idx].id; s.picker.set.has(id) ? s.picker.set.delete(id) : s.picker.set.add(id) }
      else if (name === 'enter' || name === 'tab') { setVal(c, s, f, f.kind === 'multiselect' ? opts2.filter(o => s.picker.set.has(o.id)).map(o => o.id) : opts2[s.picker.idx].id); s.picker = null; if (name === 'tab') return false }
      else if (name === 'esc') s.picker = null
      return true
    }
    if (s.editing === f.id) {
      const finish = () => { if (f.kind === 'number') setVal(c, s, f, clampNum(f, v)); s.editing = null }
      if (name === 'enter') { finish(); if (n.enterSubmits) submitForm(c); else move(1); return true }
      if (name === 'esc') { finish(); return true }
      if (name === 'backspace') { setVal(c, s, f, f.kind === 'number' ? Number(String(v).slice(0, -1)) || 0 : String(v).slice(0, -1)); return true }
      if (name === 'alt+enter' && f.kind === 'textarea') { setVal(c, s, f, v + '\n'); return true }
      if (name === 'tab') { const hit = f.suggestions?.find(x => x.startsWith(v)); if (hit) { setVal(c, s, f, hit); return true } finish(); return false }
      if (printable(raw)) { if (f.kind === 'number') { if (/\d/.test(raw)) setVal(c, s, f, Number(String(v) + raw)) } else setVal(c, s, f, v + raw); return true }
      return true
    }
    switch (name) {
      case 'up': return move(-1)
      case 'down': return move(1)
      case 'delete': if (isEdited(n, f, s)) { setVal(c, s, f, f.resetValue ?? f.value); delete s.values[f.id]; return true } return false
      case 'enter':
        if (f.disabled) { rt.say(f.disabledReason ?? 'Unavailable', 'warning'); return true }
        if (FIELD_TEXT.includes(f.kind)) { s.editing = f.id; return true }
        if (n.enterSubmits && !FIELD_TEXT.includes(f.kind)) { submitForm(c); return true }
        if (f.kind === 'toggle') { setVal(c, s, f, !v); return true }
        if (f.kind === 'select') { s.picker = { idx: Math.max(0, f.options.findIndex(o => o.id === v)), set: new Set() }; return true }
        if (f.kind === 'multiselect') { s.picker = { idx: 0, set: new Set(v) }; return true }
        return true
      case 'space':
        if (f.kind === 'select' && n.enterSubmits) { s.picker = { idx: Math.max(0, f.options.findIndex(o => o.id === v)), set: new Set() }; return true }
        if (f.kind === 'toggle') { setVal(c, s, f, !v); return true }
        if (f.kind === 'multiselect') { s.picker = { idx: 0, set: new Set(v) }; return true }
        return false
      case 'left': case 'right': {
        const d = name === 'right' ? 1 : -1
        // a control that cannot step further does not use the key, so ← falls out to the rail (§4.5)
        if (f.kind === 'select') { const E = f.options.filter(o => !o.disabled).map(o => o.id), at = E.indexOf(v), to = E[Math.max(0, Math.min(E.length - 1, at < 0 ? (d > 0 ? 0 : E.length - 1) : at + d))]; if (to === v) return false; setVal(c, s, f, to); return true }
        if (f.kind === 'number') { const to = clampNum(f, (v ?? 0) + d * (f.step ?? 1)); if (to === v) return false; setVal(c, s, f, to); return true }
        return false
      }
      default: break
    }
    if (printable(raw) && FIELD_TEXT.includes(f.kind) && !f.disabled) {
      s.editing = f.id
      if (f.kind === 'number') { if (/\d/.test(raw)) setVal(c, s, f, Number(raw)) } else setVal(c, s, f, (f.kind === 'secret' ? '' : v) + raw)
      return true
    }
    return false
  }
  const submitForm = c => {
    const n = c.node, s = store.get(n.id)
    const errors = {}
    n.fields.forEach(f => { const e = fieldError(n, { ...f, }, { ...s, editing: f.id }); if (f.required && (formValue(n, f, s) === '' || formValue(n, f, s) == null)) errors[f.id] = 'Required' })
    if (Object.keys(errors).length) { s.errors = errors; rt.say('Fix the highlighted fields', 'warning'); return }
    s.errors = {}
    const values = Object.fromEntries(n.fields.map(f => [f.id, formValue(n, f, s)]))
    emit({ kind: 'submit', controlId: n.id, actionId: n.enterSubmits, values })
  }

  // ---- prompt
  const promptKey = (c, name, raw) => {
    const n = c.node, s = store.get(n.id), items = n.completions?.items ?? []
    const changed = () => emit({ kind: 'value-change', controlId: n.id, value: s.text })
    if (items.length) {
      if (name === 'up') { s.cIdx = Math.max(0, (s.cIdx ?? 0) - 1); return true }
      if (name === 'down') { s.cIdx = Math.min(items.length - 1, (s.cIdx ?? 0) + 1); return true }
      if (name === 'tab' || name === 'enter') { emit({ kind: 'completion-accept', controlId: n.id, itemId: items[Math.min(s.cIdx ?? 0, items.length - 1)].id }); s.cIdx = 0; return true }
      if (name === 'esc') { emit({ kind: 'completion-dismiss', controlId: n.id }); return true }
    }
    if (name === 'enter') { if (s.text.trim() === '' && !(n.tokens ?? []).length) return true; emit({ kind: 'submit', controlId: n.id, value: s.text, tokens: n.tokens ?? [] }); s.text = ''; s.recallIdx = null; s.selectedToken = null; return true }
    if (name === 'alt+enter') { s.text += '\n'; changed(); return true }
    if (name === 'backspace') {
      const tokens = n.tokens ?? []
      if (s.text === '' && tokens.length) {
        // the first Backspace selects the last token, the second removes it
        if (s.selectedToken == null || s.selectedToken >= tokens.length) s.selectedToken = tokens.length - 1
        else { const tk = tokens[s.selectedToken]; s.selectedToken = null; emit({ kind: 'token-remove', controlId: n.id, tokenId: tk.id }) }
        return true
      }
      s.text = s.text.slice(0, -1); s.selectedToken = null; s.recallIdx = null; changed(); return true
    }
    if ((name === 'up' || name === 'down') && n.recall?.length && (s.text === '' || s.recallIdx != null)) {
      const last = n.recall.length - 1
      if (name === 'up') { if (s.recallIdx == null) { s.draft = s.text; s.recallIdx = 0 } else s.recallIdx = Math.min(last, s.recallIdx + 1) }
      else { if (s.recallIdx == null) return false; if (s.recallIdx === 0) { s.recallIdx = null; s.text = s.draft ?? ''; emit({ kind: 'recall-change', controlId: n.id, source: 'draft', index: -1 }); return true } s.recallIdx -= 1 }
      s.text = n.recall[s.recallIdx].text; emit({ kind: 'recall-change', controlId: n.id, source: n.recall[s.recallIdx].kind, index: s.recallIdx }); return true
    }
    if (printable(raw)) { s.text += raw; s.selectedToken = null; s.recallIdx = null; s.cIdx = 0; changed(); return true }
    return false
  }

  // ---- actions and accelerators
  const navItems = n => n.items.map((it, i) => ({ it, i })).filter(x => !x.it.hidden && !x.it.busy)
  const runAction = (c, it) => {
    const n = c.node
    const blocked = unavailable()[it.id]
    if (it.disabled || blocked) { rt.say(blocked ?? it.disabledReason ?? 'Unavailable', 'warning'); return }
    const go = () => {
      if (it.submit) { const f = controls.find(x => x.kind === 'form'); if (f) { submitForm(f); if (Object.keys(store.get(f.node.id).errors).length) return } }
      const forms = Object.fromEntries(controls.filter(x => x.kind === 'form').map(x => [x.node.id, Object.fromEntries(x.node.fields.map(f => [f.id, formValue(x.node, f, store.get(x.node.id))]))]))
      const selected = Object.fromEntries(controls.filter(x => x.kind === 'list').map(x => { const s = store.get(x.node.id), rows = listItemRows(x.node, s); return [x.node.id, (rows.find(r => r.item.id === s.cursor) ?? rows.find(r => !r.item.disabled))?.item.id] }))
      emit({ kind: 'activate', controlId: n.id, actionId: it.id, inputs: forms, selected })
      if (it.dismiss) closed = true
    }
    if (it.confirm) askYesNo(it.confirm, go); else go()
  }
  const actionsKey = (c, name) => {
    const n = c.node, s = store.get(n.id), items = navItems(n)
    const pos = Math.max(0, items.findIndex(x => x.i === s.focus))
    if (name === 'left') { if (items[pos - 1]) s.focus = items[pos - 1].i; return true }
    if (name === 'right') { if (items[pos + 1]) s.focus = items[pos + 1].i; return true }
    if (name === 'enter' || name === 'space') { const x = items[pos]; if (x) runAction(c, x.it); return true }
    if (name === 'up' || name === 'down') { const f = focusables(), i = f.findIndex(x => x.node.id === n.id), to = f[i + (name === 'down' ? 1 : -1)]; if (to) { focusId = to.node.id; return true } }
    return false
  }
  /** An actions control with `scope` (a control id or ids) only acts, and only shows its hints, while one of them has focus. */
  const inScope = x => !x.node.scope || [].concat(x.node.scope).includes(focusId)
  const accelerator = (name, raw) => {
    for (const c of controls.filter(x => x.kind === 'actions' && inScope(x))) {
      const it = c.node.items.find(i => { const k = effKey(i); return k && (k === name || k === raw) })
      if (it) { runAction(c, it); return true }
    }
    return false
  }

  // ---- tabs, scroll
  const tabsSwitch = (c, d) => {
    const n = c.node, items = n.items.filter(i => !i.disabled), at = items.findIndex(i => i.id === n.activeId), to = items[at + d]
    if (!to) return true
    if (n.mode === 'wizard' && d > 0) {
      const f = controls.find(x => x.kind === 'form'), fs = f && store.get(f.node.id)
      const missing = f ? f.node.fields.filter(x => x.required && (formValue(f.node, x, fs) === '' || formValue(f.node, x, fs) == null)) : []
      if (missing.length) { fs.errors = Object.fromEntries(missing.map(x => [x.id, 'Required'])); rt.say(`Step "${items[at].label}" is incomplete`, 'warning'); return true }
    }
    emit({ kind: 'tab-change', controlId: n.id, tabId: to.id })
    return true
  }
  const scrollKey = (c, name) => {
    const s = store.get(c.node.id), H = s.expanded ? (c.node.expandedHeight ?? 14) : (c.node.height ?? 6)
    const lines = 1e9
    if (name === 'ctrl+e') { s.expanded = !s.expanded; return true }
    if (name === 'esc' && s.expanded) { s.expanded = false; return true }
    if (name === 'up') { s.follow = false; s.top = Math.max(0, (s.top ?? 0) - 1); return true }
    if (name === 'down') { s.top = (s.top ?? 0) + 1; return true }
    if (name === 'pgup') { s.follow = false; s.top = Math.max(0, (s.top ?? 0) - H + 1); return true }
    if (name === 'pgdn') { s.top = (s.top ?? 0) + H - 1; return true }
    if (name === 'end') { s.follow = true; return true }
    if (name === 'home') { s.follow = false; s.top = 0; return true }
    return false
  }

  // ---- dirty and dismissal
  const dirty = () => controls.some(c => c.kind === 'form' && c.node.fields.some(f => isEdited(c.node, f, store.get(c.node.id))))
  const dismiss = () => {
    const sf = surfaceNode()
    if (dirty() && sf?.dismissal !== 'discard') { askYesNo({ title: 'Discard unsaved changes?' }, () => { emit({ kind: 'dismiss' }); closed = true }); return true }
    const reply = emit({ kind: 'dismiss' })
    if (!opts.onEvent || !reply || reply.kind !== 'cancelled') closed = true
    return true
  }

  // ---- hint row: computed from the same bindings
  const hintFragments = width => {
    if (decision) return [T(kpair('ui.left', 'ui.right'), 'No/Yes', 90, 1), T(kd('ui.accept'), 'confirm', 100, 2), T(kd('ui.cancel'), 'answers No', 120, 9)]
    const c = cur(), sf = surfaceNode()
    const frags = []
    const atHome = !c || homeControl()?.node.id === c.node.id
    const esc = (label = atHome ? (sf?.escapeLabel ?? 'close') : 'back') => T(kd('ui.cancel'), label, 120, 9)
    const groups = focusables().length > 1
    const tabsCtl = controls.find(x => x.kind === 'tabs')
    const tabsHint = tabsCtl && tabsCtl.node.items.length > 1 && tabsCtl.node.id !== focusId ? [T(kpair('ui.tab-prev', 'ui.tab-next'), tabsCtl.node.hintLabel ?? 'tabs', 85, 7)] : []
    const un = unavailable()
    const accelHints = [...controls.filter(x => x.kind === 'actions' && inScope(x)).flatMap(x => x.node.items.filter(i => effKey(i) && !i.disabled && !un[i.id] && i.showHint !== false && !(c?.kind === 'prompt' && isPrintableKey(effKey(i)))).map(i => T(showKey(effKey(i)), i.hintLabel ?? i.label.toLowerCase(), 96, 5))), ...tabsHint]
    const railBack = c && c.kind !== 'tabs' && focusables().some(x => x.kind === 'tabs' && x.node.orientation === 'vertical')
    if (!c) return [esc()]
    const s = store.get(c.node.id)
    if (c.kind === 'list') {
      const n = c.node, rows = listItemRows(n, s), row = rows.find(r => r.item.id === s.cursor) ?? rows.find(r => !r.item.disabled)
      if (s.searching) return [T(kd('ui.accept'), n.role === 'browse' && !n.acceptVerb ? 'open' : (n.acceptVerb ?? 'choose'), 100, 4), T(kd('ui.clear'), 'clear', 85, 6), esc('end search')]
      if (!row?.item.segment) frags.push(T(kpair('ui.up', 'ui.down'), 'options', 90, 1))
      if (n.numbered) frags.push(T(rows.length === 1 ? '1' : `1-${rows.length}`, n.numbered === true ? 'choose' : 'focus', 88, 3))
      if (row?.item.segment) { frags.push(T(kpair('ui.left', 'ui.right'), (row.item.segment.label ?? 'adjust').toLowerCase(), 95, 2)); const ss = segState(row.item, s); if (ss.pinned != null && ss.seg.inheritedId != null) frags.push(T(kd('ui.reset'), 'use default', 96, 5)) }
      else if (row?.expandable) frags.push(T(kpair('ui.left', 'ui.right'), 'branch', 95, 2))
      else if (railBack) frags.push(T(kd('ui.left'), 'labels', 94, 2))
      else if (controls.some(x => x.kind === 'tabs' && x.node.orientation !== 'vertical')) frags.push(T(kpair('ui.left', 'ui.right'), controls.find(x => x.kind === 'tabs').node.hintLabel ?? 'tabs', 95, 2))
      if (n.mode === 'multiple') frags.push(T(kd('ui.toggle'), 'toggle', 95, 2))
      const verb = row?.expandable ? 'branch' : n.mode === 'multiple' && n.tree ? 'toggle' : (n.acceptVerb ?? (n.role === 'browse' ? 'open' : 'choose'))
      if (!(row?.expandable && n.tree && false)) frags.push(T(kd('ui.accept'), n.role === 'browse' && !n.acceptVerb && row?.item.segment ? 'choose' : verb, 100, 4))
      if (n.filterable) frags.push(n.filterMode === 'slash' ? T(kd('ui.filter'), 'filter', 100, 6) : T('Type', 'filter', 100, 6))
      frags.push(...accelHints)
      if (s.query) frags.push(T(kd('ui.clear'), 'clear', 85, 6))
      if (groups) frags.push(T(kpair('ui.next-group', 'ui.prev-group'), 'groups', 80, 8))
      frags.push(esc())
    } else if (c.kind === 'form') {
      const n = c.node, f = n.fields[Math.min(s.focus, n.fields.length - 1)]
      if (s.picker) return [T(kpair('ui.up', 'ui.down'), 'options', 90, 1), ...(f.kind === 'multiselect' ? [T(kd('ui.toggle'), 'toggle', 95, 2)] : []), T(kd('ui.accept'), 'apply', 100, 4), esc('cancel')]
      if (s.editing === f.id) return [T(kd('ui.accept'), n.submitLabel ?? (n.enterSubmits ? 'submit' : 'next'), 100, 4), ...(f.kind === 'textarea' ? [T(kd('ui.newline'), 'newline', 95, 5)] : []), ...(f.suggestions ? [T(kd('ui.next-group'), 'complete', 95, 5)] : []), ...(groups && !f.suggestions ? [T(kpair('ui.next-group', 'ui.prev-group'), 'groups', 80, 8)] : []), esc('done')]
      frags.push(T(kpair('ui.up', 'ui.down'), 'fields', 90, 1))
      if (f.kind === 'select') frags.push(T(kpair('ui.left', 'ui.right'), 'adjust', 95, 2))
      else if (f.kind === 'number') frags.push(T(kpair('ui.left', 'ui.right'), 'step', 95, 2))
      frags.push(T(kd('ui.accept'), n.submitLabel ?? (n.enterSubmits ? (['input', 'secret', 'textarea', 'number'].includes(f.kind) ? 'submit' : 'continue') : f.kind === 'select' || f.kind === 'multiselect' ? 'pick' : f.kind === 'toggle' ? 'toggle' : 'edit'), 100, 4))
      if (isEdited(n, f, s)) frags.push(T(kd('ui.reset'), f.origin === 'inherited' ? 'use inherited' : 'reset', 96, 5))
      if (railBack && !f.options) frags.push(T(kd('ui.left'), 'labels', 94, 2))
      frags.push(...accelHints)
      if (groups) frags.push(T(kpair('ui.next-group', 'ui.prev-group'), 'groups', 80, 8))
      frags.push(esc())
    } else if (c.kind === 'actions') {
      frags.push(T(kpair('ui.left', 'ui.right'), 'actions', 90, 1), T(kd('ui.accept'), 'run', 100, 4), ...accelHints)
      if (groups) frags.push(T(kpair('ui.next-group', 'ui.prev-group'), 'groups', 80, 8))
      frags.push(esc())
    } else if (c.kind === 'tabs') {
      frags.push(c.node.orientation === 'vertical' ? T(kpair('ui.up', 'ui.down'), 'labels', 90, 1) : T(kpair('ui.left', 'ui.right'), 'tabs', 90, 1), T(c.node.orientation === 'vertical' ? kd('ui.right') : kd('ui.accept'), 'open', 100, 4), ...accelHints, esc(c.node.mode === 'wizard' ? 'back' : undefined))
    } else if (c.kind === 'prompt') {
      const n = c.node, items = n.completions?.items ?? []
      if (items.length) return [T(kpair('ui.up', 'ui.down'), 'options', 90, 1), T(kd('ui.next-group'), 'complete', 100, 4), T(kd('ui.accept'), 'insert', 98, 5), esc('close')]
      const f = focusables(), i = f.findIndex(x => x.node.id === c.node.id), prev = f[i - 1]
      frags.push(T(kd('ui.accept'), n.submitLabel ?? 'send', 100, 4), T(kd('ui.newline'), 'newline', 88, 6))
      if (n.recall?.length) frags.push(T(kpair('ui.up', 'ui.down'), n.recallLabel ?? 'history', 92, 1))
      if (prev) frags.push(T(kd('ui.focus-prev'), prev.node.hintLabel ?? 'select', 94, 2))
      frags.push(...accelHints)
    } else if (c.kind === 'scroll') {
      frags.push(T(kpair('ui.up', 'ui.down'), 'scroll', 90, 1), T(kd('ui.expand'), store.get(c.node.id).expanded ? 'collapse' : 'expand', 95, 5), esc(store.get(c.node.id).expanded ? 'collapse' : undefined))
    }
    // admission: three below 80 columns, four from 80; Escape always survives and always trails
    const limit = width >= 80 ? 4 : 3
    const keep = [...frags].sort((a, b) => b.priority - a.priority).slice(0, limit)
    return keep.sort((a, b) => a.order - b.order)
  }
  const hintLine = width => hintFragments(width).map(f => `${paint(f.keys, 'default')} ${paint(f.label, 'muted')}`).join(paint(' · ', 'muted'))

  // ---- key entry
  const keyInner = raw => {
    refresh()
    const physical = keyName(raw)
    const c0 = cur(), s0 = c0 && store.get(c0.node.id)
    const typing = !!(c0 && ((c0.kind === 'form' && (s0.editing || s0.picker)) || (c0.kind === 'list' && s0.searching) || (c0.kind === 'prompt')))
    // navigation keys go through the keymap; while typing, printable characters stay text
    const name = typing && physical.length === 1 ? physical : keymap.canon(physical)
    if (name.startsWith('unbound:')) return false
    if (decision) {
      if (name === 'left' || name === 'right') decision.yes = !decision.yes
      else if (name === 'y') { const d = decision; decision = null; d.onYes?.() }
      else if (name === 'n' || name === 'esc') decision = null
      else if (name === 'enter') { const d = decision; decision = null; if (d.yes) d.onYes?.() }
      return true
    }
    const c = cur()
    const textMode = c && ((c.kind === 'form' && (store.get(c.node.id).editing || store.get(c.node.id).picker)) || (c.kind === 'list' && store.get(c.node.id).searching) || c.kind === 'prompt')
    if (c && !textMode) { /* modal-free first: accelerators below */ }
    if (c) {
      const s = store.get(c.node.id)
      if (c.kind === 'form' && (s.editing || s.picker)) { const handled = formKey(c, name, raw); if (handled || name !== 'tab') return handled }
      if (c.kind === 'list' && s.searching) { if (listKey(c, name, raw)) return true }
      if (c.kind === 'prompt') { if (promptKey(c, name, raw)) return true }
    }
    // the common save action: a form saves by default; any action may claim the key by declaring `semantic: 'save'`
    if (keymap.keys('ui.save').includes(physical)) { if (accelerator(physical, raw)) return true; const fm = controls.find(x => x.kind === 'form'); if (fm) { submitForm(fm); return true } }
    if ((!textMode || physical.length > 1) && (name.startsWith('ctrl+') || name.startsWith('alt+') || (!textMode && isPrintableKey(name)))) { if (!['alt+left', 'alt+right', 'alt+up', 'alt+down', 'alt+enter', 'ctrl+u', 'ctrl+e'].includes(name) && accelerator(physical, raw)) return true }
    if (name === 'alt+left' || name === 'alt+right') { const t = controls.find(x => x.kind === 'tabs'); if (t) return tabsSwitch(t, name === 'alt+right' ? 1 : -1) }
    if (name === 'alt+up' || name === 'alt+down') { const f = focusables(), i = f.findIndex(x => x.node.id === focusId), to = f[i + (name === 'alt+down' ? 1 : -1)]; if (to) { focusId = to.node.id; return true } return false }
    if (c && c.kind === 'tabs' && c.node.orientation === 'vertical' && (name === 'up' || name === 'down')) return tabsSwitch(c, name === 'down' ? 1 : -1)
    if (c && c.kind === 'tabs' && c.node.orientation === 'vertical' && (name === 'right' || name === 'enter')) { const f = focusables(), i = f.findIndex(x => x.node.id === c.node.id); if (f[i + 1]) { focusId = f[i + 1].node.id; return true } }
    if (c) {
      const handled = c.kind === 'list' ? listKey(c, name, raw) : c.kind === 'form' ? formKey(c, name, raw) : c.kind === 'actions' ? actionsKey(c, name) : c.kind === 'tabs' ? (name === 'left' && c.node.orientation === 'vertical' ? true : name === 'left' || name === 'right' ? tabsSwitch(c, name === 'right' ? 1 : -1) : name === 'enter' || name === 'down' ? (() => { const f = focusables(), i = f.findIndex(x => x.node.id === c.node.id); if (f[i + 1]) focusId = f[i + 1].node.id; return true })() : false) : c.kind === 'scroll' ? scrollKey(c, name) : false
      if (handled) return true
      // Left leaves one level, innermost first: the focused control adjusts (a value, a collapsed row, a cursor), and only a
      // Left it does not consume moves focus out to the rail of its surface, wherever the rail sits in the focus order.
      if (name === 'left') { const rail = focusables().find(x => x.kind === 'tabs' && x.node.orientation === 'vertical' && x.node.id !== c.node.id); if (rail) { focusId = rail.node.id; return true } }
      // a list, form, or scroll with nothing to adjust lets ←/→ drive the tab strip or wizard of its surface
      if ((name === 'left' || name === 'right') && (c.kind === 'list' || c.kind === 'form' || c.kind === 'scroll')) { const tb = controls.find(x => x.kind === 'tabs' && x.node.orientation !== 'vertical'); if (tb) return tabsSwitch(tb, name === 'right' ? 1 : -1) }
    }
    if (name === 'tab' || name === 'shift+tab') { const f = focusables(), i = f.findIndex(x => x.node.id === focusId); const to = f[(i + (name === 'tab' ? 1 : -1) + f.length) % f.length]; if (to) { focusId = to.node.id; return true } }
    if (name === 'esc') {
      // Escape leaves one layer: from any control other than the home control it returns to the home control first
      const home = homeControl()
      if (c && home && c.node.id !== home.node.id) { focusId = home.node.id; return true }
      return dismiss()
    }
    return false
  }
  /** Handle one key; reports `focus-change` when focus moved to another control. */
  rt.key = raw => {
    const before = focusId
    const handled = keyInner(raw)
    if (focusId !== before) emit({ kind: 'focus-change', controlId: focusId, from: before })
    return handled
  }
  rt.render = (width, extra = {}) => {
    const tree = refresh(width)
    const sf = surfaceNode()
    const decisionLines = decision ? (() => { const d = decision; const lines = [paint(d.confirm.title, 'default', ['strong'])]; if (d.confirm.detail) lines.push(paint(d.confirm.detail, 'warning')); lines.push(`${d.yes ? '  ' + paint('[No]', 'muted') : paint('→ ', 'primary') + inverse(' No ')}   ${d.yes ? paint('→ ', 'primary') + inverse(' Yes ') : paint('[Yes]', 'muted')}`); return lines })() : null
    const out = render(tree, {
      width, frame: 0, t: 0, ...extra, state: get, focusId, unavailable: unavailable(), hintOwner: sf, hintLine: sf ? hintLine(width) : null, hintCompletions: !!(cur()?.kind === 'prompt' && cur().node.completions?.items?.length), decisionLines,
      viewport: extra.viewport ?? { width, height: 40 },
    })
    // No surface owns the focused control: the hint row trails the whole tree.
    if (!sf && focusId) out.push(paint('  ', 'muted') + hintLine(width))
    return out
  }
  rt.capturing = () => { const c = cur(); if (!c) return false; const s = store.get(c.node.id); return (c.kind === 'form' && !!(s.editing || s.picker)) || (c.kind === 'list' && !!s.searching) || c.kind === 'prompt' || !!decision }
  rt.hint = width => { refresh(width); return hintLine(width) }
  rt.refresh = refresh
  rt.dirty = dirty
  return rt
}

// ======================================================================= patterns (public recipes)
/**
 * Patterns are compositions of the primitives above that plugins and Mayfly core both reuse. They have no
 * renderer of their own: each returns a node tree built only from `ui.*`.
 */
export const patterns = {
  /** A decision: header, preview, a numbered choice list, an optional same-line input, hidden accelerators. */
  decisionPanel: defineComponent('kit.decisionPanel', 'pattern', ({ id = 'decision', title, badges, preview = [], options, input, instant = false, accelerators = [], escapeLabel = 'reject', dismissal, chrome = 'overlay' }) =>
    ui.surface({
      title, chrome, badges, escapeLabel, dismissal, child: ui.stack.column([
        ...preview,
        ui.list({ id: `${id}.options`, autofocus: true, role: 'choose', numbered: instant ? true : 'focus', items: options }),
        input && ui.form({ id: `${id}.input`, fields: [{ id: input.id, kind: 'input', label: input.label, value: '', placeholder: input.placeholder }] }),
        accelerators.length ? ui.actions({ id: `${id}.keys`, items: accelerators.map(a => ({ ...a, hidden: true })) }) : null,
      ]),
    })),
  /** A rail of labels on the left and live content on the right (sessions, settings). */
  railPanel: defineComponent('kit.railPanel', 'pattern', ({ title, badges, rail, content, railWidth = 26, escapeLabel }) =>
    ui.surface({
      title, badges, chrome: 'overlay', escapeLabel, child: ui.stack.row([
        ui.child(ui.tabs({ id: rail.id, orientation: 'vertical', items: rail.items, activeId: rail.activeId }), { basis: railWidth }),
        ui.child(content, { grow: 1 }),
      ], { gap: 2 }),
    })),
  /** A list and a live detail side by side from `breakpoint` columns, the list alone below it. */
  splitView: defineComponent('kit.splitView', 'pattern', ({ list, detail, listWidth = 58, breakpoint = 100 }) =>
    ui.stack.row([
      ui.child(list, { basis: listWidth, when: { minWidth: breakpoint } }),
      ui.child(detail, { grow: 1, when: { minWidth: breakpoint } }),
      ui.child(list, { grow: 1, when: { maxWidth: breakpoint - 1 } }),
    ], { gap: 2 })),
  /** A key/value read-only page under a tab strip. */
  statusPage: defineComponent('kit.statusPage', 'pattern', ({ title, badges, tabs: t, rows, body, footer }) =>
    ui.surface({ title, badges, chrome: 'overlay', child: ui.stack.column([ui.tabs(t), ui.spacer(), body ?? ui.fields(rows)]), footer })),
}
