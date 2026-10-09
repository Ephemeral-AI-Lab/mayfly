/**
 * Public UI patterns: four compositions of the builders that plugins and Mayfly core both reuse. A pattern has no
 * renderer of its own; each call is pure and returns a frozen node tree made only from `ui.*`.
 * @module @ephemeral-ai/mayfly-ui/patterns
 */
import { ui } from './builders.ts'
import type {
  MayflyActionItem,
  MayflyField,
  MayflyInlineSpan,
  MayflyListItem,
  MayflySurfaceNode,
  MayflyTabsNode,
  MayflyUiNode,
} from './contracts.ts'

/** How long a decision panel that opens unprompted swallows every key but `Esc`, in milliseconds. */
const DECISION_ARM_MS = 300

export interface MayflyDecisionPanelProps {
  /** The prefix of the panel's controls (`<id>.options`, `<id>.input`, `<id>.keys`); default `decision`. */
  readonly id?: string
  readonly title: string
  readonly badges?: readonly MayflyInlineSpan[]
  /** Read-only context above the choices: the thing being decided. */
  readonly preview?: readonly MayflyUiNode[]
  /** The choices. The first is focused, so `Enter` takes the common one; digits choose by position. */
  readonly options: readonly MayflyListItem[]
  /** A one-line field under the choices, e.g. an optional note. */
  readonly input?: { readonly id: string, readonly label: string, readonly placeholder?: string }
  /** A digit chooses at once, even with an input on the panel. Default: digits choose while the list holds focus. */
  readonly instant?: boolean
  /** Keys that run from anywhere on the panel without a button; every item is hidden. */
  readonly accelerators?: readonly Omit<MayflyActionItem, 'hidden'>[]
  /** What `Esc` does, as the hint row names it; default `reject`. */
  readonly escapeLabel?: MayflySurfaceNode['escapeLabel']
  /** Default `overlay`. */
  readonly chrome?: MayflySurfaceNode['chrome']
}

export interface MayflyRailPanelProps {
  readonly title: string
  readonly badges?: readonly MayflyInlineSpan[]
  /** The rail of labels. `activeId` is the label the content shows. */
  readonly rail: Pick<MayflyTabsNode, 'id' | 'items' | 'activeId' | 'hintLabel'>
  /**
   * The live content. A record keyed by rail item id gives every label its own page, so the rail switches them without
   * a republish; a single node is the content of the active label, which the plugin rebuilds on `tab-change`.
   */
  readonly content: MayflyUiNode | Readonly<Record<string, MayflyUiNode>>
  /** The rail's columns; default 26. */
  readonly railWidth?: number
  readonly escapeLabel?: MayflySurfaceNode['escapeLabel']
}

export interface MayflySplitViewProps {
  readonly list: MayflyUiNode
  readonly detail: MayflyUiNode
  /** The list's columns beside the detail; default 58. */
  readonly listWidth?: number
  /** The width from which the detail sits beside the list; below it the list is alone. Default 100. */
  readonly breakpoint?: number
}

export interface MayflyStatusPageProps {
  readonly title: string
  readonly badges?: readonly MayflyInlineSpan[]
  readonly tabs: Omit<MayflyTabsNode, 'kind'>
  /** The read-only key/value rows under the strip. */
  readonly rows?: readonly MayflyField[]
  /** Content in place of the rows. */
  readonly body?: MayflyUiNode
  /** One page per tab id, shown under the strip while that tab is active; the strip switches them without a republish. */
  readonly pages?: Readonly<Record<string, MayflyUiNode>>
  readonly footer?: MayflyUiNode
}

const isNode = (value: unknown): value is MayflyUiNode => typeof value === 'object' && value !== null && 'kind' in value

/** A decision: a header, a preview, a numbered choice list, an optional same-line input, and hidden accelerators. */
function decisionPanel(props: MayflyDecisionPanelProps): MayflySurfaceNode {
  const id = props.id ?? 'decision'
  const children: MayflyUiNode[] = [
    ...props.preview ?? [],
    ui.list({ id: `${id}.options`, autofocus: true, role: 'choose', numbered: props.instant === true ? true : 'focus', selectedIds: [], items: props.options }),
  ]
  if (props.input !== undefined) {
    const { id: fieldId, label, placeholder } = props.input
    children.push(ui.form({ id: `${id}.input`, fields: [{ id: fieldId, kind: 'input', label, value: '', ...placeholder === undefined ? {} : { placeholder } }] }))
  }
  if (props.accelerators !== undefined && props.accelerators.length > 0) {
    children.push(ui.actions({ id: `${id}.keys`, items: props.accelerators.map(item => ({ ...item, hidden: true })) }))
  }
  return ui.surface({
    title: props.title,
    chrome: props.chrome ?? 'overlay',
    escapeLabel: props.escapeLabel ?? 'reject',
    ...props.badges === undefined ? {} : { badges: props.badges },
    child: ui.stack.column(children),
  })
}

/** A rail of labels on the left and live content on the right (sessions, settings). */
function railPanel(props: MayflyRailPanelProps): MayflySurfaceNode {
  const { rail, content } = props
  const pages = isNode(content)
    ? [ui.child(content, { grow: 1 })]
    : rail.items.flatMap(item => content[item.id] === undefined ? [] : [ui.child(content[item.id]!, { grow: 1, tab: { controlId: rail.id, itemId: item.id } })])
  return ui.surface({
    title: props.title,
    chrome: 'overlay',
    ...props.badges === undefined ? {} : { badges: props.badges },
    ...props.escapeLabel === undefined ? {} : { escapeLabel: props.escapeLabel },
    child: ui.stack.row([
      ui.child(ui.tabs({ ...rail, orientation: 'vertical' }), { basis: props.railWidth ?? 26, shrink: 0 }),
      ...pages,
    ], { gap: 2 }),
  })
}

/** A list and a live detail side by side from `breakpoint` columns, the list alone below it. */
function splitView(props: MayflySplitViewProps) {
  const breakpoint = props.breakpoint ?? 100
  return ui.stack.row([
    ui.child(props.list, { basis: props.listWidth ?? 58, when: { minWidth: breakpoint } }),
    ui.child(props.detail, { grow: 1, when: { minWidth: breakpoint } }),
    ui.child(props.list, { grow: 1, when: { maxWidth: breakpoint - 1 } }),
  ], { gap: 2 })
}

/** A key/value read-only page under a tab strip. */
function statusPage(props: MayflyStatusPageProps): MayflySurfaceNode {
  const { tabs, pages } = props
  if (pages === undefined && props.body === undefined && props.rows === undefined) throw new TypeError('statusPage needs rows, a body, or pages')
  const body = pages === undefined
    ? [props.body ?? ui.fields(props.rows!)]
    : tabs.items.flatMap(item => pages[item.id] === undefined ? [] : [ui.child(pages[item.id]!, { tab: { controlId: tabs.id, itemId: item.id } })])
  return ui.surface({
    title: props.title,
    chrome: 'overlay',
    ...props.badges === undefined ? {} : { badges: props.badges },
    ...props.footer === undefined ? {} : { footer: props.footer },
    child: ui.stack.column([ui.tabs(tabs), ui.spacer(), ...body]),
  })
}

/** The patterns, pure and frozen, and the arm delay a decision panel's overlay sets (`decisionArmMs`). */
export const patterns = Object.freeze({
  decisionPanel,
  railPanel,
  splitView,
  statusPage,
  /** The `armMs` of an overlay that shows a decision panel unprompted (slice 1.8a): stray keys grant nothing for this long. */
  decisionArmMs: DECISION_ARM_MS,
})
