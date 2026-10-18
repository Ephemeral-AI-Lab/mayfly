/**
 * The first-run guide: a wizard of Preferences (language, theme and the permission preset), Connect
 * and Ready, with no buttons. Preferences and Connect settle their answer as it is given (`settle`): the plugin writes it and the
 * reply moves on. Connect is a numbered choice whose API key row swaps the page for a masked field and whose account row swaps it for the sign-in page (`Esc` steps back to the
 * choices); the last step welcomes the reader and lists what was set and what to try. The component is a pure function of the facts and the words it shows.
 * @module @ephemeral-ai/mayfly/components/onboarding-wizard
 */
import { panel, ui, wizard, wizardNext, type MayflySurfaceNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { signInBody, type SignInFacts, type SignInIds, type SignInLabels } from './account-sign-in.ts'

/** The wizard's id and the ids of its steps, controls and fields: what a submission is read by. */
export const ONBOARDING_WIZARD = 'onboarding'
export const ONBOARDING_PREFERENCES = 'preferences'
export const ONBOARDING_CONNECT = 'connect'
export const ONBOARDING_READY = 'ready'
export const ONBOARDING_PREFERENCES_FORM = 'preferences-form'
export const ONBOARDING_PERMISSION_FIELD = 'permission'
export const ONBOARDING_STARTUP_FIELD = 'startup'
export const ONBOARDING_CONNECT_LIST = 'connect-options'
export const ONBOARDING_KEY_FORM = 'key-form'
export const ONBOARDING_KEY_FIELD = 'key'
export const ONBOARDING_START_LIST = 'start'
/** The ids of the sign-in page on the Connect step: what its events are read by. */
export const ONBOARDING_SIGN_IN: SignInIds = {
  pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_CONNECT }],
  keys: 'sign-in-keys', form: 'sign-in-callback', field: 'callback-url', copy: 'sign-in-copy', restart: 'sign-in-restart',
  other: 'sign-in-other', deliver: 'sign-in-deliver', retryList: 'sign-in-retry-list', retry: 'sign-in-retry',
}

export type OnboardingStepId = typeof ONBOARDING_PREFERENCES | typeof ONBOARDING_CONNECT | typeof ONBOARDING_READY
/** The rows of the Connect list. */
export type OnboardingConnectChoice = 'account' | 'key' | 'skip'

export interface OnboardingPresetRow {
  readonly id: string
  readonly label: string
  /** The deployment's current preset: the field starts on it. */
  readonly current: boolean
}

/** What the component reads of the first run. */
export interface OnboardingFacts {
  /** The step the reader is on; the surface keeps its own position across republishes. */
  readonly activeId?: OnboardingStepId
  /** The first step's fields. */
  readonly preferences: {
    /** The language and theme, preselected with what is set now. */
    readonly language: {
      readonly value: string
      readonly theme: string
      readonly languages: readonly { readonly id: string, readonly label: string }[]
      readonly themes: readonly { readonly id: string, readonly label: string }[]
    }
    /** What a start without a session shows, preselected with what is set now. */
    readonly startup: {
      readonly value: string
      readonly options: readonly { readonly id: string, readonly label: string }[]
    }
    /** Present when the composition has permission presets: the rows, the current one preselected. */
    readonly permissions?: readonly OnboardingPresetRow[]
  }
  readonly connect: {
    /** The account row is offered only when the composition carries sign-in. */
    readonly canSignIn: boolean
    /** The masked key field takes the page. */
    readonly keyEntry: boolean
    /** The row that connected (the account); it stays ticked so the strip marks the step answered. A skip leaves none, so it reads passed over. */
    readonly connected?: 'account'
    /** A sign-in is under way: the page is the sign-in's, and `Esc` steps back to the choices. */
    readonly signIn?: SignInFacts
  }
  /** What the guide has set so far, one line each, for the Ready page; `done` false reads `○` (still to do). */
  readonly summary: readonly { readonly text: string, readonly done: boolean }[]
}

/** The words of the guide, already in the reader's language. */
export interface OnboardingLabels {
  readonly title: string
  readonly steps: Readonly<Record<OnboardingStepId, string>>
  readonly preferencesIntro: string
  readonly language: string
  readonly permissions: string
  readonly theme: string
  readonly startup: string
  readonly connectIntro: string
  readonly signIn: SignInLabels
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

const next = (stepId: OnboardingStepId): string => wizardNext(ONBOARDING_WIZARD, stepId)

function preferencesBody(facts: OnboardingFacts['preferences'], labels: OnboardingLabels): MayflyUiNode {
  const { language, startup, permissions } = facts
  const current = permissions?.find(row => row.current)
  return ui.stack.column([
    ui.text(labels.preferencesIntro),
    ui.form({
      id: ONBOARDING_PREFERENCES_FORM, enterSubmits: next(ONBOARDING_PREFERENCES), autofocus: true,
      fields: [
        { kind: 'select' as const, id: 'language', label: labels.language, value: language.value, options: language.languages.map(item => ({ id: item.id, label: item.label })) },
        { kind: 'select' as const, id: 'theme', label: labels.theme, value: language.theme, options: language.themes.map(item => ({ id: item.id, label: item.label })) },
        { kind: 'select' as const, id: ONBOARDING_STARTUP_FIELD, label: labels.startup, value: startup.value, options: startup.options.map(item => ({ id: item.id, label: item.label })) },
        ...permissions === undefined ? [] : [
          { kind: 'select' as const, id: ONBOARDING_PERMISSION_FIELD, label: labels.permissions, value: current?.id ?? null, options: permissions.map(row => ({ id: row.id, label: row.label })) },
        ],
      ],
    }),
  ])
}

function connectBody(facts: OnboardingFacts['connect'], labels: OnboardingLabels): MayflyUiNode {
  if (facts.signIn !== undefined) return signInBody(facts.signIn, labels.signIn, ONBOARDING_SIGN_IN)
  /* the key field takes the page: it is then the only control, so it holds the focus and Esc steps back to the choices */
  if (facts.keyEntry) {
    return ui.stack.column([
      ui.text(labels.key, { styles: ['strong'] }),
      ui.text(labels.keyNote, { tone: 'muted' }),
      ui.form({
        id: ONBOARDING_KEY_FORM, enterSubmits: next(ONBOARDING_CONNECT), autofocus: true,
        fields: [{ kind: 'secret', id: ONBOARDING_KEY_FIELD, label: labels.keyField, value: '', placeholder: labels.keyPlaceholder }],
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
    ui.list({ id: ONBOARDING_CONNECT_LIST, role: 'choose', autofocus: true, numbered: true, selectedIds: facts.connected === undefined ? [] : [facts.connected], items, acceptActionId: next(ONBOARDING_CONNECT) }),
  ])
}

function readyBody(summary: OnboardingFacts['summary'], labels: OnboardingLabels): MayflyUiNode {
  return ui.stack.column([
    ui.text(labels.readyIntro, { styles: ['strong'] }),
    ...summary.map(line => ui.text(`${line.done ? '✓' : '○'} ${line.text}`, { tone: line.done ? 'success' : 'warning' })),
    ui.spacer(),
    ui.text(labels.tryHeading, { tone: 'muted' }),
    ...labels.tryItems.map(item => ui.text(`${item.keys}  ${item.text}`)),
    ui.spacer(),
    /* the one row holds the focus, so Enter starts chatting */
    ui.list({ id: ONBOARDING_START_LIST, role: 'choose', autofocus: true, selectedIds: [], items: [{ id: 'start', label: labels.start }], acceptActionId: next(ONBOARDING_READY) }),
  ])
}

/** The guide for one state of the first run: the steps in order, with no review page (Ready is the summary). */
export function onboardingWizard(facts: OnboardingFacts, labels: OnboardingLabels): MayflySurfaceNode {
  return panel({
    title: labels.title,
    escapeLabel: 'cancel',
    body: wizard({
      id: ONBOARDING_WIZARD,
      ...facts.activeId === undefined ? {} : { activeId: facts.activeId },
      steps: [
        { id: ONBOARDING_PREFERENCES, label: labels.steps.preferences, body: preferencesBody(facts.preferences, labels), forms: [ONBOARDING_PREFERENCES_FORM], settle: true },
        {
          id: ONBOARDING_CONNECT, label: labels.steps.connect, body: connectBody(facts.connect, labels), settle: true,
          ...facts.connect.signIn !== undefined ? { holdBack: true } : facts.connect.keyEntry ? { forms: [ONBOARDING_KEY_FORM], holdBack: true } : { lists: [ONBOARDING_CONNECT_LIST] },
        },
        { id: ONBOARDING_READY, label: labels.steps.ready, body: readyBody(facts.summary, labels), lists: [ONBOARDING_START_LIST] },
      ],
      hintLabel: 'step',
    }),
  })
}
