/**
 * Public UI patterns: five compositions of the builders that plugins and Mayfly core both reuse. A pattern has no
 * renderer of its own; each call is pure and returns a frozen node tree made only from `ui.*`.
 * @module @ephemeral-ai/mayfly-ui/patterns
 */
import { ui } from './builders.ts'
import type {
  MayflyActionItem,
  MayflyField,
  MayflyInlineSpan,
  MayflyListItem,
  MayflyReviewItem,
  MayflySurfaceNode,
  MayflyTabsNode,
  MayflyUiNode,
} from './contracts.ts'
import type { MayflyFormAddress, MayflyPagePath, MayflySelectionAddress } from './interaction.ts'

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
  /** A node between the list and the detail (a vertical rule), one column wide; it appears with the detail only. */
  readonly separator?: MayflyUiNode
  /** The list where it stands alone (below `breakpoint`), in place of `list`: it needs no height of its own. */
  readonly aloneList?: MayflyUiNode
  /** The list for a viewport narrower than `compactBelow` (shorter row texts), in place of `aloneList`. */
  readonly compactList?: MayflyUiNode
  /** The width under which `compactList` replaces `list`; default 56. Needs `compactList`. */
  readonly compactBelow?: number
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

/** One step of a wizard: its page and the controls on that page whose drafts the wizard reads. */
export interface MayflyWizardStep {
  readonly id: string
  readonly label: string
  /** The step's page. Its lists name {@link patterns.wizardNext} as their `acceptActionId`, so `Enter` takes the answer and moves on. */
  readonly body: MayflyUiNode
  /** Ids of the forms on the page: `Enter` validates them before the next step, and the submission carries them. */
  readonly forms?: readonly string[]
  /** Ids of the lists on the page: the submission carries their selections. */
  readonly lists?: readonly string[]
  /**
   * `Enter` reaches the consumer instead of only moving on: the step's forms and selections arrive as a `submit`, and the
   * reply decides. An `accepted` reply that carries `navigate` marks the step answered (`✓`) and moves to the page it names;
   * any other reply leaves the step as it was. For a step whose answer is written as it is given (a connection, a preset).
   * A form on the page names {@link patterns.wizardNext} as its `enterSubmits`. Ignored on the last step of a wizard with no review.
   */
  readonly settle?: boolean
  /** `Esc` does not walk back from this step: it reaches the consumer as a dismiss, which can answer `dismiss: false` to step back inside the page. */
  readonly holdBack?: boolean
}

/** The answer a review row shows, as a control on one step's page. */
export interface MayflyWizardReviewItem {
  readonly stepId: string
  readonly label: string
  readonly source: { readonly kind: 'list', readonly controlId: string } | { readonly kind: 'form', readonly formId: string, readonly fieldId: string }
}

export interface MayflyWizardProps {
  /** The prefix of the wizard's controls: the strip is `<id>`, the review page `<id>.review`; default `wizard`. */
  readonly id?: string
  readonly title: string
  readonly badges?: readonly MayflyInlineSpan[]
  readonly steps: readonly MayflyWizardStep[]
  /** The step shown first; default the first. */
  readonly activeId?: string
  /** The last page, listing every answer before the submit row. Without it the last step's `Enter` submits. */
  readonly review?: {
    readonly label: string
    readonly items: readonly MayflyWizardReviewItem[]
    readonly skippedLabel: string
    readonly submitLabel: string
  }
  /** The action the review page's submit row runs; default `<id>.submit`. Without a review, the last step's {@link patterns.wizardNext} action submits. */
  readonly submitActionId?: string
  /** The word the hint row gives the strip's arrows (default `step`). */
  readonly hintLabel?: string
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
  const compactBelow = props.compactBelow ?? 56
  const aloneList = props.aloneList ?? props.list
  const alone = props.compactList === undefined
    ? [ui.child(aloneList, { grow: 1, when: { maxWidth: breakpoint - 1 } })]
    : [
        ui.child(aloneList, { grow: 1, when: { minWidth: compactBelow, maxWidth: breakpoint - 1 } }),
        ui.child(props.compactList, { grow: 1, when: { maxWidth: compactBelow - 1 } }),
      ]
  return ui.stack.row([
    ui.child(props.list, { basis: props.listWidth ?? 58, shrink: 0, when: { minWidth: breakpoint } }),
    ...props.separator === undefined ? [] : [ui.child(props.separator, { basis: 1, shrink: 0, when: { minWidth: breakpoint } })],
    ui.child(props.detail, { basis: 0, grow: 1, when: { minWidth: breakpoint } }),
    ...alone,
  ], { gap: 2 })
}

/** A read-only page under a tab strip; each tab's page takes the room under the strip, so a page can scroll its own content. */
function statusPage(props: MayflyStatusPageProps): MayflySurfaceNode {
  const { tabs, pages } = props
  if (pages === undefined && props.body === undefined && props.rows === undefined) throw new TypeError('statusPage needs rows, a body, or pages')
  const body = pages === undefined
    ? [props.body ?? ui.fields(props.rows!)]
    : tabs.items.flatMap(item => pages[item.id] === undefined ? [] : [ui.child(pages[item.id]!, { tab: { controlId: tabs.id, itemId: item.id }, grow: 1, minSize: 1 })])
  return ui.surface({
    title: props.title,
    chrome: 'overlay',
    ...props.badges === undefined ? {} : { badges: props.badges },
    ...props.footer === undefined ? {} : { footer: props.footer },
    child: ui.stack.column([ui.tabs(tabs), ui.spacer(), ...body]),
  })
}

const wizardNext = (id: string, stepId: string): string => `${id}.next.${stepId}`

/**
 * A multi-step form: a step strip, one page per step, and an optional review page. Marks follow the answers (`✓` answered,
 * `–` passed without one, `●` here, `○` to come), `Esc` walks back one step, `Alt+←/→` and (on a choose row) plain `←/→`
 * move between steps, and `Enter` takes the answer and moves on: no buttons. A wizard of one step drops the strip and the
 * review and submits at once. Drafts stay in the surface while the reader moves between steps.
 */
function wizard(props: MayflyWizardProps): MayflySurfaceNode {
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
      /* a page with nothing to submit (a sign-in under way) has an Enter that is a plain action */
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
  if (single) return ui.surface({ title: props.title, chrome: 'overlay', escapeLabel: 'cancel', ...props.badges === undefined ? {} : { badges: props.badges }, child: pages[0] as MayflyUiNode })
  const reviewItems: MayflyReviewItem[] = review === undefined ? [] : review.items.map(item => ({
    id: item.stepId, label: item.label,
    source: item.source.kind === 'list' ? { kind: 'list', pagePath: pathOf(item.stepId), controlId: item.source.controlId } : { kind: 'form', pagePath: pathOf(item.stepId), formId: item.source.formId, fieldId: item.source.fieldId },
  }))
  const reviewPage = review === undefined ? [] : [ui.child(ui.stack.column([
    ui.review({ id: reviewId, tabsId: id, items: reviewItems, skippedLabel: review.skippedLabel, submitLabel: review.submitLabel, submitActionId, autofocus: true }),
    ui.actions({ id: `${id}.keys.review`, items: [submit] }),
  ]), { tab: { controlId: id, itemId: reviewId } })]
  const items = [
    ...steps.map((step, index) => ({ id: step.id, label: step.label, ...index === 0 || step.holdBack === true ? {} : { backId: steps[index - 1]!.id } })),
    ...review === undefined ? [] : [{ id: reviewId, label: review.label, review: true as const, backId: steps.at(-1)!.id }],
  ]
  return ui.surface({
    title: props.title,
    chrome: 'overlay',
    escapeLabel: 'cancel',
    ...props.badges === undefined ? {} : { badges: props.badges },
    child: ui.stack.column([
      ui.tabs({ id, mode: 'wizard', activeId: props.activeId ?? steps[0]!.id, items, hintLabel: props.hintLabel ?? 'step' }),
      ui.spacer(),
      ...pages,
      ...reviewPage,
    ]),
  })
}

/** The patterns, pure and frozen, and the arm delay a decision panel's overlay sets (`decisionArmMs`). */
export const patterns = Object.freeze({
  decisionPanel,
  railPanel,
  splitView,
  statusPage,
  wizard,
  /** The id of the hidden action that takes a step's answer and moves to the next page; a step's lists name it as `acceptActionId`. */
  wizardNext,
  /** The `armMs` of an overlay that shows a decision panel unprompted (slice 1.8a): stray keys grant nothing for this long. */
  decisionArmMs: DECISION_ARM_MS,
})
