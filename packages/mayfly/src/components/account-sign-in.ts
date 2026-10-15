/**
 * The body of a DeepSeek account sign-in, one page for every moment of it: getting the link, opening the browser, waiting
 * (with the link's life as a countdown), the other-machine paste when this browser could not be opened, finishing, and
 * a way back when it ended. It carries no keys of its own beyond hidden accelerators the hint row names. A pure function of
 * the facts and the words it shows; the guide and the `/provider` account panel both draw it.
 * @module @ephemeral-ai/mayfly/components/account-sign-in
 */
import { ui, type MayflyPagePath, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Where a sign-in is. */
export type SignInStage = 'starting' | 'waiting' | 'finishing' | 'connected' | 'ended'

/** What the component reads of a sign-in. */
export interface SignInFacts {
  readonly stage: SignInStage
  /** `pending` while the browser launch has no result, then whether a browser took the link. */
  readonly browser: 'pending' | 'opened' | 'failed'
  /** The reader asked for the other-machine view though a browser opened. */
  readonly manual: boolean
  readonly url?: string
  /** The link's life left and in all, in milliseconds. */
  readonly remainingMs?: number
  readonly totalMs?: number
  /** The loopback callback port; absent when there is no paste-back to offer. */
  readonly callbackPort?: number
  /** The pasted address was handed over and the page loads: the stage reads as finishing. */
  readonly delivering?: boolean
  /** How it ended, already in the reader's language (stage `ended`). */
  readonly endedText?: string
}

/** The words of the page, already in the reader's language. */
export interface SignInLabels {
  readonly starting: string
  readonly opening: string
  readonly waiting: string
  readonly noBrowser: string
  readonly otherMachine: string
  readonly finishing: string
  readonly connected: string
  /** `expires in {time}` with the time filled in by the caller. */
  readonly expires: (time: string) => string
  readonly callbackLabel: string
  readonly callbackPlaceholder: string
  readonly retry: string
  readonly copyLink: string
  readonly newLink: string
  readonly otherMachineKey: string
  readonly deliver: string
}

/** The ids a host reads the page's events by, and where the page sits. */
export interface SignInIds {
  readonly pagePath: MayflyPagePath
  readonly keys: string
  readonly form: string
  readonly field: string
  readonly copy: string
  readonly restart: string
  readonly other: string
  readonly deliver: string
  readonly retryList: string
  readonly retry: string
}

/** `4:41` for a time left. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}

/** A viewport no terminal reaches: the branch is admitted but never shown. */
const NEVER = { minWidth: 100_000 }

/** The page for one moment of a sign-in. */
export function signInBody(facts: SignInFacts, labels: SignInLabels, ids: SignInIds): MayflyUiNode {
  const loading = (text: string): MayflyUiNode => ui.richText([{ text: '', motion: 'loader', variant: 'breath' }, { text: ` ${text}` }])
  const left = facts.remainingMs
  const countdown = left === undefined ? [] : [ui.stack.row([
    ui.child(ui.text(labels.expires(clock(left)), { tone: 'muted' }), { shrink: 0 }),
    ui.child(ui.progress({ value: Math.max(0, left), max: Math.max(1, facts.totalMs ?? left), style: 'rule', width: 16, tone: left < 60_000 ? 'warning' : 'primary' }), { grow: 1 }),
  ], { gap: 1 })]
  const keys = (items: readonly { readonly id: string, readonly label: string, readonly key?: string, readonly submit?: boolean }[]): MayflyUiNode => ui.actions({
    id: ids.keys,
    items: items.map(item => ({ id: item.id, label: item.label, hidden: true, ...item.key === undefined ? {} : { key: item.key }, ...item.submit === true ? { submit: [{ pagePath: ids.pagePath, formId: ids.form }] } : {} })),
  })
  const callback = (visible: boolean): MayflyUiNode | MayflyUiChild => {
    const form = ui.form({
      id: ids.form, enterSubmits: ids.deliver, ...visible ? { autofocus: true } : {},
      fields: [{ kind: 'input', id: ids.field, label: labels.callbackLabel, value: '', placeholder: labels.callbackPlaceholder }],
    })
    /* a submission is acknowledged with a page that still holds its form: out of sight, it stays there */
    return visible ? form : ui.child(form, { when: NEVER })
  }
  const withForm = (visible: boolean): readonly (MayflyUiNode | MayflyUiChild)[] => facts.callbackPort === undefined ? [] : [callback(visible)]

  switch (facts.stage) {
    case 'starting': return ui.stack.column([loading(labels.starting)])
    case 'finishing': return ui.stack.column([loading(labels.finishing), ...withForm(false)])
    case 'connected': return ui.stack.column([ui.richText([{ text: '✓ ', tone: 'success' }, { text: labels.connected }])])
    case 'ended': return ui.stack.column([
      ui.text(facts.endedText ?? '', { tone: 'warning' }),
      ui.spacer(),
      ui.list({ id: ids.retryList, role: 'choose', autofocus: true, selectedIds: [], items: [{ id: 'retry', label: labels.retry }], acceptActionId: ids.retry }),
    ])
    case 'waiting': break
  }
  if (facts.delivering === true) return ui.stack.column([loading(labels.finishing), ...withForm(false)])
  if (facts.browser === 'pending') return ui.stack.column([loading(labels.opening), ...withForm(false)])
  const manual = facts.browser === 'failed' || facts.manual
  if (!manual) {
    return ui.stack.column([
      loading(labels.waiting),
      ...countdown,
      ...withForm(false),
      keys([
        { id: ids.copy, label: labels.copyLink, key: 'ctrl+y' },
        { id: ids.restart, label: labels.newLink, key: 'ctrl+r' },
        ...facts.callbackPort === undefined ? [] : [{ id: ids.other, label: labels.otherMachineKey, key: 'p' }],
      ]),
    ])
  }
  return ui.stack.column([
    ui.text(facts.browser === 'failed' ? labels.noBrowser : labels.otherMachine),
    ui.spacer(),
    ui.text(facts.url ?? '', { tone: 'muted', overflow: 'truncate' }),
    ...countdown,
    ...facts.callbackPort === undefined ? [] : [ui.spacer(), callback(true)],
    keys([
      { id: ids.copy, label: labels.copyLink, key: 'ctrl+y' },
      { id: ids.restart, label: labels.newLink, key: 'ctrl+r' },
      ...facts.callbackPort === undefined ? [] : [{ id: ids.deliver, label: labels.deliver, submit: true }],
    ]),
  ])
}
