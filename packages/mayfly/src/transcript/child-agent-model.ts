/**
 * Projection-backed child-agent presentation helpers. Child session event
 * reduction belongs to `mayflyConversationFacts`; this module only correlates
 * readonly child snapshots with parent transcript tool entries. A spawn call
 * names its child through the native activation result
 * `{ kind: 'activation', subagentId }`; rendered tool prose is never parsed.
 *
 * @module @ephemeral-ai/mayfly/transcript/child-agent-model
 */

import type { TranscriptToolItem } from './types.ts'

/** One canonical activation result, as the native delegation tool returns it. */
export interface ActivationResult {
  readonly kind: 'activation'
  readonly subagentId: string
}

/**
 * Parse the canonical activation result from a tool result's text. Anything
 * that is not that JSON object — including the model-facing delegation prose
 * a native renderer emits — yields `undefined`; the caller then correlates
 * through the native catalog, never the prose.
 * @param text - the durable tool result text.
 * @returns the activation value, when the text is its canonical JSON.
 */
export function parseActivationResult(text: string | undefined): ActivationResult | undefined {
  if (text === undefined || text === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as { readonly kind?: unknown, readonly subagentId?: unknown }
  return row.kind === 'activation' && typeof row.subagentId === 'string' && row.subagentId !== ''
    ? { kind: 'activation', subagentId: row.subagentId }
    : undefined
}

/**
 * The child session id a spawn result names, through the canonical activation
 * JSON only.
 * @param item - the parent transcript tool item.
 * @returns the child id, or undefined when the result is not activation JSON.
 */
export function childIdOfResult(item: TranscriptToolItem): string | undefined {
  if (item.result === undefined) return undefined
  return parseActivationResult(item.result.text)?.subagentId
}
