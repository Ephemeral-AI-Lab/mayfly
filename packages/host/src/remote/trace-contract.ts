/** Client-safe readonly observations for the native Session trace browser. @module */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Detached immutable JSON in a native raw event. */
export type MayflyTraceJson = null | boolean | number | string | readonly MayflyTraceJson[] | { readonly [key: string]: MayflyTraceJson }

/** One canonical grouped trace timeline item. */
export interface MayflyTraceItem {
  readonly seq: number
  readonly lastSeq: number
  readonly eventSeqs: readonly number[]
  readonly time: number
  readonly type: string
  readonly surface: 'current' | 'shadowed' | 'log-only'
  readonly title: string
  readonly summary: string
}

/** Passive Session query address; it never activates an Agent. */
export interface MayflyTraceCatalogRequest {
  readonly sessionId: SessionId
}

/** Exact immutable raw-event identities captured by a selected catalog item. */
export interface MayflyTraceDetailRequest extends MayflyTraceCatalogRequest {
  readonly seq: number
  readonly eventSeqs: readonly number[]
}

/** Native event JSON shown verbatim in the reference trace detail. */
export interface MayflyTraceRawEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: MayflyTraceJson
}

/** Direct native replacement and cited-source relationships. */
export interface MayflyTraceRelation {
  readonly replacedBy?: number
  readonly replacementChain: readonly number[]
  readonly replacedEventSeqs: readonly number[]
  readonly sourceEventSeqs: readonly number[]
  readonly derivedEventSeqs: readonly number[]
}

/** Full selected raw events and the native relationship observation used for copy. */
export interface MayflyTraceDetail {
  readonly rawEvents: readonly MayflyTraceRawEvent[]
  readonly relation: MayflyTraceRelation
}
