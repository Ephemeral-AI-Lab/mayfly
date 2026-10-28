import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { RemoteBannerComponent } from '../../src/remote/banner.ts'
import type { MayflyComponents, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

const components = {
  strong: (text: string) => text,
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
} as MayflyComponents
const colors = {
  primary: (text: string) => text,
  accent: (text: string) => text,
  muted: (text: string) => text,
  text: (text: string) => text,
  modelHighlight: (text: string) => text,
  logoGradient: Array.from({ length: 9 }, () => (text: string) => text),
} as MayflySemanticColors

function facts(model: string | undefined): RemotePresentationFacts {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    cwd: '/work/mayfly',
    title: undefined,
    model,
    provider: 'deepseek',
    contextTokens: 0,
    contextWindow: undefined,
    active: false,
    phase: 'idle',
  }
}

describe('RemoteBannerComponent', () => {
  it('renders the Mayfly welcome banner with live remote model facts', () => {
    let model: string | undefined = 'deepseek-chat'
    const banner = new RemoteBannerComponent(colors, components, () => facts(model))
    const initial = banner.render(100).join('\n')
    expect(initial).toContain('ephemeral agents, enduring works')
    expect(initial).toContain('/work/mayfly')
    expect(initial).toContain('deepseek-chat · deepseek')
    model = undefined
    expect(banner.render(100).join('\n')).toContain('default · deepseek')
    expect(() => banner.invalidate()).not.toThrow()
  })

  it('uses default provider and unknown directory fallbacks and hides below the minimum width', () => {
    const current = facts(undefined)
    const banner = new RemoteBannerComponent(colors, components, () => ({ ...current, provider: undefined, cwd: '' }))
    const rendered = banner.render(100).join('\n')
    expect(rendered).toContain('default · default')
    expect(rendered).toContain('Directory: unknown')
    expect(banner.render(20)).toEqual([])
  })
})
