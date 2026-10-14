/** The status row as one wire node for the footer node slot.
 * @module @ephemeral-ai/mayfly/transcript/status-rows
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusEntry, MayflyUiChild, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

/** What the footer shows besides the registered entries. */
export interface StatusFooterState {
  /** The entry id of the item whose view is entered (its panel is painted under the footer), if one is. */
  readonly active?: string | undefined
}

/** One entry as an admission child of the row: the registration's priority, band, and overflow, and a mark while its view is entered. */
function childOf(entry: MayflyStatusEntry, active: string | undefined): MayflyUiChild {
  const { definition } = entry
  return ui.child(entry.node!, {
    id: entry.id,
    priority: definition.priority ?? 0,
    band: definition.band ?? 'left',
    ...(definition.overflow === undefined ? {} : { overflow: definition.overflow }),
    ...(entry.id === active ? { mark: 'underline' as const } : {}),
  })
}

/**
 * The footer: one status row. Every registry entry, lane item, and plugin entry is a child of one admission row, admitted by
 * one rule in priority order; before that the row sheds the narrower forms of its entries (rank by rank) until it fits.
 * While a view is entered a heavy line under its item's words is the row's second line, and the panel is painted under
 * the footer.
 * @param entries - the registry's entries followed by the lane's items.
 * @param state - what the lane adds.
 * @returns the node, or `null` when no entry has anything to show.
 */
export function buildStatusFooter(entries: readonly MayflyStatusEntry[], state: StatusFooterState): MayflyUiNode | null {
  const shown = entries.filter(entry => entry.node !== null)
    .toSorted((left, right) => (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id))
  if (shown.length === 0) return null
  return ui.surface({ chrome: 'none', padding: 1, child: ui.stack.row(shown.map(entry => childOf(entry, state.active))) })
}

/** What the footer owner asks of the screen: the node slot and the lane's read-only window. */
type StatusFooterScreen = Pick<Context['mayflyScreen'], 'mountNodeSlot' | 'views'>

/**
 * Lease the footer node slot and keep it showing the status row: it publishes again when a registry entry, a lane item, or
 * the entered state changes, and not when the node would be the same. The lease and the listeners are released with the
 * Fiber.
 * @param ctx - the plugin context; needs `mayflyStatus`.
 * @param screen - the screen that holds the footer slot and the views lane.
 */
export function mountStatusFooter(ctx: Context, screen: StatusFooterScreen): void {
  const slot = screen.mountNodeSlot('status.footer', { region: 'footer' })
  const { views } = screen
  let published = ''
  const refresh = (): void => {
    const entries = [...ctx.mayflyStatus.list(), ...views.statusEntries()]
    const state: StatusFooterState = { active: views.isEntered && views.active !== undefined ? `views/${views.active}` : undefined }
    const key = `${state.active ?? ''}|${entries.map(entry => `${entry.id}:${String(entry.revision)}`).join(',')}`
    if (key === published) return
    published = key
    slot.set(buildStatusFooter(entries, state))
  }
  ctx.effect(() => {
    const offStatus = ctx.mayflyStatus.subscribe(refresh)
    const offViews = views.subscribe(refresh)
    refresh()
    return () => {
      offStatus()
      offViews()
      slot.dispose()
    }
  })
}
