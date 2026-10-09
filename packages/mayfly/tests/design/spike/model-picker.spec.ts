/**
 * Composition spike: scene 23 (/model and /effort) rebuilt from the pure components in `model-picker.ts`, compiled by
 * the real renderer, and compared cell by cell with the goldens at the scene's widths and walks. The keys the frames
 * cannot show (what a Enter reports, what the hint row names) are checked beside them, and the work counters of one
 * keystroke in the picker are measured the way the work-budget spec measures them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MayflyUiEvent } from '../../../../ui/src/index.ts'
import { walks } from '../../../../../script/design-golden-walks.mjs'
import { createRealSurface, parityComponents, readGoldenFrames, type RealSurface } from '../parity.ts'
import { diffReport, frameDiffs } from '../scene.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../../src/core/ui-work-counters.ts'
import { EffortPicker, ModelPicker, modelRowId, type ModelFact, type SelectionFact } from './model-picker.ts'

const NEXT = '\x0e'
const NARROW = '\x17'
/** `interpolateLocaleMessage`: the English key with its `{name}` placeholders filled. */
const t = (key: string, values: Readonly<Record<string, string | number>> = {}): string => key.replace(/\{(\w+)\}/gu, (_all, name: string) => String(values[name]))

/** The facts behind `MODEL_DATA` in ui-preview.mjs, as `catalogRows` returns them (token counts, not '977k'). */
const MODELS: readonly ModelFact[] = [
  { provider: 'opencode-go', providerLabel: 'opencode-go', id: 'op-pro', name: 'DeepSeek V4 Pro (New)', contextWindow: 1_000_000, efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { provider: 'opencode-go', providerLabel: 'opencode-go', id: 'op-flash', name: 'deepseek-v4.1-flash', contextWindow: 1_000_000, efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { provider: 'opencode-go', providerLabel: 'opencode-go', id: 'op-bunny', name: 'space-bunny-alpha', contextWindow: 262_144 },
  { provider: 'DeepSeek', providerLabel: 'DeepSeek', id: 'ds-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000, efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { provider: 'DeepSeek', providerLabel: 'DeepSeek', id: 'ds-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, efforts: ['min', 'high', 'max'], defaultEffort: 'high' },
  { provider: 'custom', providerLabel: 'custom', id: 'cu', name: 'some-model', contextWindow: 131_072, efforts: ['low', 'medium', 'high'] },
]
const CURRENT: SelectionFact = { provider: 'DeepSeek', model: 'ds-flash', reasoningEffort: 'high' }

const modelNode = (current: SelectionFact | undefined = CURRENT, models: readonly ModelFact[] = MODELS) => ModelPicker.render({ models, current, t })
const effortNode = () => EffortPicker.render({ title: 'DeepSeek/DeepSeek-V41-Flash', levels: ['min', 'high', 'max'], defaultLevel: 'high', current: { provider: 'DeepSeek', model: 'ds-flash' }, t })

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(node: ReturnType<typeof modelNode>, width: number) {
  const events: MayflyUiEvent[] = []
  const surface = createRealSurface(node, width, {
    components: parityComponents(),
    events: event => events.push(event),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return { surface, events }
}

const SCENE_WALKS = walks().filter(walk => walk.scene === 23)

const plain = (row: string | undefined): string => (row ?? '').replace(/\x1b\[[0-9;]*m/gu, '').replace(/\x1b_[^\x07]*\x07/gu, '').replace(/\s+$/u, '')

/**
 * Frames whose cells cannot all match, as `walk -> frame -> real hint row`. While `/` searches, the renderer still steps
 * the thinking strip with `←/→` (the kit does too, line 1046 of ui-kit.mjs) but only the renderer hints it, so the hint
 * row differs from the golden by exactly the leading `←/→ thinking · ` fragment. No accepted difference covers it yet.
 */
const HINT_ROW_DIFFERENCES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  filter: { 1: '  ←/→ thinking · Enter choose · Ctrl+U clear · Esc end search', 2: '  ←/→ thinking · Enter choose · Ctrl+U clear · Esc end search' },
}
const HINT_ROW = 11

describe('spike: scene 23, /model and /effort from pure components', () => {
  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s against the golden', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    let page = 0
    let width = 84
    let current = open(modelNode(), width)
    const report: string[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 2; current = open(page === 0 ? modelNode() : effortNode(), width) }
        else if (step === NARROW) { width = width === 62 ? 84 : 62; current = open(page === 0 ? modelNode() : effortNode(), width) }
        else current.surface.press(step)
      }
      const rows = current.surface.render()
      // Δ27: the kit draws `▌` in the filter field where the renderer parks the terminal cursor.
      const diffs = await frameDiffs(frames[index]!.rows, rows, 96, [{ delta: 'Δ27', rows: [1, 1], cols: [4, 5] }])
      const hint = HINT_ROW_DIFFERENCES[walk.name]?.[index]
      if (hint !== undefined) {
        // The difference is pinned to the hint row and to the text the renderer draws there; nothing else may differ.
        expect(plain(rows[HINT_ROW]).replace(/^│/u, '').replace(/│$/u, '').trim()).toBe(hint.trim())
        const rest = diffs.filter(diff => diff.row !== HINT_ROW)
        if (rest.length > 0) report.push(`frame ${String(index)} (${frames[index]!.label}):\n${diffReport(rest)}`)
        expect(diffs.some(diff => diff.row === HINT_ROW), 'the hint-row difference is still there').toBe(true)
        continue
      }
      if (diffs.length > 0) report.push(`frame ${String(index)} (${frames[index]!.label}):\n${diffReport(diffs)}`)
    }
    expect(report.join('\n')).toBe('')
  })
})

describe('spike: what the keys report', () => {
  it('reports the unpinned strip as no segment, and a pinned one as its option', async () => {
    const { surface, events } = open(modelNode(), 84)
    surface.press('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    surface.press('\x1b[C')
    surface.press('\x1b[C')
    surface.press('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    const accepts = events.filter(event => event.kind === 'selection-accept')
    expect(accepts.map(event => ({ selectedIds: event.selectedIds, segmentId: event.segmentId }))).toEqual([
      { selectedIds: [modelRowId('opencode-go', 'op-pro')], segmentId: undefined },
      { selectedIds: [modelRowId('opencode-go', 'op-pro')], segmentId: 'max' },
    ])
  })

  it('pins the live row to its effort, even when that is the model default, and reports it', async () => {
    const { surface, events } = open(modelNode({ provider: 'DeepSeek', model: 'ds-flash', reasoningEffort: 'high' }), 84)
    for (let step = 0; step < 3; step += 1) surface.press('\x1b[B')
    const rows = surface.render().map(plain)
    // Pinned to the value that is also the default: `high` is bracketed with no `(default)`, unlike the unpinned rows.
    expect(rows.find(row => row.includes('V41-Flash'))).toMatch(/min ‹ high › max/u)
    surface.press('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events.find(event => event.kind === 'selection-accept')?.segmentId).toBe('high')
  })

  it('tells a filter that matches nothing from an empty catalog', () => {
    const { surface } = open(modelNode(), 84)
    surface.press('/')
    for (const key of 'zzz') surface.press(key)
    expect(surface.render().map(plain).join('\n')).toContain('No matches')
    expect(open(modelNode(undefined, []), 84).surface.render().map(plain).join('\n')).toContain('No models advertised')
  })

  it('reuses the node for equal props and rebuilds for a new translator (memo compares props shallowly)', () => {
    const props = { models: MODELS, current: CURRENT, t }
    expect(ModelPicker.render(props)).toBe(ModelPicker.render({ ...props }))
    expect(ModelPicker.render(props)).not.toBe(ModelPicker.render({ ...props, t: (key: string) => key }))
  })
})

/** A catalog of `count` rows over six providers, the shape of a large `catalogRows` result. */
const catalog = (count: number): readonly ModelFact[] => Array.from({ length: count }, (_, index) => ({
  provider: `p${String(index % 6)}`, providerLabel: `Provider ${String(index % 6)}`, id: `m${String(index)}`, name: `model-${String(index)}`,
  contextWindow: 131_072, efforts: ['min', 'high', 'max'], defaultEffort: 'high',
})).sort((a, b) => a.provider.localeCompare(b.provider))

/** The counters of the last key of `keys` on a warmed picker, read the way `tests/perf/work-budget.spec.ts` reads a step. */
function keyWork(models: readonly ModelFact[], keys: readonly string[]): MayflyWorkCounters {
  const counters = createWorkCounters()
  const surface = createRealSurface(modelNode(undefined, models), 84, { components: parityComponents(), overrides: { counters } })
  surfaces.push(surface)
  surface.render()
  for (const key of keys.slice(0, -1)) surface.press(key)
  Object.assign(counters, createWorkCounters())
  surface.press(keys.at(-1)!)
  return { ...counters }
}

describe('spike: the work of one key in the picker', () => {
  // Each entry is the keys pressed; the work counted is the last one. The picker is framed, so every step also pays the frame.
  const KEYS = {
    down: ['\x1b[B'], strip: ['\x1b[C'], search: ['/'], 'filter-keeps-all': ['/', 'd'], 'filter-narrows': ['/', '3', '9', '9'], accept: ['\r'],
  } as const
  const SIZES = [6, 400, 4000] as const
  const work = Object.fromEntries(SIZES.map(size => [size, Object.fromEntries(Object.entries(KEYS).map(([name, keys]) => [name, keyWork(catalog(size), keys)]))]))

  it.each(Object.keys(KEYS))('%s validates and compiles nothing, and paints at most two rows', name => {
    for (const size of SIZES) {
      const counters = work[size]![name]!
      expect(counters.nodesValidated, `${name} at ${String(size)} rows`).toBe(0)
      expect(counters.unitsCompiled, `${name} at ${String(size)} rows`).toBe(0)
      expect(counters.rowsPainted, `${name} at ${String(size)} rows`).toBeLessThanOrEqual(name === 'filter-narrows' ? 40 : 2)
    }
  })

  // A narrowing filter is excluded: the 4,000-row catalog has 11 matches for `399` and the 400-row one has 1, so it paints the matches.
  it.each(Object.keys(KEYS).filter(name => name !== 'filter-narrows'))('%s measures the same strings at 400 and at 4,000 rows (the cost is the frame, not the catalog)', name => {
    expect(work[4000]![name]!.stringsMeasured).toBe(work[400]![name]!.stringsMeasured)
    expect(work[4000]![name]!.rowsPainted).toBe(work[400]![name]!.rowsPainted)
  })

  it('prints the table the report quotes', () => {
    if (process.env.SPIKE_TABLE === '1') process.stderr.write(`${JSON.stringify(work, null, 1)}\n`)
  })
})
