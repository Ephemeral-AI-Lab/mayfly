/** Shared DeepSeek account presentation driven by readonly public facts. @module @ephemeral-ai/mayfly/components/account-panel */
import { panel, ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { signInBody, type SignInFacts, type SignInIds } from './account-sign-in.ts'

/** Display-safe fields of one native sign-in attempt. */
interface AccountPanelAttempt {
  readonly phase: string
  readonly errorCode?: string
  readonly authorizeUrl?: string
  readonly expiresAt?: number
}

/** Display-safe native account state; credentials never enter this model. */
interface AccountPanelView {
  readonly status: string
  readonly attempt: AccountPanelAttempt | null
}

function terminal(attempt: AccountPanelAttempt): boolean {
  return ['succeeded', 'cancelled', 'expired', 'failed'].includes(attempt.phase)
}

/** The one-line outcome of a finished attempt; the platform error code picks the reason. */
function outcomeText(attempt: AccountPanelAttempt, t: (key: string) => string): string {
  if (attempt.phase === 'cancelled') return t('Sign-in cancelled')
  if (attempt.phase === 'expired' || attempt.errorCode === 'expired') return t('The sign-in link expired — try again')
  if (attempt.errorCode === 'network' || attempt.errorCode === 'no-response') return t('Could not reach DeepSeek — check the connection and try again')
  if (attempt.errorCode === 'storage') return t('The login could not be saved on this machine — try again')
  return t('Sign-in failed — try again')
}

/** Presentation options for the account panel node. */
interface AccountPanelOptions {
  /** A callback was admitted and the native attempt is finishing. */
  readonly delivering?: boolean
  /** The browser launch has no result yet. */
  readonly launching?: boolean
  /** The browser could not be opened for the link: the page says so and the paste-back field is open and focused. */
  readonly focusPaste?: boolean
  /** The reader asked for the other-machine view (`p`). */
  readonly pasteOpen?: boolean
  /** The clock the countdown reads, in epoch milliseconds (the current time when omitted). */
  readonly now: number
  /** The whole life of the link in milliseconds, for the countdown bar; the time left when omitted. */
  readonly expiryTotalMs?: number
}

/** The ids the sign-in page's events are read by in this panel. */
const PANEL_SIGN_IN: SignInIds = {
  pagePath: [], keys: 'account-actions', form: 'callback-paste', field: 'callback-url', copy: 'copy-link', restart: 'restart-sign-in',
  other: 'show-paste', deliver: 'deliver-callback', retryList: 'unused-retry-list', retry: 'unused-retry',
}

/**
 * The panel for one account view. Signing in is the shared sign-in page (`components/account-sign-in.ts`): getting the link,
 * opening the browser, waiting with a countdown, and the other-machine paste when this browser could not be opened. The
 * rest are one-sentence states with a single action; the shortcuts live only in the hint row.
 * @param callbackPort - the live loopback callback port while an attempt waits for a browser; omit it to render without the paste-back.
 */
export function buildAccountPanel(
  view: AccountPanelView,
  t: (key: string, values?: Record<string, string | number>) => string,
  canSignIn: boolean,
  callbackPort: number | undefined,
  options: AccountPanelOptions,
): MayflyUiNode {
  const attempt = view.attempt
  const stored = view.status === 'credential-stored'
  const live = attempt !== null && !terminal(attempt)
  const linked = live && attempt.authorizeUrl !== undefined
  // A cancelled, expired or failed attempt is over: sign-in is offered again.
  const retry = attempt !== null && !live && attempt.phase !== 'succeeded'
  const frame = (child: MayflyUiNode): MayflyUiNode => panel({ title: t('DeepSeek Account'), escapeLabel: 'back', body: child })

  if (live) {
    const left = attempt.expiresAt === undefined ? undefined : attempt.expiresAt - options.now
    const facts: SignInFacts = {
      stage: attempt.phase === 'exchanging' || attempt.phase === 'committing' ? 'finishing' : linked ? 'waiting' : 'starting',
      browser: options.launching === true ? 'pending' : options.focusPaste === true ? 'failed' : 'opened',
      manual: options.pasteOpen === true,
      delivering: options.delivering === true,
      ...attempt.authorizeUrl === undefined ? {} : { url: attempt.authorizeUrl },
      ...left === undefined ? {} : { remainingMs: left },
      ...options.expiryTotalMs === undefined ? {} : { totalMs: options.expiryTotalMs },
      ...callbackPort === undefined ? {} : { callbackPort },
    }
    return frame(signInBody(facts, {
      starting: t('Getting your sign-in link…'),
      opening: t('Opening your browser…'),
      waiting: t('Waiting for you to sign in in your browser'),
      noBrowser: t('Couldn’t open a browser. Copy the link below and open it yourself, then paste the address it ends on (the page may fail to load).'),
      otherMachine: t('Open the link below in a browser on another machine, then paste the address it ends on (the page may fail to load).'),
      finishing: t('Signing you in…'),
      connected: t('Signed in'),
      expires: (time: string) => t('expires in {time}', { time }),
      callbackLabel: t('Callback URL'),
      callbackPlaceholder: `http://localhost:${String(callbackPort ?? '')}/oauth/callback?…`,
      retry: t('Try again'),
      copyLink: t('Copy link'),
      newLink: t('New link'),
      otherMachineKey: t('Other machine'),
      deliver: t('Deliver callback'),
    }, PANEL_SIGN_IN))
  }

  if (stored) {
    return frame(ui.stack.column([
      ui.richText([{ text: '✓ ', tone: 'success' }, { text: t('Signed in') }]),
      ui.text(t('Account models need no API key.'), { tone: 'muted' }),
      ui.spacer(),
      ui.actions({ id: 'account-actions', items: [
        { id: 'sign-out', label: t('Sign out'), hintLabel: t('sign out'), key: 'o', hidden: true, intent: 'danger' as const, confirm: t('Sign out of the DeepSeek account?') },
      ] }),
    ]))
  }

  return frame(ui.stack.column([
    ...retry ? [ui.text(outcomeText(attempt, t), { tone: 'warning' }), ui.spacer()] : [],
    ui.text(canSignIn
      ? t('Sign in with your DeepSeek account — models are billed to it and need no API key.')
      : t('Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts. Account models then need no API key.'), { tone: 'muted' }),
    ui.spacer(),
    ...canSignIn ? [ui.actions({ id: 'account-actions', items: [
      { id: 'sign-in', label: retry && attempt.phase !== 'cancelled' ? t('Try again') : t('Sign in'), hintLabel: t('sign in'), key: 's', hidden: true, intent: 'primary' as const },
    ] })] : [],
  ]))
}

