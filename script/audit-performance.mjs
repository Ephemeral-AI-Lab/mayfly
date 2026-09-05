/** Reproducible headless audit timings; run after build with Node --experimental-transform-types --expose-gc.
 * @module script/audit-performance
 */
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { ui } from '../packages/ui/lib/index.js'
import { apply } from '../packages/ui/lib/provider.js'
import { compileMayflyUiNode, MayflyComponentsService } from '../packages/mayfly/lib/core.js'
import { DARK_COLORS } from '../packages/mayfly/lib/theme-dark.js'
import { OfficialConversationModelSource } from '../packages/mayfly/src/transcript/official-model.ts'
import { conversationProjectionSchema } from '../packages/mayfly/src/conversation/projection.ts'
import { FakeTerminal } from '../packages/mayfly/tests/core/fake-terminal.ts'

const require = createRequire(new URL('../packages/mayfly/package.json', import.meta.url))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { TuiMainScreen } = await import(require.resolve('@earendil-works/pi-tui'))
const samples = 7
const results = []
const ctx = new Context()
const owner = await ctx.plugin({ name: 'audit-performance', apply })
const components = new MayflyComponentsService(ctx, {
  theme: { colors: DARK_COLORS },
  tui: new TuiMainScreen(new FakeTerminal(80, 24)),
})

async function measure(size, scenario, action, prepare = () => {}) {
  prepare()
  action()
  const times = []
  const delays = []
  const heaps = []
  for (let iteration = 0; iteration < samples; iteration += 1) {
    prepare()
    global.gc?.()
    await setImmediate()
    const heap = process.memoryUsage().heapUsed
    const start = performance.now()
    action()
    times.push(performance.now() - start)
    heaps.push(Math.max(0, process.memoryUsage().heapUsed - heap))
    await setImmediate()
    delays.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  heaps.sort((a, b) => a - b)
  results.push({ size, scenario, medianMs: Number(times[3].toFixed(3)),
    p95Ms: Number(times[6].toFixed(3)), maxYieldDelayMs: Number(Math.max(...delays).toFixed(3)),
    medianHeapGrowthBytes: heaps[3], rssBytes: process.memoryUsage().rss })
}

function compile(node) {
  const result = compileMayflyUiNode(node, {
    components, colors: DARK_COLORS, getViewport: () => ({ columns: 80, rows: 24 }),
    screenMode: 'alternate', emit: () => {},
  })
  if (!result.ok) throw new Error(result.message)
  result.value.component.render(80)
  return result.value
}

try {
  for (const size of [1_000, 10_000, 100_000]) {
    const items = Array.from({ length: size }, (_, index) => ({ id: String(index), label: `Item ${index}` }))
    const pane = ctx.mayflyPanes.register({ id: 'audit.list', placement: 'bottom' })
    const published = () => ctx.mayflyPanes.list()[0].node
    await measure(size, 'list.first-build-publish-render', () => {
      pane.set(ui.list({ id: 'items', selectedIds: [], items }))
      compile(published())
    })
    const frozen = ui.list({ id: 'items', selectedIds: [], items })
    await measure(size, 'list.repeat-publish-render', () => { pane.set(frozen); compile(published()) })
    await measure(size, 'list.selection-update-render', () => {
      pane.set(ui.list({ ...frozen, selectedIds: ['1'] }))
      compile(published())
    })
    const compiled = compile(published())
    await measure(size, 'list.page-down-render', () => {
      compiled.focusTarget.handleInput('\u001b[6~')
      compiled.component.render(80)
    })
    pane.dispose()

    const entries = Array.from({ length: size }, (_, index) => ({ kind: 'assistant', id: String(index),
      seq: index, updatedSeq: index, turn: index, step: 0, text: 'hello', streaming: false }))
    let value = { entries, streaming: true }
    let seq = size
    let changed
    const session = {}
    const source = new OfficialConversationModelSource({
      snapshot: () => ({ asOfSeq: seq, values: { mayflyConversation: value } }),
      onChanged: listener => { changed = listener; return () => { changed = undefined } },
    }, {}, () => {})
    source.attach(session)
    const nativeDelta = () => {
      value = conversationProjectionSchema.parse({ ...value, entries: [
        ...value.entries.slice(0, -1), { ...value.entries.at(-1), updatedSeq: seq + 1, text: `delta ${seq}` },
      ] })
    }
    await measure(size, 'transcript.source-after-native-clone', () => {
      changed(session, 'mayflyConversation', value, ++seq)
      if (source.snapshot().entries.length !== 200) throw new Error('transcript window changed')
    }, nativeDelta)
    await measure(size, 'transcript.native-parse-and-source', () => {
      nativeDelta()
      changed(session, 'mayflyConversation', value, ++seq)
    })
    source.dispose()
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    samples, gc: typeof global.gc === 'function', note: 'Headless synthetic timings, not terminal FPS. Heap growth is not total allocation.', results }, null, 2))
} finally {
  await owner.dispose()
}
