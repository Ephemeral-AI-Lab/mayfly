/**
 * The reference notification row over Remote-local presentation and feedback.
 * No Host Session events or Agent objects are retained here.
 * @module @ephemeral-ai/mayfly/remote/notifications
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import { ACTIVITY_LOCALE, mountTranscriptLocale, NotificationLine, type NotificationFacts, type NotificationKeyPart, type NotificationRowFacts } from '@ephemeral-ai/mayfly/editor-presentation'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type {} from '@ephemeral-ai/mayfly/core'
import type { MayflyFeedback, MayflyFeedbackRecord, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteNotice } from './notice.ts'

/** Readonly facts of the currently displayed Remote conversation and prompt. */
export interface RemoteNotificationPresentation {
  readonly hostKey?: string | undefined
  readonly sessionId?: string | undefined
  readonly running?: boolean | undefined
  readonly quietHints?: 'full' | 'off' | undefined
  /** Translated F7/F8 hints when another conversation is retained. */
  readonly toggle?: string | undefined
}

const HINTS = [
  'Alt+↑ conversation · Alt+↓ view', 'Ctrl+Enter steer · Esc interrupt',
  'Ctrl+C clear · Ctrl+G editor', 'Shift+Tab plan · Alt+M model',
] as const
const RANK: Readonly<Record<MayflyFeedbackRecord['severity'], number>> = { info: 0, success: 1, warning: 2, error: 3 }
type RemoteFocusMode = Parameters<Events['mayfly/focus-mode-changed']>[0]
type RemoteFocusRow = Parameters<Events['mayfly/focus-row-changed']>[0]

function visibleNotice(records: readonly MayflyFeedbackRecord[], sessionId: string | undefined): NotificationFacts | undefined {
  const visible = records.filter(record => record.scope.kind === 'app' || record.scope.kind === 'session' && record.scope.sessionId === sessionId)
    .toSorted((left, right) => RANK[left.severity] - RANK[right.severity] || left.createdAt - right.createdAt)
  const top = visible.at(-1)
  return top === undefined ? undefined : {
    severity: top.severity, message: top.message,
    ...top.tail === undefined ? {} : { tail: top.tail }, ...visible.length > 1 ? { waiting: visible.length - 1 } : {},
  }
}

function modeKeys(mode: RemoteFocusMode, row: RemoteFocusRow, t: MayflyTranslate): readonly NotificationKeyPart[] | undefined {
  if (mode === 'conversation' && (row === 'queued' || row === 'steering')) return [
    { text: t('e edit'), priority: 1 }, ...row === 'steering' ? [] : [{ text: t('s send now'), priority: 3 }],
    { text: t('d cancel'), priority: 2 }, { text: t('Enter expand'), priority: 4 },
    { text: t('c copy'), priority: 6 }, { text: t('↑/↓ select'), priority: 5 }, { text: t('Esc back'), priority: 0 },
  ]
  if (mode === 'conversation') return [
    { text: t('↑/↓ select'), priority: 1 }, { text: t('Enter expand'), priority: 2 }, { text: t('c copy'), priority: 4 },
    { text: t('/ ? search'), priority: 3 }, { text: t('Ctrl+G editor'), priority: 5 },
    { text: t('Ctrl+C JSON'), priority: 6 }, { text: t('Esc back'), priority: 0 },
  ]
  if (mode === 'search-select') return [
    { text: t('↑/↓ or n/N match'), priority: 1 }, { text: t('Enter expand'), priority: 2 }, { text: t('c copy'), priority: 4 },
    { text: t('/ ? new search'), priority: 3 }, { text: t('Ctrl+C JSON'), priority: 5 }, { text: t('Esc end search'), priority: 0 },
  ]
  return undefined
}

/** Instance-owned notification pane, core focus hints, and command feedback. */
export class RemoteNotifications {
  readonly notice: RemoteNotice
  private readonly cleanups: Array<() => void> = []
  private readonly pane
  private readonly owner
  private readonly t: MayflyTranslate
  private chip: string | undefined
  private wait: string | undefined
  private promptHint: string | undefined
  private recall: { readonly index: number, readonly total: number } | undefined
  private mode: RemoteFocusMode = 'prompt'
  private row: RemoteFocusRow
  private panelOpen = false
  private running = false
  private group = 0
  private shape = ''
  private serial = 0
  private scopeKey: string
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly presentation: () => RemoteNotificationPresentation,
  ) {
    mountTranscriptLocale(ctx, 'transcript.activity', ACTIVITY_LOCALE)
    this.t = memoizedLocaleTranslator(ctx, 'transcript.activity').translate
    this.scopeKey = JSON.stringify([presentation().hostKey, presentation().sessionId])
    this.owner = ctx.mayflyUiInteraction.createNotificationOwner('mayfly.remote.prompt')
    this.notice = { set: (text, severity = 'info') => {
      if (this.disposed) return
      if (text === '') { this.owner.clear('command'); return }
      const sessionId = presentation().sessionId
      const message = text.replace(/\s*[\r\n]+\s*/gu, ' · ').trim()
      this.owner.report('command', sessionId === undefined ? { kind: 'app', targetId: 'prompt' } : { kind: 'session', sessionId }, {
        severity, message, ...message === text ? {} : { detail: text },
      }, `command/${++this.serial}`)
    } }
    this.pane = ctx.mayflyPanes.register({ id: 'mayfly.pane.notification', placement: 'bottom', priority: 9, narrow: 'bottom' }, NotificationLine(this.current()))
    this.cleanups.push(
      ctx.mayflyUiInteraction.subscribe(() => { this.refresh() }),
      ctx.mayflyLocale.subscribe(() => { this.refresh() }),
      ctx.on('mayfly/focus-mode-changed', next => { this.mode = next; this.refresh() }),
      ctx.on('mayfly/focus-row-changed', next => { this.row = next; this.refresh() }),
      ctx.on('mayfly/panel-open-changed', next => { this.panelOpen = next; this.refresh() }),
      ctx.on('mayfly/prompt-wait-changed', next => { this.wait = next; this.refresh() }),
      ctx.on('mayfly/prompt-hint-changed', next => { this.promptHint = next; this.refresh() }),
      ctx.on('mayfly/prompt-recall-changed', next => { this.recall = next; this.refresh() }),
      ctx.on('mayfly/content-tail-changed', next => { this.chip = next; this.refresh() }),
    )
    this.refresh()
    ctx.effect(() => () => { this.dispose() })
  }

  /** Preserve independent editor-extension feedback identities and full details. */
  report(id: string, feedback: MayflyFeedback): void {
    if (this.disposed) return
    this.refresh()
    const sessionId = this.presentation().sessionId
    this.owner.report(`editor-extension/${id}`, sessionId === undefined ? { kind: 'app', targetId: 'prompt' } : { kind: 'session', sessionId }, feedback, id)
  }

  /** An editor change retires this input owner's transient feedback. */
  clear(): void {
    if (!this.disposed) this.owner.clearAll()
  }

  refresh(): void {
    if (this.disposed) return
    const presentation = this.presentation()
    const scopeKey = JSON.stringify([presentation.hostKey, presentation.sessionId])
    if (scopeKey !== this.scopeKey) {
      this.scopeKey = scopeKey
      this.owner.clearAll()
    }
    const running = presentation.running === true
    if (running !== this.running) {
      this.running = running
      this.group = 0
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = running ? setInterval(() => { this.group = (this.group + 1) % HINTS.length; this.refresh() }, 15_000) : undefined
      this.timer?.unref()
    }
    const facts = this.panelOpen ? undefined : this.current()
    const shape = JSON.stringify([this.panelOpen, facts])
    if (shape === this.shape) return
    this.shape = shape
    this.pane.set(this.panelOpen ? null : NotificationLine(facts))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
    this.owner.dispose()
    this.pane.dispose()
  }

  private current(): NotificationRowFacts {
    const facts = this.presentation()
    const notice = visibleNotice(this.ctx.mayflyUiInteraction.notificationSnapshot(), facts.sessionId)
    const base = { ...notice === undefined ? {} : { notice }, ...this.chip === undefined ? {} : { chip: this.chip } }
    if (this.mode !== 'prompt') {
      const keys = modeKeys(this.mode, this.row, this.t)
      return { ...base, ...keys === undefined ? {} : { keys } }
    }
    const recall = this.recall === undefined ? undefined : this.t('↑ history {index}/{total}', this.recall)
    const hint = recall ?? this.promptHint ?? (facts.toggle === undefined ? this.t(HINTS[this.running && facts.quietHints !== 'off' ? this.group : 0]!) : undefined)
    return {
      ...base, ...facts.toggle === undefined ? {} : { toggle: facts.toggle },
      ...notice === undefined ? { ...this.wait === undefined ? {} : { wait: this.wait }, ...hint === undefined ? {} : { hint } } : {},
    }
  }
}
