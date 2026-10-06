/**
 * The work-budget workloads W1 to W8 (docs/design/implementation-roadmap.md section 7.1). Each one builds a surface of
 * a stated shape, then runs one steady-state step that publishes, presses a key, or ticks the clock, and reports the
 * counters of that step alone. The counts are deterministic, so a spec gates them; `script/audit-performance.mjs`
 * runs the same workloads beside its wall-clock timings.
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { freezeWire, ui } from '@ephemeral-ai/mayfly-ui'
import {
  MayflyUiSurfaceRuntime,
  compileMayflyStatusNode,
  compileMayflyUiSurfaceNode,
  type MayflyCompiledUi,
  type MayflyUiCompilerOptions,
} from '../../src/core/ui-compiler.ts'
import { MayflyCompileCache } from '../../src/core/ui-compile-cache.ts'
import { createAdmissionCache } from '../../src/core/ui-validator.ts'
import { UiSurfaceModel, type UiSurfaceSnapshot } from '../../src/core/ui-interaction-surface.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from '../core/fake-editor.ts'

/** What a workload needs from its host: a clock it can advance (fake timers under vitest, mock timers in a script). */
export interface WorkloadEnvironment {
  readonly advance: (milliseconds: number) => void
}

export interface WorkloadRun {
  /** Runs the measured step once. */
  step(): void
  dispose(): void
}

export interface Workload {
  readonly id: string
  readonly title: string
  /** Builds the surface and warms it with one paint; the counters start at zero when `step` runs. */
  setup(counters: MayflyWorkCounters, environment: WorkloadEnvironment): WorkloadRun
}

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const components = {
  visibleWidth,
  wrapText: wrapTextWithAnsi,
  truncateToWidth,
  sliceByColumn,
  createEditor: createFakeEditor,
  createMarkdown: (options?: { text?: string }) => {
    let value = options?.text ?? ''
    return { setText: (text: string) => { value = text }, render: (width: number) => wrapTextWithAnsi(value, width), invalidate: () => {} }
  },
} as unknown as MayflyComponents

const WIDTH = 100
const ROWS = 40

/** One published surface the way the host holds it: a model, a runtime, and the component compiled from them. */
class Surface {
  readonly model: UiSurfaceModel
  readonly runtime: MayflyUiSurfaceRuntime
  private readonly events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
  private revision = 1
  private compiled: MayflyCompiledUi | undefined

  constructor(id: string, node: MayflyUiNode, private readonly counters: MayflyWorkCounters, private readonly width = WIDTH) {
    this.model = new UiSurfaceModel(id, this.snapshot(id, node), { counters })
    if (this.model.node === null || (this.model.node.kind === 'text' && this.model.node.tone === 'danger')) throw new Error(`workload surface ${id} was rejected by admission`)
    this.runtime = new MayflyUiSurfaceRuntime(this.model, () => { this.compiled?.component.invalidate?.() })
  }

  private snapshot(id: string, node: MayflyUiNode): UiSurfaceSnapshot {
    return {
      id, node, revision: this.revision, source: [], scope: { kind: 'app', targetId: id }, update: { reason: 'data' },
      events: this.events, definition: { onEvent: {} },
    } as unknown as UiSurfaceSnapshot
  }

  private options(): MayflyUiCompilerOptions & { surfaceRuntime: MayflyUiSurfaceRuntime } {
    return {
      components, colors, getViewport: () => ({ columns: this.width, rows: ROWS }), screenMode: 'alternate',
      emit: (_event: MayflyUiEvent) => {}, contextHints: { enabled: true }, counters: this.counters, surfaceRuntime: this.runtime,
    }
  }

  /** Compiles the model's node, as the surface renderer does after a publish. */
  compile(): MayflyCompiledUi {
    const result = compileMayflyUiSurfaceNode(this.model.node!, this.options())
    if (!result.ok) throw new Error(result.message)
    this.compiled = result.value
    if (this.compiled.focusTarget !== null) this.compiled.focusTarget.focused = true
    return this.compiled
  }

  render(width = this.width): string[] {
    return (this.compiled ?? this.compile()).component.render(width)
  }

  /** A new snapshot of the same surface: admission, recompile, and paint. */
  publish(node: MayflyUiNode): string[] {
    this.revision += 1
    this.model.receive(this.snapshot(this.model.instanceId, node))
    this.compile()
    return this.render()
  }

  press(key: string): string[] {
    ;(this.compiled ?? this.compile()).focusTarget?.handleInput?.(key)
    return this.render()
  }

  dispose(): void {
    this.runtime.dispose()
    this.model.dispose()
  }
}

const reset = (counters: MayflyWorkCounters): void => { Object.assign(counters, createWorkCounters()) }

const item = (index: number, extra = {}): { id: string, label: string, detail: string } => ({ id: `item-${String(index)}`, label: `Item number ${String(index)}`, detail: `detail ${String(index)}`, ...extra })

function listNode(id: string, items: readonly ReturnType<typeof item>[]): MayflyUiNode {
  return ui.list({ id, role: 'browse', selectedIds: [], items })
}

function fieldBlock(prefix: string, count: number, revision = 0): MayflyUiNode {
  return ui.form({
    id: `${prefix}-form`,
    fields: Array.from({ length: count }, (_, index) => ({ kind: 'input' as const, id: `${prefix}-${String(index)}`, label: `Field ${String(index)}`, value: `value ${String(index)} ${String(revision)}` })),
  })
}

/** A settings-sized panel: a form of ten fields over a short list. */
function settingsPanel(): MayflyUiNode {
  return ui.stack.column([ui.child(fieldBlock('settings', 10)), ui.child(listNode('namespaces', Array.from({ length: 8 }, (_, index) => item(index))))])
}

/** W6 with `changed` of the 32 panes republished in one burst; the spec checks that the work grows with `changed`, not with 32. */
export function swarmWorkload(changed: number): Workload {
  return {
    id: 'W6', title: `swarm: 32 panes of a field block and an 8-item list, a burst changes ${String(changed)} of them`,
    setup(counters) {
      const paneNode = (index: number, revision = 0): MayflyUiNode => ui.stack.column([ui.child(fieldBlock(`pane-${String(index)}`, 4, revision)), ui.child(listNode(`list-${String(index)}`, Array.from({ length: 8 }, (__, row) => item(row))))])
      const panes = Array.from({ length: 32 }, (_, index) => new Surface(`w6-${String(index)}`, paneNode(index), counters))
      for (const pane of panes) pane.render()
      let revision = 0
      reset(counters)
      return {
        step: () => {
          revision += 1
          for (let step = 0; step < changed; step += 1) {
            const index = 3 + step * 8
            panes[index]!.publish(paneNode(index, revision))
          }
        },
        dispose: () => { for (const pane of panes) pane.dispose() },
      }
    },
  }
}

export const WORKLOADS: readonly Workload[] = [
  {
    id: 'W1', title: 'status tick: a row of 12 entries, one entry changes',
    setup(counters) {
      const entries = Array.from({ length: 12 }, (_, index) => ui.richText([{ text: `entry ${String(index)} ` }, { text: '0', tone: 'muted' }]))
      let revision = 0
      const admission = createAdmissionCache()
      const reuse = new MayflyCompileCache()
      const publish = (): void => {
        revision += 1
        const children = entries.map((entry, index) => ui.child(index === 11 ? ui.richText([{ text: 'entry 11 ' }, { text: String(revision), tone: 'muted' }]) : entry))
        const result = compileMayflyStatusNode(ui.stack.row(children), { components, colors, getViewport: () => ({ columns: WIDTH, rows: ROWS }), screenMode: 'alternate', counters, admission, reuse })
        if (!result.ok) throw new Error(result.message)
        result.value.component.render(WIDTH)
      }
      publish()
      reset(counters)
      return { step: publish, dispose: () => {} }
    },
  },
  {
    id: 'W2', title: 'spinner tick: 120 static rows (the tree quota is 256 nodes) and one loader, one clock tick',
    setup(counters, environment) {
      const rows = Array.from({ length: 120 }, (_, index) => ui.child(ui.text(`static row ${String(index)}`)))
      const surface = new Surface('w2', ui.stack.column([ui.child(ui.loader({ message: 'Working', variant: 'braille' })), ...rows]), counters)
      surface.render()
      reset(counters)
      return { step: () => { environment.advance(100); surface.render() }, dispose: () => surface.dispose() }
    },
  },
  {
    id: 'W3', title: 'list cursor: a list of 10,000 items, Down',
    setup(counters) {
      const surface = new Surface('w3', listNode('big', Array.from({ length: 10_000 }, (_, index) => item(index))), counters)
      surface.render()
      reset(counters)
      return { step: () => { surface.press('\x1b[B') }, dispose: () => surface.dispose() }
    },
  },
  {
    id: 'W4', title: 'stream: a list of 2,000 items, the last item changes',
    setup(counters) {
      // A stream keeps its settled items as frozen snapshots, so a republish shares them by identity.
      const items = Array.from({ length: 2000 }, (_, index) => freezeWire(item(index)))
      const surface = new Surface('w4', listNode('stream', items), counters)
      surface.render()
      let revision = 0
      reset(counters)
      return {
        step: () => {
          revision += 1
          surface.publish(listNode('stream', [...items.slice(0, -1), item(1999, { detail: `streaming ${String(revision)}` })]))
        },
        dispose: () => surface.dispose(),
      }
    },
  },
  {
    id: 'W5', title: 'form key: a form of 20 fields, one keystroke into the focused field',
    setup(counters) {
      const surface = new Surface('w5', fieldBlock('typing', 20), counters)
      surface.render()
      surface.press('\r')
      reset(counters)
      return { step: () => { surface.press('a') }, dispose: () => surface.dispose() }
    },
  },
  swarmWorkload(4),
  {
    id: 'W7', title: 'resize: a settings-sized panel painted at a new width',
    setup(counters) {
      const surface = new Surface('w7', settingsPanel(), counters)
      surface.render(WIDTH)
      let wide = false
      reset(counters)
      return { step: () => { wide = !wide; surface.render(wide ? 60 : WIDTH) }, dispose: () => surface.dispose() }
    },
  },
  {
    id: 'W8', title: 'cold open: a settings-sized panel, the first publish',
    setup(counters) {
      let surface: Surface | undefined
      return {
        step: () => {
          surface = new Surface('w8', settingsPanel(), counters)
          surface.render()
        },
        dispose: () => surface?.dispose(),
      }
    },
  },
]

/** Runs one workload and returns the counters of its measured step. */
export function measureWorkload(workload: Workload, environment: WorkloadEnvironment): MayflyWorkCounters {
  const counters = createWorkCounters()
  const run = workload.setup(counters, environment)
  try {
    run.step()
    return { ...counters }
  } finally {
    run.dispose()
  }
}
