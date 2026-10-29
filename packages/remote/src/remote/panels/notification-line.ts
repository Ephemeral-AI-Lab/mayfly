/**
 * Current Mayfly one-row notification presentation and selection for Remote.
 * @module @ephemeral-ai/mayfly/remote/panels/notification-line
 */

import { ui, type MayflyFeedbackRecord, type MayflyTone, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Severity used by the shared notification lane. */
export type RemoteNotificationSeverity = 'success' | 'info' | 'warning' | 'error'

/** One selected notification and its waiting count. */
export interface RemoteNotificationFacts {
  readonly severity: RemoteNotificationSeverity
  readonly message: string
  readonly tail?: string
  readonly waiting?: number
}

/** Additional row content supported by the current Mayfly notification line. */
export interface RemoteNotificationRowFacts {
  readonly notice?: RemoteNotificationFacts
  readonly chip?: string
  readonly wait?: string
  readonly hint?: string
  readonly keys?: readonly { readonly text: string, readonly priority: number }[]
  readonly toggle?: string
}

const GLYPHS: Readonly<Record<Exclude<RemoteNotificationSeverity, 'info'>, readonly [string, MayflyTone]>> = {
  success: ['✓', 'success'], warning: ['⚠', 'warning'], error: ['✗', 'danger'],
}
const RANK: Readonly<Record<MayflyFeedbackRecord['severity'], number>> = { info: 0, success: 1, warning: 2, error: 3 }
const MARGIN = { basis: 3, grow: 0, shrink: 0 } as const
const INDENT = { basis: 2, grow: 0, shrink: 0 } as const
const BODY = { basis: 0, grow: 1, shrink: 1 } as const
const SIDE_LEFT = { basis: 0, grow: 5, shrink: 1 } as const
const SIDE_RIGHT = { basis: 0, grow: 8, shrink: 1 } as const
const CHIP = { basis: 'auto', grow: 0, shrink: 0 } as const
const GAP = 1

/** Select the most severe then newest app/current-Session notification. */
export function selectRemoteNotification(
  records: readonly MayflyFeedbackRecord[],
  sessionId: string | undefined,
): RemoteNotificationFacts | undefined {
  const visible = records
    .filter(record => record.scope.kind === 'app' || (record.scope.kind === 'session' && String(record.scope.sessionId) === sessionId))
    .toSorted((left, right) => RANK[left.severity] - RANK[right.severity] || left.createdAt - right.createdAt)
  const top = visible.at(-1)
  if (top === undefined) return undefined
  return {
    severity: top.severity,
    message: top.message,
    ...top.tail === undefined ? {} : { tail: top.tail },
    ...visible.length > 1 ? { waiting: visible.length - 1 } : {},
  }
}

function noticeChildren(facts: RemoteNotificationFacts, front: number, back: number): readonly MayflyUiChild[] {
  const mark = facts.severity === 'info' ? undefined : GLYPHS[facts.severity]
  const tail = facts.tail !== undefined && facts.message.length > facts.tail.length && facts.message.endsWith(facts.tail) ? facts.tail : undefined
  const head = tail === undefined ? facts.message : facts.message.slice(0, facts.message.length - tail.length).replace(/\s*·\s*$/u, '')
  const waiting = facts.waiting === undefined || facts.waiting <= 0 ? undefined : facts.waiting
  const style = mark === undefined || facts.severity === 'success' ? {} : { tone: mark[1] }
  const right = { band: 'right' } as const
  return [
    ...mark === undefined ? [] : [ui.child(ui.richText([{ text: mark[0], tone: mark[1] }]), { ...right, priority: front })],
    ui.child(ui.richText([{ text: head, ...style }], { overflow: 'truncate' }), { ...right, priority: back, overflow: 'truncate' }),
    ...tail === undefined ? [] : [ui.child(ui.richText([{ text: `· ${tail}`, ...style }]), { ...right, priority: front + 1 })],
    ...waiting === undefined ? [] : [ui.child(ui.richText([{ text: `· +${String(waiting)}`, tone: 'muted' }]), { ...right, priority: front + 2 })],
  ]
}

function toggleChild(toggle: string, followed: boolean): MayflyUiChild {
  return ui.child(ui.richText([{ text: followed ? `${toggle}  ` : toggle, tone: 'muted' }]), { band: 'right', priority: 0 })
}

function waitChild(message: string): MayflyUiChild {
  return ui.child(ui.richText([{ text: '', motion: 'loader', variant: 'gap' }, { text: ` ${message}` }], { overflow: 'truncate' }), { band: 'right', priority: 1, overflow: 'truncate' })
}

function hintChild(hint: string): MayflyUiChild {
  return ui.child(ui.richText([{ text: hint, tone: 'muted' }], { overflow: 'truncate' }), { band: 'right', priority: 1, overflow: 'truncate' })
}

function rightOf(facts: RemoteNotificationRowFacts | undefined): MayflyUiNode | undefined {
  const toggle = facts?.toggle
  if (facts?.notice !== undefined) return ui.stack.row([...toggle === undefined ? [] : [toggleChild(toggle, true)], ...noticeChildren(facts.notice, 1, 4)], { gap: GAP })
  const after = facts?.wait !== undefined ? waitChild(facts.wait) : facts?.hint !== undefined ? hintChild(facts.hint) : undefined
  if (toggle === undefined && after === undefined) return undefined
  return ui.stack.row([...toggle === undefined ? [] : [toggleChild(toggle, after !== undefined)], ...after === undefined ? [] : [after]], { gap: GAP })
}

function keysRow(keys: readonly { readonly text: string, readonly priority: number }[], notice: RemoteNotificationFacts | undefined): MayflyUiNode {
  const order = keys.map((part, index) => ({ part, index })).toSorted((left, right) => left.part.priority - right.part.priority || left.index - right.index).map(entry => entry.index)
  return ui.stack.row([
    ...keys.map((part, index) => ui.child(
      ui.richText([{ text: index === 0 ? part.text : `· ${part.text}`, tone: 'muted' }]),
      { band: 'left', priority: order.indexOf(index) * 10, overflow: 'hide' },
    )),
    ...notice === undefined ? [] : noticeChildren(notice, 25, 1000),
  ], { gap: GAP })
}

/** Build the width-safe current Mayfly notification row. */
export function RemoteNotificationLine(facts: RemoteNotificationRowFacts | undefined): MayflyUiNode {
  if (facts?.chip !== undefined) {
    return ui.stack.row([
      ui.child(ui.spacer(), MARGIN),
      ui.child(ui.spacer(), SIDE_LEFT),
      ui.child(ui.richText([{ text: ` ${facts.chip} `, styles: ['inverse'] }]), CHIP),
      ui.child(rightOf(facts) ?? ui.spacer(), SIDE_RIGHT),
      ui.child(ui.spacer(), MARGIN),
    ])
  }
  const body = facts?.keys === undefined ? rightOf(facts) : keysRow(facts.keys, facts.notice)
  if (body === undefined) return ui.spacer()
  return ui.stack.row([ui.child(ui.spacer(), INDENT), ui.child(body, BODY), ui.child(ui.spacer(), MARGIN)])
}
