/** Native adapter addressing and endpoint normalization accepted by provider configuration. @module */
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-api-remotes/client'
import { describe, expect, it } from 'vitest'
import { normalizeRemoteProviderBaseURL, remoteProviderContainer } from '../../src/app/features/provider-profile.ts'

const route = (provider: string, settingsNs: string, settingsPath: readonly string[]): LlmConfigurableProvider => ({ provider, displayName: provider, settingsNs, settingsPath })

describe('provider adapter profiles', () => {
  it('keeps Anthropic endpoints at their native root', () => {
    expect(normalizeRemoteProviderBaseURL('anthropic-messages', 'https://api.anthropic.com/v1///')).toBe('https://api.anthropic.com')
    expect(normalizeRemoteProviderBaseURL('anthropic-messages', 'https://api.anthropic.com/')).toBe('https://api.anthropic.com')
    expect(normalizeRemoteProviderBaseURL('openai-completions', 'https://api.example/', 'https://api.example/v1')).toBe('https://api.example/v1')
  })

  it('ignores a standalone adapter and prefers the most populated native route dictionary', () => {
    expect(remoteProviderContainer([route('standalone', 'standalone', [])])).toBeUndefined()
    expect(remoteProviderContainer([
      route('standalone', 'standalone', ['provider']),
      route('one', 'z', ['providers', 'one']),
      route('two', 'z', ['providers', 'two']),
      route('sparse', 'a', ['providers', 'sparse']),
    ])).toMatchObject({ ns: 'z', path: ['providers'] })
  })

  it('breaks native dictionary ties by namespace then the adapter-declared path', () => {
    expect(remoteProviderContainer([route('z', 'z', ['providers', 'z']), route('a', 'a', ['providers', 'a'])])).toMatchObject({ ns: 'a', path: ['providers'] })
    expect(remoteProviderContainer([route('z', 'a', ['z-routes', 'z']), route('a', 'a', ['a-routes', 'a'])])).toMatchObject({ ns: 'a', path: ['a-routes'] })
  })
})
