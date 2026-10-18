/** The canonical child activation result contract. */

import { describe, expect, it } from 'vitest'
import { parseActivationResult } from '../../src/transcript/child-agent-model.ts'

const childId = '9f5c4086a0674b55b621c3eaf8b88c0e'
const activation = JSON.stringify({ kind: 'activation', subagentId: childId })

describe('activation result', () => {
  it('reads the canonical activation result JSON only, never model-facing prose', () => {
    expect(parseActivationResult(activation)).toEqual({ kind: 'activation', subagentId: childId })
    // Model-facing stream prose is presentation, never correlation.
    expect(parseActivationResult(`started subagent ${childId}`)).toBeUndefined()
    expect(parseActivationResult('{"kind":"job","subagentId":"x"}')).toBeUndefined()
    expect(parseActivationResult('not json')).toBeUndefined()
    expect(parseActivationResult(undefined)).toBeUndefined()
    expect(parseActivationResult('')).toBeUndefined()
  })

  it('rejects JSON values that are not objects', () => {
    for (const text of ['42', 'null', 'true', '"activation"', '[]']) expect(parseActivationResult(text)).toBeUndefined()
  })
})
