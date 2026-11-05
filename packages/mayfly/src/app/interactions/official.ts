/**
 * Client-safe official approval/question DTOs and the narrow userQuestions Remote adapter.
 * @module @ephemeral-ai/mayfly/remote/interactions/official
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostClient } from '../../client/types.ts'

/** Official approval request without its transport-resolved Agent Context. */
export interface ApprovalRequest {
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly displayReason?: { readonly en: string, readonly [locale: string]: string }
  readonly signal?: AbortSignal
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ApprovalListener = (
  this: Context,
  request: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

interface QuestionOption {
  readonly label: string
  readonly description?: string
}

type QuestionIntent = {
  readonly kind: 'plan-review'
  readonly approve: string
  readonly callId?: ToolCallId
} | {
  readonly kind: 'approval'
  readonly approve: string
  readonly reject: string
  readonly always?: string
}

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: QuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: QuestionIntent
}

export interface QuestionRequest {
  readonly questions: QuestionItem[]
  readonly signal?: AbortSignal
  readonly wait?: {
    readonly callId: ToolCallId
    readonly timed?: boolean
  }
}

export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

export interface QuestionAnswer {
  readonly answers: QuestionAnswerItem[]
}

export type QuestionCallId = ToolCallId

/** Official userQuestions projection subset consumed by continued-question cards. */
export interface RemotePendingQuestion {
  readonly callId: QuestionCallId
  readonly questions: QuestionItem[]
  readonly state: 'open' | 'continued'
}

export interface RemoteQuestionProjection {
  readonly active: readonly RemotePendingQuestion[]
}

export interface OfficialQuestionWait extends AsyncIterable<{ readonly remainingMs: number }> {
  dispose(): void
}

/** Exact official userQuestions methods used by Remote; no generic Remote invocation surface. */
interface OfficialUserQuestionsRemote {
  attachWait(sessionId: SessionId, callId: QuestionCallId, signal: AbortSignal): OfficialQuestionWait
  answer(sessionId: SessionId, callId: QuestionCallId, answer: QuestionAnswer): Promise<
    | { readonly ok: true, readonly value: boolean }
    | { readonly ok: false, readonly error: { readonly message: string } }
  >
}

/** Read the official namespace omitted by the nested lock's ClientRemote declarations. */
export function officialUserQuestions(client: HostClient): OfficialUserQuestionsRemote {
  return (client.remote as HostClient['remote'] & { readonly userQuestions: OfficialUserQuestionsRemote }).userQuestions
}

/** Subscribe to the official approval waterfall key missing from the nested handoff declarations. */
export function onApprovalRequest(client: HostClient, listener: ApprovalListener): () => void {
  const remote = client.remote as HostClient['remote'] & {
    $on(event: 'approval/request', listener: ApprovalListener): () => void
  }
  return remote.$on('approval/request', listener)
}
