/**
 * The interaction panel kit: the one frame, hidden action row, and list/form
 * bodies that command panels share. A domain module passes ids, titles, rows,
 * fields, and action items; the kit owns their order and chrome, so a panel
 * change lands in one place instead of being replayed per command.
 *
 * This is not a renderer and adds no new wire shape: every helper returns the
 * same `panel`, `ui.list`, `ui.form`, and `ui.actions` nodes the call sites
 * built by hand.
 *
 * @module @ephemeral-ai/mayfly/interaction/panel
 */

import {
  panel,
  ui,
  type MayflyActionItem,
  type MayflyFormNode,
  type MayflyListNode,
  type MayflyListItem,
  type MayflySurfaceNode,
  type MayflyUiNode,
  type PanelProps,
} from '@ephemeral-ai/mayfly-ui'

/**
 * The frame every command panel draws: a title, an Escape label, one body,
 * and an optional footer outside the body.
 * @param props - the shared panel props.
 * @returns the overlay surface.
 */
export function panelFrame(props: PanelProps): MayflySurfaceNode {
  return panel(props)
}

/** One panel's action row: its id and hidden/visible items. */
export interface PanelActions {
  readonly id: string
  readonly items: readonly MayflyActionItem[]
}

/**
 * Build one panel's action row.
 * @param actions - the row's id and items.
 * @returns the `ui.actions` node.
 */
export function panelActions(actions: PanelActions): MayflyUiNode {
  return ui.actions({ id: actions.id, items: actions.items })
}

/** A framed list panel: leading notices, the list, trailing notices, then the action row. */
export interface ListPanelProps extends Omit<MayflyListNode, 'kind' | 'items'> {
  readonly title: string
  readonly subtitle?: string | undefined
  readonly escapeLabel: PanelProps['escapeLabel']
  readonly items: readonly MayflyListItem[]
  readonly leading?: readonly MayflyUiNode[] | undefined
  readonly trailing?: readonly MayflyUiNode[] | undefined
  readonly actions?: PanelActions | undefined
}

/**
 * The usual list page: a browse/choose list inside the panel frame, with its
 * notices above or below and its hidden keys under it.
 * @param props - the list options plus the frame, notices, and action row.
 * @returns the framed surface.
 */
export function listPanel(props: ListPanelProps): MayflySurfaceNode {
  const { title, subtitle, escapeLabel, items, leading = [], trailing = [], actions, ...list } = props
  return panelFrame({
    title,
    ...subtitle === undefined ? {} : { subtitle },
    escapeLabel,
    body: ui.stack.column([
      ...leading,
      ui.list({ ...list, items }),
      ...trailing,
      ...actions === undefined ? [] : [panelActions(actions)],
    ]),
  })
}

/** A framed form panel: leading notices, the form, trailing notices, then the action row. */
export interface FormPanelProps extends Omit<MayflyFormNode, 'kind' | 'fields'> {
  readonly title: string
  readonly subtitle?: string | undefined
  readonly escapeLabel: PanelProps['escapeLabel']
  readonly fields: MayflyFormNode['fields']
  readonly leading?: readonly MayflyUiNode[] | undefined
  readonly trailing?: readonly MayflyUiNode[] | undefined
  readonly actions?: PanelActions | undefined
}

/**
 * The usual form page: one form inside the panel frame, with its notices
 * above or below and its hidden keys under it.
 * @param props - the form options plus the frame, notices, and action row.
 * @returns the framed surface.
 */
export function formPanel(props: FormPanelProps): MayflySurfaceNode {
  const { title, subtitle, escapeLabel, fields, leading = [], trailing = [], actions, ...form } = props
  return panelFrame({
    title,
    ...subtitle === undefined ? {} : { subtitle },
    escapeLabel,
    body: ui.stack.column([
      ...leading,
      ui.form({ ...form, fields }),
      ...trailing,
      ...actions === undefined ? [] : [panelActions(actions)],
    ]),
  })
}
