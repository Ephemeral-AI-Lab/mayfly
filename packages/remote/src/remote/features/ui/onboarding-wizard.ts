/**
 * Pure Remote first-run wizard with preferences, connection, and ready pages.
 * @module @ephemeral-ai/mayfly/remote/features/ui/onboarding-wizard
 */

import { panel, ui, wizard, wizardNext, type MayflySurfaceNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { remoteSignInBody, type RemoteSignInFacts, type RemoteSignInIds, type RemoteSignInLabels } from './account-sign-in.ts'

export const REMOTE_ONBOARDING_WIZARD = 'onboarding'
export const REMOTE_ONBOARDING_PREFERENCES = 'preferences'
export const REMOTE_ONBOARDING_CONNECT = 'connect'
export const REMOTE_ONBOARDING_READY = 'ready'
export const REMOTE_ONBOARDING_PREFERENCES_FORM = 'preferences-form'
export const REMOTE_ONBOARDING_PERMISSION_FIELD = 'permission'
export const REMOTE_ONBOARDING_STARTUP_FIELD = 'startup'
export const REMOTE_ONBOARDING_CONNECT_LIST = 'connect-options'
export const REMOTE_ONBOARDING_KEY_FORM = 'key-form'
export const REMOTE_ONBOARDING_KEY_FIELD = 'key'
export const REMOTE_ONBOARDING_START_LIST = 'start'

/** Sign-in control identities on the Connect page. */
export const REMOTE_ONBOARDING_SIGN_IN: RemoteSignInIds = {
  pagePath: [{ controlId: REMOTE_ONBOARDING_WIZARD, itemId: REMOTE_ONBOARDING_CONNECT }],
  keys: 'sign-in-keys', form: 'sign-in-callback', field: 'callback-url', copy: 'sign-in-copy', restart: 'sign-in-restart',
  other: 'sign-in-other', deliver: 'sign-in-deliver', retryList: 'sign-in-retry-list', retry: 'sign-in-retry', cancel: 'sign-in-cancel',
}

export type RemoteOnboardingStepId = typeof REMOTE_ONBOARDING_PREFERENCES | typeof REMOTE_ONBOARDING_CONNECT | typeof REMOTE_ONBOARDING_READY
export type RemoteOnboardingConnectChoice = 'account' | 'key' | 'skip'

/** One default permission row. */
export interface RemoteOnboardingPresetRow {
  readonly id: string
  readonly label: string
  readonly current: boolean
}

/** Complete first-run facts. */
export interface RemoteOnboardingFacts {
  readonly activeId?: RemoteOnboardingStepId
  readonly preferences: {
    readonly language: {
      readonly value: string
      readonly theme: string
      readonly languages: readonly { readonly id: string, readonly label: string }[]
      readonly themes: readonly { readonly id: string, readonly label: string }[]
    }
    readonly startup: { readonly value: string, readonly options: readonly { readonly id: string, readonly label: string }[] }
    readonly permissions?: readonly RemoteOnboardingPresetRow[]
  }
  readonly connect: {
    readonly canSignIn: boolean
    readonly keyEntry: boolean
    readonly connected?: 'account'
    readonly signIn?: RemoteSignInFacts
  }
  readonly summary: readonly { readonly text: string, readonly done: boolean }[]
}

/** Localized wizard labels. */
export interface RemoteOnboardingLabels {
  readonly title: string
  readonly steps: Readonly<Record<RemoteOnboardingStepId, string>>
  readonly preferencesIntro: string
  readonly language: string
  readonly permissions: string
  readonly theme: string
  readonly startup: string
  readonly connectIntro: string
  readonly signIn: RemoteSignInLabels
  readonly account: string
  readonly accountDetail: string
  readonly key: string
  readonly keyDetail: string
  readonly keyNote: string
  readonly keyField: string
  readonly keyPlaceholder: string
  readonly skip: string
  readonly skipDetail: string
  readonly recommended: string
  readonly readyIntro: string
  readonly tryHeading: string
  readonly tryItems: readonly { readonly keys: string, readonly text: string }[]
  readonly start: string
}

const next = (stepId: RemoteOnboardingStepId): string => wizardNext(REMOTE_ONBOARDING_WIZARD, stepId)

function preferencesBody(facts: RemoteOnboardingFacts['preferences'], labels: RemoteOnboardingLabels): MayflyUiNode {
  const current = facts.permissions?.find(row => row.current)
  return ui.stack.column([
    ui.text(labels.preferencesIntro),
    ui.form({
      id: REMOTE_ONBOARDING_PREFERENCES_FORM,
      enterSubmits: next(REMOTE_ONBOARDING_PREFERENCES),
      autofocus: true,
      fields: [
        { kind: 'select', id: 'language', label: labels.language, value: facts.language.value, options: facts.language.languages.map(item => ({ id: item.id, label: item.label })) },
        { kind: 'select', id: 'theme', label: labels.theme, value: facts.language.theme, options: facts.language.themes.map(item => ({ id: item.id, label: item.label })) },
        { kind: 'select', id: REMOTE_ONBOARDING_STARTUP_FIELD, label: labels.startup, value: facts.startup.value, options: facts.startup.options.map(item => ({ id: item.id, label: item.label })) },
        ...facts.permissions === undefined ? [] : [{ kind: 'select' as const, id: REMOTE_ONBOARDING_PERMISSION_FIELD, label: labels.permissions, value: current?.id ?? null, options: facts.permissions.map(row => ({ id: row.id, label: row.label })) }],
      ],
    }),
  ])
}

function connectBody(facts: RemoteOnboardingFacts['connect'], labels: RemoteOnboardingLabels): MayflyUiNode {
  if (facts.signIn !== undefined) return remoteSignInBody(facts.signIn, labels.signIn, REMOTE_ONBOARDING_SIGN_IN)
  if (facts.keyEntry) {
    return ui.stack.column([
      ui.text(labels.key, { styles: ['strong'] }),
      ui.text(labels.keyNote, { tone: 'muted' }),
      ui.form({
        id: REMOTE_ONBOARDING_KEY_FORM,
        enterSubmits: next(REMOTE_ONBOARDING_CONNECT),
        autofocus: true,
        fields: [{ kind: 'secret', id: REMOTE_ONBOARDING_KEY_FIELD, label: labels.keyField, value: '', placeholder: labels.keyPlaceholder }],
      }),
    ])
  }
  const items = [
    ...facts.canSignIn ? [{ id: 'account', label: labels.account, badge: labels.recommended, detail: labels.accountDetail }] : [],
    { id: 'key', label: labels.key, detail: labels.keyDetail },
    { id: 'skip', label: labels.skip, detail: labels.skipDetail },
  ]
  return ui.stack.column([
    ui.text(labels.connectIntro, { styles: ['strong'] }),
    ui.list({ id: REMOTE_ONBOARDING_CONNECT_LIST, role: 'choose', autofocus: true, numbered: true, selectedIds: facts.connected === undefined ? [] : [facts.connected], items, acceptActionId: next(REMOTE_ONBOARDING_CONNECT) }),
  ])
}

function readyBody(summary: RemoteOnboardingFacts['summary'], labels: RemoteOnboardingLabels): MayflyUiNode {
  return ui.stack.column([
    ui.text(labels.readyIntro, { styles: ['strong'] }),
    ...summary.map(line => ui.text(`${line.done ? '✓' : '○'} ${line.text}`, { tone: line.done ? 'success' : 'warning' })),
    ui.spacer(),
    ui.text(labels.tryHeading, { tone: 'muted' }),
    ...labels.tryItems.map(item => ui.text(`${item.keys}  ${item.text}`)),
    ui.spacer(),
    ui.list({ id: REMOTE_ONBOARDING_START_LIST, role: 'choose', autofocus: true, selectedIds: [], items: [{ id: 'start', label: labels.start }], acceptActionId: next(REMOTE_ONBOARDING_READY) }),
  ])
}

/** Pure first-run wizard node. */
export function remoteOnboardingWizard(facts: RemoteOnboardingFacts, labels: RemoteOnboardingLabels): MayflySurfaceNode {
  return panel({
    title: labels.title,
    escapeLabel: 'cancel',
    body: wizard({
      id: REMOTE_ONBOARDING_WIZARD,
      ...facts.activeId === undefined ? {} : { activeId: facts.activeId },
      steps: [
        { id: REMOTE_ONBOARDING_PREFERENCES, label: labels.steps.preferences, body: preferencesBody(facts.preferences, labels), forms: [REMOTE_ONBOARDING_PREFERENCES_FORM], settle: true },
        {
          id: REMOTE_ONBOARDING_CONNECT,
          label: labels.steps.connect,
          body: connectBody(facts.connect, labels),
          settle: true,
          ...facts.connect.signIn !== undefined ? { holdBack: true } : facts.connect.keyEntry ? { forms: [REMOTE_ONBOARDING_KEY_FORM], holdBack: true } : { lists: [REMOTE_ONBOARDING_CONNECT_LIST] },
        },
        { id: REMOTE_ONBOARDING_READY, label: labels.steps.ready, body: readyBody(facts.summary, labels), lists: [REMOTE_ONBOARDING_START_LIST] },
      ],
      hintLabel: 'step',
    }),
  })
}
