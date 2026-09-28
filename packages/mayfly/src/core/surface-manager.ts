/**
 * Core-private arbitration for optional terminal surfaces. The public pane
 * registry owns declaration validation; this module receives already compiled
 * components and turns them into deterministic lane decisions.
 */

import type { MayflyComponent, MayflyFocusable } from './types.ts'
import { interpolateLocaleMessage } from '../frontend/locale.ts'
import { sanitizePluginText } from './plugin-view.ts'
import { renderOverflowRow } from './ui-patterns.ts'
import { sliceByColumn, visibleWidth } from './width.ts'

export type SurfacePlacement = 'header' | 'left' | 'right' | 'bottom'
export type SurfaceNarrowPolicy = 'bottom' | 'overlay' | 'hidden'

export interface SurfaceContribution {
  readonly id: string
  readonly title?: string
  readonly placement: SurfacePlacement
  readonly priority?: number
  readonly size?: {
    readonly min?: number
    readonly preferred?: number | 'auto'
    readonly max?: number
  }
  readonly narrow?: SurfaceNarrowPolicy
  readonly component: MayflyComponent
  readonly focusTarget?: MayflyFocusable | null
}

export interface SurfaceUserLayoutState {
  readonly hiddenIds: readonly string[]
  readonly order: readonly string[]
  readonly active: Readonly<Partial<Record<SurfacePlacement, string>>>
  readonly placements: Readonly<Record<string, SurfacePlacement>>
  readonly pinnedIds: readonly string[]
  readonly sizes: Readonly<Record<string, number>>
}

export type SurfaceUserLayoutInput = Partial<SurfaceUserLayoutState>

export interface SurfaceLaneEntry extends SurfaceContribution {
  readonly placement: SurfacePlacement
  readonly priority: number
  readonly pinned: boolean
}

export interface SurfaceLaneLayout {
  readonly placement: SurfacePlacement
  readonly entries: readonly SurfaceLaneEntry[]
  readonly active: SurfaceLaneEntry
  readonly width?: number
}

export interface SurfaceOverflowEntry {
  readonly entry: SurfaceLaneEntry
  readonly reason: 'hidden' | 'overlay'
}

export interface SurfaceLayout {
  readonly columns: number
  readonly rows: number
  readonly transcriptColumns: number
  readonly header?: SurfaceLaneLayout
  readonly left?: SurfaceLaneLayout
  readonly right?: SurfaceLaneLayout
  readonly bottom?: SurfaceLaneLayout
  readonly overflow: readonly SurfaceOverflowEntry[]
}

export interface SurfaceRegistration {
  readonly disposed: boolean
  setHidden(hidden: boolean): void
  replace(component: MayflyComponent, focusTarget?: MayflyFocusable | null): void
  dispose(): void
}

export interface SurfaceManagerOptions {
  readonly userState?: SurfaceUserLayoutInput
  readonly onChange?: () => void
  readonly onUserStateChange?: (state: SurfaceUserLayoutState) => void
  readonly onSurfaceFocusTransition?: (previous: MayflyFocusable, next: MayflyFocusable | null) => void
}

export const SURFACE_TRANSCRIPT_MIN_COLUMNS = 40
export const SURFACE_TRANSCRIPT_REOPEN_COLUMNS = 44
export const SURFACE_SIDE_MIN_COLUMNS = 20
export const SURFACE_SIDE_PREFERRED_COLUMNS = 32
export const SURFACE_SIDE_MAX_COLUMNS = 48
export const SURFACE_HEADER_MAX_ROWS = 4

const PLACEMENTS: readonly SurfacePlacement[] = ['header', 'left', 'right', 'bottom']

interface RegisteredSurface {
  contribution: SurfaceContribution
  hidden: boolean
}

function finiteInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.floor(value)
}

function compareId(left: string, right: string): number {
  /* v8 ignore next -- registered ids are unique, so sort never compares equal ids */
  return left < right ? -1 : left > right ? 1 : 0
}

function freezeUserState(input: SurfaceUserLayoutInput = {}): SurfaceUserLayoutState {
  const active = Object.freeze({ ...input.active })
  const placements = Object.freeze({ ...input.placements })
  const sizes = Object.freeze({ ...input.sizes })
  return Object.freeze({
    hiddenIds: Object.freeze([...(input.hiddenIds ?? [])]),
    order: Object.freeze([...(input.order ?? [])]),
    active,
    placements,
    pinnedIds: Object.freeze([...(input.pinnedIds ?? [])]),
    sizes,
  })
}

function safeDimension(value: number): number {
  return Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1)
}

function fit(value: string, width: number): string {
  const available = safeDimension(width)
  return visibleWidth(value) <= available ? value : sliceByColumn(value, 0, available, true)
}

function chromeText(value: string): string {
  return sanitizePluginText(value).replace(/[\r\n]+/gu, ' ')
}

function contributionFocusTarget(contribution: SurfaceContribution): MayflyFocusable | null {
  if (contribution.focusTarget !== undefined) return contribution.focusTarget
  return typeof (contribution.component as MayflyComponent & { focused?: unknown }).focused === 'boolean'
    ? contribution.component as MayflyFocusable
    : null
}

/** ANSI-aware Mayfly-owned lane tab chrome with deterministic overflow. */
export function renderSurfaceTabs(lane: SurfaceLaneLayout, width: number): string {
  const available = safeDimension(width)
  const selectable = selectableSurfaceEntries(lane)
  const activeId = selectable.some(entry => entry.id === lane.active.id) ? lane.active.id : selectable[0]?.id
  const tokens = selectable.map(entry => ({
    id: entry.id,
    value: entry.id === activeId ? `[${chromeText(entry.title ?? entry.id)}]` : chromeText(entry.title ?? entry.id),
  }))
  const complete = tokens.map(token => token.value).join(' ')
  if (visibleWidth(complete) <= available) return complete

  const activeIndex = tokens.findIndex(token => token.id === activeId)
  const kept = new Set<number>([activeIndex])
  for (let index = 0; index < tokens.length; index += 1) {
    if (kept.has(index)) continue
    const trial = [...kept, index].sort((left, right) => left - right).map(item => tokens[item]!.value)
    const hidden = tokens.length - trial.length
    /* v8 ignore next -- the full set was already proven too wide above */
    if (visibleWidth(`${trial.join(' ')}${hidden === 0 ? '' : ` +${String(hidden)}`}`) <= available) kept.add(index)
  }
  const ordered = [...kept].sort((left, right) => left - right).map(index => tokens[index]!.value)
  const hidden = tokens.length - ordered.length
  const suffix = ` +${String(hidden)}`
  const labelWidth = Math.max(1, available - visibleWidth(suffix))
  return fit(`${fit(ordered.join(' '), labelWidth)}${suffix}`, available)
}

/** Entries eligible for tab selection; passive bottom progress panes need no tab. */
function selectableSurfaceEntries(lane: SurfaceLaneLayout): readonly SurfaceLaneEntry[] {
  return lane.placement === 'bottom'
    ? lane.entries.filter(entry => contributionFocusTarget(entry) !== null)
    : lane.entries
}

/** Entries painted by one lane: passive bottom panes stack around one interactive tab. */
export function renderedSurfaceEntries(lane: SurfaceLaneLayout): readonly SurfaceLaneEntry[] {
  if (lane.placement !== 'bottom') return [lane.active]
  const interactive = selectableSurfaceEntries(lane)
  if (interactive.length === 0) return lane.entries
  const selected = interactive.find(entry => entry.id === lane.active.id) ?? interactive[0]!
  return lane.entries.filter(entry => contributionFocusTarget(entry) === null || entry.id === selected.id)
}

/** Tab chrome rows used by one lane; stacked bottom panes do not need tabs. */
export function surfaceLaneTabRows(lane: SurfaceLaneLayout): 0 | 1 {
  return selectableSurfaceEntries(lane).length > 1 ? 1 : 0
}

/** One bottom pane's row demand for {@link allocateBottomRows}. */
export interface BottomRowDemand {
  /** Rows the pane rendered. */
  readonly rows: number
  /** Rows granted before any pane grows; default 1 (the head row). */
  readonly min?: number | undefined
  /** Rows the pane may never exceed. */
  readonly max?: number | undefined
}

/**
 * Allot the bottom lane's row budget. Demands are in paint order (top to
 * bottom) and are served nearest the editor first: every pane first receives
 * its minimum (the head row by default), then rows are handed out one at a
 * time round-robin until the budget or every demand is exhausted. The result
 * is deterministic and never exceeds a pane's rows or `max`.
 * @param demands - the painted panes' demands, top to bottom.
 * @param budget - the lane rows available to panes.
 * @returns the rows granted to each demand, in the same order.
 */
export function allocateBottomRows(demands: readonly BottomRowDemand[], budget: number): number[] {
  const sizes = demands.map(() => 0)
  const caps = demands.map(demand => Math.max(0, Math.min(demand.rows, finiteInteger(demand.max, demand.rows))))
  const order = demands.map((_demand, index) => demands.length - 1 - index)
  let remaining = Math.max(0, finiteInteger(budget, 0))
  for (const index of order) {
    const grant = Math.min(remaining, caps[index]!, Math.max(1, finiteInteger(demands[index]!.min, 1)))
    sizes[index] = grant
    remaining -= grant
  }
  let grew = true
  while (remaining > 0 && grew) {
    grew = false
    for (const index of order) {
      if (remaining === 0) break
      if (sizes[index]! >= caps[index]!) continue
      sizes[index]! += 1
      remaining -= 1
      grew = true
    }
  }
  return sizes
}

/**
 * Fit one pane's rows to its allotment, keeping the head: an over-tall pane
 * shows its first rows and ends in a row naming how many were cut. When
 * `keepTail` is set the pane's own final row (a fold affordance) survives and
 * the overflow row moves in front of it.
 * @param rows - the pane's rows.
 * @param size - the allotted row count.
 * @param overflow - renders the replacement row for `hidden` cut rows.
 * @param keepTail - keep the final affordance row when at least 3 rows fit.
 * @returns at most `size` rows.
 */
export function fitSurfaceRows(rows: readonly string[], size: number, overflow: (hidden: number) => string, keepTail = false): string[] {
  if (rows.length <= size) return [...rows]
  if (size <= 1) return rows.slice(0, Math.max(0, size))
  const hidden = rows.length - size + 1
  if (keepTail && size >= 3) return [...rows.slice(0, size - 2), overflow(hidden), rows[rows.length - 1]!]
  return [...rows.slice(0, size - 1), overflow(hidden)]
}

/** Lane hooks a bottom pane component may offer beyond `render`. */
export interface SurfaceLaneRows {
  /** Whether the first rendered row is a plain rule the lane paints once. */
  readonly leadingRule?: boolean
  /** Paint the muted row that replaces `hidden` cut rows. */
  renderOverflow?(hidden: number, width: number): string
  /** Whether the final row is a fold affordance the lane must keep visible. */
  readonly overflowKeepsTail?: boolean
}

/** One painted entry of a planned bottom lane. */
export interface BottomLaneSlot {
  readonly entry: SurfaceLaneEntry
  /** Passive panes paint `rows`; an interactive pane lays out in `size` rows. */
  readonly passive: boolean
  readonly rows: readonly string[]
  readonly size: number
}

/** A bottom lane's rows for one width and budget. */
export interface BottomLanePlan {
  /** The single rule stacked passive panes share, when any leads with one. */
  readonly rule: string | undefined
  readonly tabs: string | undefined
  readonly slots: readonly BottomLaneSlot[]
  /** Total painted rows: rule, tabs, and every slot size. */
  readonly rows: number
}

function laneRows(entry: SurfaceLaneEntry): SurfaceLaneRows {
  return entry.component as MayflyComponent & SurfaceLaneRows
}

/**
 * Plan the bottom lane: passive panes whose content leads with a rule share
 * one lane rule, rows are allotted by {@link allocateBottomRows}, and passive
 * panes are fit head-first by {@link fitSurfaceRows}. Measurement, main-mode
 * painting, and the alternate-screen layout all read this plan, so they agree.
 * @param lane - the bottom lane.
 * @param width - the lane width.
 * @param maxRows - the lane's row budget.
 * @returns the plan.
 */
export function planBottomLane(lane: SurfaceLaneLayout, width: number, maxRows: number): BottomLanePlan {
  const available = safeDimension(width)
  let budget = Math.max(0, finiteInteger(maxRows, 0))
  const tabs = surfaceLaneTabRows(lane) === 1 && budget > 0 ? renderSurfaceTabs(lane, available) : undefined
  if (tabs !== undefined) budget -= 1
  const painted = renderedSurfaceEntries(lane).map(entry => {
    const passive = contributionFocusTarget(entry) === null
    const rows = entry.component.render(available).map(row => fit(row, available))
    const ruled = passive && laneRows(entry).leadingRule === true && rows.length > 0
    return { entry, passive, ruled, rule: ruled ? rows[0] : undefined, rows: ruled ? rows.slice(1) : rows }
  })
  const allocate = (rows: number): number[] => allocateBottomRows(painted.map(item => ({
    rows: item.rows.length,
    ...(item.passive ? { min: item.entry.size?.min, max: item.entry.size?.max } : {}),
  })), rows)
  const ruledFirst = painted.find(item => item.ruled)
  let rule: string | undefined
  let sizes = allocate(budget)
  if (ruledFirst !== undefined && budget > 0) {
    const ruledSizes = allocate(budget - 1)
    if (painted.some((item, index) => item.ruled && ruledSizes[index]! > 0)) {
      rule = ruledFirst.rule
      sizes = ruledSizes
    }
  }
  const slots = painted.map((item, index): BottomLaneSlot => {
    const size = sizes[index]!
    if (!item.passive) return { entry: item.entry, passive: false, rows: item.rows.slice(0, size), size }
    const paint = laneRows(item.entry).renderOverflow
    const overflow = (hidden: number): string => fit(paint === undefined
      ? renderOverflowRow(hidden, interpolateLocaleMessage)
      : paint.call(item.entry.component, hidden, available), available)
    const keepTail = laneRows(item.entry).overflowKeepsTail === true
    return { entry: item.entry, passive: true, rows: fitSurfaceRows(item.rows, size, overflow, keepTail), size }
  })
  const rows = (rule === undefined ? 0 : 1) + (tabs === undefined ? 0 : 1) + sizes.reduce((sum, size) => sum + size, 0)
  return { rule, tabs, slots, rows }
}

/** Flatten a planned bottom lane to its painted rows. */
export function bottomLaneRows(plan: BottomLanePlan): string[] {
  return [
    ...(plan.rule === undefined ? [] : [plan.rule]),
    ...(plan.tabs === undefined ? [] : [plan.tabs]),
    ...plan.slots.flatMap(slot => slot.rows),
  ]
}

/** Render one lane and clamp hostile component output. */
export function renderSurfaceLane(lane: SurfaceLaneLayout | undefined, width: number, maxRows = Number.MAX_SAFE_INTEGER): string[] {
  if (lane === undefined) return []
  if (lane.placement === 'bottom') return bottomLaneRows(planBottomLane(lane, width, maxRows))
  const available = safeDimension(width)
  const tabs = surfaceLaneTabRows(lane) === 1 ? [renderSurfaceTabs(lane, available)] : []
  const body = renderedSurfaceEntries(lane)
    .flatMap(entry => entry.component.render(available))
    .map(row => fit(row, available))
  const rows = [...tabs, ...body]
  const budget = Math.max(0, finiteInteger(maxRows, 0))
  if (rows.length <= budget) return rows
  // A header/body lane that runs out of rows names the loss instead of
  // silently dropping the tail (the bottom lane already does).
  if (budget <= 1) return rows.slice(0, budget)
  return [...rows.slice(0, budget - 1), fit(renderOverflowRow(rows.length - budget + 1, interpolateLocaleMessage), available)]
}

/**
 * In-memory manager; persistence adapters consume and replace its frozen user
 * state. Layouts are pure functions of the registry state and one viewport, so
 * both layout flavours are memoized per viewport until the next mutation: one
 * frame asks for the layout from several lanes, callbacks, and measurements.
 */
export class SurfaceManager {
  private readonly entries = new Map<string, RegisteredSurface>()
  private readonly collapsed: Record<'left' | 'right', boolean> = { left: false, right: false }
  private readonly layouts = new Map<string, SurfaceLayout>()
  private readonly linearLayouts = new Map<string, SurfaceLayout>()
  private revision = 0
  private userStateValue: SurfaceUserLayoutState
  private focusedIdValue: string | undefined
  private activeIdValue: string | undefined

  constructor(private readonly options: SurfaceManagerOptions = {}) {
    this.userStateValue = freezeUserState(options.userState)
  }

  /** Drop memoized layouts after any registry, user-state, focus, or activation change. */
  private touch(): void {
    this.revision += 1
    this.layouts.clear()
    this.linearLayouts.clear()
  }

  /**
   * Flip one side's collapse flag. The flag carries hysteresis across
   * viewports, so a change invalidates every memoized layout; the mutating
   * `layout()` call itself fails its revision check and recomputes next time.
   */
  private setCollapsed(placement: 'left' | 'right', collapsed: boolean): void {
    if (this.collapsed[placement] === collapsed) return
    this.collapsed[placement] = collapsed
    this.touch()
  }

  /** Invalidate memoized layouts, then notify the renderer. */
  private changed(): void {
    this.touch()
    this.options.onChange?.()
  }

  get userState(): SurfaceUserLayoutState {
    return this.userStateValue
  }

  get empty(): boolean {
    return this.visibleEntries().length === 0
  }

  get focusedId(): string | undefined {
    return this.focusedIdValue
  }

  invalidate(): void {
    for (const registered of this.entries.values()) registered.contribution.component.invalidate()
  }

  register(contribution: SurfaceContribution): SurfaceRegistration {
    if (this.entries.has(contribution.id)) throw new Error(`Duplicate surface id: ${contribution.id}`)
    const registered: RegisteredSurface = { contribution, hidden: false }
    this.entries.set(contribution.id, registered)
    this.changed()
    let disposed = false
    return {
      get disposed() {
        return disposed
      },
      setHidden: hidden => {
        if (disposed || registered.hidden === hidden) return
        registered.hidden = hidden
        if (hidden && this.activeIdValue === contribution.id) this.activeIdValue = undefined
        if (hidden && this.focusedIdValue === contribution.id) {
          this.focusedIdValue = undefined
          this.touch()
          const previous = contributionFocusTarget(registered.contribution)
          if (previous !== null) this.options.onSurfaceFocusTransition?.(previous, null)
        }
        this.changed()
      },
      replace: (component, focusTarget) => {
        const previous = contributionFocusTarget(registered.contribution)
        const next = focusTarget === undefined
          ? typeof (component as MayflyComponent & { focused?: unknown }).focused === 'boolean' ? component as MayflyFocusable : null
          : focusTarget
        if (disposed || (registered.contribution.component === component && previous === next)) return
        const { focusTarget: _previousTarget, ...metadata } = registered.contribution
        registered.contribution = focusTarget === undefined
          ? { ...metadata, component }
          : { ...metadata, component, focusTarget }
        if (this.focusedIdValue === contribution.id) {
          if (next === null) this.focusedIdValue = undefined
          this.changed()
          if (previous !== null) this.options.onSurfaceFocusTransition?.(previous, next)
        } else this.changed()
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        const placement = this.effectivePlacement(registered.contribution)
        const activePlacements = PLACEMENTS.filter(item => this.userStateValue.active[item] === contribution.id)
        const wasFocused = this.focusedIdValue === contribution.id
        const previousFocus = wasFocused ? contributionFocusTarget(registered.contribution) : null
        this.entries.delete(contribution.id)
        if (this.activeIdValue === contribution.id) this.activeIdValue = undefined
        if (placement === 'left' || placement === 'right') this.collapsed[placement] = false
        let focusSuccessor: SurfaceLaneEntry | undefined
        if (activePlacements.length > 0) {
          const active = { ...this.userStateValue.active }
          for (const item of activePlacements) {
            const successor = this.activationCandidates(item)[0]
            focusSuccessor ??= successor
            if (successor === undefined) delete active[item]
            else active[item] = successor.id
          }
          this.setUserState({ ...this.userStateValue, active })
        } else {
          focusSuccessor = this.activationCandidates(placement)[0]
          this.changed()
        }
        if (wasFocused) {
          const nextFocus = focusSuccessor === undefined ? null : contributionFocusTarget(focusSuccessor)
          this.focusedIdValue = nextFocus === null ? undefined : focusSuccessor?.id
          if (previousFocus !== null) this.options.onSurfaceFocusTransition?.(previousFocus, nextFocus)
        }
        this.touch()
      },
    }
  }

  replaceUserState(state: SurfaceUserLayoutInput): void {
    const focusedContribution = this.focusedIdValue === undefined ? undefined : this.entries.get(this.focusedIdValue)?.contribution
    const focused = focusedContribution === undefined ? null : contributionFocusTarget(focusedContribution)
    this.userStateValue = freezeUserState(state)
    this.collapsed.left = false
    this.collapsed.right = false
    this.focusedIdValue = undefined
    this.activeIdValue = undefined
    if (focused !== null) this.options.onSurfaceFocusTransition?.(focused, null)
    this.changed()
  }

  activate(placement: SurfacePlacement, id: string): boolean {
    const lane = this.activationCandidates(placement)
    if (!lane.some(entry => entry.id === id)) return false
    const previous = this.lane(placement, lane)?.active
    const next = lane.find(entry => entry.id === id)!
    this.activeIdValue = id
    const active = { ...this.userStateValue.active, [placement]: id }
    if (placement === 'bottom' && next.placement !== 'bottom') active[next.placement] = id
    this.setUserState({
      ...this.userStateValue,
      active,
    })
    if (previous !== undefined && previous.id !== next.id && this.focusedIdValue === previous.id) {
      const previousFocus = contributionFocusTarget(previous)
      const nextFocus = contributionFocusTarget(next)
      this.focusedIdValue = nextFocus === null ? undefined : next.id
      if (previousFocus !== null) this.options.onSurfaceFocusTransition?.(previousFocus, nextFocus)
    }
    this.touch()
    return true
  }

  setFocused(id: string | undefined): boolean {
    if (id !== undefined && !this.visibleEntries().some(entry => entry.id === id)) return false
    if (this.focusedIdValue === id) return true
    this.focusedIdValue = id
    this.changed()
    return true
  }

  setFocusedComponent(component: MayflyComponent | null): void {
    const entry = component === null
      ? undefined
      : this.visibleEntries().find(item => contributionFocusTarget(item) === component)
    this.setFocused(entry?.id)
  }

  linearLayout(columns: number, rows: number): SurfaceLayout {
    const key = `${String(safeDimension(columns))}:${String(safeDimension(rows))}`
    const memo = this.linearLayouts.get(key)
    if (memo !== undefined) return memo
    const grouped = this.groupedEntries()
    const sides = (['left', 'right'] as const).flatMap(placement => {
      const lane = this.lane(placement, grouped[placement])
      return lane === undefined ? [] : [{ placement, lane, width: this.sideWidth(lane.active) }]
    })
    const layout = this.finishLayout(safeDimension(columns), safeDimension(rows), grouped, sides, [])
    this.linearLayouts.set(key, layout)
    return layout
  }

  layout(columns: number, rows: number): SurfaceLayout {
    const safeColumns = safeDimension(columns)
    const safeRows = safeDimension(rows)
    const key = `${String(safeColumns)}:${String(safeRows)}`
    const memo = this.layouts.get(key)
    if (memo !== undefined) return memo
    // Focus retirement below and any nested mutation invalidate mid-flight;
    // the result is then kept only when the revision it started from survives.
    const revision = this.revision
    const grouped = this.groupedEntries()
    const sideLanes = (['left', 'right'] as const).flatMap(placement => {
      const lane = this.lane(placement, grouped[placement])
      return lane === undefined ? [] : [{ placement, lane, width: this.sideWidth(lane.active) }]
    })
    for (const placement of ['left', 'right'] as const) {
      if (grouped[placement].length === 0) this.setCollapsed(placement, false)
    }

    const retained = sideLanes.filter(side => !this.collapsed[side.placement])
    const collapsed = sideLanes.filter(side => this.collapsed[side.placement])
    collapsed.sort((left, right) => this.compareSideStrength(right.lane, left.lane))
    for (const side of collapsed) {
      const trial = [...retained, side]
      if (this.transcriptWidth(safeColumns, trial) >= SURFACE_TRANSCRIPT_REOPEN_COLUMNS) {
        this.setCollapsed(side.placement, false)
        retained.push(side)
      }
    }
    const strongestCollapsed = collapsed.find(side => this.collapsed[side.placement])
    const weakestRetained = [...retained]
      .sort((left, right) => this.compareSideStrength(left.lane, right.lane))
      .at(0)
    if (
      strongestCollapsed !== undefined
      && weakestRetained !== undefined
      && this.compareSideStrength(strongestCollapsed.lane, weakestRetained.lane) > 0
    ) {
      const replacementTranscriptWidth = this.transcriptWidth(safeColumns, retained)
        + weakestRetained.width - strongestCollapsed.width
      if (replacementTranscriptWidth >= SURFACE_TRANSCRIPT_MIN_COLUMNS) {
        this.setCollapsed(weakestRetained.placement, true)
        this.setCollapsed(strongestCollapsed.placement, false)
        retained.splice(retained.indexOf(weakestRetained), 1, strongestCollapsed)
      }
    }
    retained.sort((left, right) => left.placement.localeCompare(right.placement))
    while (retained.length > 0 && this.transcriptWidth(safeColumns, retained) < SURFACE_TRANSCRIPT_MIN_COLUMNS) {
      const weakest = [...retained].sort((left, right) => this.compareSideStrength(left.lane, right.lane)).at(0)!
      this.setCollapsed(weakest.placement, true)
      retained.splice(retained.indexOf(weakest), 1)
    }

    const fallback: SurfaceLaneEntry[] = []
    const overflow: SurfaceOverflowEntry[] = []
    for (const side of sideLanes) {
      if (!this.collapsed[side.placement]) continue
      for (const entry of side.lane.entries) {
        const narrow = entry.narrow ?? 'bottom'
        if (narrow === 'bottom') fallback.push(entry)
        else overflow.push({ entry, reason: narrow })
      }
    }
    const unavailableFocused = overflow.find(item => item.entry.id === this.focusedIdValue)
    if (unavailableFocused !== undefined) {
      this.focusedIdValue = undefined
      this.touch()
      const previous = contributionFocusTarget(unavailableFocused.entry)
      if (previous !== null) this.options.onSurfaceFocusTransition?.(previous, null)
    }
    if (overflow.some(item => item.entry.id === this.activeIdValue)) {
      this.activeIdValue = undefined
      this.touch()
    }
    const effectiveGroups = {
      ...grouped,
      left: retained.find(side => side.placement === 'left')?.lane.entries ?? [],
      right: retained.find(side => side.placement === 'right')?.lane.entries ?? [],
      bottom: this.sortEntries([...grouped.bottom, ...fallback]),
    }
    const layout = this.finishLayout(safeColumns, safeRows, effectiveGroups, retained, overflow)
    if (revision === this.revision) this.layouts.set(key, layout)
    return layout
  }

  private setUserState(state: SurfaceUserLayoutInput): void {
    this.userStateValue = freezeUserState(state)
    this.options.onUserStateChange?.(this.userStateValue)
    this.changed()
  }

  private activationCandidates(placement: SurfacePlacement): SurfaceLaneEntry[] {
    const grouped = this.groupedEntries()
    return placement === 'bottom'
      ? this.sortEntries([...grouped.bottom, ...grouped.left, ...grouped.right]
          .filter(entry => entry.placement === 'bottom' || (entry.narrow ?? 'bottom') === 'bottom'))
      : grouped[placement]
  }

  private visibleEntries(): SurfaceLaneEntry[] {
    const hidden = new Set(this.userStateValue.hiddenIds)
    const pinned = new Set(this.userStateValue.pinnedIds)
    return [...this.entries.values()].flatMap(registered => {
      if (registered.hidden || hidden.has(registered.contribution.id)) return []
      const placement = this.effectivePlacement(registered.contribution)
      return [{
        ...registered.contribution,
        placement,
        priority: finiteInteger(registered.contribution.priority, 0),
        pinned: pinned.has(registered.contribution.id),
      }]
    })
  }

  private effectivePlacement(contribution: SurfaceContribution): SurfacePlacement {
    return this.userStateValue.placements[contribution.id] ?? contribution.placement
  }

  private groupedEntries(): Record<SurfacePlacement, SurfaceLaneEntry[]> {
    const grouped: Record<SurfacePlacement, SurfaceLaneEntry[]> = { header: [], left: [], right: [], bottom: [] }
    for (const entry of this.visibleEntries()) grouped[entry.placement].push(entry)
    for (const placement of PLACEMENTS) grouped[placement] = this.sortEntries(grouped[placement])
    return grouped
  }

  private sortEntries(entries: readonly SurfaceLaneEntry[]): SurfaceLaneEntry[] {
    const order = new Map(this.userStateValue.order.map((id, index) => [id, index]))
    return [...entries].sort((left, right) => {
      const leftOrder = order.get(left.id)
      const rightOrder = order.get(right.id)
      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1
        if (rightOrder === undefined) return -1
        /* v8 ignore next -- one id has one index in the user order map */
        if (leftOrder !== rightOrder) return leftOrder - rightOrder
      }
      return Number(right.pinned) - Number(left.pinned)
        || right.priority - left.priority
        || compareId(left.id, right.id)
    })
  }

  private lane(placement: SurfacePlacement, entries: readonly SurfaceLaneEntry[]): SurfaceLaneLayout | undefined {
    if (entries.length === 0) return undefined
    const selectable = placement === 'bottom'
      ? entries.filter(entry => contributionFocusTarget(entry) !== null)
      : entries
    const activeEntries = selectable.length > 0 ? selectable : entries
    const requested = placement === 'bottom'
      ? [
          this.focusedIdValue,
          this.activeIdValue,
          this.userStateValue.active.bottom,
          this.userStateValue.active.left,
          this.userStateValue.active.right,
        ]
      : [this.userStateValue.active[placement]]
    const active = requested.flatMap(id => activeEntries.find(entry => entry.id === id) ?? []).at(0) ?? activeEntries[0]!
    return { placement, entries, active }
  }

  private sideWidth(entry: SurfaceLaneEntry): number {
    const minimum = Math.max(SURFACE_SIDE_MIN_COLUMNS, Math.min(SURFACE_SIDE_MAX_COLUMNS, finiteInteger(entry.size?.min, SURFACE_SIDE_MIN_COLUMNS)))
    const maximum = Math.max(minimum, Math.min(SURFACE_SIDE_MAX_COLUMNS, finiteInteger(entry.size?.max, SURFACE_SIDE_MAX_COLUMNS)))
    const preferred = entry.size?.preferred === 'auto'
      ? SURFACE_SIDE_PREFERRED_COLUMNS
      : finiteInteger(entry.size?.preferred, SURFACE_SIDE_PREFERRED_COLUMNS)
    const user = finiteInteger(this.userStateValue.sizes[entry.id], preferred)
    return Math.max(minimum, Math.min(maximum, user))
  }

  private compareSideStrength(left: SurfaceLaneLayout, right: SurfaceLaneLayout): number {
    const leftPinned = left.entries.some(entry => entry.pinned)
    const rightPinned = right.entries.some(entry => entry.pinned)
    const leftFocused = left.entries.some(entry => entry.id === this.focusedIdValue)
    const rightFocused = right.entries.some(entry => entry.id === this.focusedIdValue)
    const leftActive = left.entries.some(entry => entry.id === this.activeIdValue)
    const rightActive = right.entries.some(entry => entry.id === this.activeIdValue)
    const order = new Map(this.userStateValue.order.map((id, index) => [id, index]))
    const leftOrder = left.entries.reduce<number | undefined>((best, entry) => {
      const index = order.get(entry.id)
      return index === undefined ? best : best === undefined ? index : Math.min(best, index)
    }, undefined)
    const rightOrder = right.entries.reduce<number | undefined>((best, entry) => {
      const index = order.get(entry.id)
      return index === undefined ? best : best === undefined ? index : Math.min(best, index)
    }, undefined)
    return Number(leftPinned) - Number(rightPinned)
      || (leftOrder === undefined && rightOrder === undefined
        ? 0
        : leftOrder === undefined
          ? -1
          : rightOrder === undefined
            ? 1
            : rightOrder - leftOrder)
      || Number(leftFocused) - Number(rightFocused)
      || Number(leftActive) - Number(rightActive)
      || left.active.priority - right.active.priority
      || -compareId(left.active.id, right.active.id)
  }

  private transcriptWidth(columns: number, sides: readonly { readonly width: number }[]): number {
    return Math.max(1, columns - sides.reduce((total, side) => total + side.width, 0) - sides.length)
  }

  private finishLayout(
    columns: number,
    rows: number,
    grouped: Record<SurfacePlacement, readonly SurfaceLaneEntry[]>,
    sides: readonly { readonly placement: 'left' | 'right'; readonly lane: SurfaceLaneLayout; readonly width: number }[],
    overflow: readonly SurfaceOverflowEntry[],
  ): SurfaceLayout {
    const leftSide = sides.find(side => side.placement === 'left')
    const rightSide = sides.find(side => side.placement === 'right')
    const left = leftSide === undefined ? this.lane('left', grouped.left) : { ...leftSide.lane, width: leftSide.width }
    const right = rightSide === undefined ? this.lane('right', grouped.right) : { ...rightSide.lane, width: rightSide.width }
    const transcriptColumns = sides.length === 0 ? columns : this.transcriptWidth(columns, sides)
    return {
      columns,
      rows,
      transcriptColumns,
      ...(this.lane('header', grouped.header) === undefined ? {} : { header: this.lane('header', grouped.header)! }),
      ...(left === undefined ? {} : { left }),
      ...(right === undefined ? {} : { right }),
      ...(this.lane('bottom', grouped.bottom) === undefined ? {} : { bottom: this.lane('bottom', grouped.bottom)! }),
      overflow,
    }
  }
}
