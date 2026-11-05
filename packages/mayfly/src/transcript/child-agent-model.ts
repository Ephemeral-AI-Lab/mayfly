
/** One canonical activation result, as the native delegation tool returns it. */
interface ActivationResult {
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

