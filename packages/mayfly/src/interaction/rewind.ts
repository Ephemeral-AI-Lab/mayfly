/** Safe rewind rows derived directly from a dsh Session event log.
 * @module @ephemeral-ai/mayfly/interaction/rewind
 */

import { panel, ui, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage } from '../frontend/locale.ts'

/** Validated native event shape used by the readonly rewind presentation. */
interface RewindEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

export interface RewindCandidate {
  readonly turn: number
  readonly boundarySeq: number
  readonly prompt: string
  readonly response?: string
  /** User/assistant messages the new branch would drop after this boundary. */
  readonly discarded: number
}

interface MessageLike {
  readonly content?: readonly { readonly type?: string, readonly text?: string }[]
  readonly source?: { readonly kind?: string }
}

function preview(message: MessageLike): string {
  return message.content
    ?.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim() ?? ''
}

/** Return direct-user turn boundaries in newest-first order. */
export function rewindCandidates(events: readonly RewindEvent[]): readonly RewindCandidate[] {
  const rows: RewindCandidate[] = []
  // Suffix count of conversation messages: `messagesAfter[i]` counts
  // user/assistant events at index i or later, so a boundary at index b
  // discards `messagesAfter[b + 1]` messages.
  const messagesAfter = new Array<number>(events.length + 1).fill(0)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    messagesAfter[index] = messagesAfter[index + 1]! + (type === 'user/message' || type === 'assistant/message' ? 1 : 0)
  }
  let turn = 0
  let boundarySeq = 0
  let boundaryIndex = 0
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      turn = (event.data as { readonly turn: number }).turn
      boundarySeq = event.seq
      boundaryIndex = index
    }
    if (event.type !== 'user/message') continue
    const message = event.data as unknown as MessageLike
    if (message.source?.kind !== 'user') continue
    const nextUser = events.slice(index + 1).findIndex(candidate =>
      candidate.type === 'user/message'
      && (candidate.data as unknown as MessageLike).source?.kind === 'user')
    const end = nextUser < 0 ? events.length : index + 1 + nextUser
    const response = events.slice(index + 1, end)
      .filter(candidate => candidate.type === 'assistant/message')
      .map(candidate => preview((candidate.data as { readonly message: MessageLike }).message))
      .find(text => text.length > 0)
    const previous = rows.at(-1)
    if (previous?.boundarySeq === boundarySeq) {
      rows[rows.length - 1] = {
        ...previous,
        prompt: `${previous.prompt} / ${preview(message) || '(empty prompt)'}`,
        ...(response === undefined ? {} : { response }),
      }
      continue
    }
    rows.push({
      turn,
      boundarySeq,
      prompt: preview(message) || '(empty prompt)',
      ...(response === undefined ? {} : { response }),
      discarded: messagesAfter[boundaryIndex + 1]!,
    })
  }
  return rows.reverse()
}

/** The immutable rc.2 filterable earlier-turn picker; choosing never mutates history. */
export function rewindNode(candidates: readonly RewindCandidate[], t: MayflyTranslate = interpolateLocaleMessage): MayflyUiNode {
  return panel({ title: t('Rewind current session'), escapeLabel: 'close', body: ui.stack.column([
    ui.list({ id: 'rewind-candidates', role: 'choose', selectedIds: candidates.length === 0 ? [] : [String(candidates[0]!.boundarySeq)], filterable: true, items: candidates.map(candidate => ({ id: String(candidate.boundarySeq), label: t('Turn {turn} · {prompt}', { turn: candidate.turn, prompt: candidate.prompt }), detail: `${candidate.response === undefined ? '' : `↳ ${candidate.response} · `}${t('rewinds')} ${t(candidate.discarded === 1 ? '{count} message' : '{count} messages', { count: candidate.discarded })}` })) }),
    ui.text(t('The original session stays available in /sessions.'), { tone: 'muted' }),
  ]) })
}
