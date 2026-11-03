/** Reproducible headless audit timings; run after build with Node --experimental-transform-types --expose-gc.
 * @module script/audit-performance
 */
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { ui } from '../packages/ui/lib/index.js'
import { apply } from '../packages/ui/lib/provider.js'
import { compileMayflyUiNode, MayflyComponentsService } from '../packages/mayfly/lib/core.js'
import * as frontend from '../packages/mayfly/lib/frontend.js'
import { DARK_COLORS } from '../packages/mayfly/lib/theme-dark.js'
import { conversationTranscriptModel, OfficialConversationModelSource } from '../packages/mayfly/src/transcript/official-model.ts'
import { conversationProjectionSchema, foldConversationProjection, initialConversationState } from '../packages/mayfly/src/conversation/projection.ts'
import { NO_DISCLOSURE } from '../packages/mayfly/src/transcript/disclosure.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION } from '../packages/mayfly/src/transcript/presentation-policy.ts'
import { findHits, readPattern } from '../packages/mayfly/src/transcript/search.ts'
import { StreamFacts } from '../packages/mayfly/src/transcript/stream-facts.ts'
import { moveDocument, reconcileDocument } from '../packages/mayfly/src/core/ui-interaction-document.ts'
import { FakeTerminal } from '../packages/mayfly/tests/core/fake-terminal.ts'
import { assertUnchangedEntriesReused, LongSessionHarness, longSessionDraft, longSessionProjection, longSessionTools, pendingLastTool, settleLastTool } from '../packages/mayfly/tests/perf/long-session.ts'
import { SlotScreen, WORKLOADS } from '../packages/mayfly/tests/perf/workloads.ts'
import { event } from '../packages/mayfly/tests/transcript/helpers.ts'
import { createWorkCounters } from '../packages/mayfly/src/core/ui-work-counters.ts'

const require = createRequire(new URL('../packages/mayfly/package.json', import.meta.url))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { TuiMainScreen } = await import(require.resolve('@earendil-works/pi-tui'))
const samples = 7
const results = []
const ctx = new Context()
const owner = await ctx.plugin({ name: 'audit-performance', apply })
const frontendOwner = await ctx.plugin(frontend)
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

function compile(node, interaction) {
  const result = compileMayflyUiNode(node, {
    interaction, components, colors: DARK_COLORS, getViewport: () => ({ columns: 80, rows: 24 }),
    screenMode: 'alternate', emit: () => {},
  })
  if (!result.ok) throw new Error(result.message)
  result.value.component.render(80)
  return result.value
}

/* The scale curves are report-only: long-session timings and the counters of the same operations the
   work-budget rows measure at 2,000 turns. Every setup builds its own screen and harness, and warms the
   path once; the measured step starts after the counters are reset. */
const scale = []

function resetWorkCounters(counters) {
  Object.assign(counters, createWorkCounters())
}

function scaleRowWithKind(row, kind) {
  return { ...row, kind, ...(row.counters === undefined ? {} : { counters: { ...row.counters } }) }
}

async function measureScale(kind, size, sampleCount, setup) {
  const warm = setup()
  try {
    warm.run()
  } finally {
    warm.dispose()
  }
  const times = []
  let counters
  for (let iteration = 0; iteration < sampleCount; iteration += 1) {
    const sample = setup()
    try {
      global.gc?.()
      await setImmediate()
      const start = performance.now()
      sample.run()
      times.push(performance.now() - start)
      if (sample.counters !== undefined) counters = { ...sample.counters() }
    } finally {
      sample.dispose()
    }
    await setImmediate()
  }
  times.sort((left, right) => left - right)
  const medianIndex = Math.floor(times.length / 2)
  const p95Index = Math.max(0, Math.ceil(times.length * 0.95) - 1)
  return {
    kind, size, medianMs: Number(times[medianIndex].toFixed(3)), p95Ms: Number(times[p95Index].toFixed(3)),
    ...(counters === undefined ? {} : { counters }),
  }
}

/** The durable conversion W28 measures: the feed takes the settled projection and the source folds it. */
function durableConversionSetup(turns) {
  return () => {
    const initial = pendingLastTool(longSessionProjection(turns))
    const settled = settleLastTool(initial)
    const counters = createWorkCounters()
    const harness = new LongSessionHarness(new SlotScreen(counters), counters, 100)
    const view = harness.addView('main', initial)
    harness.show('main')
    harness.render()
    resetWorkCounters(counters)
    view.feed.push(settled, 2)
    return {
      run: () => { view.source.snapshot() },
      counters: () => counters,
      dispose: () => { harness.dispose() },
    }
  }
}

/** W28 exactly: the settled value is converted, the controller republishes, and the tail paints. */
function w28ScaleSetup(turns) {
  return () => {
    const initial = pendingLastTool(longSessionProjection(turns))
    const settled = settleLastTool(initial)
    const counters = createWorkCounters()
    const harness = new LongSessionHarness(new SlotScreen(counters), counters, 100)
    const view = harness.addView('main', initial)
    harness.show('main')
    harness.render()
    resetWorkCounters(counters)
    return {
      run: () => {
        view.feed.push(settled, 2)
        harness.publish()
        harness.render()
      },
      counters: () => counters,
      dispose: () => { harness.dispose() },
    }
  }
}

/** W29 exactly: one live draft grows by 24 characters, republishes, and keeps the settled entries. */
function w29ScaleSetup(turns) {
  return () => {
    const projection = longSessionProjection(turns)
    const text = 'The answer starts here and keeps going. '.repeat(40)
    const counters = createWorkCounters()
    const harness = new LongSessionHarness(new SlotScreen(counters), counters, 100)
    const view = harness.addView('main', projection, { draft: longSessionDraft(projection, text, 1) })
    harness.show('main')
    const before = view.source.snapshot()
    harness.render()
    resetWorkCounters(counters)
    let revision = 1
    return {
      run: () => {
        revision += 1
        view.feed.setDraft(longSessionDraft(projection, `${text} the tail keeps growing.`, revision))
        const after = harness.publish()
        assertUnchangedEntriesReused(before, after)
        harness.render()
      },
      counters: () => counters,
      dispose: () => { harness.dispose() },
    }
  }
}

/** W30 exactly: the pending call's captured tick fires and the tail paints. */
function w30ScaleSetup(turns) {
  return () => {
    const projection = pendingLastTool(longSessionProjection(turns))
    const counters = createWorkCounters()
    const harness = new LongSessionHarness(new SlotScreen(counters), counters, 100)
    harness.addView('main', projection)
    harness.show('main')
    harness.render()
    const fire = harness.tick.capture()
    if (fire === undefined) throw new Error(`W30 at ${String(turns)} turns: the pending call did not subscribe to the tick`)
    resetWorkCounters(counters)
    const tickAt = 1_700_000_000_000
    return {
      run: () => { fire(tickAt + 1000); harness.render() },
      counters: () => counters,
      dispose: () => { harness.dispose() },
    }
  }
}

/** W31 exactly: three retained views invalidate their tool presenters, then the shown view republishes. */
function w31ScaleSetup(turns) {
  return () => {
    const projection = longSessionProjection(turns)
    const counters = createWorkCounters()
    const harness = new LongSessionHarness(new SlotScreen(counters), counters, 100)
    const views = [harness.addView('a', projection), harness.addView('b', projection), harness.addView('c', projection)]
    harness.show('a')
    harness.render()
    resetWorkCounters(counters)
    return {
      run: () => {
        for (const view of views) view.source.invalidateTools()
        harness.republish()
        harness.render()
      },
      counters: () => counters,
      dispose: () => { harness.dispose() },
    }
  }
}

function scaleRun(turns, kind) {
  if (kind === 'W28') return w28ScaleSetup(turns)
  if (kind === 'W29') return w29ScaleSetup(turns)
  if (kind === 'W30') return w30ScaleSetup(turns)
  if (kind === 'W31') return w31ScaleSetup(turns)
  throw new Error(`unknown scale workload ${kind}`)
}

/** The stream facts build alone: the model is converted once per size, the facts are warmed, and only the pass is timed. */
function streamFactsScaleSetup(model) {
  const inputs = {
    policy: DEFAULT_TRANSCRIPT_PRESENTATION,
    disclosure: NO_DISCLOSURE,
    liveTurnHeader: false,
    t: key => key,
    now: 1_700_000_000_000,
    queued: [],
    requests: [],
  }
  return () => {
    const counters = createWorkCounters()
    const facts = new StreamFacts(counters)
    facts.build(model, inputs)
    resetWorkCounters(counters)
    return {
      run: () => { facts.build(model, inputs) },
      counters: () => counters,
      dispose: () => {},
    }
  }
}

/** The search refresh alone, as the controller runs it: every modeled part is searched for one pattern. */
function searchRefreshScaleSetup(model, pattern) {
  let result
  return () => ({
    run: () => { result = findHits(model, pattern) },
    counters: () => ({ hits: result.hits.length, parts: result.orders.size, turns: result.turnStart.size }),
    dispose: () => {},
  })
}

/** A tail user message appended to a durable state built from user turns, one fold per timed step. */
function projectionFoldScaleSetup(state, tail, turns) {
  const counters = { events: turns * 3, entries: state.entries.length, finalizedSteps: state.finalizedSteps.length, turns: state.turns.length }
  return () => ({
    run: () => { foldConversationProjection(state, tail) },
    counters: () => counters,
    dispose: () => {},
  })
}

/** Fold the stated user/turn cycles into a durable conversation state; turn events open and close each one. */
function longFoldState(turns) {
  let state = initialConversationState()
  let time = 1_700_000_000_000
  for (let turn = 1; turn <= turns; turn += 1) {
    time += 1
    state = foldConversationProjection(state, event('turn/start', { turn }, time))
    time += 1
    state = foldConversationProjection(state, {
      ...event('user/message', {
        id: `scale-user-${String(turn)}`, role: 'user', content: [{ type: 'text', text: `long session message ${String(turn)}` }], source: { kind: 'user' },
      }, time),
      surfaceOp: 'append',
    })
    time += 1
    state = foldConversationProjection(state, event('turn/end', { turn, reason: { kind: 'completed' } }, time))
  }
  return state
}

function longFoldTail(turns) {
  return {
    ...event('user/message', {
      id: `scale-tail-${String(turns)}`, role: 'user', content: [{ type: 'text', text: 'the measured tail message' }], source: { kind: 'user' },
    }, 1_700_000_000_000 + turns * 3 + 1),
    surfaceOp: 'append',
  }
}

try {
  for (const size of [1_000, 10_000, 100_000]) {
    const items = Array.from({ length: size }, (_, index) => ({ id: String(index), label: `Item ${index}` }))
    const pane = ctx.mayflyPanes.register({ id: 'audit.list', placement: 'bottom' })
    const published = () => ctx.mayflyPanes.list()[0].node
    const interaction = () => ctx.mayflyUiInteraction.get('pane', 'audit.list')
    await measure(size, 'list.first-build-publish-render', () => {
      pane.set(ui.list({ id: 'items', role: 'browse', selectedIds: [], items }))
      compile(published(), interaction())
    })
    const frozen = ui.list({ id: 'items', role: 'browse', selectedIds: [], items })
    await measure(size, 'list.repeat-publish-render', () => { pane.set(frozen); compile(published(), interaction()) })
    await measure(size, 'list.selection-update-render', () => {
      pane.set(ui.list({ ...frozen, selectedIds: ['1'] }))
      compile(published(), interaction())
    })
    const compiled = compile(published(), interaction())
    const revision = interaction().revision
    await measure(size, 'list.repeat-render', () => {
      compiled.component.render(80)
      if (interaction().revision !== revision) throw new Error('render mutated interaction state')
    })
    await measure(size, 'list.page-down-render', () => {
      compiled.focusTarget.handleInput('\u001b[6~')
      compiled.component.render(80)
    })

    const address = { pagePath: [], controlId: 'items' }
    interaction().updateChoice(address, { kind: 'query', query: 'Item' })
    const filtered = compile(published(), interaction())
    await measure(size, 'list.filtered-repeat-render', () => { filtered.component.render(80) })
    await measure(size, 'list.filtered-page-down-render', () => {
      filtered.focusTarget.handleInput('\u001b[6~')
      filtered.component.render(80)
    })

    interaction().updateChoice(address, { kind: 'clear-search' })
    pane.set(ui.list({ ...frozen, tree: true }))
    const tree = compile(published(), interaction())
    await measure(size, 'list.tree-repeat-render', () => { tree.component.render(80) })
    await measure(size, 'list.tree-page-down-render', () => {
      tree.focusTarget.handleInput('\u001b[6~')
      tree.component.render(80)
    })
    pane.dispose()

    const entries = Array.from({ length: size }, (_, index) => ({ kind: 'assistant', id: String(index),
      seq: index, updatedSeq: index, turn: index, step: 0, text: 'hello', streaming: false }))
    let value = { entries, streaming: true, settledSteps: [], turns: [] }
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
      const snapshot = source.snapshot()
      if (snapshot.entries.length !== size || snapshot.entries.at(-1)?.id !== String(size - 1)) {
        throw new Error('complete transcript projection changed')
      }
    }, nativeDelta)
    await measure(size, 'transcript.native-parse-and-source', () => {
      nativeDelta()
      changed(session, 'mayflyConversation', value, ++seq)
    })
    source.dispose()

    const text = 'x'.repeat(size)
    const document = id => ui.scroll(ui.text(id), { id: 'audit.document' })
    const initialDocument = reconcileDocument(undefined, document(text))
    const anchoredDocument = moveDocument(initialDocument, { blockId: initialDocument.blocks[0].id, offset: Math.floor(size / 2), follow: 'none' })
    await measure(size, 'document.append-reconcile', () => {
      const next = reconcileDocument(anchoredDocument, document(`${text}tail`))
      if (next.anchor?.offset !== Math.floor(size / 2)) throw new Error('document append moved the anchor')
    })
    await measure(size, 'document.prepend-reconcile', () => {
      const next = reconcileDocument(anchoredDocument, document(`head${text}`))
      if (next.anchor?.offset !== Math.floor(size / 2) + 4) throw new Error('document prepend lost the anchor')
    })
  }

  /* Concurrent subagent activity publishes many pane snapshots per frame;
     a swarm burst covers the admit+compile path that storms hit. */
  for (const agents of [8, 32]) {
    const swarm = Array.from({ length: agents }, (_, index) => ctx.mayflyPanes.register({ id: `audit.swarm.${index}`, placement: 'bottom' }))
    const memberNode = index => ui.stack.column([
      ui.fields([{ label: 'agent', value: [{ text: `swarm-${index}` }] }]),
      ui.list({ id: `swarm-${index}`, role: 'browse', selectedIds: [], items: Array.from({ length: 8 }, (_, item) => ({ id: String(item), label: `tool ${item}` })) }),
    ])
    const swarmPublished = index => ctx.mayflyPanes.list().find(entry => entry.id === `audit.swarm.${index}`).node
    const swarmInteraction = index => ctx.mayflyUiInteraction.get('pane', `audit.swarm.${index}`)
    await measure(agents, 'swarm.publish-burst', () => {
      for (const [index, pane] of swarm.entries()) pane.set(memberNode(index))
    })
    await measure(agents, 'swarm.publish-compile-burst', () => {
      for (const [index, pane] of swarm.entries()) { pane.set(memberNode(index)); compile(swarmPublished(index), swarmInteraction(index)) }
    })
    const compiledSwarm = swarm.map((_, index) => compile(swarmPublished(index), swarmInteraction(index)))
    await measure(agents, 'swarm.steady-state-frame', () => {
      for (const surface of compiledSwarm) surface.component.render(80)
    })
    for (const pane of swarm) pane.dispose()
  }
  /* The work-budget workloads W1-W8 (roadmap section 7.1), and W1-slot and W4-slot, the same status
     row and stream published through the node slot (slice 1.10a): the counters are the gate in
     tests/perf/work-budget.spec.ts; the timing is reported beside them and gates nothing. */
  mock.timers.enable({ apis: ['setTimeout'] })
  const environment = { advance: milliseconds => mock.timers.tick(milliseconds) }
  const workloads = []
  for (const workload of WORKLOADS) {
    const times = []
    let counters
    for (let iteration = 0; iteration < samples; iteration += 1) {
      counters = createWorkCounters()
      const run = workload.setup(counters, environment)
      const start = performance.now()
      run.step()
      times.push(performance.now() - start)
      counters = { ...counters }
      run.dispose()
    }
    times.sort((a, b) => a - b)
    workloads.push({ id: workload.id, title: workload.title, medianMs: Number(times[3].toFixed(3)), p95Ms: Number(times[6].toFixed(3)), counters })
  }
  mock.timers.reset()
  /* The scale curves: the long-session conversion and publish paths, the StreamFacts pass alone, the
     search refresh, and the fold of one more durable event, at sizes the work budgets cannot afford.
     The draft, tick, and tools/change rows are the W29-W31 steps, repeated here under their own names;
     the W rows carry their exact counters. */
  for (const size of [100, 500, 2_000]) {
    const sampleCount = size === 100 ? samples : 3
    const model = conversationTranscriptModel(pendingLastTool(longSessionProjection(size)), longSessionTools())
    const durable = await measureScale('durable-conversion', size, sampleCount, durableConversionSetup(size))
    const streamFacts = await measureScale('stream-facts-build', size, sampleCount, streamFactsScaleSetup(model))
    const w28 = await measureScale('W28', size, sampleCount, scaleRun(size, 'W28'))
    const w29 = await measureScale('W29', size, sampleCount, scaleRun(size, 'W29'))
    const w30 = await measureScale('W30', size, sampleCount, scaleRun(size, 'W30'))
    const w31 = await measureScale('W31', size, sampleCount, scaleRun(size, 'W31'))
    const search = await measureScale('search-refresh (findHits)', size, sampleCount, searchRefreshScaleSetup(model, readPattern('session')))
    scale.push(
      durable,
      streamFacts,
      w28,
      scaleRowWithKind(w29, 'draft-publish'),
      w29,
      scaleRowWithKind(w30, 'tick-publish'),
      w30,
      scaleRowWithKind(w31, 'tools-change'),
      w31,
      search,
    )
  }
  /* A durable state that has folded these many user turns, then one more event at the tail. */
  for (const size of [1_000, 5_000, 20_000]) {
    const sampleCount = size === 1_000 ? samples : 3
    const state = longFoldState(size)
    scale.push(await measureScale('projection-fold', size, sampleCount, projectionFoldScaleSetup(state, longFoldTail(size), size)))
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    samples, gc: typeof global.gc === 'function', note: 'Headless synthetic timings, not terminal FPS. Heap growth is not total allocation. Workload counters are exact; stringsMeasured covers the injected seam and the compiler frame paths only.', results, workloads, scale }, null, 2))
} finally {
  await frontendOwner.dispose()
  await owner.dispose()
}
