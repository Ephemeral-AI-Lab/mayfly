/**
 * Pure account sign-in pages for Remote account and onboarding surfaces.
 * @module @ephemeral-ai/mayfly/remote/features/ui/account-sign-in
 */

import { ui, type MayflyPagePath, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Sign-in stages presented by the pure component. */
export type RemoteSignInStage = 'starting' | 'waiting' | 'finishing' | 'connected' | 'ended'

/** Safe sign-in facts; callback codes and credentials are never retained here. */
export interface RemoteSignInFacts {
  readonly stage: RemoteSignInStage
  readonly browser: 'pending' | 'opened' | 'failed'
  readonly manual: boolean
  readonly url?: string
  readonly remainingMs?: number
  readonly totalMs?: number
  readonly callbackPort?: number
  readonly delivering?: boolean
  readonly endedText?: string
}

/** Localized sign-in labels. */
export interface RemoteSignInLabels {
  readonly starting: string
  readonly opening: string
  readonly waiting: string
  readonly noBrowser: string
  readonly otherMachine: string
  readonly finishing: string
  readonly connected: string
  readonly expires: (time: string) => string
  readonly callbackLabel: string
  readonly callbackPlaceholder: string
  readonly retry: string
  readonly copyLink: string
  readonly newLink: string
  readonly otherMachineKey: string
  readonly deliver: string
  readonly cancel: string
}

/** Control identities consumed by a feature controller. */
export interface RemoteSignInIds {
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
  readonly cancel: string
}

/** `4:41` countdown text. */
export function remoteSignInClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}

const NEVER = { minWidth: 100_000 }

/** Pure sign-in body; only the explicit cancel action maps to cancelSignIn. */
export function remoteSignInBody(facts: RemoteSignInFacts, labels: RemoteSignInLabels, ids: RemoteSignInIds): MayflyUiNode {
  const loading = (text: string): MayflyUiNode => ui.richText([{ text: '', motion: 'loader', variant: 'breath' }, { text: ` ${text}` }])
  const left = facts.remainingMs
  const countdown = left === undefined ? [] : [ui.stack.row([
    ui.child(ui.text(labels.expires(remoteSignInClock(left)), { tone: 'muted' }), { shrink: 0 }),
    ui.child(ui.progress({ value: Math.max(0, left), max: Math.max(1, facts.totalMs ?? left), style: 'rule', width: 16, tone: left < 60_000 ? 'warning' : 'primary' }), { grow: 1 }),
  ], { gap: 1 })]
  const keys = (items: readonly { readonly id: string, readonly label: string, readonly key?: string, readonly submit?: boolean }[]): MayflyUiNode => ui.actions({
    id: ids.keys,
    items: items.map(item => ({ id: item.id, label: item.label, hidden: true, ...item.key === undefined ? {} : { key: item.key }, ...item.submit === true ? { submit: [{ pagePath: ids.pagePath, formId: ids.form }] } : {} })),
  })
  const callback = (visible: boolean): MayflyUiNode | MayflyUiChild => {
    const form = ui.form({
      id: ids.form,
      enterSubmits: ids.deliver,
      ...visible ? { autofocus: true } : {},
      fields: [{ kind: 'input', id: ids.field, label: labels.callbackLabel, value: '', placeholder: labels.callbackPlaceholder }],
    })
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
        { id: ids.cancel, label: labels.cancel, key: 'ctrl+x' },
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
      { id: ids.cancel, label: labels.cancel, key: 'ctrl+x' },
      ...facts.callbackPort === undefined ? [] : [{ id: ids.deliver, label: labels.deliver, submit: true }],
    ]),
  ])
}
