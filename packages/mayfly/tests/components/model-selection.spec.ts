import { describe, expect, it } from 'vitest'
import { modelSwitchNotice, sameModelSelection } from '../../src/components/model-selection.ts'

const first = { provider: 'deepseek', model: 'flash' }

describe('confirmed model selection feedback', () => {
  it.each([
    [{ provider: 'deepseek', model: 'pro' }, undefined, 'Switched to pro (deepseek)'],
    [{ provider: 'deepseek', model: 'pro' }, 'high', 'Switched to pro (deepseek) · thinking high'],
    [{ provider: 'other', model: 'flash', reasoningEffort: 'low' }, 'high', 'Switched to flash (other) · thinking low'],
    [{ ...first, reasoningEffort: 'high' }, undefined, 'Thinking set to high'],
    [first, 'high', 'Already using flash (deepseek)'],
  ] as const)('describes the confirmed change to %j', (next, inherited, message) => {
    expect(modelSwitchNotice(first, next, inherited)).toBe(message)
  })

  it.each([
    [undefined, 'Thinking set to provider default'], ['high', 'Thinking set to provider default (high)'],
  ])('describes removing a pinned effort with default %s', (inherited, message) => {
    expect(modelSwitchNotice({ ...first, reasoningEffort: 'low' }, first, inherited)).toBe(message)
  })

  it('treats provider, model and explicit effort as independent route fields', () => {
    expect(sameModelSelection(first, { ...first })).toBe(true)
    expect(sameModelSelection(first, { ...first, provider: 'other' })).toBe(false)
    expect(sameModelSelection(first, { ...first, model: 'pro' })).toBe(false)
    expect(sameModelSelection(first, { ...first, reasoningEffort: 'high' })).toBe(false)
  })
})
