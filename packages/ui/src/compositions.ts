/**
 * Public UI compositions: the one layered shell for panels, decisions, wizards, rails, browsers, and completion rows.
 * Every composition is pure and returns a frozen tree made only from `ui.*`; it owns no renderer, focus, or key state.
 *
 * @module @ephemeral-ai/mayfly-ui/compositions
 */
import { ui } from './builders.ts'
import type {
  MayflyActionItem,
  MayflyInlineSpan,
  MayflyListItem,
  MayflySurfaceNode,
  MayflyUiNode,
} from './contracts.ts'
import type { MayflyFormAddress, MayflyPagePath, MayflySelectionAddress } from './interaction.ts'

/** The ids the shared decision strip uses; core answers the same ids. */
export const DECISION_YES = 'mayfly.decision.yes'
export const DECISION_NO = 'mayfly.decision.no'

/** How long a decision lane that opens unprompted swallows every key but `Esc`, in milliseconds. */
const DECISION_ARM_MS = 300

export interface PanelProps {
  readonly title: string
  readonly subtitle?: string
  readonly badges?: readonly MayflyInlineSpan[]
  readonly escapeLabel: 'close' | 'back' | 'cancel' | 'reject' | 'no'
  readonly body: MayflyUiNode
  readonly footer?: MayflyUiNode
  readonly hint?: 'auto' | 'none'
}

/** A command panel: one borderless overlay surface with a title, optional subtitle, body, footer, and hint row. */
export function panel(props: PanelProps): MayflySurfaceNode {
  return ui.surface({
    title: props.title,
    chrome: 'overlay',
    escapeLabel: props.escapeLabel,
    ...props.subtitle === undefined ? {} : { subtitle: props.subtitle },
    ...props.badges === undefined ? {} : { badges: props.badges },
    ...props.footer === undefined ? {} : { footer: props.footer },
    ...props.hint === undefined ? {} : { hint: props.hint },
    child: props.body,
  })
}

export interface DecisionLaneProps {
  /** The prefix of the lane's controls (`<id>.options`, `<id>.note`, `<id>.keys`); default `decision`. */
  readonly id?: string
  readonly title: string
  readonly badges?: readonly MayflyInlineSpan[]
  /** A live body (a wizard or a picker). Exactly one of `body` and `choices` is required. */
  readonly body?: MayflyUiNode
  /** A numbered choice list. The first is focused; digits choose at once. */
  readonly choices?: readonly MayflyListItem[]
  /** A one-line note under the choices. */
  readonly note?: { readonly id: string, readonly label: string, readonly placeholder?: string }
  /** Hidden accelerators; every item must carry `hidden: true`. */
  readonly keys?: readonly MayflyActionItem[]
  readonly escapeLabel?: 'reject' | 'cancel' | 'close' | 'no'
  /** The hidden action a choice runs; default `<id>.choose`. */
  readonly acceptActionId?: string
  /** The hidden action the note's Enter runs; default `<id>.send`. */
  readonly sendActionId?: string
  /** Take the whole editor slot and hide the status row (the Questions panel does this). */
  readonly coverStatus?: boolean
}

/** The one lane surface every agent request uses: a title rule, a body or choices, an optional note, and hidden keys. */
export function decisionLane(props: DecisionLaneProps): MayflySurfaceNode {
  const id = props.id ?? 'decision'
  if ((props.body === undefined) === (props.choices === undefined)) throw new TypeError('decisionLane needs exactly one of body or choices')
  const accept = props.acceptActionId ?? `${id}.choose`
  const send = props.sendActionId ?? `${id}.send`
  const children: MayflyUiNode[] = []
  if (props.body !== undefined) children.push(props.body)
  if (props.choices !== undefined) {
    children.push(ui.list({
      id: `${id}.options`, role: 'choose', autofocus: true, numbered: true, selectedIds: [],
      acceptActionId: accept, acceptVerb: 'choose', items: props.choices,
    }))
  }
  if (props.note !== undefined) {
    children.push(ui.form({
      id: `${id}.note`, enterSubmits: send,
      fields: [{ kind: 'input', id: props.note.id, label: props.note.label, value: '', ...props.note.placeholder === undefined ? {} : { placeholder: props.note.placeholder } }],
    }))
  }
  const page: MayflyPagePath = []
  const keys: MayflyActionItem[] = []
  if (props.choices !== undefined) {
    keys.push({
      id: accept, label: accept, hidden: true,
      selections: [{ pagePath: page, controlId: `${id}.options` }],
      ...props.note === undefined ? {} : { read: [{ pagePath: page, formId: `${id}.note` }] },
    })
  }
  if (props.note !== undefined) keys.push({ id: send, label: send, hidden: true, read: [{ pagePath: page, formId: `${id}.note` }] })
  keys.push(...(props.keys ?? []).map(item => ({ ...item, hidden: true as const })))
  if (keys.length > 0) children.push(ui.actions({ id: `${id}.keys`, items: keys }))
  return ui.surface({
    title: props.title,
    chrome: 'lane',
    escapeLabel: props.escapeLabel ?? 'cancel',
    ...props.coverStatus === true ? { coverStatus: true } : {},
    ...props.badges === undefined ? {} : { badges: props.badges },
    child: ui.stack.column(children),
  })
}

export interface DecisionStripProps {
  readonly title: string
  readonly detail?: string
  readonly yesLabel?: string
  readonly noLabel?: string
  readonly danger?: boolean
  readonly actionsId?: string
}

/**
 * A compact yes/no lane that replaces the current surface's content. It is a lane surface, not a nested box:
 * the overlay host stays, the question becomes the rule title, and every key but `y`, `n`, and `Esc` is inert.
 */
export function decisionStrip(props: DecisionStripProps): MayflySurfaceNode {
  const yes = props.yesLabel ?? 'Yes'
  const no = props.noLabel ?? 'No'
  return ui.surface({
    title: props.title,
    chrome: 'lane',
    escapeLabel: 'no',
    child: props.detail === undefined
      ? ui.actions({ id: props.actionsId ?? 'mayfly.decision', items: decisionItems(yes, no, props.danger === true) })
      : ui.stack.column([
          ui.text(props.detail, { tone: 'warning', overflow: 'wrap' }),
          ui.actions({ id: props.actionsId ?? 'mayfly.decision', items: decisionItems(yes, no, props.danger === true) }),
        ]),
  })
}

function decisionItems(yes: string, no: string, danger: boolean): MayflyActionItem[] {
  return [
    { id: DECISION_YES, label: yes, hintLabel: yes.toLocaleLowerCase(), key: 'y', hidden: true, ...(danger ? { intent: 'danger' as const } : {}) },
    { id: DECISION_NO, label: no, hintLabel: no.toLocaleLowerCase(), key: 'n', hidden: true },
  ]
}

export interface WizardStep {
  readonly id: string
  readonly label: string
  readonly body: MayflyUiNode
  readonly forms?: readonly string[]
  readonly lists?: readonly string[]
  readonly settle?: boolean
  readonly holdBack?: boolean
}

export interface WizardReviewItem {
  readonly stepId: string
  readonly label: string
  readonly source: { readonly kind: 'list', readonly controlId: string } | { readonly kind: 'form', readonly formId: string, readonly fieldId: string }
}

export interface WizardReview {
  readonly label: string
  readonly items: readonly WizardReviewItem[]
  readonly skippedLabel: string
  readonly submitLabel: string
}

export interface WizardProps {
  readonly id?: string
  readonly steps: readonly WizardStep[]
  readonly activeId?: string
  readonly review?: WizardReview
  readonly submitActionId?: string
  readonly hintLabel?: string
}

export const wizardNext = (id: string, stepId: string): string => `${id}.next.${stepId}`

/** The body of a multi-step form: a step strip, one page per step, and an optional review page. No surface. */
export function wizard(props: WizardProps): MayflyUiNode {
  const id = props.id ?? 'wizard'
  const { steps, review } = props
  if (steps.length === 0) throw new TypeError('wizard needs at least one step')
  const submitActionId = props.submitActionId ?? `${id}.submit`
  const single = steps.length === 1 && review === undefined
  const pathOf = (stepId: string): MayflyPagePath => single ? [] : [{ controlId: id, itemId: stepId }]
  const forms = steps.flatMap((step): MayflyFormAddress[] => (step.forms ?? []).map(formId => ({ pagePath: pathOf(step.id), formId })))
  const selections = steps.flatMap((step): MayflySelectionAddress[] => (step.lists ?? []).map(controlId => ({ pagePath: pathOf(step.id), controlId })))
  const submit = { id: submitActionId, label: review?.submitLabel ?? 'Submit', hidden: true, intent: 'primary' as const, submit: forms, ...selections.length === 0 ? {} : { selections } }
  const reviewId = `${id}.review`
  const reviewPath: MayflyPagePath = [{ controlId: id, itemId: reviewId }]
  const pages = steps.map((step, index) => {
    const last = index === steps.length - 1
    const read = (step.forms ?? []).map(formId => ({ pagePath: pathOf(step.id), formId }))
    const stepLists = (step.lists ?? []).map(controlId => ({ pagePath: pathOf(step.id), controlId }))
    const next = last && review === undefined ? { ...submit, id: wizardNext(id, step.id) } : step.settle === true ? {
      id: wizardNext(id, step.id), label: 'Next', hidden: true, intent: 'primary' as const,
      ...read.length === 0 && stepLists.length === 0 ? {} : { submit: read },
      ...stepLists.length === 0 ? {} : { selections: stepLists },
    } : {
      id: wizardNext(id, step.id), label: 'Next', hidden: true,
      ...read.length === 0 ? {} : { read },
      navigate: last ? reviewPath : pathOf(steps[index + 1]!.id),
    }
    const content = ui.stack.column([step.body, ui.actions({ id: `${id}.keys.${step.id}`, items: [next] })])
    return single ? content : ui.child(content, { tab: { controlId: id, itemId: step.id } })
  })
  if (single) return pages[0] as MayflyUiNode
  const reviewItems = review === undefined ? [] : review.items.map(item => ({
    id: item.stepId, label: item.label,
    source: item.source.kind === 'list'
      ? { kind: 'list' as const, pagePath: pathOf(item.stepId), controlId: item.source.controlId }
      : { kind: 'form' as const, pagePath: pathOf(item.stepId), formId: item.source.formId, fieldId: item.source.fieldId },
  }))
  const reviewPage = review === undefined ? [] : [ui.child(ui.stack.column([
    ui.review({ id: reviewId, tabsId: id, items: reviewItems, skippedLabel: review.skippedLabel, submitLabel: review.submitLabel, submitActionId, autofocus: true }),
    ui.actions({ id: `${id}.keys.review`, items: [submit] }),
  ]), { tab: { controlId: id, itemId: reviewId } })]
  const items = [
    ...steps.map((step, index) => ({ id: step.id, label: step.label, ...index === 0 || step.holdBack === true ? {} : { backId: steps[index - 1]!.id } })),
    ...review === undefined ? [] : [{ id: reviewId, label: review.label, review: true as const, backId: steps.at(-1)!.id }],
  ]
  return ui.stack.column([
    ui.tabs({ id, mode: 'wizard', activeId: props.activeId ?? steps[0]!.id, items, hintLabel: props.hintLabel ?? 'step' }),
    ui.spacer(),
    ...pages,
    ...reviewPage,
  ])
}

export interface TabsProps {
  /** The strip spec: id, labels, active tab, and hint word. */
  readonly tabs: Pick<import('./contracts.ts').MayflyTabsNode, 'id' | 'items' | 'activeId' | 'hintLabel'>
  /** One page per tab id; a tab without a page gets no page child. */
  readonly pages: Readonly<Record<string, MayflyUiNode>>
  /** Blank rows between the strip and the active page (default 1). */
  readonly gap?: 0 | 1 | 2 | 3
  /** Let the page take the room under the strip (stats pages do). */
  readonly pageGrow?: boolean
  /** The page's minimum height when it grows (default 1). */
  readonly pageMinSize?: number
}

/** A horizontal tab strip over arbitrary pages. The pages own their own layout: a browser, a form, or fields. */
export function tabs(props: TabsProps): MayflyUiNode {
  const { tabs: strip, pages } = props
  return ui.stack.column([
    ui.tabs(strip),
    ...strip.items.flatMap(item => pages[item.id] === undefined ? [] : [ui.child(pages[item.id]!, {
      tab: { controlId: strip.id, itemId: item.id },
      ...props.pageGrow === true ? { grow: 1, minSize: props.pageMinSize ?? 1 } : {},
    })]),
  ], { gap: props.gap ?? 1 })
}

export interface RailProps {
  readonly rail: Pick<import('./contracts.ts').MayflyTabsNode, 'id' | 'items' | 'activeId' | 'hintLabel'>
  readonly pages?: Readonly<Record<string, MayflyUiNode>>
  readonly content?: MayflyUiNode
  readonly railWidth?: number
  /** Draw the column rule between the rail and the page (default `true`). */
  readonly separator?: boolean
}

/** A vertical rail on the left and live content on the right; the host wraps it in a panel. */
export function rail(props: RailProps): MayflyUiNode {
  const { rail: railNode, pages, content } = props
  if ((pages === undefined) === (content === undefined)) throw new TypeError('rail needs exactly one of pages or content')
  const pageChildren = pages === undefined
    ? [ui.child(content!, { grow: 1 })]
    : railNode.items.flatMap(item => pages[item.id] === undefined ? [] : [ui.child(pages[item.id]!, { grow: 1, tab: { controlId: railNode.id, itemId: item.id } })])
  return ui.stack.row([
    ui.child(ui.tabs({ ...railNode, orientation: 'vertical' }), { basis: props.railWidth ?? 26, shrink: 0 }),
    ...pageChildren,
  ], { gap: props.separator === false ? 2 : 3, ...props.separator === false ? {} : { rule: 'column' as const } })
}

export interface BrowserProps {
  readonly list: MayflyUiNode
  readonly listNarrow?: MayflyUiNode
  readonly detail?: MayflyUiNode
  readonly narrow?: 'list' | 'detail'
  readonly breakpoint?: number
  readonly listWidth?: number
  /** The column rule; default a muted vertical line, `false` removes it. */
  readonly separator?: MayflyUiNode | false
}

/** A list and a live detail side by side from `breakpoint` columns; on a narrow surface, one page at a time. */
export function browser(props: BrowserProps): MayflyUiNode {
  const breakpoint = props.breakpoint ?? 100
  const narrow = props.narrow ?? 'list'
  const narrowList = props.listNarrow ?? props.list
  return ui.stack.row([
    ui.child(props.list, { basis: props.listWidth ?? 58, grow: 0, shrink: 0, when: { minWidth: breakpoint } }),
    ...props.separator === undefined || props.separator === false || props.detail === undefined ? [] : [ui.child(props.separator, { basis: 1, grow: 0, shrink: 0, when: { minWidth: breakpoint } })],
    ...props.detail === undefined ? [] : [ui.child(props.detail, { basis: 0, grow: 1, when: { minWidth: breakpoint } })],
    ui.child(narrow === 'detail' && props.detail !== undefined ? props.detail : narrowList, { grow: 1, when: { maxWidth: breakpoint - 1 } }),
  ], { gap: props.separator === false || props.separator !== undefined ? 2 : 3, ...props.separator === false || props.separator !== undefined ? {} : { rule: 'column' as const } })
}

export interface CompletionPaletteItem {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly right?: string
  readonly source?: string
  readonly problem?: string
  readonly focused?: boolean
  readonly typedPrefix?: string
  readonly path?: boolean
}

export interface CompletionPaletteProps {
  readonly items: readonly CompletionPaletteItem[]
  readonly wait?: string
  readonly maxRows?: number
}

/** The rows of a completion palette: a focused arrow, the label with its typed prefix strong, detail, right cue, and notes. */
export function completionPalette(props: CompletionPaletteProps): MayflyUiNode {
  const rows: MayflyUiNode[] = props.items.map(item => {
    const prefix = item.typedPrefix !== undefined && item.label.startsWith(item.typedPrefix) ? item.typedPrefix.length : 0
    const label: MayflyInlineSpan[] = prefix === 0
      ? [{ text: item.label }]
      : [{ text: item.typedPrefix!, styles: ['strong'] }, { text: item.label.slice(prefix) }]
    const content = item.path === true
      ? ui.text(item.label, { overflow: 'start' })
      : ui.richText(label, { overflow: 'truncate' })
    return ui.stack.row([
      ui.child(ui.text(item.focused === true ? '→' : ' ', { tone: item.focused === true ? 'primary' : 'muted' }), { basis: 2, shrink: 0 }),
      ui.child(content, { grow: 1 }),
      ...item.detail === undefined ? [] : [ui.child(ui.text(item.detail, { tone: 'muted', overflow: 'truncate' }), { priority: 2, overflow: 'hide' })],
      ...item.source === undefined ? [] : [ui.child(ui.text(item.source, { tone: 'muted', overflow: 'truncate' }), { priority: 1, overflow: 'hide' })],
      ...item.right === undefined ? [] : [ui.child(ui.text(item.right, { tone: 'muted' }), { shrink: 0 })],
    ], { gap: 1 })
  })
  if (props.items.length === 0) return ui.stack.column(rows)
  const bounded = props.maxRows === undefined ? rows : [...rows.slice(0, props.maxRows), ...rows.length > props.maxRows ? [ui.text(`  +${String(rows.length - props.maxRows)} more`, { tone: 'muted' })] : []]
  const problem = props.items.find(item => item.focused === true)?.problem
  return ui.stack.column([
    ...bounded,
    ...problem === undefined ? [] : [ui.text(`    ${problem}`, { tone: 'danger', overflow: 'truncate' })],
    ...props.wait === undefined ? [] : [ui.text(`    ${props.wait}`, { tone: 'muted', overflow: 'truncate' })],
  ])
}

export interface StatusPageProps {
  readonly tabs: Omit<import('./contracts.ts').MayflyTabsNode, 'kind'>
  readonly rows?: readonly import('./contracts.ts').MayflyField[]
  readonly body?: MayflyUiNode
  readonly pages?: Readonly<Record<string, MayflyUiNode>>
  readonly footer?: MayflyUiNode
}

/** A tabbed read-only page body; the host wraps it in a panel. */
export function statusPage(props: StatusPageProps): MayflyUiNode {
  const { tabs: strip, pages } = props
  if (pages === undefined && props.body === undefined && props.rows === undefined) throw new TypeError('statusPage needs rows, a body, or pages')
  const body = pages === undefined
    ? [ui.tabs(strip), ui.spacer(), props.body ?? ui.fields(props.rows!)]
    : [tabs({ tabs: strip, pages, pageGrow: true })]
  return ui.stack.column([...body, ...props.footer === undefined ? [] : [props.footer]])
}

export const decisionArmMs = DECISION_ARM_MS

/** The composition namespace: the one surface layer for Mayfly and plugins. */
export const compose = Object.freeze({
  panel,
  decisionLane,
  decisionStrip,
  wizard,
  tabs,
  rail,
  browser,
  completionPalette,
  statusPage,
  wizardNext,
  decisionArmMs,
})
