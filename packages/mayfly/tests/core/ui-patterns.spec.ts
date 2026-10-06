/** Private L2 pattern presentation and degradation behavior. */
import { describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import {
  renderActions,
  renderDivider,
  renderEmpty,
  renderFormField,
  renderList,
  renderListSegment,
  renderLoader,
  renderProgress,
  renderSurfaceHead,
  renderSurfaceTail,
  renderTabs,
  type PatternFocus,
} from '../../src/core/ui-patterns.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { visibleWidth } from '../../src/core/width.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const idle: PatternFocus = { key: '', focused: false, marker: '|' }

describe('private UI pattern painters', () => {
  it('renders distinct surface chrome and every badge tone', () => {
    const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    const badges = [
      { text: 'default' },
      { text: 'muted', tone: 'muted' as const },
      { text: 'accent', tone: 'accent' as const },
      { text: 'success', tone: 'success' as const },
      { text: 'warning', tone: 'warning' as const },
      { text: 'danger', tone: 'danger' as const, styles: ['strong'] as const },
    ]
    const none = ui.surface({ title: 'Title', subtitle: 'Subtitle', badges, child: ui.text('body') })
    expect(plain(renderSurfaceHead(none, 120, colors))).toEqual(['Title  default muted accent success warning danger', 'Subtitle'])
    expect(renderSurfaceHead(none, 120, colors)[0]).toContain('\x1b[1mTitle\x1b[22m')
    expect(plain(renderSurfaceHead(ui.surface({ badges: [{ text: 'b' }], child: ui.text('body') }), 20, colors))).toEqual(['b'])
    expect(renderSurfaceTail(none, 20, colors)).toEqual([])
    expect(renderSurfaceHead(ui.surface({ child: ui.text('body') }), 20, colors)).toEqual([])

    const lane = ui.surface({ chrome: 'lane', title: 'Lane', child: ui.text('body') })
    expect(plain(renderSurfaceHead(lane, 20, colors))).toEqual(['── Lane ────────────'])
    expect(plain(renderSurfaceHead(ui.surface({ chrome: 'lane', badges: [{ text: 'two' }], child: ui.text('body') }), 12, colors))).toEqual(['──────── two'])
    expect(plain(renderSurfaceHead(ui.surface({ chrome: 'lane', title: 'Long lane title', child: ui.text('body') }), 10, colors))[0]).toHaveLength(10)
    expect(renderSurfaceTail(lane, 20, colors)).toEqual([])

    const surface = ui.surface({ chrome: 'surface', child: ui.text('body') })
    const overlay = ui.surface({ chrome: 'overlay', title: 'Overlay', badges: [{ text: '1 of 3', tone: 'muted' }], child: ui.text('body') })
    expect(renderSurfaceHead(surface, 1, colors)).toEqual(['╭'])
    expect(renderSurfaceTail(surface, 1, colors)).toEqual(['╰'])
    expect(renderSurfaceHead(surface, 6, colors)).toEqual(['╭────╮'])
    expect(plain(renderSurfaceHead(overlay, 24, colors))).toEqual(['╭ Overlay ───── 1 of 3 ╮'])
    expect(plain(renderSurfaceHead(overlay, 16, colors))).toEqual(['╭ Overlay ─────╮'])
    expect(renderSurfaceTail(overlay, 6, colors)).toEqual(['╰────╯'])
    expect(plain(renderSurfaceHead(overlay, 8, colors))).toEqual(['╭ Ov… ─╮'])
    expect(renderSurfaceHead(overlay, 2, colors)).toEqual(['╭╮'])
    expect(renderSurfaceHead(overlay, 1, colors)).toEqual(['╭'])
    for (const width of [1, 2, 5, 8, 16, 24, 40]) expect(visibleWidth(renderSurfaceHead(overlay, width, colors)[0]!)).toBe(width)
  })

  it('draws the active tab with an underline, folds a strip that does not fit, and marks wizard steps', () => {
    const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    const node = ui.tabs({ id: 'tabs', activeId: 'a', items: [
      { id: 'a', label: 'Alpha', count: 12 },
      { id: 'b', label: 'Beta', disabled: true, count: 3 },
      { id: 'c', label: 'Gamma', count: 4 },
    ] })
    expect(plain(renderTabs(node, 80, idle, colors))).toEqual(['Alpha 12   Beta 3   Gamma 4', '━━━━━━━━'])
    const focused = renderTabs({ ...node, activeId: 'c' }, 80, { key: 'c', focused: true, marker: '|' }, colors)
    expect(plain(focused)).toEqual(['Alpha 12   Beta 3   Gamma 4', `${' '.repeat(20)}━━━━━━━|`])
    expect(focused[0]).toContain('\x1b[1mGamma\x1b[22m')
    expect(focused[1]).toContain('\x1b[1m━━━━━━━\x1b[22m')
    expect(plain(renderTabs(node, 16, idle, colors))).toEqual(['‹ Alpha 12  Beta'])
    expect(plain(renderTabs({ ...node, activeId: 'c' }, 16, idle, colors))).toEqual(['‹ Gamma 4  +2 ›'])
    expect(plain(renderTabs({ ...node, activeId: 'missing' }, 80, idle, colors))[1]).toBe('━━━━━━━━')
    const primary = vi.fn(identity)
    const muted = vi.fn(identity)
    const palette = new Proxy(colors, { get: (target, key, receiver) => key === 'primary' ? primary : key === 'muted' ? muted : Reflect.get(target, key, receiver) })
    renderTabs(node, 80, idle, palette)
    expect(primary).toHaveBeenCalledWith('Alpha')
    expect(muted).toHaveBeenCalledWith('Gamma')

    // Two tabs that do not fit fold with nothing hidden; a strip without tabs paints an empty rule.
    expect(plain(renderTabs(ui.tabs({ id: 'pair', activeId: 'x', items: [{ id: 'x', label: 'Extended' }, { id: 'y', label: 'Yonder' }] }), 12, idle, colors))).toEqual(['‹ Extended  ›'.slice(0, 12)])
    expect(plain(renderTabs({ ...node, items: [] }, 20, idle, colors))).toEqual(['', ''])
    const wizard = ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'two', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three' }] })
    expect(plain(renderTabs(wizard, 80, idle, colors, ['one', 'two']))).toEqual(['✓ One  ›  ● Two  ›  ○ Three', '          ━━━━━'])
    expect(plain(renderTabs(wizard, 80, idle, colors))[0]).toBe('○ One  ›  ● Two  ›  ○ Three')
  })

  it('renders list marks, the focused cursor, groups, filtering, detail degradation, and windows', () => {
    const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    const selectedBg = vi.fn(identity)
    const primary = vi.fn(identity)
    const tracked = new Proxy(colors, { get: (target, key, receiver) => key === 'selectedBg' ? selectedBg : key === 'primary' ? primary : Reflect.get(target, key, receiver) })
    const node = ui.list({
      id: 'list', mode: 'multiple', selectedIds: ['a', 'd'], filter: 'term',
      items: [
        { id: 'a', label: 'Alpha', detail: 'detail-a', badge: 'hot', group: 'One' },
        { id: 'b', label: 'Beta', detail: 'detail-b', group: 'One', disabled: true },
        { id: 'c', label: 'Gamma', group: 'Two' },
        { id: 'd', label: 'Delta' },
        { id: 'e', label: 'Epsilon' },
      ],
    })
    const idleRows = plain(renderList(node, 80, 20, idle, tracked))
    expect(idleRows).toEqual(['/ term', 'One', '  ● Alpha [hot] — detail-a', '  ○ Beta — detail-b', 'Two', '  ○ Gamma', '  ● Delta', '  ○ Epsilon'])
    expect(selectedBg).not.toHaveBeenCalled()

    const focusedRows = plain(renderList(node, 40, 3, { key: 'd', focused: true, marker: '|' }, tracked))
    expect(focusedRows).toEqual(['  ○ Gamma', '→|● Delta', '  ○ Epsilon'])
    expect(primary).toHaveBeenCalledWith('→')
    // A cursor row of an unfocused list keeps its bold label and has no arrow.
    const unfocused = renderList(node, 80, 20, { key: 'c', focused: false, marker: '|' }, tracked).join('\n')
    expect(unfocused).toContain('\x1b[1mGamma\x1b[22m')
    expect(unfocused).not.toContain('→')
    expect(selectedBg).not.toHaveBeenCalled()
    expect(renderList(node, 20, 2, { key: 'missing', focused: true, marker: '|' }, colors)[0]).toContain('/ term')
    expect(renderList(node, 20, Number.NaN, { key: 'e', focused: true, marker: '|' }, colors)).toHaveLength(1)
    expect(renderList(ui.list({ id: 'single', selectedIds: ['x'], items: [{ id: 'x', label: 'X' }] }), 20, 3, idle, colors)).toEqual(['  X'])
    expect(plain(renderList(ui.list({ id: 'numbered', numbered: true, selectedIds: [], items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y', disabled: true }] }), 20, 3, idle, colors))).toEqual(['  1  X', '  2  Y'])
    expect(renderList(node, 80, 2, { key: 'a', focused: true, marker: '|' }, colors).join('\n')).toContain('detail-a')
    expect(renderList(node, 40, 2, { key: 'a', focused: true, marker: '|' }, colors).join('\n')).not.toContain('detail-a')

    const tree = ui.list({ id: 'tree', mode: 'multiple', tree: true, selectedIds: ['p1'], items: [{ id: 'p', label: 'parent' }, { id: 'p1', label: 'one', parentId: 'p' }, { id: 'p2', label: 'two', parentId: 'p' }, { id: 'q', label: 'all' }, { id: 'q1', label: 'only', parentId: 'q' }, { id: 'r', label: 'none' }, { id: 'r1', label: 'child', parentId: 'r' }] })
    expect(plain(renderList({ ...tree, selectedIds: ['p1', 'q1', 'r'] }, 40, 20, idle, colors))).toEqual(['  ◐ parent', '  ● one', '  ○ two', '  ● all', '  ● only', '  ● none', '  ○ child'])
    expect(plain(renderList({ ...tree, selectedIds: [] }, 40, 20, idle, colors))[0]).toBe('  ○ parent')

    const nestedPaint = new Proxy(colors, { get: (target, key, receiver) => {
      if (key === 'primary') return (value: string) => `<primary>${value}</primary>`
      if (key === 'muted') return (value: string) => `<muted>${value}</muted>`
      return Reflect.get(target, key, receiver)
    } })
    const disabledSelected = renderList(ui.list({ id: 'disabled', mode: 'multiple', selectedIds: ['x'], items: [{ id: 'x', label: 'X', disabled: true }] }), 80, 3, { key: 'x', focused: true, marker: '|' }, nestedPaint)[0]!
    expect(disabledSelected).toBe('  <muted>●</muted> <muted>X</muted>')
  })

  it('paints structured list detail spans without losing semantics on focused rows', () => {
    const accent = vi.fn((value: string) => `<accent>${value}</accent>`)
    const muted = vi.fn((value: string) => `<muted>${value}</muted>`)
    const tracked = new Proxy(colors, { get: (target, key, receiver) => {
      if (key === 'accent') return accent
      if (key === 'muted') return muted
      return Reflect.get(target, key, receiver)
    } })
    const node = ui.list({
      id: 'variants', selectedIds: ['model'], items: [{
        id: 'model', label: 'Model', detail: 'legacy detail',
        detailSpans: [
          { text: 'ctx 64k' },
          { text: ' [Low]', tone: 'muted' },
          { text: ' [High]', tone: 'accent', styles: ['strong'] },
          { text: ' [Primary]', tone: 'primary', styles: ['italic'] },
          { text: ' [User]', tone: 'user', styles: ['strike'] },
        ],
      }],
    })

    const idleRow = renderList(node, 120, 2, idle, tracked)[0]!
    expect(idleRow).toContain('<muted>—</muted> ctx 64k')
    expect(idleRow).not.toContain('legacy detail')
    expect(idleRow).toContain('<muted> [Low]</muted>')
    expect(idleRow).toContain('\x1b[1m<accent> [High]</accent>\x1b[22m')
    expect(idleRow).toContain('\x1b[3m [Primary]\x1b[23m')
    expect(idleRow).toContain('\x1b[9m [User]\x1b[29m')
    expect(accent).toHaveBeenCalledTimes(1)

    const focusedRow = renderList(node, 120, 2, { key: 'model', focused: true, marker: '|' }, tracked)[0]!
    expect(focusedRow).toContain('<muted> [Low]</muted>')
    expect(focusedRow).toContain('\x1b[1m<accent> [High]</accent>\x1b[22m')
    expect(renderList(node, 40, 2, idle, tracked)[0]).not.toContain('High')
    expect(renderList(ui.list({ id: 'empty-detail', selectedIds: [], items: [{ id: 'x', label: 'X', detailSpans: [] }] }), 80, 2, idle, tracked)[0]).toBe('  X')
  })

  it('paints a list-row segment around the selected option and degrades at narrow widths', () => {
    const primary = vi.fn((value: string) => `\x1b[35m${value}\x1b[39m`)
    const textStrong = vi.fn((value: string) => `\x1b[1m${value}\x1b[22m`)
    const tracked = new Proxy(colors, { get: (target, key, receiver) => {
      if (key === 'primary') return primary
      if (key === 'textStrong') return textStrong
      return Reflect.get(target, key, receiver)
    } })
    const segment = { label: 'Thinking', options: [
      { id: 'default', label: 'Default' },
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
      { id: 'max', label: 'Max', disabled: true },
    ] }
    const wide = renderListSegment(segment, 'high', 80, tracked)
    expect(wide).toContain('‹ High ›')
    expect(wide).toContain('Default')
    expect(wide).toContain('\x1b[1mThinking:\x1b[22m')
    expect(primary).toHaveBeenCalledWith('‹ High ›')
    for (const width of [60, 40, 30, 24, 16, 8]) {
      const row = renderListSegment(segment, 'high', width, tracked)
      expect(visibleWidth(row)).toBeLessThanOrEqual(Math.max(1, width))
      expect(row).toContain('High')
    }
    for (const width of [4, 2, 1]) expect(visibleWidth(renderListSegment(segment, 'high', width, tracked))).toBeLessThanOrEqual(Math.max(1, width))
    expect(renderListSegment(segment, 'high', 24, tracked)).toContain('+')
    expect(renderListSegment(segment, 'high', 16, tracked)).toContain('+3')
    const unselected = renderListSegment(segment, undefined, 80, tracked)
    expect(unselected).not.toContain('‹')
    const unlabeled = renderListSegment({ options: segment.options }, 'low', 80, tracked)
    expect(unlabeled).not.toContain('Thinking')
    expect(unlabeled).toContain('‹ Low ›')
    const labelOnly = renderListSegment({ label: 'Thinking', options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ] }, 'c', 20, colors)
    expect(labelOnly).toBe('   A  B  ‹ C ›')
    const disabledActive = renderListSegment(segment, 'max', 80, tracked)
    expect(disabledActive).toContain('‹ Max ›')
    expect(primary).not.toHaveBeenCalledWith('‹ Max ›')
  })

  it('renders every form field state with validation on its own row', () => {
    const focus = { key: 'input', focused: true, marker: '|' }
    expect(renderFormField({ kind: 'input', id: 'input', label: 'Input', value: '', placeholder: 'hint', error: 'required' }, 40, focus, colors)).toEqual([
      '|→ Input: hint',
      '   ! required',
    ])
    expect(renderFormField({ kind: 'textarea', id: 'text', label: 'Text', value: '' }, 20, idle, colors)[0]).toBe('   Text: ')
    expect(renderFormField({ kind: 'textarea', id: 'text', label: 'Text', value: 'body' }, 20, idle, colors)[0]).toContain('body')
    expect(renderFormField({ kind: 'secret', id: 'secret', label: 'Secret', value: '', placeholder: 'secret' }, 20, idle, colors)[0]).toContain('secret')
    expect(renderFormField({ kind: 'secret', id: 'secret', label: 'Secret', value: '' }, 20, idle, colors)[0]).toBe('   Secret: ')
    expect(renderFormField({ kind: 'secret', id: 'secret', label: 'Secret', value: 'abc' }, 20, idle, colors)[0]).toContain('•••')
    expect(renderFormField({ kind: 'select', id: 'select', label: 'Select', value: null, options: [] }, 20, idle, colors)[0]).toContain('Choose…')
    const unfocusedSelect = renderFormField({ kind: 'select', id: 'select', label: 'Select', value: 'a', options: [{ id: 'a', label: 'Alpha' }] }, 20, idle, colors)
    expect(unfocusedSelect).toEqual(['   Select: Alpha'])
    const focusedSelect = renderFormField({ kind: 'select', id: 'select', label: 'Select', value: 'a', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }, 24, { key: 'select', focused: true, marker: '|' }, colors)
    expect(focusedSelect).toEqual(['|→ Select: ‹ Alpha ›'])
    // Nothing to cycle to: a lone chosen option, a disabled alternative, or a multiselect.
    expect(renderFormField({ kind: 'select', id: 'select', label: 'Select', value: 'a', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', disabled: true }] }, 24, { key: 'select', focused: true, marker: '|' }, colors)).toEqual(['|→ Select: Alpha'])
    expect(renderFormField({ kind: 'select', id: 'select', label: 'Select', value: null, options: [{ id: 'a', label: 'Alpha' }] }, 24, { key: 'select', focused: true, marker: '|' }, colors)).toEqual(['|→ Select: ‹ Choose… ›'])
    expect(renderFormField({ kind: 'multiselect', id: 'select', label: 'Tags', value: ['a'], options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }, 24, { key: 'select', focused: true, marker: '|' }, colors)).toEqual(['|→ Tags: Alpha'])
    const editingSelect = renderFormField({ kind: 'select', id: 'select', label: 'Select', value: 'a', options: [{ id: 'a', label: 'Alpha' }] }, 20, { key: 'select', focused: true, marker: '|', editing: true }, colors)
    expect(editingSelect.join('\n')).toContain('→ ● Alpha')
    const unfocusedEditing = renderFormField({ kind: 'select', id: 'select', label: 'Select', value: 'a', options: [{ id: 'a', label: 'Alpha' }] }, 20, { key: 'select', marker: '|', editing: true }, colors)
    expect(unfocusedEditing).toEqual(['   Select', '   ● Alpha'])
    expect(renderFormField({ kind: 'select', id: 'select', label: 'Select', value: 'missing', options: [] }, 20, idle, colors)[0]).toContain('missing')
    expect(renderFormField({ kind: 'toggle', id: 'toggle', label: 'Toggle', value: true }, 20, idle, colors)[0]).toContain('[on]')
    expect(renderFormField({ kind: 'toggle', id: 'toggle', label: 'Toggle', value: false, disabled: true }, 5, idle, colors)[0]).toHaveLength(5)
    const mutedOnly = new Proxy(colors, { get: (target, key, receiver) => key === 'muted'
      ? (value: string) => `<muted>${value}</muted>`
      : key === 'text' || key === 'textStrong' ? (value: string) => `<foreground>${value}</foreground>` : Reflect.get(target, key, receiver) })
    const disabled = renderFormField({ kind: 'input', id: 'disabled', label: 'Disabled', value: 'value', disabled: true }, 80, idle, mutedOnly)[0]!
    expect(disabled).toContain('<muted>')
    expect(disabled).not.toContain('<foreground>')
    expect(renderFormField({ kind: 'input', id: 'disabled', label: 'Disabled', value: '', disabled: true }, 80, { key: 'disabled', focused: true, marker: '|' }, colors)[0]).not.toContain('|')
    const focusPalette = new Proxy(colors, { get: (target, key, receiver) => key === 'primary' ? (value: string) => `<primary>${value}</primary>` : Reflect.get(target, key, receiver) })
    expect(renderFormField({ kind: 'input', id: 'focused', label: 'Focused', value: 'value' }, 80, { key: 'focused', focused: true, marker: '|' }, focusPalette)[0]).toContain('<primary>|→ Focused: value</primary>')
  })

  it('renders action intents, busy/confirm states, deterministic loaders, and empty groups', () => {
    const node = ui.actions({ id: 'actions', items: [
      { id: 'primary', label: 'Run', intent: 'primary' },
      { id: 'secondary', label: 'Later', intent: 'secondary', confirm: 'sure' },
      { id: 'danger', label: 'Delete', intent: 'danger' },
      { id: 'busy', label: 'Wait', busy: true },
      { id: 'disabled', label: 'No', disabled: true },
    ] })
    const vertical = renderActions(node, 40, { key: 'secondary', focused: true, marker: '|', pendingKey: 'secondary' }, colors, true)
    expect(vertical).toHaveLength(5)
    expect(vertical.join('\n')).toContain('[ Run ]')
    expect(vertical.join('\n')).toContain('|Later')
    expect(vertical.join('\n')).toContain('! Delete')
    expect(renderActions(node, 40, { key: 'danger', focused: true, marker: '|' }, colors, true).join('\n')).toContain('|! Delete')
    expect(vertical.join('\n')).toContain('… Wait')
    // A pending action keeps its cursor so focus does not vanish while it runs; disabled ones never hold it.
    expect(renderActions(node, 80, { key: 'busy', focused: true, marker: '|', pendingKey: 'busy' }, colors, true).join('')).toContain('|… Wait')
    expect(renderActions(node, 80, { key: 'disabled', focused: true, marker: '|', pendingKey: 'disabled' }, colors, true).join('')).not.toContain('|')
    const reasoned = ui.actions({ id: 'reasoned', items: [{ id: 'install', label: 'Install', disabled: true, disabledReason: 'Already installed' }] })
    expect(renderActions(reasoned, 80, { key: '', focused: false, marker: '|' }, colors, false).join('')).toContain('Install — Already installed')
    const selectedBg = vi.fn((value: string) => `<selected>${value}</selected>`)
    const actionPalette = new Proxy(colors, { get: (target, key, receiver) => {
      if (key === 'primary') return (value: string) => `<primary>${value}</primary>`
      if (key === 'error') return (value: string) => `<error>${value}</error>`
      if (key === 'selectedBg') return selectedBg
      return Reflect.get(target, key, receiver)
    } })
    expect(renderActions(node, 80, { key: 'secondary', focused: true, marker: '|' }, actionPalette, true).join('\n'))
      .toContain('|<selected><primary>Later</primary></selected>')
    expect(selectedBg).toHaveBeenCalledWith('<primary>Later</primary>')
    expect(renderActions(node, 80, { key: 'danger', focused: true, marker: '|' }, actionPalette, true).join('\n'))
      .toContain('|<selected><error>! Delete</error></selected>')
    expect(renderActions(node, 80, { key: 'primary', focused: true, marker: '|' }, actionPalette, true).join('\n'))
      .toContain('|<selected><primary>[ Run ]</primary></selected>')
    expect(visibleWidth(renderActions(node, 10, { key: 'danger', focused: true, marker: '|' }, colors, false)[0]!)).toBeLessThanOrEqual(10)
    expect(renderActions(ui.actions({ id: 'empty', items: [] }), 10, idle, colors, false)).toEqual([])
    expect(renderLoader(ui.loader({ message: 'Load' }), 20, colors)).toEqual(['⠋ Load'])
    expect(renderLoader(ui.loader({ message: 'Tide', variant: 'tide', elapsedMs: 25 }), 20, colors)).toEqual(['≈ Tide 0s'])
    expect(renderLoader(ui.loader({ message: 'Tide', variant: 'tide', elapsedMs: 12_345 }), 20, colors)).toEqual(['≈ Tide 12s'])
    expect(renderLoader(ui.loader({ message: 'Tide', variant: 'tide', elapsedMs: 125_000 }), 20, colors)).toEqual(['≈ Tide 2m 5s'])
    expect(renderEmpty(ui.empty({ title: 'Nothing', description: 'Try again' }), 20, colors)).toEqual(['Nothing', 'Try again'])
    const narrowEmpty = renderEmpty(ui.empty({ title: 'Nothing' }), 3, colors)
    expect(narrowEmpty.join('')).toBe('Nothing')
    expect(narrowEmpty.every(row => visibleWidth(row) <= 3)).toBe(true)
  })

  it('uses eighth-block progress and semantic dividers at degenerate widths', () => {
    expect(renderProgress(ui.progress({ label: 'Half', value: 1, max: 2 }), 20, colors)[0]).toContain('Half ')
    expect(renderProgress(ui.progress({ value: 1, max: 3 }), 8, colors)[0]).toMatch(/[▏▎▍▌▋▊▉]/u)
    expect(renderProgress(ui.progress({ value: 0, max: 2 }), 2, colors)).toEqual(['░░'])
    expect(renderProgress(ui.progress({ value: 2, max: 2 }), 2, colors)).toEqual(['██'])
    expect(renderDivider(undefined, 3, colors)).toEqual(['───'])
    expect(renderDivider('long label', 3, colors)[0]).toHaveLength(3)
    expect(renderDivider(undefined, Number.NaN, colors)).toEqual(['─'])
  })

  it('renders numeric units and expanded select and multiselect options', () => {
    expect(renderFormField({ kind: 'number', id: 'count', label: 'Count', value: 2, unit: 'ms' }, 30, idle, colors)[0]).toContain('2 ms')
    expect(renderFormField({ kind: 'number', id: 'count', label: 'Count', value: null }, 30, idle, colors)[0]).toContain('Count:')
    const select = renderFormField({
      kind: 'select', id: 'mode', label: 'Mode', value: 'one', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', disabled: true, disabledReason: 'Unavailable' }],
    }, 40, { key: 'mode', focused: true, marker: '|', optionId: 'two', editing: true }, colors)
    expect(select).toHaveLength(3)
    expect(select.join('\n')).toContain('● One')
    expect(select.join('\n')).toContain('→ ○ Two — Unavailable')
    const multiple = renderFormField({
      kind: 'multiselect', id: 'levels', label: 'Levels', value: ['one'], options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
    }, 40, { key: 'levels', focused: true, marker: '|', editing: true }, colors)
    expect(multiple.join('\n')).toContain('→ ● One')
    const choosing = renderFormField({
      kind: 'select', id: 'pick', label: 'Pick', value: null, options: [{ id: 'a', label: 'A' }],
    }, 40, { key: 'pick', focused: true, marker: '|', editing: true }, colors)
    expect(choosing.join('\n')).toContain('→ ○ A')
    const locked = renderFormField({
      kind: 'select', id: 'lock', label: 'Lock', value: 'a', disabled: true, options: [{ id: 'a', label: 'A' }],
    }, 40, idle, colors)
    expect(locked).toHaveLength(1)
  })
})
