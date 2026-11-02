/** Context data comes directly from native projection snapshots. @module tests/remote/session-information */
import { describe, expect, it } from 'vitest'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { remoteSessionInformation, REMOTE_SESSION_INFO_KEYS } from '../../src/remote/session-information.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

const presentation = { model: 'fallback-model', provider: 'fallback-provider' } as RemotePresentationFacts
function read(values: Readonly<Record<string, unknown>>, facts = presentation) {
  const keys: string[] = []
  const binding = { session: { projections: { faceOf: (key: string) => { keys.push(key); return { getSnapshot: () => values[key] } } } } } as unknown as SessionBinding
  return { facts: remoteSessionInformation(binding, facts), keys }
}

describe('native context information', () => {
  it('reads only the original reference usage facts from one exact projection binding', () => {
    const result = read({
      tokenUsage: { uncachedInputTokens: 11, cacheReadTokens: 22, cacheWriteTokens: 33, outputTokens: 44 },
      contextPressure: { projectedTokens: 2500, pressureTokens: 1800, contextWindow: 128000 },
      contextBreakdown: { systemTokens: 101, toolsTokens: 202, messageTokens: 303 },
      modelSelection: { next: { model: 'next', provider: 'native', reasoningEffort: 'high' }, lastUsed: { model: 'old', provider: 'native' } },
    })
    expect(result.keys).toEqual(REMOTE_SESSION_INFO_KEYS)
    expect(result.facts).toEqual({
      model: { model: 'next', provider: 'native', reasoningEffort: 'high' },
      usage: { buckets: { input: 11, cacheRead: 22, cacheWrite: 33, output: 44 }, context: { used: 2500, window: 128000 } },
      composition: { system: 101, tools: 202, messages: 303 },
    })
    expect(result.facts).not.toHaveProperty('createdAt')
  })

  it('uses last-used model and native pressure only when next-request facts are absent', () => {
    expect(read({
      modelSelection: { lastUsed: { model: 'last', provider: 'native' } },
      contextPressure: { pressureTokens: 120 },
    }).facts).toEqual({
      model: { model: 'last', provider: 'native' },
      usage: { buckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, context: { used: 120 } },
    })
  })

  it('keeps unadvertised occupancy absent and uses only advertised Host model fallback', () => {
    expect(read({}).facts).toEqual({
      model: { model: 'fallback-model', provider: 'fallback-provider' },
      usage: { buckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, context: {} },
    })
    for (const partial of [{}, { model: 'missing-provider' }, { provider: 'missing-model' }]) {
      expect(read({ contextPressure: {} }, partial as unknown as RemotePresentationFacts).facts).toEqual({ usage: { buckets: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, context: {} } })
    }
  })
})
