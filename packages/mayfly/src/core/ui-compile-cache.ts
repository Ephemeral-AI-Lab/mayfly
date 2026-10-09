/** Reuse of compiled static leaves: an admitted node that paints only from itself keeps its component across publishes.
 * @module @ephemeral-ai/mayfly/core/ui-compile-cache
 */
import type { MayflyComponent, MayflyComponents, MayflySemanticColors } from './types.ts'
import type { MayflyWorkCounters } from './ui-work-counters.ts'

/** What a reusable leaf reads from the surface that compiled it; it is re-pointed at the newest surface on every reuse. */
export interface PaintOptions {
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly counters?: MayflyWorkCounters | undefined
  readonly reportRuntimeFailure: (message: string) => void
}

interface Entry {
  readonly component: MayflyComponent
  readonly holder: { options: PaintOptions }
  readonly colors: MayflySemanticColors
  readonly components: MayflyComponents
  pass: number
}

/**
 * A per-surface memo from an admitted node to the component compiled from it. Admission shares the admitted object of an
 * unchanged subtree (see `MayflyAdmissionCache`), so the same object arriving again means the same painter, and its
 * per-width row memo survives with it. A leaf is reused only while the colors and components it was built for are the
 * ones now in use, and at most once per compile pass, because one component cannot sit at two layout positions.
 */
export class MayflyCompileCache {
  private readonly entries = new WeakMap<object, Entry>()
  private pass = 0

  /** Starts a compile pass; a leaf taken in an earlier pass may be taken again. */
  beginPass(): void { this.pass += 1 }

  /** The leaf compiled from `node` earlier, re-pointed at `options`, or undefined when there is none to reuse. */
  take(node: object, options: PaintOptions): MayflyComponent | undefined {
    const entry = this.entries.get(node)
    if (entry === undefined || entry.pass === this.pass || entry.colors !== options.colors || entry.components !== options.components) return undefined
    entry.pass = this.pass
    entry.holder.options = options
    return entry.component
  }

  /** Builds a leaf whose painter reads its surface through a holder, and remembers it for the next pass. */
  keep(node: object, options: PaintOptions, build: (paint: PaintOptions) => MayflyComponent): MayflyComponent {
    const holder = { options }
    const paint: PaintOptions = {
      components: options.components,
      colors: options.colors,
      get counters() { return holder.options.counters },
      reportRuntimeFailure: message => { holder.options.reportRuntimeFailure(message) },
    }
    const component = build(paint)
    // A node already taken this pass keeps its first component; the second occurrence is simply a fresh, unshared leaf.
    if (!this.entries.has(node) || this.entries.get(node)!.pass !== this.pass) {
      this.entries.set(node, { component, holder, colors: options.colors, components: options.components, pass: this.pass })
    }
    return component
  }
}
