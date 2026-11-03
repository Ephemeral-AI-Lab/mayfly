#!/usr/bin/env node
/**
 * Terminal prototype of the Mayfly UI design (docs/design/component-library.md).
 *
 * Three modules, two layers:
 *
 *   ui-kit.mjs             the basic components: `ui.*` builders, one renderer, one key engine, patterns
 *   mayfly-components.mjs  Mayfly's own components (status bar, editor, panes, transcript, panels), built
 *                          only from the kit, exactly as a downstream plugin would build them
 *   ui-preview.mjs         this file: the scene runner and the scenes
 *
 *   node docs/design/prototypes/ui-preview.mjs [scene number or name]
 *   node docs/design/prototypes/ui-preview.mjs --list     print the scene index
 *   node docs/design/prototypes/ui-preview.mjs --smoke    render every scene, feed it keys, exit 1 on an error or a misaligned box
 *   node docs/design/prototypes/ui-preview.mjs --audit    prove the layering and print which basic components each Mayfly component uses
 *   node docs/design/prototypes/ui-preview.mjs --keys     print the raw bytes of each key you press and how they decode
 *   node docs/design/prototypes/ui-preview.mjs --no-alt   show the non-Alt key first in every hint (a terminal or multiplexer that eats Alt)
 *
 *   ] or Tab next scene · [ or Shift+Tab previous · } { next/previous layer · q or Ctrl+C quit
 *   Ctrl+Left / Ctrl+Right (or Ctrl+] / Ctrl+\) change scene while a text field has the keyboard; Esc also hands ] [ back.
 *   Ctrl+Up / Ctrl+Down scroll a scene taller than the terminal. Pages inside a scene use Ctrl+N / Ctrl+P.
 *   Alt keys have plain alternatives (F2-F5, Ctrl+J), see spec §3.5.
 *
 * It draws its own colors and does not use the Mayfly renderer, so it shows the design, not shipped rendering.
 *
 * @module docs/design/prototypes/ui-preview
 */

import fs from 'node:fs'
import { ui, patterns, mount, render, theme, paint, strip, cells, pad, clip, wrap, usage, fmtDur, keyName, splitKeys, keymap, showKey, TONE_NAMES, FRAMES, defineComponent } from './ui-kit.mjs'
import * as MC from './mayfly-components.mjs'

const S = (text, tone, styles) => ({ text, ...(tone ? { tone } : {}), ...(styles ? { styles } : {}) })
const mu = text => S(text, 'muted')
const caption = text => ui.text(text, { tone: 'muted' })

// ======================================================================= scene registry
const scenes = []
const scene = def => scenes.push({ keys: '', ...def })
/** Draw a node tree with the scene's clocks. */
const draw = (node, c, extra = {}) => render(node, { width: c.width, frame: c.f, t: c.t, ...extra })
/** Mount a tree with its own runtime; returns the pieces a scene needs. */
const interactive = (build, onEvent) => mount(build, { onEvent })
const printable = k => k.length === 1 && k >= ' ' && k !== '\x7f'
const WIDE = 100

// ======================================================================= shared sample facts
const FACTS = { model: 'deepseek-chat', effort: 'High', cwd: '~/work/mayfly', git: 'main ±3', cache: 34, context: 18, tokens: '22.9k/128k' }
const EDIT_BEFORE = ["  const moon = state.mode === 'waiting'", '  const frame = moon', '  const now = activityNow()', '  const a = 1', '  const b = 2', '  const c = 3', '  const d = 4', "  return { kind: 'stack', direction: 'column',"].join('\n')
const EDIT_AFTER = ["  const moon = state.mode === 'waiting'", '  const frame = glyphFor(state)', '  const now = activityNow()', '  const a = 1', '  const b = 2', '  const c = 3', '  const d = 4', "  return { kind: 'stack', direction: 'column',"].join('\n')

// ======================================================================= scene helpers
const NEXT = '\x0e', PREV = '\x10'
/** A scene whose body is one mounted component tree: the kit's key engine drives it. */
const rtScene = def => scene({
  ...def,
  init() { this.s = def.state?.call(this) ?? {}; this.rt = interactive(rt => def.build.call(this, rt, this.s), (e, rt) => def.onEvent?.call(this, e, rt, this.s)); def.init?.call(this, this.s) },
  lines(c) { const w = typeof def.width === 'function' ? def.width.call(this, c, this.s) : def.width ?? c.width; return [...(def.before?.call(this, c, this.s) ?? []), ...this.rt.render(w, { frame: c.f, t: c.t }), ...(def.after?.call(this, c, this.s) ?? [])] },
  key(k) { if (def.pages && (k === NEXT || k === PREV)) { this.s.page = (this.s.page + (k === NEXT ? 1 : def.pages - 1)) % def.pages; this.rt.reset(); return } if (def.key?.call(this, k, this.s) === true) return; this.rt.key(k) },
  capture() { return def.capturing?.call(this, this.s) || this.rt.capturing() },
})
/** A scene of static pages. */
const pagesScene = def => scene({
  ...def, keys: `Ctrl+N/Ctrl+P next/previous page${def.keys ? ' · ' + def.keys : ''}`,
  init() { this.p = 0; def.init?.call(this) },
  lines(c) { const pg = def.pages.call(this, c); const [title, body] = pg[this.p]; return [...draw(caption(`page ${this.p + 1}/${pg.length} (Ctrl+N): ${title}`), c), '', ...(typeof body === 'function' ? body.call(this, c) : draw(body, c))] },
  key(k) { const n = def.count; if (k === NEXT) this.p = (this.p + 1) % n; else if (k === PREV) this.p = (this.p + n - 1) % n; else def.key?.call(this, k) },
})
const col = (...children) => ui.stack.column(children)
const row = (children, o) => ui.stack.row(children.map(x => (x.node ? x : ui.child(x))), o)
const rule = label => ui.divider(label)

// ======================================================================= BASIC: marks and tokens
pagesScene({
  layer: 'basic', name: 'Marks and tokens', section: '§2', count: 6, width: WIDE,
  pages() {
    const state = (cursor, extra = {}) => id => ({ cursor, ...extra })
    return [
      ['selection and focus: → the cursor, ▌ the persistent selection, ▸ ▾ disclosure, ● ○ ◐ checks, [current], — reason', c => [
        ...draw(caption('→ a cursor in a choose list (the row Enter acts on)'), c),
        ...draw(ui.list({ id: 'm1', role: 'choose', items: [{ id: 'a', label: 'Default', badge: 'current' }, { id: 'b', label: 'Accept edits' }, { id: 'c', label: 'Full access', disabled: true, disabledReason: 'managed by policy' }] }), c, { focusId: 'm1', state: state('a') }), '',
        ...draw(caption('▌ the persistent selection in a rail; inverse only while the rail has focus'), c),
        ...draw(ui.list({ id: 'm2', role: 'browse', marker: 'selection', items: [{ id: 'a', label: 'General' }, { id: 'b', label: 'Model' }, { id: 'c', label: 'Permissions', right: '2' }] }), c, { focusId: 'm2', state: state('b') }),
        ...draw(ui.list({ id: 'm2b', role: 'browse', marker: 'selection', items: [{ id: 'a', label: 'General' }, { id: 'b', label: 'Model' }] }), c, { state: state('b') }), '',
        ...draw(caption('▸ ▾ disclosure and ● ○ ◐ checks (single: ●/○, multiple: ●/○, a partly selected parent ◐)'), c),
        ...draw(ui.list({ id: 'm3', role: 'choose', mode: 'multiple', tree: true, items: [{ id: 'p', label: 'filesystem', expanded: true }, { id: 'p1', label: 'read_file', parentId: 'p' }, { id: 'p2', label: 'write_file', parentId: 'p' }, { id: 'q', label: 'github' }], selectedIds: ['p1'] }), c, { state: id => ({ cursor: 'p', expanded: new Set(['p']), selected: new Set(['p1']), seg: {} }) }), '',
        ...draw(caption('‹ v › a value ←/→ changes · • an edited field · (inherited) · ! an error'), c),
        ...draw(ui.form({ id: 'm4', fields: [{ id: 'm', kind: 'select', label: 'Model', value: 'deepseek-chat', origin: 'inherited', options: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }, { id: 't', kind: 'number', label: 'Timeout', value: 45, resetValue: 30, unit: 's', min: 5, max: 120 }, { id: 'n', kind: 'input', label: 'Name', value: '', required: true, error: 'Required' }] }), c, { focusId: 'm4', state: () => ({ focus: 0 }) }),
      ]],
      ['state and progress glyphs (one glyph, one meaning)', col(...[
        ['●', 'primary', 'assistant block; a tool or step running'], ['»', 'user', 'user block'], ['✻', 'primary', 'thinking'], ['✓', 'success', 'done'], ['✗', 'danger', 'failed'], ['⊘', 'muted', 'cancelled'], ['◐', 'muted', 'declined (plan)'], ['■', 'danger', 'stopping or interrupted'], ['?', 'warning', 'waiting on the user'], ['⚠', 'warning', 'warning'], ['ℹ', 'primary', 'information'], ['✕', 'danger', 'goal blocked'], ['❚❚', 'muted', 'goal paused'], ['⎿', 'muted', 'detail connector'], ['⏵', 'primary', 'background jobs'], ['↻', 'warning', 'applies after a restart'], ['↗', 'accent', 'opens in the external editor'],
      ].map(([g, tone, what]) => ui.richText([S(g.padEnd(3), tone, ['strong']), S(what)])), ui.spacer(), ui.richText([S('▰▰▰▰▱▱ ', 'primary'), mu('determinate progress cells   '), S('━━━━───', 'primary'), mu('  heavy and light rule')]))],
      ['tones and styles (the whole palette; a monochrome terminal keeps weight and glyphs)', col(...TONE_NAMES.map(t => ui.richText([S(t.padEnd(9), t), S(t === 'danger' ? '✗ Plan copy failed' : t === 'success' ? '✓ Saved to clipboard' : t === 'warning' ? '⚠ permission picker is unavailable' : 'Sample text in this tone', t)])), ui.spacer(), ui.richText([S('strong', 'default', ['strong']), S('  '), S('italic', 'default', ['italic']), S('  '), S('struck', 'muted', ['strike'])]))],
      ['one answer for five states: every panel and every secondary read looks the same', col(
        ui.loader({ message: 'Loading sessions…' }), ui.richText([mu('empty      '), S('No plugins installed — press → to browse')]), ui.richText([S('✗ ', 'danger'), S('Could not reach the market'), mu('  r retry')]), ui.richText([S('⚠ ', 'warning'), S('offline · showing cached data from 2d ago')]), ui.richText([mu('— not supported by this provider')]), ui.spacer(), caption('a slow or failed secondary read (a balance, a catalog refresh) never blocks or alters the primary content'))],
      ['feedback severities: glyph plus word, never color alone', col(
        ui.richText([S('✓ ', 'success'), S('Installed Git Helper · restart Mayfly to apply'), mu('   5 s visible, then it goes')]), ui.richText([S('ℹ ', 'primary'), S('Resumed session · 24 turns'), mu('   5 s visible')]), ui.richText([S('⚠ ', 'warning'), S('Balance low · ¥ 6.20 left'), mu('   stays until acted on')]), ui.richText([S('✗ ', 'danger'), S('Sign-in failed — try again'), mu('   stays, offers its retry key')]), ui.spacer(), caption('inline in the footer of an open surface; a toast in the activity row gap otherwise'))],
      ['breakpoints: one list-and-detail panel at three widths', c => {
        const panel = patterns.splitView({ list: ui.list({ id: 'bp', role: 'browse', marker: 'selection', items: [{ id: 'a', label: 'Loop', detail: 'official · T W', right: '1.4.0' }, { id: 'b', label: 'Git Helper', detail: 'community · T W', right: 'update 1.3.0' }] }), detail: ui.fields([{ label: 'Loop', value: 'official · Automation' }, { label: 'Status', value: [S('✓ installed 1.4.0', 'success')] }]), listWidth: 50 })
        return [...draw(caption('≥ 100 columns: split view'), c), ...draw(panel, { ...c, width: 100 }), '', ...draw(caption('60–99 columns: one column, Enter opens the detail'), c), ...draw(panel, { ...c, width: 70 }), '', ...draw(caption('below 60: the name and one glyph (the list degrades; the detail opens on Enter)'), c), ...draw(ui.list({ id: 'bp2', role: 'browse', marker: 'selection', items: [{ id: 'a', label: 'Loop', right: [S('✓', 'success')] }, { id: 'b', label: 'Git Helper', right: [S('↑', 'warning')] }] }), { ...c, width: 40 })]
      }],
    ]
  },
})

// ======================================================================= BASIC: actions
rtScene({
  layer: 'basic', name: 'Actions', section: '§4.2', keys: 'w narrow · c copy (accelerator) · Ctrl+Y copy link (a key with no button)',
  state: () => ({ busyUntil: 0, narrow: false }),
  width: (c, s) => (s.narrow ? 46 : 78),
  build(rt, s) {
    const busy = Date.now() < s.busyUntil
    if (s.busyUntil && !busy) { s.busyUntil = 0; rt.say('Saved', 'success') }
    return ui.surface({
      title: 'Edit provider', chrome: 'overlay', child: ui.stack.column([
        ui.text('Name: production · Endpoint: https://api.example.com/v1', { tone: 'muted' }),
        ui.spacer(),
        ui.actions({
          id: 'bar', items: [
            { id: 'save', label: 'Save', intent: 'primary', busy },
            { id: 'copy', label: 'Copy', key: 'c' },
            { id: 'delete', label: 'Delete provider', intent: 'danger', confirm: { title: 'Delete provider?', detail: 'Removes the stored credentials.', tone: 'danger' } },
            { id: 'archive', label: 'Archive', disabled: true, disabledReason: 'archive it first' },
            { id: 'copy-link', label: 'Copy link', key: 'ctrl+y', hidden: true, hintLabel: 'copy link' },
          ],
        }),
      ]), footer: rt.feedbackNode(),
    })
  },
  onEvent(e, rt, s) {
    if (e.kind !== 'activate') return
    if (e.actionId === 'save') s.busyUntil = Date.now() + 1500
    else if (e.actionId === 'copy' || e.actionId === 'copy-link') rt.say('Copied', 'success')
    else if (e.actionId === 'delete') rt.say('Provider deleted', 'success')
  },
  before: () => draw(caption('primary [ Save ] · accelerator (c) · danger ! asks first · busy keeps its verb · disabled shows its reason · narrow folds into +N'), { width: 96, f: 0, t: 0 }).concat(['']),
  key(k, s) { if (k === 'w') { s.narrow = !s.narrow; return true } },
})

// ======================================================================= BASIC: fields and forms
const FORM_FIELDS = (v = {}) => [
  { id: 'name', kind: 'input', label: 'Name', value: v.name ?? 'production', placeholder: 'e.g. production', required: true, group: 'Connection' },
  { id: 'url', kind: 'input', label: 'Endpoint', value: v.url ?? 'https://api.example.com/v1', help: 'Base URL, including the version path', pattern: '^https?://\\S+$', patternMessage: 'Must be an http(s) URL' },
  { id: 'key', kind: 'secret', label: 'API key', value: v.key ?? 'sk-live-0123456789', help: 'Never shown again after saving' },
  { id: 'model', kind: 'select', label: 'Model', value: v.model ?? 'deepseek-chat', origin: 'inherited', group: 'Behaviour', options: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'custom-model', disabled: true, disabledReason: 'not in this plan' }] },
  { id: 'timeout', kind: 'number', label: 'Timeout', value: v.timeout ?? 30, min: 5, max: 120, step: 5, unit: 's', origin: 'inherited' },
  { id: 'stream', kind: 'toggle', label: 'Streaming', value: v.stream ?? true },
  { id: 'channels', kind: 'multiselect', label: 'Channels', value: v.channels ?? ['mentions', 'errors'], options: [{ id: 'mentions' }, { id: 'errors' }, { id: 'digest', disabled: true, disabledReason: 'enterprise only' }] },
  { id: 'dir', kind: 'input', label: 'Directory', value: v.dir ?? '~/work/may', placeholder: '~/…', suggestions: ['~/work/mayfly', '~/work/website', '~/work/dsh', '~/notes'], help: 'Type a path; Tab completes' },
  { id: 'notes', kind: 'textarea', label: 'Notes', value: v.notes ?? 'Prefer small diffs.\nAlways run the width scan.' },
]
rtScene({
  layer: 'basic', name: 'Fields and forms', section: '§4.3', keys: 'every field kind · Delete resets · Esc asks before discarding edits',
  state: () => ({ saved: {} }),
  width: 76,
  build(rt, s) {
    return ui.surface({
      title: 'Edit provider', chrome: 'overlay', badges: rt.dirty() ? [S('unsaved changes', 'warning')] : [], child: ui.stack.column([
        ui.form({ id: 'provider', fields: FORM_FIELDS(s.saved) }),
        ui.divider('Finish'),
        ui.actions({ id: 'finish', items: [{ id: 'save', label: 'Save', intent: 'primary', submit: true }] }),
      ]), footer: rt.feedbackNode(),
    })
  },
  onEvent(e, rt, s) { if (e.kind === 'activate' && e.actionId === 'save') { s.saved = e.inputs.provider; return { kind: 'completed', feedback: { message: 'Saved', severity: 'success' } } } },
})

// ======================================================================= BASIC: replies and validation
rtScene({
  layer: 'basic', name: 'Replies and validation', section: '§4.10', keys: 'fill Name and press Save: the owner answers invalid, failed, then completed',
  state: () => ({ attempt: 0, name: '' }),
  width: 76,
  build(rt, s) {
    return ui.surface({
      title: 'Add provider', chrome: 'overlay', child: ui.stack.column([
        ui.form({ id: 'add', enterSubmits: 'save', fields: [{ id: 'name', kind: 'input', label: 'Name', value: '', required: true, placeholder: 'e.g. production' }, { id: 'region', kind: 'select', label: 'Region', value: 'us-east', options: [{ id: 'us-east' }, { id: 'eu-west' }] }] }),
        ui.actions({ id: 'finish', items: [{ id: 'save', label: 'Save', intent: 'primary', submit: true }] }),
      ]), footer: rt.feedbackNode(),
    })
  },
  onEvent(e, rt, s) {
    if (e.kind !== 'activate' || e.actionId !== 'save') return
    s.attempt++
    if (s.attempt === 1) return { kind: 'failed', message: 'Could not reach the provider — try again (your input is kept)' }
    if (s.attempt === 2) return { kind: 'invalid', errors: { name: 'That name is already used' } }
    return { kind: 'completed', feedback: { message: `Added ${e.inputs.add.name}`, severity: 'success' } }
  },
  before: (c, s) => draw(caption(`the owner answers each save in turn: required (checked in the surface) → ${['failed', 'invalid', 'completed'][Math.min(s.attempt, 2)]} next (attempt ${s.attempt + 1})`), { width: 96, f: 0, t: 0 }).concat(['']),
  after: () => ['', ...draw(caption('invalid repaints beside the field · failed shows a message and keeps the input · completed settles · a cancel returns silently'), { width: 96, f: 0, t: 0 })],
})

// ======================================================================= BASIC: lists
const SKILLS = [
  { id: 'review-pr', label: 'review-pr', detail: 'Review a pull request', badge: 'enabled', group: 'Project' },
  { id: 'release-notes', label: 'release-notes', detail: 'Draft release notes', group: 'Project' },
  { id: 'pdf-export', label: 'pdf-export', detail: 'PDF export', disabled: true, disabledReason: 'retired', group: 'Project' },
  { id: 'plugin-author', label: 'plugin-author', detail: 'Prototype a plugin in-process', group: 'Preset' },
  { id: 'preset-author', label: 'preset-author', detail: 'Compose your own presets', group: 'Preset' },
]
const MODELS = [
  { id: 'op-pro', label: 'opencode-go/DeepSeek V4 Pro', detail: '977k context', group: 'opencode-go', segment: { label: 'Thinking', options: ['min', 'high', 'max'].map(id => ({ id, label: id })), inheritedId: 'high' } },
  { id: 'op-bunny', label: 'opencode-go/space-bunny-alpha', detail: '256k context', group: 'opencode-go' },
  { id: 'ds-flash', label: 'DeepSeek/DeepSeek-V41-Flash', badge: 'current · high', detail: '977k context', group: 'DeepSeek', segment: { label: 'Thinking', options: ['min', 'high', 'max'].map(id => ({ id, label: id })), inheritedId: 'high' } },
  { id: 'cu', label: 'custom/some-model', detail: '128k context', group: 'custom', segment: { label: 'Thinking', options: ['low', 'medium', 'high'].map(id => ({ id, label: id })) } },
]
const rejectedCombo = (() => {
  try {
    const rt = mount(() => ui.surface({ title: 'x', child: ui.stack.column([ui.list({ id: 'l', role: 'browse', filterable: true, items: [{ id: 'a', label: 'a' }] }), ui.actions({ id: 'k', items: [{ id: 'i', label: 'Install', key: 'i' }] })]) }))
    rt.render(60); return null
  } catch (e) { return e.message }
})()
rtScene({
  layer: 'basic', name: 'Lists', section: '§4.4', pages: 7, width: (c, s) => (s.page === 5 && s.narrow ? 62 : 84), keys: 'Ctrl+N/Ctrl+P next/previous page · Ctrl+W width (page 6)',
  state: () => ({ page: 0, narrow: false }),
  build(rt, s) {
    const fb = rt.feedbackNode()
    switch (s.page) {
      case 0: return ui.surface({ title: 'Numbered choose lists', chrome: 'overlay', footer: fb, child: ui.stack.column([
        caption('numbered: true — a digit chooses at once (preferences, questions)'), ui.list({ id: 'instant', role: 'choose', numbered: true, items: [{ id: 'preset', label: 'Preset endpoint', detail: 'known provider' }, { id: 'custom', label: 'Custom endpoint', detail: 'any compatible URL' }, { id: 'oauth', label: 'OAuth provider', detail: 'browser sign-in' }] }),
        ui.spacer(), caption("numbered: 'focus' — a digit only moves the cursor (anything that grants)"), ui.list({ id: 'focus', role: 'choose', numbered: 'focus', items: [{ id: 'reject', label: 'Reject' }, { id: 'once', label: 'Allow once' }, { id: 'session', label: 'Allow for this session' }] }),
      ]) })
      case 1: return ui.surface({ title: 'Skills', chrome: 'overlay', footer: fb, child: ui.list({ id: 'skills', role: 'browse', filterable: true, items: SKILLS, empty: ui.empty('No skills match', { description: 'Esc ends the search · Ctrl+U clears it' }) }) })
      case 2: return ui.surface({ title: 'Channels', chrome: 'overlay', footer: fb, child: ui.list({ id: 'channels', role: 'choose', mode: 'multiple', selectedIds: ['mentions'], items: [{ id: 'mentions', label: 'mentions' }, { id: 'errors', label: 'errors' }, { id: 'digest', label: 'digest', disabled: true, disabledReason: 'enterprise only' }] }) })
      case 3: return ui.surface({ title: 'Plugins', chrome: 'overlay', footer: fb, child: ui.stack.column([
        ui.list({ id: 'plugins', role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', items: [{ id: 'loop', label: 'Loop', detail: 'official', right: '1.4.0' }, { id: 'git', label: 'Git Helper', detail: 'community', right: 'update 1.3.0' }] }),
        ui.actions({ id: 'keys', items: [{ id: 'install', label: 'Install', key: 'i', hidden: true }, { id: 'remove', semantic: 'delete', label: 'Remove', hidden: true, confirm: { title: 'Remove plugin?', detail: 'Removal applies after restarting Mayfly.', tone: 'danger' } }, { id: 'refresh', semantic: 'refresh', label: 'Refresh', hidden: true }] }),
      ]) })
      case 4: return ui.surface({ title: 'Providers', chrome: 'overlay', footer: fb, child: ui.stack.column([
        ui.list({ id: 'providers', role: 'browse', acceptVerb: 'edit', items: [{ id: 'ds', label: 'DeepSeek', detail: 'built-in', unavailableActions: { delete: 'built-in providers cannot be deleted' } }, { id: 'local', label: 'Local', detail: 'custom' }, { id: 'staging', label: 'Staging', detail: 'asks before it is chosen', confirm: { title: 'Use Staging?', detail: 'It is not your default provider.' } }] }),
        ui.actions({ id: 'bar', items: [{ id: 'delete', semantic: 'delete', label: 'Delete', hintLabel: 'delete', hidden: true, confirm: { title: 'Delete this provider?', tone: 'danger' } }] }),
      ]) })
      case 5: return ui.surface({ title: 'Select a model', chrome: 'overlay', footer: fb, child: ui.list({ id: 'models', role: 'browse', filterable: true, acceptVerb: 'choose', items: MODELS }) })
      default: return ui.surface({ title: 'Tree and accordion', chrome: 'overlay', footer: fb, child: ui.stack.column([
        ui.list({ id: 'tree', role: 'choose', mode: 'multiple', tree: true, items: [
          { id: 'fs', label: [S('filesystem', 'default', ['strong'])], expanded: true, right: [S('✓ connected · 120ms  ', 'success'), mu('4 tools')] },
          { id: 'rd', label: 'read_file', parentId: 'fs', detail: 'Read a file from disk' }, { id: 'wr', label: 'write_file', parentId: 'fs', detail: 'Create or overwrite a file' },
          { id: 'dl', label: 'delete_file', parentId: 'fs', detail: 'Remove a file', right: [S('⚠ dangerous', 'warning')] }, { id: 'ls', label: 'list_dir', parentId: 'fs', detail: 'List a directory' },
          { id: 'gh', label: [S('github', 'default', ['strong'])], right: [S('✓ connected · 340ms  ', 'success'), mu('12 tools')] }, { id: 'gh1', label: 'create_issue', parentId: 'gh' }, { id: 'gh2', label: 'list_prs', parentId: 'gh' },
        ], selectedIds: ['rd', 'wr', 'ls'] }),
        ui.spacer(),
        ui.list({ id: 'accordion', role: 'browse', items: [{ id: 'a1', label: 'plugin-author', detail: 'preset', body: 'Prototype a plugin in-process,\nthen promote it to a durable external plugin.' }, { id: 'a2', label: 'preset-author', detail: 'preset', body: 'Compose your own presets from the\nbuilt-in services and panels.' }] }),
      ]) })
    }
  },
  onEvent(e, rt, s) {
    if (e.kind === 'selection-accept') rt.say(`accepted ${e.selectedIds.join(', ')}${e.segmentId !== undefined ? ` · thinking ${e.segmentId ?? 'provider default'}` : ''}`, 'success')
    else if (e.kind === 'selection-toggle') rt.say(`selected: ${e.selectedIds.join(', ') || 'none'}`, 'info')
    else if (e.kind === 'activate') rt.say(`${e.actionId} (the owner handles it)`, 'success')
  },
  before(c, s) {
    const T = ['choose lists: numbered instant vs focus-only digits', 'browse list: type to filter, groups, badges, details, an empty state', 'multiple: Space toggles, Enter commits', 'slash filter: `/` starts it, so bare letters are free accelerators: i is this panel\'s own key, x and r are the common meanings delete and refresh (rebindable)', 'per-row availability and confirm reuse the key: x deletes the focused row, the built-in row says why it cannot, and a destructive key asks first (there is no Delete button)', 'a segment strip on the focused row (the model picker): ←/→ steps, Delete unpins, it never moves a row', 'tree with tri-state checks (Space toggles, → expands) and an accordion (Enter or → expands)']
    return [...draw(caption(`page ${s.page + 1}/7 (Ctrl+N): ${T[s.page]}`), { width: 96, f: 0, t: 0 }), ...(s.page === 3 ? draw(caption(`the kit rejects the other combination: ${rejectedCombo}`), { width: 96, f: 0, t: 0 }) : []), '']
  },
  key(k, s) { if (k === '\x17' && s.page === 5) { s.narrow = !s.narrow; return true } },
})

// ======================================================================= BASIC: tabs, wizards, rails
const TAB_ITEMS = [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage', count: 3 }, { id: 'conn', label: 'Connections', attention: true }, { id: 'skills', label: 'Skills', count: 12 }, { id: 'about', label: 'About' }]
rtScene({
  layer: 'basic', name: 'Tabs, wizards, rails', section: '§4.5', pages: 4, width: (c, s) => (s.page === 3 ? (s.narrow ? 40 : 76) : 78), keys: 'Ctrl+N/Ctrl+P page · Alt+←/→ switch tabs from anywhere · Ctrl+W narrow (page 4)',
  state: () => ({ page: 0, tab: 'usage', step: 'kind', rail: 'model', narrow: false }),
  build(rt, s) {
    const fb = rt.feedbackNode()
    if (s.page === 0) return ui.surface({ title: 'Status', chrome: 'overlay', footer: fb, child: ui.stack.column([ui.tabs({ id: 'strip', items: TAB_ITEMS, activeId: s.tab }), ui.spacer(), ui.text(`${TAB_ITEMS.find(t => t.id === s.tab).label} page content`, { tone: 'muted' })]) })
    if (s.page === 1) {
      const steps = [{ id: 'kind', label: 'Kind' }, { id: 'conn', label: 'Connection' }, { id: 'models', label: 'Models' }, { id: 'review', label: 'Review' }]
      return ui.surface({ title: 'Add provider', chrome: 'overlay', badges: [S(`step ${steps.findIndex(x => x.id === s.step) + 1} of 4`, 'muted')], footer: fb, child: ui.stack.column([
        ui.tabs({ id: 'wizard', mode: 'wizard', items: steps, activeId: s.step }), ui.spacer(),
        s.step === 'conn' ? ui.form({ id: 'conn', fields: [{ id: 'name', kind: 'input', label: 'Name', value: '', required: true }, { id: 'url', kind: 'input', label: 'Endpoint', value: 'https://api.example.com/v1' }] }) : ui.text(`${steps.find(x => x.id === s.step).label}: nothing to validate on this step`, { tone: 'muted' }),
      ]) })
    }
    if (s.page === 2) {
      const R = [{ id: 'general', label: 'General', group: 'Session' }, { id: 'model', label: 'Model', group: 'Session' }, { id: 'perm', label: 'Permissions', count: 2, group: 'Session' }, { id: 'providers', label: 'Providers', attention: true, group: 'Integrations' }, { id: 'mcp', label: 'MCP', count: 4, group: 'Integrations' }]
      const body = { general: [{ id: 'lang', kind: 'select', label: 'Language', value: 'English', options: [{ id: 'English' }, { id: '简体中文' }] }, { id: 'n', kind: 'toggle', label: 'Notifications', value: true }], model: [{ id: 'model', kind: 'select', label: 'Model', value: 'deepseek-chat', origin: 'inherited', options: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }, { id: 'effort', kind: 'select', label: 'Effort', value: 'medium', origin: 'inherited', options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }], perm: [{ id: 'preset', kind: 'select', label: 'Preset', value: 'Default', options: [{ id: 'Default' }, { id: 'Accept edits' }] }], providers: [{ id: 'p', kind: 'select', label: 'Provider', value: 'DeepSeek', options: [{ id: 'DeepSeek' }, { id: 'Local' }] }], mcp: [{ id: 'auto', kind: 'toggle', label: 'Auto-connect', value: true }] }
      return patterns.railPanel({ title: 'Settings', rail: { id: 'rail', items: R, activeId: s.rail }, content: ui.stack.column([ui.text(R.find(r => r.id === s.rail).label, { styles: ['strong'], tone: 'primary' }), ui.spacer(), ui.form({ id: `settings.${s.rail}`, fields: body[s.rail] })]), railWidth: 24 })
    }
    return ui.surface({ title: 'Narrow strip', chrome: 'overlay', child: ui.tabs({ id: 'narrow', items: TAB_ITEMS, activeId: s.tab }) })
  },
  onEvent(e, rt, s) {
    if (e.kind === 'tab-change') { if (s.page === 1) s.step = e.tabId; else if (s.page === 2) s.rail = e.tabId; else s.tab = e.tabId }
  },
  before(c, s) {
    const T = ['a tab strip: text color only; ←/→ move when focused, Alt+←/→ from anywhere; counts and ! attention', 'a wizard: step marks come from position; a forward switch validates (try Alt+→ with Name empty)', 'a vertical rail: the content follows the cursor live; ↑/↓ move, → or Enter enters the content. ← leaves one level at a time, innermost first (see below)', 'narrow: the active tab stays visible and the rest folds into +N']
    return [...draw(caption(`page ${s.page + 1}/4 (Ctrl+N): ${T[s.page]}`), { width: 96, f: 0, t: 0 }), ...(s.page === 2 ? draw(ui.stack.column([caption('focus levels, outer to inner: rail → content control → a field inside it (a select, a picker)'), caption('← moves out exactly one level. A control that uses ← itself (a select adjusts, a tree row collapses, a text field moves its caret) keeps it;'), caption('the first ← it does not use goes to the rail, wherever the rail sits. Shift+Tab and Esc always step out one level too, and the hint row shows ← labels whenever ← goes to the rail.')]), { width: 96, f: 0, t: 0 }) : []), '']
  },
  key(k, s) { if (k === '\x17' && s.page === 3) { s.narrow = !s.narrow; return true } },
})

// ======================================================================= BASIC: surfaces and scroll
rtScene({
  layer: 'basic', name: 'Surfaces and scroll', section: '§4.6', pages: 3, width: 76, keys: 'Ctrl+N/Ctrl+P page · scroll: ↑↓ PgUp PgDn End follow · Ctrl+E expand',
  state: () => ({ page: 0, t0: Date.now() }),
  build(rt, s) {
    if (s.page === 0) return ui.stack.column([
      caption('overlay: rounded, focus border color'), ui.surface({ title: 'Approve bash?', chrome: 'overlay', subtitle: 'optional subtitle (muted)', badges: [S('1 of 3 waiting', 'muted')], child: ui.text('Runs: pnpm build'), footer: ui.richText([mu('optional custom footer')]) }),
      caption('surface: rounded, quiet border color'), ui.surface({ title: 'Select a model', chrome: 'surface', child: ui.text('→ DeepSeek/DeepSeek-V4-Pro') }),
      caption('lane: rules only (the queue pane head)'), ui.surface({ title: 'Queued (2) · ↑ recall newest', chrome: 'lane', child: ui.text('Queued: also update the footer') }),
      caption('none: a bare bold title (the todo pane)'), ui.surface({ title: 'Todo', chrome: 'none', child: ui.text('  ✓ read the config') }),
    ])
    if (s.page === 1) {
      const n = 12 + Math.floor((Date.now() - s.t0) / 1500)
      return ui.surface({ title: 'Output', chrome: 'overlay', badges: [S('following', 'muted')], child: ui.scroll({ id: 'log', follow: 'end', height: 6, expandedHeight: 14, child: ui.stack.column(Array.from({ length: n }, (_, i) => ui.text(`log line ${i + 1}`))) }) })
    }
    return ui.surface({ title: 'Edit provider', chrome: 'overlay', badges: [S('unsaved changes', 'warning')], child: ui.stack.column([ui.text('A badge on the right of the title rule carries a short state.'), ui.text('Narrow widths drop the subtitle and badges before the title.', { tone: 'muted' })]) })
  },
  before(c, s) { return [...draw(caption(['chrome kinds: overlay, surface, lane, none', 'a scroll region: follow end (a line arrives every 1.5 s), a scrollbar, Ctrl+E expands, Esc collapses', 'header badges'][s.page] + ` · page ${s.page + 1}/3`), { width: 96, f: 0, t: 0 }), ''] },
})

// ======================================================================= BASIC: content
pagesScene({
  layer: 'basic', name: 'Content', section: '§4.1', count: 7, width: WIDE, keys: 'h highlight (code) · d numbered diff · b over-budget diagram',
  init() { this.hl = true; this.nd = true; this.over = false },
  pages() {
    const hdr = 'Prefer small diffs and always run the width scan before pushing.'
    return [
      ['text, rich text, spacer, divider: eight tones, wrap or truncate, strong italic strike', c => [
        ...draw(col(...TONE_NAMES.map(t => ui.text(`${t.padEnd(9)} sample in this tone`, { tone: t }))), c), '',
        ...draw(ui.stack.row([ui.child(ui.text(hdr), { basis: 30 }), ui.child(ui.text(hdr, { overflow: 'truncate' }), { basis: 30 })], { gap: 4 }), c), ...draw(caption('wrap (default)                    truncate'), c), '',
        ...draw(col(ui.richText([S('deepseek-chat High  '), S('PLAN', 'primary', ['strong']), S('  '), S('YOLO', 'warning', ['strong']), S('  '), S('italic', 'default', ['italic']), S('  '), S('struck', 'muted', ['strike']), S('  '), mu('⏵ 2 jobs')]), ui.spacer(), ui.divider(), ui.divider('Connection')), c)]],
      ['fields (key/value) and sections (bold title, body; collapsed shows the title only)', col(
        ui.fields([{ label: 'Provider', value: 'DeepSeek' }, { label: 'Balance', value: [S('¥ 128.40', 'default', ['strong']), mu(' available')] }, { label: 'Status', value: [S('✓ ', 'success'), S('signed in')] }]), ui.spacer(),
        ui.sections([{ title: 'Connection', body: ui.fields([{ label: 'Name', value: 'production' }, { label: 'Endpoint', value: 'https://api.example.com/v1' }]) }, { title: 'Behaviour', collapsed: true, body: ui.text('hidden') }, { body: ui.text('x'), collapsed: true }]))],
      ['markdown (code fences highlighted) and code (muted language name, then the lines)', function (c) {
        theme.highlight = this.hl
        const out = [...draw(caption(`ui.code — ${this.hl ? 'highlighted by language' : 'one flat tone'} (h toggles)`), c), ...draw(ui.code(["const frame = glyphFor(state)", "if (state.mode === 'waiting') {", "  return { kind: 'loader', variant: 'gap' }", '}'].join('\n'), { language: 'typescript' }), c), '',
          ...draw(caption('ui.markdown'), c), ...draw(ui.markdown('# Release notes\n- Hero copy now reads *Ship agent UI in a keystroke*\n- Width scan covers the **new panels**\n> a quote reads muted\n```ts\nconst a = 1\n```'), c)]
        theme.highlight = false; return out
      }],
      ['diff: two strings in, aligned rows out — numbered gutters, −/+ and color, ⋯ between hunks', function (c) { return [...draw(caption(`numbered ${this.nd ? 'on' : 'off'} (d toggles); an @@ header names the hunk`), c), ...draw(ui.diff(EDIT_BEFORE, EDIT_AFTER, { start: 41, numbered: this.nd, hunkHeader: true, context: 1 }), c)] }],
      ['charts: sparkline, bars (grouped, stacked, normalized), heatmap with a legend', col(
        ui.chart({ chart: 'sparkline', values: [3, 5, 4, 8, 6, 9, 7, 5, 4, 6, 8, 10], label: 'tokens' }), ui.spacer(),
        ui.chart({ chart: 'bar', orientation: 'horizontal', layout: 'grouped', title: 'grouped', categories: ['mon', 'tue'], series: [{ id: 'a', values: [62, 31] }, { id: 'b', values: [40, 55] }] }), ui.spacer(),
        ui.chart({ chart: 'bar', orientation: 'horizontal', layout: 'stacked', title: 'stacked', categories: ['mon', 'tue'], series: [{ id: 'a', values: [12, 8] }, { id: 'b', values: [8, 14] }] }),
        ui.chart({ chart: 'bar', orientation: 'horizontal', layout: 'normalized', title: 'normalized', categories: ['mon', 'tue'], series: [{ id: 'a', values: [12, 8] }, { id: 'b', values: [8, 14] }] }), ui.spacer(),
        ui.chart({ chart: 'heatmap', title: 'activity', columns: ['Mon', 'Tue', 'Wed', 'Thu'], rows: ['AM', 'PM'], values: [[0, 1, 2, 2], [0, 1, 2, 1]], levels: [{ value: 0, label: 'low', tone: 'muted' }, { value: 1, label: 'mid', tone: 'warning' }, { value: 2, label: 'high', tone: 'success' }] }))],
      ['charts: line, point, vertical bars', col(
        ui.chart({ chart: 'line', title: 'latency (ms)', xLabel: 'turn', series: [{ id: 's', tone: 'accent', points: Array.from({ length: 30 }, (_, x) => ({ x, y: Math.round(120 + 90 * Math.sin(x / 5) + x * 4) })) }] }), ui.spacer(),
        ui.chart({ chart: 'point', title: 'point', series: [{ id: 's', tone: 'success', points: Array.from({ length: 20 }, (_, x) => ({ x, y: (x * 7) % 11 })) }], height: 5 }), ui.spacer(),
        ui.chart({ chart: 'bar', title: 'vertical', categories: ['mon', 'tue', 'wed', 'thu'], series: [{ id: 'a', tone: 'warning', values: [3, 5, 2, 4] }], height: 5 }))],
      ['diagram: a flowchart as ASCII within a budget, falling back to its source', function (c) {
        const src = this.over ? Array.from({ length: 30 }, (_, i) => `  n${i} --> n${i + 1}`).join('\n') : 'flowchart LR\n  queue --> agent --> tools'
        return [...draw(caption(`budget: 8 KiB, 100 lines, 25 nodes · ${this.over ? 'over budget: the original source is shown' : 'within budget'} (b toggles)`), c), ...draw(ui.diagram(src), c)]
      }],
    ]
  },
  key(k) { if (k === 'h') this.hl = !this.hl; else if (k === 'd') this.nd = !this.nd; else if (k === 'b') this.over = !this.over },
})

// ======================================================================= BASIC: feedback and progress
scene({
  layer: 'basic', name: 'Feedback and progress', section: '§4.8, §2.4', keys: 'Ctrl+N/Ctrl+P page',
  init() { this.p = 0 },
  lines(c) {
    const k = Math.floor(c.t / 600) % 12
    const P = [
      ['loaders (one glyph channel, animated by the renderer) and the cancel hint', col(
        ui.loader({ variant: 'bloom', message: 'Thinking' }), ui.loader({ variant: 'fill', message: 'Working' }), ui.loader({ variant: 'gap', message: 'Discovering models from api.example.com', elapsedMs: 12000, cancelActionId: 'cancel' }), ui.loader({ variant: 'breath', message: 'Waiting for authorization', elapsedMs: 45000 }))],
      ['progress: determinate cells with n/N, and the heading rule (heavy for done, light for what is left)', col(
        ui.progress({ label: 'Building', value: Math.min(10, k), max: 10, width: 10 }), ui.progress({ value: 9, max: 10, width: 10, showCount: false, showPercent: true }), ui.spacer(),
        ui.stack.row([ui.child(ui.progress({ style: 'rule', value: 2, max: 8, width: 40 }), { basis: 40 }), ui.child(ui.richText([S('Goal', 'primary', ['strong']), mu(' round 2 of 8')]))], { gap: 2 }),
        ui.stack.row([ui.child(ui.progress({ style: 'rule', value: 8, max: 8, width: 40, tone: 'danger' }), { basis: 40 }), ui.child(ui.richText([S('Goal', 'primary', ['strong']), S(' ✕ blocked', 'danger')]))], { gap: 2 }),
        caption('a bar never appears for an unknown duration: an eased bar that never completes is a fabricated estimate'))],
      ['settled forms are static; the retry is a key', col(
        ui.richText([S('✓ ', 'success'), S('Discovered 14 models'), mu(' · 2.1s')]), ui.richText([S('✗ ', 'danger'), S('Discovery failed: 401 Unauthorized'), mu('  r retry')]), ui.richText([mu('⊘ Cancelled')]))],
      ['empty: what is missing and the next action', col(ui.empty('No sessions found', { description: 'Restore a checkpoint with /rewind' }), ui.spacer(), ui.empty('No plugins installed', { description: 'press → to browse' }))],
    ]
    const [cap, body] = P[this.p]
    return [...draw(caption(`page ${this.p + 1}/${P.length} (Ctrl+N): ${cap}`), c), '', ...draw(body, c)]
  },
  key(k) { if (k === '\x0e') this.p = (this.p + 1) % 4; else if (k === '\x10') this.p = (this.p + 3) % 4 },
})

// ======================================================================= BASIC: layout
scene({
  layer: 'basic', name: 'Layout', section: '§4.7', keys: '←/→ width · h height · o toggle the cwd overflow',
  init() { this.w = 70; this.tall = true; this.hide = false },
  lines(c) {
    const w = this.w
    const ladder = ui.stack.column([
      ui.child(ui.richText([S('Loop  official · Automation   ✓ installed 1.4.0   TUI ✓ Web ✓')]), { when: { minWidth: 100 } }),
      ui.child(ui.richText([S('Loop  official   ✓ installed 1.4.0')]), { when: { minWidth: 60, maxWidth: 99 } }),
      ui.child(ui.richText([S('Loop ✓')]), { when: { maxWidth: 59 } }),
      ui.child(ui.richText([S('↻ 1 change applies after restart', 'warning')]), { when: { minHeight: 20 } }),
    ])
    const admit = ui.stack.row([
      ui.child(ui.richText([S('deepseek-chat High')]), { priority: 0 }), ui.child(ui.richText([S('PLAN', 'primary', ['strong'])]), { priority: 1 }), ui.child(ui.richText([S('⏵ 2 jobs')]), { priority: 3 }),
      ui.child(ui.richText([mu('cache 34%  context: 18% (22.9k/128k)')]), { priority: 4, band: 'right', overflow: 'hide' }), ui.child(ui.richText([mu('~/work/mayfly/packages/mayfly')]), { priority: 5, overflow: this.hide ? 'hide' : 'truncate' }), ui.child(ui.richText([mu('main ±3')]), { priority: 10 }),
    ], { gap: 2 })
    const flex = ui.stack.row([ui.child(ui.surface({ title: 'basis 24', chrome: 'surface', child: ui.text('fixed') }), { basis: 24 }), ui.child(ui.surface({ title: 'grow 1', chrome: 'surface', child: ui.text('takes the rest') }), { grow: 1 }), ui.child(ui.surface({ title: 'grow 2', chrome: 'surface', child: ui.text('twice') }), { grow: 2 })], { gap: 1 })
    const win = ui.list({ id: 'win', role: 'browse', maxRows: 4, items: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, label: `row ${i + 1}` })) })
    return [...draw(caption(`width ${w} (←/→) · height ${this.tall ? '≥ 20' : '< 20'} (h)`), c), '',
      ...draw(caption('stack row with basis and grow:'), c), ...draw(flex, { ...c, width: w }), '',
      ...draw(caption('a width ladder: children with disjoint ranges; the renderer picks one, a plugin never reads a width'), c), ...draw(ladder, { ...c, width: w, viewport: { width: w, height: this.tall ? 24 : 12 } }), '',
      ...draw(caption(`priority admission: lower is kept first; "hide" drops out instead of truncating (cwd ${this.hide ? 'hide' : 'truncate'}, o)`), c), ...draw(admit, { ...c, width: w }), '',
      ...draw(caption('a windowed list (maxRows 4) counts what is hidden:'), c), ...draw(win, { ...c, width: Math.min(w, 40) })]
  },
  key(k) { if (k === '\x1b[C') this.w = Math.min(130, this.w + 10); else if (k === '\x1b[D') this.w = Math.max(24, this.w - 10); else if (k === 'h') this.tall = !this.tall; else if (k === 'o') this.hide = !this.hide },
})

// ======================================================================= BASIC: patterns
rtScene({
  layer: 'basic', name: 'Patterns', section: '§4.9', pages: 4, width: (c, s) => (s.page === 2 ? WIDE : 80), keys: 'Ctrl+N/Ctrl+P page',
  state: () => ({ page: 0, tab: 'overview', rail: 'work' }),
  build(rt, s) {
    if (s.page === 0) return patterns.decisionPanel({ id: 'decision', title: 'Delete branch?', badges: [S('1 of 2 waiting', 'muted')], preview: [ui.text('feature/old-hero · 3 unmerged commits', { tone: 'muted' }), ui.richText([S('⚠ ', 'warning'), S('the commits are not on any other branch', 'warning')])], options: [{ id: 'keep', label: 'Keep the branch' }, { id: 'delete', label: 'Delete it', detail: 'cannot be undone' }, { id: 'archive', label: 'Archive it as a tag' }], input: { id: 'why', label: 'Note', placeholder: 'optional' }, accelerators: [{ id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name' }] })
    if (s.page === 1) return patterns.railPanel({ title: 'Workspaces', rail: { id: 'rail', activeId: s.rail, items: [{ id: 'work', label: 'work/mayfly', count: 8 }, { id: 'site', label: 'website', count: 5 }, { id: 'notes', label: 'notes', count: 2 }] }, content: ui.list({ id: `ws.${s.rail}`, role: 'browse', marker: 'selection', items: [{ id: 'a', label: 'Fix login redirect', right: '2h' }, { id: 'b', label: 'Docs sync', right: '1d' }] }) })
    if (s.page === 2) return ui.stack.column([patterns.splitView({ list: ui.list({ id: 'sv', role: 'browse', marker: 'selection', items: [{ id: 'a', label: 'Loop', detail: 'official', right: '1.4.0' }, { id: 'b', label: 'Git Helper', detail: 'community', right: 'update 1.3.0' }] }), detail: ui.fields([{ label: 'Name', value: 'Loop' }, { label: 'Source', value: 'official' }, { label: 'Status', value: [S('✓ installed 1.4.0', 'success')] }]) })])
    return patterns.statusPage({ title: 'Status', tabs: { id: 'st', activeId: s.tab, items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }, { id: 'account', label: 'Account', attention: true }] }, rows: [{ label: 'Provider', value: 'DeepSeek' }, { label: 'Balance', value: [S('⚠ ¥ 6.20', 'warning'), mu(' low balance')] }, { label: 'Checked', value: [mu('2 min ago · r refresh')] }] })
  },
  onEvent(e, rt, s) { if (e.kind === 'tab-change') { if (s.page === 1) s.rail = e.tabId; else s.tab = e.tabId } else if (e.kind === 'selection-accept') rt.say(`chose ${e.itemId}`, 'success') },
  before(c, s) { return [...draw(caption(`page ${s.page + 1}/4 (Ctrl+N): ${['decisionPanel: header, preview, numbered choices, same-line input, hidden accelerators', 'railPanel: labels on the left, live content on the right', 'splitView: list and detail side by side from 100 columns, the list alone below', 'statusPage: a read-only key/value page under tabs'][s.page]}`), { width: 96, f: 0, t: 0 }), ''] },
})

// ======================================================================= BASIC: a downstream plugin
/** A plugin's panel. It is written against the same `ui.*` API the Mayfly components use; nothing here is privileged. */
const AcmeLoop = defineComponent('acme.loop', 'plugin', ({ interval, enabled, prompt, feedback }) => ui.surface({
  title: 'Loop · schedule a prompt', chrome: 'overlay', footer: feedback, badges: [enabled ? S('running', 'success') : S('stopped', 'muted')], child: ui.stack.column([
    ui.form({ id: 'loop', fields: [
      { id: 'prompt', kind: 'textarea', label: 'Prompt', value: prompt, required: true },
      { id: 'every', kind: 'select', label: 'Every', value: interval, options: [{ id: '5m' }, { id: '15m' }, { id: '1h' }] },
      { id: 'on', kind: 'toggle', label: 'Enabled', value: enabled },
    ] }),
    ui.actions({ id: 'ops', items: [{ id: 'save', label: 'Save', intent: 'primary', submit: true }, { id: 'stop', label: 'Stop the loop', intent: 'danger', confirm: { title: 'Stop the loop?', detail: 'No more runs are scheduled.', tone: 'danger' }, disabled: !enabled, disabledReason: 'not running' }] }),
  ]),
}))
rtScene({
  layer: 'basic', name: 'A downstream plugin', section: '§6', width: 90, keys: 'a plugin panel and a plugin status entry, built with the same API as core',
  state: () => ({ interval: '15m', enabled: true, prompt: 'Check CI and summarize failures' }),
  build(rt, s) {
    return ui.stack.column([
      AcmeLoop({ interval: s.interval, enabled: s.enabled, prompt: s.prompt, feedback: rt.feedbackNode() }),
      MC.StatusBar({ facts: { ...FACTS, jobs: 0 }, extra: [{ id: 'acme.loop', priority: 7, band: 'left', spans: [S(s.enabled ? `↻ loop ${s.interval}` : '↻ loop off', s.enabled ? 'accent' : 'muted')] }] }),
    ])
  },
  onEvent(e, rt, s) {
    if (e.kind === 'activate' && e.actionId === 'save') { Object.assign(s, { interval: e.inputs.loop.every, prompt: e.inputs.loop.prompt, enabled: e.inputs.loop.on }); return { kind: 'completed', feedback: { message: `Loop every ${s.interval}`, severity: 'success' } } }
    if (e.kind === 'activate' && e.actionId === 'stop') { s.enabled = false; return { kind: 'completed', feedback: { message: 'Loop stopped', severity: 'success' } } }
  },
  before: () => draw(caption('acme.loop is a plugin component (defineComponent, layer "plugin"). Its panel and its status-bar entry use ui.* exactly like the Mayfly components do.'), { width: 96, f: 0, t: 0 }).concat(['']),
})

// ======================================================================= MAYFLY: status area (two composable rows)
const AGENTS = [{ id: 'review', name: 'review', task: 'Audit facts projection', meta: [S('41s · 6 tools · ↓6.4k', 'muted')], state: 'run' }, { id: 'plan', name: 'plan', task: 'Draft migration plan', meta: [S('waiting · reply needed', 'warning')], state: 'wait' }, { id: 'explore', name: 'explore', task: 'Map transcript files', meta: [mu('12s · 8 tools')], state: 'done' }, { id: 'lint', name: 'lint', task: 'Sweep oxlint findings', meta: [mu('9s · 3 tools')], state: 'done' }, { id: 'docs', name: 'docs', task: 'Update README variants', meta: [mu('20s · 5 tools')], state: 'done' }]
const JOBS = [{ id: 'dev', name: 'dev', task: 'pnpm run dev', meta: [mu('running 4m 2s')], state: 'job' }, { id: 'watch', name: 'watch', task: 'pnpm run test -- --watch', meta: [mu('running 1m 9s')], state: 'job' }, { id: 'build', name: 'build', task: 'pnpm run build', meta: [mu('exited 0 · 22s')], state: 'done' }]
const TODO_TEXT = ['Audit current hero copy', 'Update landing page hero', 'Run the tests', 'Update screenshots', 'Bump changelog', 'Open the PR']
const todoAt = t => { const done = t < 3000 ? 2 : t < 6000 ? 3 : t < 9000 ? 4 : 5; return TODO_TEXT.map((text, i) => ({ text, status: i < done ? 'done' : i === done ? 'progress' : 'pending' })) }
rtScene({
  layer: 'mayfly', name: 'Status area', section: '§5.1', width: 100,
  keys: 'Alt+↓ enter the views · ←/→ view · ↑↓ select · x stop · Esc back · Ctrl+P plan · Ctrl+Y yolo · Ctrl+T shell · Ctrl+B low balance · Ctrl+G goal state · Ctrl+W width',
  state: () => ({ mode: 'editor', active: 'agents', plan: false, yolo: false, shell: false, low: false, goal: 0, w: 0, agents: structuredClone(AGENTS), jobs: structuredClone(JOBS) }),
  width: (c, s) => [100, 72, 52, 36][s.w],
  build(rt, s) {
    const facts = { ...FACTS, plan: s.plan, yolo: s.yolo, balanceLow: s.low ? '¥6.2' : undefined, agents: s.agents, jobs: s.jobs, todo: todoAt(Date.now() % 12000), goal: { round: [2, 4, 8][s.goal], rounds: 8, state: ['active', 'paused', 'blocked'][s.goal], text: 'Ship the hero refresh and keep all 214 tests green', reason: 'needs a decision on the release channel' } }
    return ui.stack.column([
      MC.Editor({ title: 'Update the landing page hero', mode: s.shell ? 'shell' : 'prompt', autofocus: s.mode === 'editor', placeholder: ['Ask anything · / commands · @ files · # skills · ! shell', 'Ask anything · / commands · @ files', 'Ask anything'] }),
      MC.StatusBar({ facts }),
      s.mode === 'editor' ? MC.ViewRow({ facts, conversations: 1 }) : MC.ViewPanel({ active: s.active, facts }),
      rt.feedbackNode(),
    ])
  },
  onEvent(e, rt, s) {
    if (e.kind === 'tab-change') s.active = e.tabId
    else if (e.kind === 'selection-accept') rt.say(`→ opened ${s.active === 'agents' ? 'the conversation' : 'the job detail'} "${e.itemId}"`, 'success')
    else if (e.kind === 'activate' && e.actionId === 'stop') { const r = s[s.active]?.find(x => x.id === e.selected[`views.${s.active}`]); if (r) { r.state = 'stopped'; rt.say(`⊘ stopped ${r.name}`, 'info') } }
    else if (e.kind === 'dismiss' && s.mode === 'views') { s.mode = 'editor'; this.rt.reset(); return { kind: 'cancelled' } }
  },
  key(k, s) {
    const n = keymap.canon(keyName(k))
    if (s.mode === 'editor' && (n === 'alt+down' || k === '\x1b[17~')) { s.mode = 'views'; this.rt.reset(); return true }
    if (k === '\x10') { s.plan = !s.plan; return true }
    if (k === '\x19') { s.yolo = !s.yolo; return true }
    if (k === '\x14') { s.shell = !s.shell; return true }
    if (k === '\x02') { s.low = !s.low; return true }
    if (k === '\x07') { s.goal = (s.goal + 1) % 3; return true }
    if (k === '\x17') { s.w = (s.w + 1) % 4; return true }
  },
  before: () => draw(caption('two composable rows: row 1 is facts (model, mode chips, context, directory, git, balance); row 2 is views (agents, jobs, goal, todo). The conversation title is in the edit box corner; shell mode colors the box border.'), { width: 96, f: 0, t: 0 }).concat(['']),
})
// ======================================================================= MAYFLY: activity row
scene({
  layer: 'mayfly', name: 'Activity row', section: '§5.3', keys: 'v/V next/previous phase',
  init() { this.v = 0 },
  lines(c) {
    const P = [
      ['Thinking: the glyph moves, the label is still', { phase: 'thinking', label: 'Thinking', counts: { elapsed: 8000, up: '30.2k', down: '1.1k' }, gap: 'Esc interrupt · Ctrl+O expand', detail: ['Checking whether the activity row can show more than the latest tool name, since every tool call overwrites the previous one…'] }],
      ['Tool running: the label shimmers, ● is still', { phase: 'tool', label: 'Running commands', counts: { elapsed: 12000, up: '30.2k', down: '4.1k', rate: 38 }, gap: 'Esc interrupt · Ctrl+O expand', detail: ['pnpm run verify:changed -- --plan'] }],
      ['Deep diving on the model: the glyph fills; the tip lives in the gap', { phase: 'working', label: 'Deep diving', counts: { elapsed: 2000 }, tip: '@ files' }],
      ['Waiting on an external action: ● breathes, the label is still', { phase: 'waiting', label: 'Waiting for authorization', counts: { elapsed: 45000 }, gap: 'Esc cancel' }],
      ['Waiting on you: nothing moves', { phase: 'user', label: 'Waiting for your action', counts: { elapsed: 8000 } }],
      ['Stopping: nothing moves', { phase: 'stopping', label: 'interrupting…' }],
    ]
    const [cap, props] = P[this.v]
    return [...draw(caption(`phase ${this.v + 1}/${P.length} (v): ${cap}`), c), '', ...draw(MC.ActivityRow(props), c), '',
      ...draw(caption('idle: nothing is rendered. Narrow widths shed the detail lines, then the connector, then the counters, then the gap:'), c),
      ...[60, 40, 28].flatMap(w => ['', ...draw(MC.ActivityRow(props), { ...c, width: w })])]
  },
  key(k) { if (k === 'v') this.v = (this.v + 1) % 6; else if (k === 'V') this.v = (this.v + 5) % 6 },
})

// ======================================================================= MAYFLY: editor
const PROMPT_HISTORY = ['run the width scan again', 'bump the changelog too', 'explain the facts projection']
const PROMPT_FILES = [{ id: 'f1', label: '@pane-activity.ts', detail: 'packages/mayfly/src/transcript/', size: '2 KB' }, { id: 'f2', label: '@pane-agents.ts', detail: 'packages/mayfly/src/transcript/', size: '3 KB' }, { id: 'f3', label: '@notes.md', detail: 'docs/', size: '2 KB' }]
const PROMPT_COMMANDS = [{ id: 'c1', label: '/model', detail: 'switch model and thinking' }, { id: 'c2', label: '/sessions', detail: 'browse and resume sessions' }, { id: 'c3', label: '/trace', detail: 'inspect the execution trace' }]
const PROMPT_SKILLS = [{ id: 's1', label: '#frontend-design', detail: 'build distinctive interfaces' }, { id: 's2', label: '#review', detail: 'review a diff for defects' }]
const EDITOR_CONTEXTS = [
  { title: 'Update the landing page hero', variants: ['Ask anything · / commands · @ files · # skills · ! shell', 'Ask anything · / commands · @ files · # skills', 'Ask anything · / commands · @ files', 'Ask anything'], running: ['Type a follow-up to queue it · @ files · # skills', 'Type a follow-up to queue it'], note: 'main conversation' },
  { title: 'why does the cache miss', variants: ['Continue the side question · @ files · # skills', 'Continue the side question'], note: 'side question' },
  { title: 'reviewer', variants: ['Reply to reviewer — sending resumes it'], note: 'subagent that may be resumed' },
  { title: 'reviewer', variants: ['Read-only conversation'], note: 'subagent that is read-only' },
]
rtScene({
  layer: 'mayfly', name: 'Editor', section: '§5.2', width: 96,
  keys: 'type @ / # for completions · ! starts shell mode · Ctrl+K add an image · Ctrl+V paste text · Backspace selects then removes a token · ↑↓ queue then history · Ctrl+R running · Ctrl+O conversation · Ctrl+W width',
  state: () => ({ tokens: [], queued: ['also update the footer'], history: [...PROMPT_HISTORY], running: false, shell: false, ctx: 0, w: 0, reset: { rev: 0, value: '' }, pulled: null, n: 1, log: '' }),
  width: (c, s) => [96, 60, 40][s.w],
  build(rt, s) {
    const text = rt.state('prompt').text ?? ''
    const m = !s.shell && /(^|\s)([@/#])(\S*)$/.exec(text)
    const pool = m ? { '@': PROMPT_FILES, '/': PROMPT_COMMANDS, '#': PROMPT_SKILLS }[m[2]].filter(x => x.label.slice(1).startsWith(m[3])) : []
    const x = EDITOR_CONTEXTS[s.ctx]
    return ui.stack.column([
      MC.Editor({ title: x.title, mode: s.shell ? 'shell' : 'prompt', tokens: s.tokens, queued: s.queued, recall: [...s.queued.map(t => ({ kind: 'queued', text: t })), ...s.history.map(t => ({ kind: 'history', text: t }))], placeholder: s.shell ? ['Run a shell command · Esc leaves shell mode'] : s.running && x.running ? x.running : x.variants, completions: pool.length ? { items: pool } : undefined, reset: s.reset }),
      rt.feedbackNode(),
    ])
  },
  onEvent(e, rt, s) {
    const setText = value => { s.reset = { rev: s.reset.rev + 1, value } }
    if (e.kind === 'value-change' && e.controlId === 'prompt' && e.value === '!' && !s.shell) { s.shell = true; setText('') }
    else if (e.kind === 'completion-accept') {
      const text = rt.state('prompt').text ?? '', pool = { '@': PROMPT_FILES, '/': PROMPT_COMMANDS, '#': PROMPT_SKILLS }
      const word = /[@/#]\S*$/.exec(text)?.[0] ?? '', all = pool[word[0]] ?? [], it = all.find(i => i.id === e.itemId)
      if (word[0] === '@') { s.tokens.push({ id: `t${s.n++}`, label: it.label, size: it.size }); setText(text.slice(0, -word.length)) }
      else setText(text.slice(0, -word.length) + it.label + ' ')
    }
    else if (e.kind === 'token-remove') { s.tokens = s.tokens.filter(t => t.id !== e.tokenId); rt.say('Removed the attachment', 'info') }
    else if (e.kind === 'recall-change') s.pulled = e.source === 'queued' ? e.index : null
    else if (e.kind === 'submit') {
      if (s.pulled != null) { s.queued.splice(s.pulled, 1); s.pulled = null }
      if (s.shell) { rt.say(`ran "${e.value}" in the shell (the border stays accent until Esc)`, 'success'); return }
      if (s.running) { s.queued.push(e.value); rt.say('Queued — it sends when the agent finishes', 'info') } else { s.history.unshift(e.value); rt.say(`Sent${e.tokens.length ? ` with ${e.tokens.length} attachment${e.tokens.length > 1 ? 's' : ''}` : ''}`, 'success') }
      s.tokens = []
    }
  },
  key(k, s) {
    const text = this.rt.state('prompt').text ?? ''
    if (k === '\x0b') { s.tokens.push({ id: `t${s.n++}`, label: `Image #${s.tokens.filter(t => t.label.startsWith('Image')).length + 1}`, size: '84 KB' }); return true }
    if (k === '\x16') { s.tokens.push({ id: `t${s.n++}`, label: `Pasted #${s.tokens.filter(t => t.label.startsWith('Pasted')).length + 1}`, size: '12 lines' }); return true }
    if (k === '\x12') { s.running = !s.running; return true }
    if (k === '\x0f') { s.ctx = (s.ctx + 1) % EDITOR_CONTEXTS.length; return true }
    if (k === '\x17') { s.w = (s.w + 1) % 3; return true }
    if (s.shell && (k === '\x1b' || (k === '\x7f' && text === ''))) { s.shell = false; return true }
  },
  before: (c, s) => draw(caption(`${EDITOR_CONTEXTS[s.ctx].note} · ${s.running ? 'agent running' : 'idle'}${s.shell ? ' · shell mode: the border is accent-colored, nothing else changes' : ''}`), { width: 96, f: 0, t: 0 }).concat(['']),
})

// ======================================================================= MAYFLY: notices
pagesScene({
  layer: 'mayfly', name: 'Notices and banners', section: '§5.2', count: 2, width: WIDE,
  pages() {
    return [
      ['banners: one row, a glyph and a word, severity by tone', c => [
        ...draw(MC.Banner({ severity: 'warning', title: 'Rate limited', detail: '· retrying in 12s · attempt 2 of 5', tail: 'Esc cancel' }), c), ...draw(MC.Banner({ severity: 'error', title: 'Offline', detail: '· cannot reach api.deepseek.com', tail: 'r retry' }), c),
        ...draw(MC.Banner({ severity: 'warning', title: 'Context 92% full', detail: '· /compact now, or it will compact automatically at 95%' }), c), ...draw(MC.Banner({ severity: 'info', title: 'Resumed session', detail: '· 24 turns · last active 2h ago' }), c)]],
      ['toasts live in the activity gap; an undo toast carries its key and its deadline', c => [
        ...draw(ui.stack.row([ui.child(ui.richText([S('⊘ ', 'muted'), S('Deleted session "Docs sync"')]), { priority: 0 }), ui.child(ui.richText([mu('u undo · 8s')]), { priority: 1, band: 'right' })], { gap: 2 }), c), '',
        ...draw(MC.ActivityRow({ phase: 'working', label: 'Deep diving', counts: { elapsed: 4000 }, gap: '✓ build finished · 22s  Ctrl+J view' }), c)]],
    ]
  },
})



const WRITE_CODE = ['import type { Frame } from \'./types.ts\'', '', '/** Glyph frames for each activity phase; one frame per 100 ms tick. */', 'export const FRAMES: Record<string, string[]> = {', "  thinking: ['✻', '✺', '✹', '✸'],", "  tool: ['●', '◉', '○', '◉'],", '}', '', 'export function frameFor(phase: string, tick: number): Frame {', '  const frames = FRAMES[phase] ?? FRAMES.tool', '  return { glyph: frames[tick % frames.length], phase }', '}'].join('\n')
// ======================================================================= MAYFLY: tool rows and edits
scene({
  layer: 'mayfly', name: 'Tool rows and edits', section: '§5.3', keys: 'Ctrl+N/Ctrl+P page',
  init() { this.p = 0 },
  lines(c) {
    const T = c.t % 9000
    const cats = [['Running commands', 'pnpm run verify:changed -- --plan'], ['Reading files', 'packages/mayfly/src/transcript/pane-activity.ts'], ['Searching code', '"activity" in packages/'], ['Visiting web pages', 'https://pi.dev/docs/latest/tui'], ['Updating the plan', '3 of 5 items done']]
    const [lab, det] = cats[Math.floor(c.t / 1600) % cats.length]
    const path = 'pane-activity.ts'
    const P = [
      ['running calls: the category picks the label and the detail (cycles every 1.6 s); a question waits on you', col(MC.ActivityRow({ phase: 'tool', label: lab, detail: [det], counts: { elapsed: 12000 } }), ui.spacer(), MC.ActivityRow({ phase: 'user', label: 'Waiting for your action', detail: ['Which release channel should this go to?'], counts: { elapsed: 8000 } }))],
      ['settled calls: one static past-tense line each; a folded turn is one summary', col(
        MC.ToolLine({ verb: 'Read', target: path, outcome: '481 lines' }), MC.ToolLine({ verb: 'Searched', target: '"activity"', outcome: '47 matches in 12 files' }), MC.ToolLine({ verb: 'Ran', target: 'pnpm run check:lib', outcome: '4.2s' }), MC.ToolLine({ ok: false, verb: 'Ran', target: 'pnpm run lint', outcome: 'exit 1 · 3s' }), MC.ToolLine({ verb: 'Fetched', target: 'pi.dev/docs/latest/tui', outcome: '200 · 18 KB' }), MC.ToolLine({ cancelled: true, verb: 'Ran', target: 'pnpm run build' }), MC.ToolLine({ folded: true, verb: 'Read 3 files · Searched code · Ran 2 commands · 6s' }))],
      ['edit: three phases — arguments streaming, applying (the counts tick up), then settled with a flash and a numbered diff', c => T < 2500
        ? draw(MC.ActivityRow({ phase: 'tool', label: 'Preparing to edit files', counts: { elapsed: 3000, up: '0.4', down: '0.8k' } }), c)
        : T < 5000 ? draw(col(MC.ActivityRow({ phase: 'tool', label: 'Editing files', detail: [path], counts: { elapsed: 5000 } })), c)
          : draw(MC.EditCard({ file: path, added: 12, removed: 3, before: EDIT_BEFORE, after: EDIT_AFTER, start: 41 }), c)],
      ['multi-file patch and a failed edit', col(
        MC.EditCard({ multi: [{ kind: 'M', file: 'pane-activity.ts', a: 34, d: 12 }, { kind: 'A', file: 'frame-table.ts', a: 18, d: 0 }, { kind: 'D', file: 'moon-frames.ts', a: 0, d: 9 }], added: 52, removed: 21 }), ui.spacer(),
        MC.EditCard({ file: path, added: 0, removed: 0, status: 'failed' }))],
      ['write is not a diff: collapsed it is one line, Ctrl+O shows the file with syntax highlighting and line numbers; an edit keeps the red/green diff', c => [
        ...draw(caption('Write, collapsed'), c), ...draw(MC.WriteCard({ path: 'packages/mayfly/src/transcript/frame-table.ts', code: WRITE_CODE, language: 'ts', size: '0.6 KB' }), c), '',
        ...draw(caption('Write, expanded (Ctrl+O)'), c), ...draw(MC.WriteCard({ path: 'packages/mayfly/src/transcript/frame-table.ts', code: WRITE_CODE, language: 'ts', size: '0.6 KB', expanded: true }), c), '',
        ...draw(caption('Edit, expanded: removed rows on a red band, added rows on a green band, the old and new line numbers in the gutter'), c), ...draw(MC.EditCard({ file: path, added: 2, removed: 1, before: EDIT_BEFORE, after: EDIT_AFTER, start: 41 }), c)]],
    ]
    const [cap, body] = P[this.p]
    return [...draw(caption(`page ${this.p + 1}/${P.length} (Ctrl+N): ${cap}`), c), '', ...(typeof body === 'function' ? body(c) : draw(body, c))]
  },
  key(k) { if (k === '\x0e') this.p = (this.p + 1) % 5; else if (k === '\x10') this.p = (this.p + 4) % 5 },
})


// ======================================================================= MAYFLY: transcript levels
const T_HERO = { id: 't1', time: '10:02', user: 'Update the landing page hero copy and run the tests.', secs: '38s', steps: [
  { t: 'think', text: 'I will read the hero component, unify the heading, then run the tests.' }, { t: 'read', label: 'Hero.tsx', out: '96 lines' }, { t: 'search', label: '"heading"', out: '7 matches in 3 files' },
  { t: 'edit', file: 'Hero.tsx', a: 4, d: 2, start: 12, before: ['  return (', '    <h1>Build agents faster</h1>', '    <p>{sub}</p>'].join('\n'), after: ['  return (', '    <h1>Ship agent UI in a keystroke</h1>', '    <p>{sub}</p>'].join('\n') },
  { t: 'bash', cmd: 'pnpm run test', ok: false, secs: '12.1s', tail: ['FAIL width-scan.spec.ts', '  tool-line row is 62 cells, expected ≤ 60', '1 failed · 213 passed'] },
  { t: 'edit', file: 'tool-line.ts', a: 6, d: 1, start: 87, before: ['  const full = toolDetail(call)', '  const detail = full'].join('\n'), after: ['  const full = toolDetail(call)', '  const detail = truncate(full, width - 4)'].join('\n') },
  { t: 'bash', cmd: 'pnpm run test', ok: true, secs: '11.8s', tail: ['214 passed'] },
], answer: ['Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.', 'The one failure was a truncation bug in the tool-line row, fixed in the same change.'] }
const T_FAIL = { id: 't2', time: '10:04', user: 'Now bump the changelog and run the full gate.', secs: '4m 12s', fail: 'verify:full timed out after 4m', steps: [
  { t: 'read', label: 'CHANGELOG.md', out: '210 lines' }, { t: 'edit', file: 'CHANGELOG.md', a: 3, d: 0, start: 6, before: '', after: ['## Unreleased', '- Hero copy now reads "Ship agent UI in a keystroke".', '- Width scan covers the new panels.'].join('\n') },
  { t: 'bash', cmd: 'pnpm run verify:full', ok: false, secs: '4m 0s', tail: ['…', 'coverage: 100% (214 files)', 'timed out'] }], answer: [] }
const T_LIVE = { id: 't3', time: '10:09', user: 'Regenerate the screenshots and check that they are fresh.', secs: '21s', live: true, steps: [
  { t: 'think', text: 'Run shots:sync first, then shots:check to confirm.' }, { t: 'bash', cmd: 'pnpm run shots:sync', ok: true, secs: '8.0s', tail: ['wrote 14 screenshots'] },
  { t: 'bash', cmd: 'pnpm run shots:check', ok: true, secs: '1.2s', tail: ['14 files up to date'], running: true, live: ['checking 14 files…', 'framed.svg  ok'] }], answer: ['Screenshots are fresh: shots:sync wrote 14 files and shots:check agrees.'] }
const LEVELS = ['compact', 'standard', 'detailed', 'verbose']
const STREAM_TURNS = [T_HERO, T_FAIL, T_LIVE]
const levelRows = (L, running) => render(MC.TranscriptView({ turns: STREAM_TURNS, level: L, running }), { width: 96 }).length
/** The ids of the rows whose text (including the details a level hides) matches; a turn with a match opens at Verbose. */
const streamMatches = q => {
  if (!q) return []
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), out = []
  for (const t of STREAM_TURNS) {
    if (re.test(t.user)) out.push({ id: t.id, turn: t.id })
    t.steps.forEach((s, i) => { const hay = [s.text, s.cmd, s.file, s.label, s.out, ...(s.tail ?? []), s.before, s.after].filter(Boolean).join('\n'); if (re.test(hay)) out.push({ id: s.t === 'edit' ? `${t.id}.${s.file}` : `${t.id}.s${i}`, turn: t.id }) })
    t.answer.forEach((l, i) => { if (re.test(l)) out.push({ id: `${t.id}.a${i}`, turn: t.id }) })
  }
  return out
}
rtScene({
  layer: 'mayfly', name: 'Conversation stream', section: '§5.6', width: 96,
  keys: 'Alt+↑ select a row · ↑↓ move · Enter expand · c copy · Ctrl+G open in editor · Ctrl+F search · Alt+↓ back to the prompt · Ctrl+O level · Ctrl+R running · Ctrl+D request card',
  state: () => ({ level: 1, toggled: new Set(), running: true, card: null, query: '', searching: false, cur: 0, rev: 0, focus: null }),
  build(rt, s) {
    const matches = streamMatches(s.query)
    const force = new Set(matches.map(m => m.turn))
    const facts = { ...FACTS, agents: AGENTS, jobs: JOBS, todo: todoAt(Date.now() % 12000), goal: { round: 2, rounds: 8, state: 'active', text: 'Ship the hero refresh' } }
    const counts = [0, 1, 2, 3].map(L => levelRows(L, s.running))
    return ui.stack.column([
      ui.richText([S(`level ${LEVELS[s.level]} · ${counts[s.level]} rows (Ctrl+O cycles ${counts.join(' · ')})`, 'muted')]),
      MC.TranscriptView({ turns: STREAM_TURNS, level: s.level, toggled: s.toggled, forceVerbose: force, running: s.running, request: s.card ? { card: s.card, diffBefore: EDIT_BEFORE, diffAfter: EDIT_AFTER } : undefined, focusItem: s.focus, query: s.query }),
      s.searching ? MC.StreamSearch({ query: s.query, count: matches.length, cur: Math.min(s.cur, Math.max(0, matches.length - 1)) }) : null,
      s.running && !s.card ? MC.ActivityRow({ phase: 'tool', label: 'Running commands', detail: ['pnpm run shots:check'], counts: { elapsed: 8000, up: '30.2k', down: '4.1k' } }) : null,
      s.card ? MC.DecisionCard({ card: s.card, variant: 'A' }) : MC.Editor({ title: 'Update the landing page hero', recall: [{ kind: 'history', text: 'run the width scan again' }], placeholder: ['Type a follow-up to queue it · @ files · # skills'] }),
      s.card ? null : MC.StatusBar({ facts }),
      s.card ? null : MC.ViewRow({ facts, conversations: 1 }),
      rt.feedbackNode(),
    ])
  },
  onEvent(e, rt, s) {
    const matches = streamMatches(s.query)
    const go = () => { if (matches.length) s.focus = { id: matches[s.cur].id, rev: ++s.rev } }
    if (e.kind === 'selection-accept' && e.controlId === 'stream') { s.toggled.has(e.itemId) ? s.toggled.delete(e.itemId) : s.toggled.add(e.itemId) }
    else if (e.kind === 'activate' && e.actionId === 'copy') rt.say(`Copied "${e.selected.stream ?? 'row'}" to the clipboard`, 'success')
    else if (e.kind === 'activate' && e.actionId === 'open') rt.say(e.controlId === 'decision' ? 'Opened the full content in $EDITOR — saving does not change the request' : `Opened "${e.selected.stream ?? 'row'}" in $EDITOR`, 'success')
    else if (e.kind === 'value-change' && e.controlId === 'search') { s.query = e.value; s.cur = 0; go() }
    else if (e.kind === 'submit' && e.controlId === 'search') { if (matches.length) { s.cur = (s.cur + 1) % matches.length; go() } }
    else if (e.kind === 'dismiss' && s.searching) { s.searching = false; rt.setFocus('stream'); return { kind: 'cancelled' } }
    else if (e.kind === 'selection-accept' && e.controlId === 'decision') { rt.say(`You chose "${e.itemId}"`, 'success'); s.card = null }
    else if (e.kind === 'activate' && e.actionId === 'copy') rt.say('Copied', 'success')
  },
  key(k, s) {
    if (keymap.keys('ui.search').includes(keyName(k))) { s.searching = true; this.rt.setFocus('search'); return true }
    if (k === '\x0f') { s.level = (s.level + 1) % 4; return true }
    if (k === '\x12') { s.running = !s.running; return true }
    if (k === '\x04') { s.card = [null, 'command', 'edit', 'plan'][([null, 'command', 'edit', 'plan'].indexOf(s.card) + 1) % 4]; this.rt.reset(); return true }
  },
  after: (c, s) => ['', ...draw(caption(s.card ? 'the agent\'s request is the newest stream row, with today\'s content; the card below it is the decision (Ctrl+G opens an edit or a plan in $EDITOR)' : 'Alt+↑ from the prompt selects a stream row; recall, search, and the views row work from here'), { width: 96, f: 0, t: 0 })],
})


// ======================================================================= MAYFLY: prompt styles
const T_LONG = { id: 't4', time: '10:03', user: 'Before the release, audit every place that still prints "Working" instead of "Deep diving": the activity row, the tips, the website pages, and the screenshots. List each file you changed, keep the diff small, and do not touch the locale files for other languages. Run the width scan when you are done and tell me which cases cover narrow terminals.', secs: '17s', steps: [
  { t: 'search', label: '"Working"', out: '11 matches in 5 files' }, { t: 'read', label: 'tips-content.ts', out: '212 lines' },
  { t: 'edit', file: 'tips-content.ts', a: 2, d: 2, start: 31, before: ["  'Working · @ files',", "  'Working · / commands',"].join('\n'), after: ["  'Deep diving · @ files',", "  'Deep diving · / commands',"].join('\n') },
  { t: 'bash', cmd: 'pnpm run test:width', ok: true, secs: '3.4s', tail: ['44 cases passed'] }], answer: ['Done — 5 files updated; the width scan has 6 narrow cases (24 to 60 columns) and all pass.'] }
const PS_TURNS = [T_HERO, T_LONG, T_FAIL]
const PS_INFO = {
  plain: ['today: one bold `»` row in the user tone', 'no gap, no landmark; a wrapped prompt has no marker'],
  rule: ['A (chosen) — a blank row and a muted rule with the time before every turn after the first', '+2 rows per turn; monochrome-safe; the turn boundary is explicit and the prompt keeps its own row'],
  indent: ['B — hanging indent: the prompt is the only row in the first column, everything else sits under it', '0 rows; monochrome-safe; costs 2 columns of output width'],
  bar: ['C — a `▎` quote bar in the user tone down every line of the prompt', '0 rows; monochrome-safe; fixes the wrapped-line problem'],
  band: ['D — a background band behind the whole prompt, like the diff code', '0 rows; needs truecolor (m shows the monochrome fallback)'],
  card: ['E — the prompt is a titled rounded card', '+2 rows per turn; clearest; breaks the rule against boxed sub-panels'],
  recommended: ['the earlier recommendation — a blank row, hanging indent, quote bar, and band; capped at 4 lines', '+1 row per turn; band drops away in monochrome and bar + indent remain (not chosen)'],
}
rtScene({
  layer: 'mayfly', name: 'Prompt styles', section: '§5.6', width: (c, s) => [96, 64, 44][s.w],
  keys: '1-7 style (today, A rule, B indent, C bar, D band, E card, recommended) · l level · m monochrome · w width · ↑↓ select · Enter opens a capped prompt',
  state: () => ({ style: 1, level: 0, mono: false, w: 0, toggled: new Set() }),
  build(rt, s) {
    theme.mono = s.mono
    return MC.TranscriptView({ turns: PS_TURNS, level: s.level, toggled: s.toggled, promptStyle: MC.PROMPT_STYLES[s.style] })
  },
  onEvent(e, rt, s) { if (e.kind === 'selection-accept') { s.toggled.has(e.itemId) ? s.toggled.delete(e.itemId) : s.toggled.add(e.itemId) } },
  before(c, s) {
    const [a, b] = PS_INFO[MC.PROMPT_STYLES[s.style]]
    return [...draw(ui.stack.column([ui.richText([S(`${s.style + 1} ${MC.PROMPT_STYLES[s.style]}`, 'primary', ['strong']), mu(`  ${LEVELS[s.level]} · ${[96, 64, 44][s.w]} columns${s.mono ? ' · monochrome' : ''}`)]), caption(a), caption(b)]), { width: 96, f: 0, t: 0 }), '']
  },
  key(k, s) {
    if (k >= '1' && k <= '7') { s.style = Number(k) - 1; return true }
    if (k === 'l') { s.level = (s.level + 1) % 4; return true }
    if (k === 'm') { s.mono = !s.mono; return true }
    if (k === 'w') { s.w = (s.w + 1) % 3; return true }
  },
  after() { theme.mono = false; return [] },
})

scene({
  layer: 'mayfly', name: 'Compaction', section: '§5.6', keys: 'a failed state (f) · the bar is the real context occupancy',
  init() { this.fail = false },
  lines(c) {
    const T = c.t % 10000
    const stage = T < 5000 ? ['summarizing: the model call runs, the edge cell breathes', { stage: 1, percent: 91 }] : T < 5800 ? ['the summary landed: the bar drains (one-shot, 800 ms)', { stage: 2, percent: Math.max(9, Math.round(91 - (T - 5000) / 800 * 82)) }] : ['settled (static)', { stage: 'done', items: 84, before: 91, after: 9 }]
    return [...draw(caption(`stage: ${stage[0]}`), c), '', ...draw(MC.CompactionRow(stage[1]), c), '', ...draw(caption('narrow terminals drop the bar first, then the token pair; a failure keeps its reason'), c), ...draw(MC.CompactionRow({ stage: 'failed' }), c)]
  },
})

// ======================================================================= MAYFLY: approval, plan review, permission
rtScene({
  layer: 'mayfly', name: 'Approval, plan review, permission', section: '§5.7', pages: 4, width: 78, keys: 'Ctrl+T switch variant A/B · Ctrl+X simulate a stray "1" + Enter · Ctrl+N next card · Ctrl+G open the diff or plan in $EDITOR · c copy the plan',
  state: () => ({ page: 0, variant: 'A', last: '', stray: '' }),
  build(rt, s) {
    const card = MC.DECISION_CARDS[s.page]
    return ui.stack.column([
      card === 'permission' ? null : MC.TranscriptView({ turns: [], level: 1, request: { card, diffBefore: EDIT_BEFORE, diffAfter: EDIT_AFTER.replace('glyphFor(state)', 'glyphFor(state)  // moon retired') } }),
      MC.DecisionCard({ card, variant: s.variant }), rt.feedbackNode(),
    ])
  },
  onEvent(e, rt, s) {
    if (e.kind === 'selection-accept') { s.last = `→ ${e.itemId}`; rt.say(`chose "${e.itemId}"`, ['reject', 'default', 'keep'].includes(e.itemId) ? 'info' : 'success') }
    else if (e.kind === 'activate' && e.actionId === 'copy') rt.say('Plan copied to the clipboard', 'success')
    else if (e.kind === 'activate' && e.actionId === 'open') rt.say(`Opened the ${MC.DECISION_CARDS[s.page] === 'plan' ? 'plan' : 'diff'} in $EDITOR — closing it returns here, the request stays open`, 'success')
  },
  before(c, s) { return [...draw(ui.text(`variant ${s.variant}: ${s.variant === 'A' ? 'safe-first — Reject is row 1, a digit only moves the cursor, a grant costs two keys' : 'grant-first — the common grant is row 1, a digit chooses at once'}  ·  card ${s.page + 1}/4`, { tone: 'muted' }), { width: 96, f: 0, t: 0 }), ''] },
  after(c, s) { return ['', ...draw(ui.stack.column([ui.text(s.stray ? s.stray : 'press Ctrl+X: a "1" and an Enter typed into the editor a moment before this card opened', { tone: s.stray.includes('GRANTED') ? 'warning' : 'muted' })]), { width: 96, f: 0, t: 0 })] },
  key(k, s) {
    if (k === '\x14') { s.variant = s.variant === 'A' ? 'B' : 'A'; this.rt.reset(); s.stray = ''; return true }
    if (k === '\x18') {
      this.rt.reset(); s.last = ''; this.rt.render(78); this.rt.key('1'); this.rt.key('\r')
      const grants = ['once', 'session', 'start', 'auto']
      s.stray = !s.last ? 'stray 1 + Enter → nothing happened (the digit only moved the cursor, and Enter on Reject answers no)' : grants.includes(s.last.slice(2)) ? `stray 1 + Enter → "${s.last.slice(2)}" is GRANTED before the user saw the card` : `stray 1 + Enter → "${s.last.slice(2)}" (nothing is granted; the agent is told no)`
      return true
    }
  },
})

// ======================================================================= MAYFLY: questions
const QS = [
  { id: 'auth', tab: 'Auth', text: 'Which auth method should the CLI use?', multi: false, options: [{ label: 'OAuth', detail: 'browser sign-in, tokens refresh automatically' }, { label: 'API key', detail: 'paste a token; you rotate it yourself' }] },
  { id: 'region', tab: 'Region', text: 'Which region should the service deploy to?', multi: false, options: [{ label: 'us-east-1', detail: 'lowest latency to most users' }, { label: 'eu-west-1', detail: 'GDPR data residency' }, { label: 'ap-south-1', detail: 'closest to the pilot customers' }] },
  { id: 'scopes', tab: 'Scopes', text: 'Which scopes should the token carry?', multi: true, options: [{ label: 'read', detail: 'list and fetch resources' }, { label: 'write', detail: 'create and update resources' }, { label: 'admin', detail: 'manage members and billing' }] },
]
rtScene({
  layer: 'mayfly', name: 'Questions', section: '§5.8', width: 78, keys: 'digits answer at once · ←/→ move between questions · ↓ from the last option focuses Other · Enter on Review submits',
  state: () => ({ step: 'auth', answers: {}, done: false }),
  build(rt, s) {
    if (s.done) return ui.surface({ title: 'Questions', chrome: 'overlay', badges: [S('submitted', 'muted')], child: ui.richText([S('✓ ', 'success'), S('Answers sent to the agent.')]) })
    return MC.QuestionsPanel({ questions: QS, step: s.step, answers: s.answers, feedback: rt.feedbackNode() })
  },
  onEvent(e, rt, s) {
    const next = () => { const i = [...QS.map(q => q.id), 'review'].indexOf(s.step); s.step = [...QS.map(q => q.id), 'review'][Math.min(i + 1, QS.length)] }
    if (e.kind === 'tab-change') s.step = e.tabId
    else if (e.kind === 'selection-accept' && e.controlId === 'review') { if (e.itemId === 'submit') s.done = true; else s.step = e.itemId }
    else if (e.kind === 'selection-accept') { s.answers[s.step] = e.selectedIds; next() }
    else if (e.kind === 'submit') { s.answers[s.step] = [`Other: ${e.values.other}`]; next() }
  },
})

// ======================================================================= MAYFLY: /model and /effort
const MODEL_DATA = [
  { id: 'op-pro', provider: 'opencode-go', name: 'DeepSeek V4 Pro (New)', ctx: '977k', efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { id: 'op-flash', provider: 'opencode-go', name: 'deepseek-v4.1-flash', ctx: '977k', efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { id: 'op-bunny', provider: 'opencode-go', name: 'space-bunny-alpha', ctx: '256k' },
  { id: 'ds-flash', provider: 'DeepSeek', name: 'DeepSeek-V41-Flash', ctx: '977k', efforts: ['min', 'high', 'max'], defaultEffort: 'high', live: true, liveEffort: 'high' },
  { id: 'ds-pro', provider: 'DeepSeek', name: 'DeepSeek-V4-Pro', ctx: '977k', efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { id: 'cu', provider: 'custom', name: 'some-model', ctx: '128k', efforts: ['low', 'medium', 'high'] },
]
rtScene({
  layer: 'mayfly', name: '/model and /effort', section: '§5.9', pages: 2, width: (c, s) => (s.narrow ? 62 : 84), keys: 'Ctrl+N /effort · Ctrl+W width · ←/→ thinking · Delete use default · type or / filters',
  state: () => ({ page: 0, narrow: false, models: structuredClone(MODEL_DATA), current: 'default' }),
  build(rt, s) { return s.page === 0 ? MC.ModelPicker({ models: s.models }) : MC.EffortPicker({ model: 'DeepSeek/DeepSeek-V41-Flash', levels: ['min', 'high', 'max'], current: s.current, defaultLevel: 'high' }) },
  onEvent(e, rt, s) {
    if (e.kind !== 'selection-accept') return
    if (s.page === 1) { s.current = e.itemId; rt.say(e.itemId === 'default' ? 'Thinking set to high (provider default)' : `Thinking set to ${e.itemId}`, 'success'); return }
    const m = s.models.find(x => x.id === e.itemId)
    s.models.forEach(x => { x.live = x === m; delete x.liveEffort })
    m.liveEffort = m.efforts ? (e.segmentId ?? m.defaultEffort) : undefined
    rt.say(`Switched to ${m.name} (${m.provider})${m.efforts ? ` · thinking ${e.segmentId ?? 'provider default'}` : ''}`, 'success')
  },
  after(c, s) { const f = this.rt.feedbackNode(); return f ? ['', ...draw(f, { width: 84, f: 0, t: 0 })] : [] },
  key(k, s) { if (k === '\x17') { s.narrow = !s.narrow; return true } },
})

// ======================================================================= MAYFLY: /sessions
const WS = [
  { path: '/home/ubuntu/work/mayfly', count: 8, sessions: [{ title: 'Update landing page hero', branch: 'main', turns: 12, age: '2m', prompt: 'Update the landing page hero copy and run the tests.', outcome: 'Done — the hero now reads "Ship agent UI in a keystroke".' }, { title: 'Fix width scan for tool rows', branch: 'fix/width', turns: 4, age: '1h', prompt: 'The tool rows overflow at 60 columns.', outcome: 'Added a truncate variant; scan passes.' }, { title: 'Release 0.1.3-rc.2', branch: 'release', turns: 9, age: '1d', prompt: 'Prepare the rc.2 release notes.', outcome: 'Tarballs verified.' }] },
  { path: '/home/ubuntu/dev/clients/acme/monorepo/packages/mayfly', count: 5, sessions: [{ title: 'Port the tray to acme layout', branch: 'feat/tray', turns: 6, age: '3h', prompt: 'Port the tray design to the acme fork.', outcome: 'Rebased; specs pass.' }, { title: 'Bump harness pins', branch: 'main', turns: 3, age: '2d', prompt: 'Update the harness line pins.', outcome: 'Pins updated.' }] },
  { path: '/home/ubuntu/dev/experiments/very-long-project-name-here', count: 4, sessions: [{ title: 'Spike: session graph', branch: 'spike', turns: 2, age: '9d', prompt: 'Sketch a session graph view.', outcome: 'Parked.' }] },
  { path: '/home/ubuntu/work/website', count: 5, sessions: [{ title: 'Add pricing page', branch: 'main', turns: 7, age: '4h', prompt: 'Add a pricing page under docs.', outcome: 'Preview is up.' }, { title: 'Fix dark-mode logo', branch: 'fix/logo', turns: 2, age: '2d', prompt: 'The logo is illegible in dark mode.', outcome: 'Swapped the asset.' }] },
]
rtScene({
  layer: 'mayfly', name: '/sessions', section: '§5.10', width: 96, keys: '↑↓ labels · → into sessions · / filter · c copy path · n new · x delete · u undo',
  state: () => ({ active: WS[0].path, ws: structuredClone(WS), deleted: null }),
  build(rt, s) {
    const wsList = s.ws
    return MC.SessionsPanel({ workspaces: wsList, active: wsList.some(w => w.path === s.active) || s.active === 'all' ? s.active : wsList[0].path, feedback: rt.feedbackNode() })
  },
  onEvent(e, rt, s) {
    if (e.kind === 'tab-change') s.active = e.tabId
    else if (e.kind === 'activate') {
      if (e.actionId === 'copy') rt.say('Copied the full path', 'success')
      else if (e.actionId === 'new') rt.say('Started a new session in this workspace', 'success')
      else if (e.actionId === 'delete') { const w = s.ws.find(x => x.path === s.active); if (w?.sessions.length) { s.deleted = w.sessions.shift(); w.count--; rt.say(`⊘ Deleted "${s.deleted.title}"  u undo · 8s`, 'info') } }
    }
  },
})

// ======================================================================= MAYFLY: /settings
const SETTING_GROUPS = [
  { id: 'general', label: 'General', fields: [{ id: 'lang', kind: 'select', label: 'Language', value: 'English', options: [{ id: 'English' }, { id: '简体中文' }] }, { id: 'notif', kind: 'toggle', label: 'Notifications', value: true }, { id: 'tele', kind: 'toggle', label: 'Telemetry', value: false }] },
  { id: 'model', label: 'Model', fields: [{ id: 'model', kind: 'select', label: 'Model', value: 'deepseek-chat', origin: 'inherited', options: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }, { id: 'effort', kind: 'select', label: 'Effort', value: 'medium', origin: 'inherited', options: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] }, { id: 'ctx', kind: 'number', label: 'Context', value: 128, min: 32, max: 256, step: 32, unit: 'k', origin: 'inherited' }] },
  { id: 'perm', label: 'Permissions', fields: [{ id: 'preset', kind: 'select', label: 'Preset', value: 'Default', options: [{ id: 'Default' }, { id: 'Accept edits' }, { id: 'Full access' }] }, { id: 'allow', kind: 'multiselect', label: 'Auto-allow', value: ['read', 'grep'], options: [{ id: 'read' }, { id: 'grep' }, { id: 'bash' }, { id: 'write', disabled: true, disabledReason: 'needs Accept edits' }] }] },
  { id: 'providers', label: 'Providers', fields: [{ id: 'p', kind: 'select', label: 'Provider', value: 'DeepSeek', options: [{ id: 'DeepSeek' }, { id: 'Local' }] }, { id: 'k', kind: 'secret', label: 'API key', value: 'sk-0123456789' }] },
  { id: 'appearance', label: 'Appearance', fields: [{ id: 'theme', kind: 'select', label: 'Theme', value: 'dark', options: [{ id: 'dark' }, { id: 'light' }, { id: 'ocean' }, { id: 'paper' }] }, { id: 'dens', kind: 'select', label: 'Density', value: 'comfortable', options: [{ id: 'compact' }, { id: 'comfortable' }] }] },
]
rtScene({
  layer: 'mayfly', name: '/settings', section: '§5.10', width: 84, keys: '↑↓ groups · → into the form · ← back · each group keeps its own draft; edits apply as you go',
  state: () => ({ active: 'general' }),
  build(rt, s) { return MC.SettingsPanel({ groups: SETTING_GROUPS, active: s.active, feedback: rt.feedbackNode() }) },
  onEvent(e, rt, s) { if (e.kind === 'tab-change') s.active = e.tabId; else if (e.kind === 'value-change') rt.say(`Saved ${e.fieldId}`, 'success') },
})

// ======================================================================= MAYFLY: /status
const WEEKS = 26
const ACTIVITY = (() => { let x = 7; const r = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; const values = ['Mon', 'Wed', 'Fri', 'Sun'].map((_, ri) => Array.from({ length: WEEKS }, (_, w) => { const v = r() * (ri === 3 ? 0.7 : 1) * (0.4 + w / WEEKS * 0.8); return v < 0.25 ? 0 : v < 0.45 ? 1 : v < 0.65 ? 2 : v < 0.85 ? 3 : 4 })); const monthLabels = Array(WEEKS).fill(''); ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'].forEach((m, i) => { monthLabels[Math.round(i * 4.3)] = m }); return { weeks: Array(WEEKS).fill(0), monthLabels, values, recent: [3, 5, 2, 0, 6, 8, 4, 7, 9, 3, 5, 11, 8, 6] } })()
rtScene({
  layer: 'mayfly', name: '/status', section: '§5.10', width: 84, keys: '←/→ tabs · b cycle the balance state (demo) · r refresh · o open the top-up page',
  state: () => ({ tab: 'overview', bal: 0 }),
  build(rt, s) {
    return ui.stack.column([MC.StatusPanel({ tab: s.tab, balance: ['ok', 'low', 'loading', 'error', 'none'][s.bal], activity: ACTIVITY }), ui.actions({ id: 'status.keys', items: [{ id: 'refresh', label: 'Refresh', key: 'r', hidden: true, hintLabel: 'refresh' }, { id: 'topup', label: 'Top up', key: 'o', hidden: true, hintLabel: 'top up in browser' }] }), rt.feedbackNode()])
  },
  onEvent(e, rt, s) { if (e.kind === 'tab-change') s.tab = e.tabId; else if (e.kind === 'activate') rt.say(e.actionId === 'refresh' ? 'Checked just now' : 'Opened platform.deepseek.com', 'success') },
  key(k, s) { if (k === 'b') { s.bal = (s.bal + 1) % 5; return true } },
  after(c, s) { return ['', ...draw(caption(`balance state: ${['available', 'low', 'loading', 'unavailable', 'unsupported (hidden)'][s.bal]} — one optional read-only query; a failed check never affects the conversation`), { width: 96, f: 0, t: 0 })] },
})

// ======================================================================= MAYFLY: /plugin marketplace
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
rtScene({
  layer: 'mayfly', name: '/plugin marketplace', section: '§5.11', width: (c, s) => (s.narrow ? 84 : 112), keys: '←/→ tab · / filter · i install · u update · x remove · s source · r refresh · Ctrl+W width · Ctrl+O offline (demo)',
  state: () => ({ tab: 'installed', entries: structuredClone(MARKET), source: 'npm', op: null, pending: 0, offline: false, refresh: 0, narrow: false, sel: null }),
  build(rt, s) {
    if (s.op && Date.now() - s.op.t0 > 3200) {
      const e = s.entries.find(x => x.id === s.op.id)
      if (s.op.kind === 'install') e.installed = true; if (s.op.kind === 'update') { e.ver = e.update; delete e.update } if (s.op.kind === 'remove') e.installed = false
      s.pending++; rt.say(`${s.op.kind === 'remove' ? 'Removed' : s.op.kind === 'update' ? 'Updated' : 'Installed'} ${e.name} · restart Mayfly to apply`, 'success'); s.op = null
    }
    if (s.refresh && Date.now() - s.refresh > 1400) { s.refresh = 0; rt.say(`Refreshed ${s.entries.length} entries`, 'success') }
    return MC.PluginMarketplace({ tab: s.tab, entries: s.entries, source: s.source, op: s.op ? { ...s.op, elapsed: Date.now() - s.op.t0 } : null, pending: s.pending, offline: s.offline, refreshing: !!s.refresh, feedback: rt.feedbackNode() })
  },
  onEvent(e, rt, s) {
    if (e.kind === 'tab-change') { s.tab = e.tabId; return }
    if (e.kind === 'dismiss' && s.op) { s.op = null; rt.say('Cancelled', 'info'); return { kind: 'cancelled' } }
    if (e.kind !== 'activate') return
    const id = e.selected[`market.${s.tab}`], p = s.entries.find(x => x.id === id)
    if (e.actionId === 'refresh') { s.refresh = Date.now(); return }
    if (e.actionId === 'source') { s.source = s.source === 'npm' ? 'github' : 'npm'; return }
    if (!p || s.op) { if (s.op) rt.say('a plugin operation is already running', 'warning'); return }
    if (e.actionId === 'install') { if (p.installed) return; if (p.status === 'removed') rt.say(`${p.name}: ${p.note}`, 'warning'); else if (!p.tui) rt.say('web-only plugin: it contributes nothing in this terminal', 'warning'); else s.op = { kind: 'install', id: p.id, name: p.name, t0: Date.now() } }
    else if (e.actionId === 'update') { if (p.update) s.op = { kind: 'update', id: p.id, name: p.name, t0: Date.now() } }
    else if (e.actionId === 'remove') { if (p.installed) s.op = { kind: 'remove', id: p.id, name: p.name, t0: Date.now() } }
  },
  key(k, s) { if (k === '\x17') { s.narrow = !s.narrow; return true } if (k === '\x0f') { s.offline = !s.offline; return true } },
})

// ======================================================================= MAYFLY: /account
const ACCOUNT_STATES = ['signed-out', 'waiting', 'expired', 'network', 'no-server', 'signed-in', 'low']
rtScene({
  layer: 'mayfly', name: '/account', section: '§5.12', width: 84, keys: 's next state (demo) · Enter signs in (waits 4 s, then connects) · Ctrl+Y copy link · Ctrl+R new link · r refresh · o top up · x sign out',
  state: () => ({ st: 0, bal: 0, t0: 0 }),
  build(rt, s) {
    if (s.t0 && Date.now() - s.t0 > 4500 && ACCOUNT_STATES[s.st] === 'waiting') { s.st = 5; s.t0 = 0 }
    return MC.AccountPanel({ state: ACCOUNT_STATES[s.st], balance: ['ok', 'loading', 'error'][s.bal % 3], feedback: rt.feedbackNode() })
  },
  onEvent(e, rt, s) {
    if (e.kind === 'selection-accept' && e.controlId === 'account.choice') { if (e.itemId === 'sign-in' || e.itemId === 'retry') { s.st = 1; s.t0 = Date.now() } else rt.say('Opening the API key step', 'info') }
    else if (e.kind === 'activate') {
      if (e.actionId === 'copy') rt.say('Copied the sign-in link', 'success')
      else if (e.actionId === 'new') { s.t0 = Date.now(); rt.say('Issued a new link', 'success') }
      else if (e.actionId === 'refresh') { s.bal++; rt.say('Checked just now', 'success') }
      else if (e.actionId === 'topup') rt.say('Opened platform.deepseek.com', 'success')
      else if (e.actionId === 'signout') { s.st = 0; rt.say('Signed out', 'success') }
    }
  },
  key(k, s) { if (k === 's') { s.st = (s.st + 1) % ACCOUNT_STATES.length; this.rt.reset(); return true } },
  before(c, s) { return [...draw(caption(`state ${s.st + 1}/${ACCOUNT_STATES.length}: ${ACCOUNT_STATES.map((x, i) => (i === s.st ? `[${x}]` : x)).join(' · ')}`), { width: 96, f: 0, t: 0 }), ''] },
})

// ======================================================================= MAYFLY: first run
rtScene({
  layer: 'mayfly', name: 'Onboarding', section: '§5.12', width: 84, keys: 'Enter continues · ←/→ change · Esc goes back · digits choose on the choice steps',
  state: () => ({ step: 'language', sub: 'choose', state: 'waiting', perm: 'Default', welcome: { lang: 'English', theme: 'dark' }, connected: null, t0: 0 }),
  build(rt, s) {
    if (s.sub === 'account' && Date.now() - s.t0 > 4500 && s.state === 'waiting') { s.state = 'signed-in'; s.connected = 'account' }
    return MC.Onboarding({ step: s.step, sub: s.sub, state: s.sub === 'account' ? s.state : s.connected ? 'connected' : 'none', perm: s.perm, welcome: s.welcome, feedback: rt.feedbackNode() })
  },
  onEvent(e, rt, s) {
    if (e.kind === 'submit' && e.controlId === 'welcome') { s.welcome = { lang: e.values.lang, theme: e.values.theme }; s.step = 'connect'; s.sub = 'choose'; this.rt?.reset?.() }
    else if (e.kind === 'selection-accept' && e.controlId === 'connect') { if (e.itemId === 'account') { s.sub = 'account'; s.state = 'waiting'; s.t0 = Date.now() } else if (e.itemId === 'key') s.sub = 'key'; else s.step = 'permissions' }
    else if (e.kind === 'submit' && e.controlId === 'apikey') { s.connected = 'key'; s.step = 'permissions' }
    else if (e.kind === 'selection-accept' && e.controlId === 'perm') { s.perm = { default: 'Default', accept: 'Accept edits', full: 'Full access' }[e.itemId]; s.step = 'ready' }
    else if (e.kind === 'activate' && e.actionId === 'start') rt.say('Starting a conversation…', 'success')
    else if (e.kind === 'dismiss') { if (s.sub !== 'choose' && s.step === 'connect') { s.sub = 'choose'; return { kind: 'cancelled' } } const order = ['language', 'connect', 'permissions', 'ready'], i = order.indexOf(s.step); if (i > 0) { s.step = order[i - 1]; s.sub = 'choose'; return { kind: 'cancelled' } } }
  },
})

// ======================================================================= MAYFLY: command surfaces
const CMDS = [['/model', 'Switch model', 'Alt+M'], ['/effort', 'Set thinking effort', ''], ['/compact', 'Compact the context', ''], ['/clear', 'Start a fresh conversation', ''], ['/rewind', 'Restore a checkpoint', 'Esc Esc'], ['/sessions', 'Browse and resume sessions', ''], ['/settings', 'Edit settings', ''], ['/jobs', 'Browse background jobs', ''], ['/agents', 'Browse subagents', 'F7'], ['/status', 'Show session status', ''], ['/schedule', 'Show scheduled reminders', ''], ['/btw', 'Ask a side question', '']].map(([name, what, key]) => ({ name, what, key }))
const JOB_LINES = [{ t: '12:01:02', text: 'ready in 412 ms' }, { t: '12:01:05', text: 'GET /  200  8ms' }, { t: '12:01:09', text: 'GET /api/models  200  22ms' }, { t: '12:01:14', tag: 'warn', tone: 'warning', text: 'slow query 380ms' }, { t: '12:01:20', text: 'GET /  200  6ms' }, { t: '12:01:27', text: 'GET /api/sessions  200  31ms' }, { t: '12:01:33', text: 'GET /  200  7ms' }, { t: '12:01:41', text: 'GET /api/plugins  200  44ms' }, { t: '12:01:48', text: 'GET /  200  5ms' }]
rtScene({
  layer: 'mayfly', name: 'Command surfaces', section: '§5.13', pages: 6, width: 84, keys: 'Ctrl+N/Ctrl+P next/previous surface',
  state: () => ({ page: 0, follow: true, hunk: 1 }),
  build(rt, s) {
    switch (s.page) {
      case 0: return MC.CommandPalette({ commands: CMDS })
      case 1: return MC.FilePicker({ files: [{ name: 'pane-activity.ts', dir: 'packages/mayfly/src/transcript/' }, { name: 'pane-agents.ts', dir: 'packages/mayfly/src/transcript/' }, { name: 'activity-detail.ts', dir: 'packages/mayfly/src/conversation/' }] })
      case 2: return MC.ChangedFiles({ files: [{ kind: 'M', name: 'pane-activity.ts', a: 12, d: 3, line: 42 }, { kind: 'A', name: 'frame-table.ts', a: 18, d: 0, line: 1 }, { kind: 'D', name: 'moon-frames.ts', a: 0, d: 9, line: 1 }] })
      case 3: return MC.RewindPanel({ checkpoints: [{ id: 'c1', label: 'Before "Run the tests"', when: '12m ago · 2 files changed after' }, { id: 'c2', label: 'Before "Update landing page hero"', when: '18m ago · 5 files' }, { id: 'c3', label: 'Session start', when: '24m ago' }] })
      case 4: return MC.KeyHelp({ context: 'while typing a prompt', groups: [{ title: 'Send', rows: [['Enter', 'send'], ['Alt+Enter', 'newline']] }, { title: 'Complete', rows: [['/ @ # !', 'commands · files · skills · shell']] }, { title: 'Model', rows: [['Alt+M', 'cycle'], ['/model', 'pick'], ['/effort', 'thinking']] }, { title: 'View', rows: [['Ctrl+O', 'expand'], ['Ctrl+T', 'todo'], ['F6 / F7', 'panes / switch'], ['Ctrl+F', 'search']] }] })
      default: return s.page === 5 ? MC.JobOutput({ name: 'dev', status: 'running 4m 2s', lines: JOB_LINES, follow: s.follow }) : MC.HunkReview({ file: 'pane-activity.ts', index: s.hunk, total: 3, before: EDIT_BEFORE, after: EDIT_AFTER })
    }
  },
  onEvent(e, rt, s) {
    if (e.kind === 'selection-accept') rt.say(`→ ${e.itemId}${e.segmentId ? ` (${e.segmentId})` : ''}`, 'success')
    else if (e.kind === 'activate') { if (e.actionId === 'follow') s.follow = !s.follow; else rt.say(`${e.actionId}`, 'success') }
  },
  before(c, s) { return [...draw(caption(`surface ${s.page + 1}/6 (Ctrl+N): ${['command palette: / then type · Enter run', '@ file picker: Enter opens in the external editor (↗) · Tab inserts the mention', 'changed files: Enter opens at the first change · d diff', 'rewind: a checkpoint list with a restore scope on each row (←/→)', 'key help (?, on an empty prompt): contextual, grouped by task', 'job output: a followed tail · f follow · x stop'][s.page]}`), { width: 96, f: 0, t: 0 }), ''] },
})

// ======================================================================= MAYFLY: /trace
const TRACE_JSON = {
  'user-message': { seq: 0, type: 'user-message', surface: 'main', turn: 1, text: 'Update the landing page hero copy and run the tests.', attachments: [] },
  'tool-call': { seq: 0, type: 'tool-call', surface: 'tool', turn: 1, name: 'bash', arguments: { command: 'pnpm run test', cwd: '~/work/mayfly' }, permission: 'allowed (session)' },
  'tool-result': { seq: 0, type: 'tool-result', surface: 'tool', turn: 1, name: 'bash', ok: false, exitCode: 1, durationMs: 12100, stderr: ['FAIL width-scan.spec.ts', 'tool-line row is 62 cells, expected ≤ 60'] },
  'model-request': { seq: 0, type: 'model-request', surface: 'main', turn: 1, model: 'deepseek-chat', effort: 'high', tokens: { input: 18420, cached: 12011, output: 612 } },
  'subagent-start': { seq: 0, type: 'subagent-start', surface: 'subagent', turn: 1, agent: 'review', task: 'Audit facts projection' },
  'error': { seq: 0, type: 'error', surface: 'system', turn: 2, code: 'timeout', message: 'verify:full timed out after 4m', retriable: true },
}
const ev = (seq, time, type, glyph, title, summary, surface, ms, failed) => ({ seq, time, type, glyph, title, summary, surface, ms, failed })
const TRACE_TURNS = [
  { n: 1, start: '10:02:11', dur: '38s', up: '18.4k', down: '0.6k', maxMs: 12100, events: [
    ev(1, '10:02:11', 'user-message', '»', 'user message', 'Update the landing page hero copy…', 'main', 80),
    ev(2, '10:02:12', 'model-request', '●', 'model request', 'deepseek-chat · high · 18.4k in', 'main', 4200),
    ev(3, '10:02:17', 'tool-call', '⏵', 'bash', 'pnpm run test', 'tool', 300),
    ev(4, '10:02:29', 'tool-result', '✗', 'bash result', 'exit 1 · 12.1s · width-scan.spec.ts', 'tool', 12100, true),
    ev(5, '10:02:30', 'subagent-start', '●', 'subagent review', 'Audit facts projection', 'subagent', 6400)] },
  { n: 2, start: '10:04:02', dur: '4m 12s', up: '31.0k', down: '2.1k', maxMs: 240000, failed: true, events: [
    ev(6, '10:04:02', 'user-message', '»', 'user message', 'Now bump the changelog and run the full gate.', 'main', 80),
    ev(7, '10:04:09', 'tool-call', '⏵', 'bash', 'pnpm run verify:full', 'tool', 300),
    ev(8, '10:08:09', 'error', '✗', 'error', 'verify:full timed out after 4m', 'system', 240000, true)] },
]
const traceDetail = id => { const e = TRACE_TURNS.flatMap(t => t.events).find(x => String(x.seq) === id); if (!e) return undefined; return { type: e.type, surface: e.surface, took: e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : `${e.ms}ms`, json: JSON.stringify({ ...TRACE_JSON[e.type], seq: e.seq, time: e.time }, null, 2) } }
rtScene({
  layer: 'mayfly', name: '/trace', section: '§5.14', width: 112,
  keys: '↑↓ events · / filter · c copy item · a copy all · f failures only · Ctrl+G open the JSON in $EDITOR · Alt+↓ scroll the JSON · Ctrl+E expand it · Esc close',
  state: () => ({ failuresOnly: false, sel: '4' }),
  build(rt, s) {
    const cur = rt.state('trace.events').cursor
    return MC.TracePanel({ turns: TRACE_TURNS, failuresOnly: s.failuresOnly, detail: traceDetail(/^\d+$/.test(cur ?? '') ? cur : s.sel), feedback: rt.feedbackNode() })
  },
  onEvent(e, rt, s) {
    if (e.kind === 'focus-change') return
    if (e.kind === 'activate') {
      const id = e.selected['trace.events']
      if (e.actionId === 'copy') rt.say(`Copied event #${id} (JSON)`, 'success')
      else if (e.actionId === 'copy-all') rt.say('Copied all 8 events (JSON lines)', 'success')
      else if (e.actionId === 'failures') { s.failuresOnly = !s.failuresOnly; rt.say(s.failuresOnly ? 'Showing the 2 failed events' : 'Showing all events', 'info') }
      else if (e.actionId === 'open') rt.say(`Opened event #${id} in $EDITOR`, 'success')
    }
  },
  before: (c, s) => draw(caption('one tree: a turn is a node, its events are children with a duration meter; the right pane shows the selected event as highlighted JSON'), { width: 96, f: 0, t: 0 }).concat(['']),
})

// ======================================================================= BASIC + MAYFLY: rebinding keys
const KEY_GROUPS = [[/^ui\.(save|copy|delete|refresh|external|search)$/, 'Common meanings (every panel)'], [/^demo-plugin\./, 'Demo plugin'], [/^ui\.(tab|focus)/, 'Moving between controls'], [/^ui\./, 'Navigation'], [/./, 'Components']]
const groupOf = id => KEY_GROUPS.find(([re]) => re.test(id))[1]
const keyActions = () => keymap.list().toSorted((a, b) => KEY_GROUPS.findIndex(([re]) => re.test(a.id)) - KEY_GROUPS.findIndex(([re]) => re.test(b.id))).map(a => ({ ...a, group: groupOf(a.id), modified: keymap.overrides.has(a.id), keys: a.keys.map(showKey), defaults: a.defaults.map(showKey) }))
rtScene({
  layer: 'mayfly', name: 'Keybindings', section: '§3.5', width: 96,
  keys: 'Enter rebinds the selected action · then press the new key · Delete restores the default · / filters · the plugin panel below follows the rebind',
  state: () => ({ capturing: null, demo: 0 }),
  capturing: s => !!s.capturing,
  init: () => keymap.resetAll(),
  build(rt, s) {
    return ui.stack.column([
      MC.KeybindingsPanel({ actions: keyActions(), capturing: s.capturing, feedback: rt.feedbackNode() }),
      ui.spacer(), ui.text('A downstream plugin panel declares its own action; the same list rebinds it, and its hint row follows:', { tone: 'muted' }),
      ui.surface({ title: 'Demo plugin', chrome: 'overlay', child: ui.stack.column([ui.richText([span2(`installs so far: ${s.demo}`)]), ui.actions({ id: 'demo.keys', items: [{ id: 'install', action: 'demo-plugin.install', label: 'Install', key: 'i', hintLabel: 'install' }, { id: 'copy', semantic: 'copy', label: 'Copy', hintLabel: 'copy' }] })]) }),
    ])
  },
  onEvent(e, rt, s) {
    if (e.kind === 'selection-accept' && e.controlId === 'keys.list') { s.capturing = e.itemId; rt.say(`Press the new key for "${e.itemId}" — Esc cancels`, 'info') }
    else if (e.kind === 'activate' && e.actionId === 'install') s.demo++
    else if (e.kind === 'activate' && e.actionId === 'copy') rt.say('Copied (the semantic action "copy" is bound to c here)', 'success')
  },
  key(k, s) {
    if (s.capturing) {
      if (k === '\x1b') { s.capturing = null; this.rt.say('Cancelled — nothing changed', 'info'); return true }
      const name = keyName(k), clash = keymap.list().find(a => a.id !== s.capturing && a.keys.includes(name))
      if (clash) { this.rt.say(`${showKey(name)} is already "${clash.label}" — pick another key, or rebind that action first`, 'warning'); return true }
      keymap.bind(s.capturing, name); this.rt.say(`"${s.capturing}" is now ${showKey(name)}`, 'success'); s.capturing = null; return true
    }
    if (k === '\x1b[3~') { const id = this.rt.state('keys.list').cursor; if (id && keymap.overrides.has(id)) { keymap.reset(id); this.rt.say(`"${id}" restored to ${keymap.defaults(id).map(showKey).join(' / ')}`, 'success') } return true }
  },
})
const span2 = text => ({ text })
// ======================================================================= runner
let cur = 0, f = 0, sceneStart = Date.now(), drawn = 0
const baseWidth = 96
const sceneIndex = () => scenes.map((s, i) => `${String(i + 1).padStart(2)} ${s.layer === 'basic' ? 'basic ' : 'mayfly'} ${s.name}  ${s.section ?? ''}`)

function frameLines(i, fr, t, width = baseWidth) {
  const sc = scenes[i]
  return sc.lines.call(sc, { f: fr, t, width: sc.width ?? width })
}

function boxProblems(idx, label, ls, problems) {
  const L = ls.map(strip)
  for (let i = 0; i < L.length; i++) {
    if (!/^\s*[╭┌]/.test(L[i])) continue
    const w = cells(L[i].trimEnd())
    let j = i + 1
    while (j < L.length && !/^\s*[╰└]/.test(L[j])) { if (/^\s*│/.test(L[j]) && cells(L[j].trimEnd()) !== w) problems.push(`scene ${idx + 1} (${scenes[idx].name}) ${label}: a box row at line ${j} is ${cells(L[j].trimEnd()) - w > 0 ? '+' : ''}${cells(L[j].trimEnd()) - w} cells off`); j++ }
    if (j < L.length && cells(L[j].trimEnd()) !== w) problems.push(`scene ${idx + 1} (${scenes[idx].name}) ${label}: a box bottom at line ${j} is off`)
  }
}

if (process.argv.includes('--list')) { console.log(sceneIndex().join('\n')); process.exit(0) }

/** Keys every scene is walked with: single keys, then a long run of page keys so every page and state is built. */
const WALK_KEYS = ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\r', ' ', '\t', 'v', 'V', 'a', 'b', 'd', 'h', 'o', 'p', 'n', 'w', 's', 'x', 'y', '1', '2', '3', '\x1b[1;3C', '\x1b[1;3D', '\x1b', '/', 'i', 'u', 'r', 'j', 'k', 'z', '\x0e', '\x10', '\x17', '\x14', '\x18', '\x13', '\x0f', '\x1b[17~']
const WALKS = [[], ...WALK_KEYS.map(k => [k]), Array(9).fill('\x0e'), Array(8).fill('v'), ['\x1b[B', '\x1b[17~'], ['\x1b[B', '\x1b[B', '\x1b[B'], ['\x1b[C', 'i'], ['\x1b[C', 'i', 'y'], ['i', 'x', 'y'], ['\x1b[C', '\x1b[C', '\x1b[A', '\x1b[A']]
if (process.argv.includes('--smoke')) {
  const problems = []
  let count = 0
  scenes.forEach((sc, idx) => {
    for (const walk of WALKS) {
      try {
        sc.init?.call(sc)
        for (const k of walk) { sc.key?.call(sc, k); count++; boxProblems(idx, `after ${JSON.stringify(k)}`, frameLines(idx, 1, 1000), problems) }
        if (!walk.length) { boxProblems(idx, 'initial', frameLines(idx, 0, 0), problems); count++ }
      } catch (error) { problems.push(`scene ${idx + 1} (${sc.name}) threw after ${JSON.stringify(walk)}: ${error.message}`) }
    }
  })
  console.log(problems.length ? [...new Set(problems)].join('\n') : `ui-preview smoke: ${scenes.length} scenes, ${count} frames, no errors`)
  process.exit(problems.length ? 1 : 0)
}

if (process.argv.includes('--audit')) {
  const problems = []
  // 1. layering: Mayfly components import only the kit, never paint, never read a width, never read keys
  const src = fs.readFileSync(new URL('./mayfly-components.mjs', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const imports = [...code.matchAll(/^import .* from '(.*)'/gm)].map(m => m[1])
  if (imports.some(i => i !== './ui-kit.mjs')) problems.push(`mayfly-components.mjs imports ${imports.filter(i => i !== './ui-kit.mjs').join(', ')}; it may import only ./ui-kit.mjs`)
  for (const [re, why] of [[/\\x1b|\\u001b/, 'raw ANSI'], [/process\.std/, 'terminal access'], [/\bwidth\s*[<>=]/, 'a width comparison'], [/\bcells\(|\bclip\(|\bpad\(|\bstrip\(/, 'text measuring']]) if (re.test(code)) problems.push(`mayfly-components.mjs contains ${why}`)
  // 2. walk every scene through its pages and states so every component has been built
  scenes.forEach((sc, i) => { for (const walk of WALKS) { try { sc.init?.call(sc); for (const k of walk) { sc.key?.call(sc, k); frameLines(i, 1, 1000) } frameLines(i, 0, 0) } catch (error) { problems.push(`scene ${i + 1} threw: ${error.message}`); break } } })
  const log = usage()
  const rows = [...log.entries()].map(([name, e]) => ({ name, layer: e.layer, uses: [...e.uses].filter(u => !u.startsWith('component:')).toSorted(), nested: [...e.uses].filter(u => u.startsWith('component:')).map(u => u.slice(10)).toSorted() }))
  const order = { pattern: 0, mayfly: 1 }
  rows.sort((a, b) => order[a.layer] - order[b.layer] || a.name.localeCompare(b.name))
  const kinds = [...new Set(rows.flatMap(r => r.uses))].toSorted()
  console.log(`# layer audit: ${rows.filter(r => r.layer === 'mayfly').length} Mayfly components and ${rows.filter(r => r.layer === 'pattern').length} patterns, built only from ${kinds.length} basic builders\n`)
  for (const r of rows) console.log(`${r.layer.padEnd(8)} ${r.name.padEnd(30)} ${r.uses.join(' ')}${r.nested.length ? '   + ' + r.nested.join(' ') : ''}`)
  const allKinds = ['text', 'rich-text', 'fields', 'markdown', 'code', 'diff', 'sections', 'chart', 'diagram', 'spacer', 'divider', 'stack', 'surface', 'scroll', 'tabs', 'list', 'form', 'actions', 'loader', 'progress', 'empty', 'prompt']
  console.log(`\nbasic builders no Mayfly component needed (kept for plugins): ${allKinds.filter(k => !kinds.includes(k)).join(', ') || 'none'}`)
  console.log(problems.length ? '\nPROBLEMS\n' + problems.join('\n') : '\naudit passed: every Mayfly component is composed only from the kit')
  process.exit(problems.length ? 1 : 0)
}

if (process.argv.includes('--keys')) {
  // Key diagnostics: press keys and see the raw bytes and what the prototype decodes them as. Ctrl+C quits.
  console.log('ui-preview --keys: press keys (try Alt+Up, Alt+Left, Alt+Enter, F2); Ctrl+C quits\n')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', d => { const raw = d.toString(); if (raw === '\x03') process.exit(0); for (const k of splitKeys(raw)) console.log(`${JSON.stringify(k).padEnd(24)} bytes ${[...Buffer.from(k)].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(24)} -> ${keyName(k)}`) })
} else {
// ---- interactive
if (process.argv.includes('--no-alt')) keymap.preferPlain = true
const arg = process.argv[2]
if (arg && !arg.startsWith('--')) { const n = Number(arg); cur = Number.isInteger(n) ? Math.max(0, Math.min(scenes.length - 1, n - 1)) : Math.max(0, scenes.findIndex(s => s.name.toLowerCase().includes(arg.toLowerCase()))) }
const enter = i => { scroll = 0; released = false; keymap.resetAll(); cur = (i + scenes.length) % scenes.length; scenes[cur].init?.call(scenes[cur]); sceneStart = Date.now(); f = 0 }
const tty = process.stdout.isTTY
const quit = () => { process.stdout.write(tty ? '\x1b[?25h\x1b[?1049l' : '\x1b[?25h\n'); process.exit(0) }
process.on('SIGINT', quit)
let scroll = 0, released = false
function paintScreen() {
  const sc = scenes[cur]
  const nav = `${paint(` ${cur + 1}/${scenes.length} `, 'primary', ['strong'])} ${paint(sc.layer === 'basic' ? 'BASIC' : 'MAYFLY', sc.layer === 'basic' ? 'accent' : 'primary', ['strong'])} ${paint(sc.name, 'default', ['strong'])} ${paint(sc.section ?? '', 'muted')}`
  const typing = sc.capture?.call(sc) && !released
  const foot = paint(`${typing ? 'typing: Esc then ] [ , or Ctrl+←/→ scene' : '] next · [ previous · Ctrl+←/→ scene · } { layer · q quit'} · Ctrl+↑/↓ scroll${sc.keys ? ' · ' + sc.keys : ''}`, 'muted')
  const body = ['', ...frameLines(cur, f, Date.now() - sceneStart), '']
  if (!tty) {
    const all = [nav, ...body, foot]
    if (drawn) process.stdout.write(`\x1b[${drawn}A`)
    process.stdout.write(all.map(l => `\x1b[2K${l}`).join('\n') + '\n\x1b[J')
    drawn = all.length
    return
  }
  // a real terminal: draw on the alternate screen from the top, pin the header and footer, and scroll the body
  const cols = process.stdout.columns || 100, rows = process.stdout.rows || 30
  const footLines = wrap(foot, cols), room = Math.max(3, rows - 1 - footLines.length)
  scroll = Math.max(0, Math.min(scroll, body.length - room))
  const view = body.slice(scroll, scroll + room)
  while (view.length < room) view.push('')
  const more = body.length > room ? paint(` ↕ ${scroll + 1}-${Math.min(body.length, scroll + room)} of ${body.length}`, 'muted') : ''
  const all = [clip(nav, cols - cells(strip(more))) + more, ...view.map(l => clip(l, cols)), ...footLines]
  process.stdout.write('\x1b[H' + all.map(l => `\x1b[2K${l}`).join('\n') + '\x1b[J')
}
enter(cur)
process.stdout.write(tty ? '\x1b[?1049h\x1b[?25l' : '\x1b[?25l')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
const handle = k => {
  if (k === '\x03') return quit()
  const sc = scenes[cur], name = keyName(k)
  if (name === 'release') return
  // a terminal or multiplexer that does not deliver Alt: the first F2-F5 press switches the hints to the plain keys
  if (/^f[2-5]$/.test(name) && !keymap.preferPlain) keymap.preferPlain = true
  // Ctrl+Left / Ctrl+Right move between scenes even while a prompt has the keyboard
  if (name === 'ctrl+right' || k === '\x1d') return enter(cur + 1)
  if (name === 'ctrl+left' || k === '\x1c') return enter(cur - 1)
  if (name === 'ctrl+up') { scroll = Math.max(0, scroll - 5); return paintScreen() }
  if (name === 'ctrl+down') { scroll += 5; return paintScreen() }
  // Esc while a text control holds the keyboard also hands the navigation keys back, until the next typed key
  const typing = sc.capture?.call(sc) && !released
  if (k === '\x1b' && sc.capture?.call(sc)) released = true
  else if (typing) released = false
  if (!typing) {
    if (k === 'q') return quit()
    if (k === ']' || k === '\t') return enter(cur + 1)
    if (k === '[' || name === 'shift+tab') return enter(cur - 1)
    if (k === '}') { let i = cur; while (scenes[i % scenes.length].layer === sc.layer) i++; return enter(i) }
    if (k === '{') { let i = cur; while (scenes[(i + scenes.length) % scenes.length].layer === sc.layer) i--; return enter(i) }
  }
  if (released && k !== '\x1b' && sc.capture?.call(sc)) released = false
  sc.key?.call(sc, k)
  paintScreen()
}
process.stdin.on('data', d => { for (const k of splitKeys(d.toString())) handle(k) })
setInterval(() => { f++; paintScreen() }, 100)
}
