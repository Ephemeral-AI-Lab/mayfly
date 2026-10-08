/**
 * The views lane: the views of status row 2. A view is a `mayflyPanes` pane with `placement: 'views'`; the lane has no
 * rows of its own. Each view's summary joins status row 2 as a status entry; while a view is entered, its panel
 * replaces row 2 under a tab strip of every enterable view, and the lane's one focusable component carries the keys:
 * `←`/`→` switch views, `Esc` (through the panel's own unhandled-escape path) returns to the prompt, and every other
 * key reaches the active panel. The lane is plain state plus painting: the renderer binds its host (colors, keymap,
 * focus, and the viewport) and the surface manager owns the focus id. Registrations carry no renderer objects.
 *
 * @module @ephemeral-ai/mayfly/core/views-lane
 */
import type { MayflyStatusEntry, MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'
import { displayKey, keyActionKeys, matchesKeyAction, ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT } from './key-actions.ts'
import { glyphRows, type MayflyGlyphMode } from './glyphs.ts'
import { sanitizePluginText } from './plugin-view.ts'
import { renderOverflowRow } from './ui-patterns.ts'
import type { MayflyComponent, MayflyFocusable, MayflyKeymap, MayflySemanticColors } from './types.ts'
import { sliceByColumn, truncateToWidth, visibleWidth } from './width.ts'

/** The id under which the surface manager records the lane's focus (`SurfaceManager.focusedId`); no pane id can spell it. */
export const VIEWS_FOCUS_ID = '@views'
/** Columns between two tabs of the strip. */
export const VIEWS_TAB_GAP = 3
/** The smallest the entered lane gets: the strip, the rule, and two panel rows. */
export const VIEWS_MIN_ROWS = 4
/** The rule under the active tab. */
const RULE = '━'

/** What a view puts in status row 2: a motion-free status node, and the count its tab shows. */
export interface ViewSummary {
  readonly node: MayflyStatusNode
  readonly count?: number | string
}

/** A view's declaration. */
export interface ViewContribution {
  readonly id: string
  readonly title?: string
  readonly priority?: number
  readonly summary: ViewSummary | null
}

/** One live view as the lane keeps it. */
interface ViewState {
  readonly id: string
  readonly title: string
  readonly priority: number
  summary: ViewSummary | null
  /** A lane-wide serial of the summary: unique across removals, so a status cache keyed by it never goes stale. */
  summarySerial: number
  panel: MayflyComponent | null
  focusTarget: MayflyFocusable | null
}

/** A view's slot in the lane. */
export interface ViewRegistration {
  readonly disposed: boolean
  /** Replace the row-2 summary; `null` takes the view out of the row. Identity-equal summaries change nothing. */
  setSummary(summary: ViewSummary | null): void
  /** Replace the panel and its focus target; a view with no panel, or none to focus, is in the row but cannot be entered. */
  setPanel(panel: MayflyComponent | null, focusTarget: MayflyFocusable | null): void
  dispose(): void
}

/** What the renderer lends the lane while it is mounted. */
export interface ViewsLaneHost {
  readonly colors: MayflySemanticColors
  readonly keymap?: MayflyKeymap | undefined
  readonly translate?: MayflyTranslate | undefined
  readonly glyphs?: MayflyGlyphMode | undefined
  /** Move focus to the lane's component (through the surface manager's focus bookkeeping). */
  focus(component: MayflyFocusable): void
  /** Hand focus back to what held it before the lane was entered. */
  release(): void
  requestRender(): void
  /** The terminal's size; the entered lane takes at most a third of its rows. */
  viewport(): { readonly columns: number, readonly rows: number }
}

/** The footer's read-only window onto the lane. */
export interface MayflyViewsSource {
  /** The summaries of status row 2 as status entries (id `views/<id>`, row 2, left band), in the lane's order. */
  statusEntries(): readonly MayflyStatusEntry[]
  /** The rows that replace row 2 while a view is entered; `undefined` otherwise. */
  panel(width: number): readonly string[] | undefined
}

/** A hint the renderer adds to a view panel's key row. */
export interface ViewHint {
  readonly id: string
  readonly keys: string
  readonly label: string
}

function chromeText(value: string): string {
  return sanitizePluginText(value).replace(/[\r\n]+/gu, ' ')
}

function fit(row: string, width: number): string {
  return visibleWidth(row) <= width ? row : sliceByColumn(row, 0, width, true)
}

/** The lane's focusable component: its rows are the strip, the rule, and the active panel; its keys are the lane's. */
class ViewsComponent implements MayflyFocusable {
  private focusedValue = false

  constructor(private readonly lane: ViewsLane) {}

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    this.lane.syncFocus(value)
  }

  render(width: number): string[] { return [...(this.lane.panel(width) ?? [])] }
  invalidate(): void { this.lane.invalidate() }
  handleInput(data: string): void { this.lane.handleInput(data) }
}

/**
 * The lane. Views sort by priority (lower first), then id; a view is *in the row* with a summary and *enterable* with a
 * summary, a panel, and a focus target. State changes bump {@link ViewsLane.revision} and ask the host for a repaint.
 */
export class ViewsLane implements MayflyViewsSource {
  /** The component the surface manager recognizes as the lane's focus. */
  readonly component: MayflyFocusable = new ViewsComponent(this)
  private readonly views = new Map<string, ViewState>()
  private host: ViewsLaneHost | undefined
  private revisionValue = 0
  private serial = 0
  private entered = false
  private activeId: string | undefined
  /** Where the active view sorted, so a vanished view hands over to the one now at its place. */
  private activeAt: { readonly priority: number, readonly id: string } | undefined
  private statusMemo: { readonly revision: number, readonly entries: readonly MayflyStatusEntry[] } | undefined

  /** Counts every change of the views, their summaries and panels, and the entered state. */
  get revision(): number { return this.revisionValue }

  /** Whether a view is entered: its panel replaces row 2 and the lane holds focus. */
  get isEntered(): boolean { return this.entered }

  /** Whether any view could be entered now. */
  get enterable(): boolean { return this.host !== undefined && this.tabs().length > 0 }

  /** The id of the view that is entered (or was last), when it is still enterable. */
  get active(): string | undefined { return this.activeView()?.id }

  /**
   * Lend the lane the renderer's colors, keymap, focus, and viewport. Unbinding leaves an entered view.
   * @param host - what the lane paints and focuses with.
   * @returns the disposer; a later bind replaces this host, so a stale disposer does nothing.
   */
  bind(host: ViewsLaneHost): () => void {
    this.host = host
    this.changed()
    return () => {
      if (this.host !== host) return
      this.leave()
      this.host = undefined
    }
  }

  /**
   * Add a view.
   * @param contribution - the view's id, tab title, priority, and first summary.
   * @returns the registration; disposing it removes the view and, when it was entered, moves on or leaves.
   * @throws Error for an id that is already registered.
   */
  register(contribution: ViewContribution): ViewRegistration {
    if (this.views.has(contribution.id)) throw new Error(`Duplicate view id: ${contribution.id}`)
    const state: ViewState = {
      id: contribution.id,
      title: chromeText(contribution.title ?? contribution.id),
      priority: Number.isFinite(contribution.priority) ? Math.floor(contribution.priority!) : 0,
      summary: contribution.summary,
      summarySerial: ++this.serial,
      panel: null,
      focusTarget: null,
    }
    this.views.set(state.id, state)
    this.changed()
    let disposed = false
    return {
      get disposed() { return disposed },
      setSummary: summary => {
        if (disposed || state.summary === summary) return
        state.summary = summary
        state.summarySerial = ++this.serial
        this.settle()
      },
      setPanel: (panel, focusTarget) => {
        if (disposed || (state.panel === panel && state.focusTarget === focusTarget)) return
        state.panel = panel
        state.focusTarget = focusTarget
        this.settle()
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        this.views.delete(state.id)
        this.settle()
      },
    }
  }

  /**
   * Enter a view: its panel replaces row 2 and takes focus.
   * @param id - the view; absent means the first enterable one (or the one already active).
   * @returns whether a view was entered.
   */
  enter(id?: string): boolean {
    const host = this.host
    if (host === undefined) return false
    const tabs = this.tabs()
    const target = id === undefined ? tabs.find(view => view.id === this.activeId) ?? tabs[0] : tabs.find(view => view.id === id)
    if (target === undefined) return false
    const wasEntered = this.entered
    this.moveActive(target.id)
    this.entered = true
    this.changed()
    if (!wasEntered) host.focus(this.component)
    return true
  }

  /** Return focus to where it was before the lane was entered. */
  leave(): void {
    if (!this.entered) return
    this.entered = false
    this.changed()
    this.host?.release()
  }

  /** The surface manager calls this when focus moved off the lane by any other path. */
  focusLost(): void {
    if (!this.entered) return
    this.entered = false
    this.changed()
  }

  /**
   * Move to a neighboring view; a boundary stays where it is.
   * @param delta - `-1` for the previous view, `1` for the next.
   * @returns whether the active view changed.
   */
  switchView(delta: -1 | 1): boolean {
    const tabs = this.tabs()
    const index = tabs.findIndex(view => view.id === this.activeId)
    const target = tabs[index + delta]
    if (index < 0 || target === undefined) return false
    this.moveActive(target.id)
    this.changed()
    return true
  }

  /** Drop what the panels cached; the next paint rebuilds from scratch. */
  invalidate(): void {
    for (const view of this.views.values()) view.panel?.invalidate()
  }

  /** The `←/→ tabs` hint of an entered panel, when there is more than one view to switch to. */
  hints(): readonly ViewHint[] {
    const keymap = this.host?.keymap
    const left = keyActionKeys(keymap, ACTION_SEGMENT_LEFT)[0]
    const right = keyActionKeys(keymap, ACTION_SEGMENT_RIGHT)[0]
    if (this.tabs().length < 2 || left === undefined || right === undefined) return []
    return [{ id: 'views', keys: `${displayKey(left)}/${displayKey(right)}`, label: 'tabs' }]
  }

  /** The panel's viewport while entered: the terminal's width and what a third of its rows leave under the strip and the rule. */
  viewport(): { readonly columns: number, readonly rows: number } {
    const size = this.host?.viewport() ?? { columns: 1, rows: 1 }
    return { columns: Math.max(1, size.columns), rows: Math.max(1, this.laneRows(size.rows) - 2) }
  }

  statusEntries(): readonly MayflyStatusEntry[] {
    if (this.statusMemo?.revision === this.revisionValue) return this.statusMemo.entries
    const entries = this.inRow().map((view): MayflyStatusEntry => Object.freeze({
      id: `views/${view.id}`,
      definition: Object.freeze({ id: `views/${view.id}`, priority: view.priority, band: 'left' as const, row: 2 as const }),
      node: view.summary!.node,
      revision: view.summarySerial,
    }))
    this.statusMemo = { revision: this.revisionValue, entries }
    return entries
  }

  panel(width: number): readonly string[] | undefined {
    const host = this.host
    const active = this.entered ? this.activeView() : undefined
    if (host === undefined || active === undefined) return undefined
    const available = Math.max(1, Math.floor(width))
    const { strip, rule } = this.paintStrip(host, available)
    const budget = Math.max(1, this.laneRows(host.viewport().rows) - 2)
    const rows = active.panel!.render(available).map(row => fit(row, available))
    const body = rows.length <= budget || budget <= 1
      ? rows.slice(0, budget)
      : [...rows.slice(0, budget - 1), fit(host.colors.muted(renderOverflowRow(rows.length - budget + 1, host.translate ?? interpolateLocaleMessage)), available)]
    return [...glyphRows([strip, rule], host.glyphs), ...body]
  }

  /** The component's key route: `←/→` switch views unless the panel is editing; every other key is the panel's. */
  handleInput(data: string): void {
    const active = this.entered ? this.activeView() : undefined
    if (active === undefined) return
    const editing = active.focusTarget!.captureFocusIdentity?.()?.editing === true
    const keymap = this.host?.keymap
    if (!editing && matchesKeyAction(keymap, data, ACTION_SEGMENT_LEFT)) { this.switchView(-1); return }
    if (!editing && matchesKeyAction(keymap, data, ACTION_SEGMENT_RIGHT)) { this.switchView(1); return }
    active.focusTarget!.handleInput?.(data)
  }

  /** Mirror the component's focus onto the active panel's focus target. */
  syncFocus(focused: boolean): void {
    const target = this.activeView()?.focusTarget
    if (target !== null && target !== undefined) target.focused = focused
  }

  private laneRows(terminalRows: number): number {
    return Math.max(VIEWS_MIN_ROWS, Math.floor(terminalRows / 3))
  }

  private inRow(): ViewState[] {
    return [...this.views.values()]
      .filter(view => view.summary !== null)
      .toSorted((left, right) => left.priority - right.priority || (left.id < right.id ? -1 : 1))
  }

  private tabs(): ViewState[] {
    return this.inRow().filter(view => view.panel !== null && view.focusTarget !== null)
  }

  private activeView(): ViewState | undefined {
    return this.tabs().find(view => view.id === this.activeId)
  }

  private moveActive(id: string): void {
    if (this.activeId === id) return
    const previous = this.activeView()
    if (previous?.focusTarget != null) previous.focusTarget.focused = false
    this.activeId = id
    const view = this.views.get(id)!
    this.activeAt = { priority: view.priority, id }
    this.syncFocus(this.component.focused)
  }

  /** A view changed shape: keep the active view enterable, or move on to the view now at its place, or leave. */
  private settle(): void {
    if (this.entered && this.activeView() === undefined) {
      const tabs = this.tabs()
      const next = tabs.find(view => this.follows(view)) ?? tabs.at(-1)
      if (next === undefined) {
        this.entered = false
        this.changed()
        this.host?.release()
        return
      }
      this.activeId = next.id
      this.activeAt = { priority: next.priority, id: next.id }
      this.syncFocus(this.component.focused)
    }
    this.changed()
  }

  /** Whether a view sorts at or after the place the active view held. */
  private follows(view: ViewState): boolean {
    const at = this.activeAt
    return at === undefined || view.priority > at.priority || (view.priority === at.priority && view.id >= at.id)
  }

  private changed(): void {
    this.revisionValue += 1
    this.statusMemo = undefined
    this.host?.requestRender()
  }

  private paintStrip(host: ViewsLaneHost, width: number): { readonly strip: string, readonly rule: string } {
    const tabs = this.tabs()
    const active = this.activeView()!
    const label = (view: ViewState): string => view.summary!.count === undefined ? view.title : `${view.title} ${chromeText(String(view.summary!.count))}`
    const labelWidth = (view: ViewState): number => visibleWidth(label(view))
    // The active tab always shows; the others join in order while the strip, and the `+N` that counts the rest, fit.
    const kept = new Set<ViewState>([active])
    const stripWidth = (): number => [...kept].reduce((sum, view) => sum + labelWidth(view), 0) + VIEWS_TAB_GAP * (kept.size - 1)
    for (const view of tabs) {
      if (view === active) continue
      kept.add(view)
      const hidden = tabs.length - kept.size
      if (stripWidth() + (hidden === 0 ? 0 : visibleWidth(` +${String(hidden)}`)) > width) kept.delete(view)
    }
    const shown = tabs.filter(view => kept.has(view))
    const hidden = tabs.length - shown.length
    const tab = (view: ViewState): string => {
      const color = view === active ? host.colors.primary : host.colors.muted
      if (labelWidth(view) > width) return color(truncateToWidth(label(view), width))
      const count = view.summary!.count
      return count === undefined ? color(view.title) : `${color(view.title)} ${color(chromeText(String(count)))}`
    }
    const gap = ' '.repeat(VIEWS_TAB_GAP)
    const before = shown.slice(0, shown.indexOf(active)).map(tab)
    const offset = before.length === 0 ? 0 : visibleWidth(before.join(gap)) + VIEWS_TAB_GAP
    const suffix = hidden === 0 ? '' : host.colors.muted(` +${String(hidden)}`)
    const strip = fit(shown.map(tab).join(gap) + suffix, width)
    const underline = Math.max(0, Math.min(labelWidth(active), width - offset))
    return { strip, rule: `${' '.repeat(Math.min(offset, width))}${host.colors.muted(RULE.repeat(underline))}` }
  }
}
