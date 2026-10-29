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
const identity = (text: string): string => text
const colors = {
  primary: identity,
  accent: identity,
  border: identity,
  muted: identity,
  textMuted: identity,
  text: identity,
  success: identity,
  warning: identity,
  error: identity,
  modelHighlight: identity,
  logoInks: Array.from({ length: 5 }, () => identity) as readonly ((text: string) => string)[],
} as MayflySemanticColors

function facts(model: string | undefined): RemotePresentationFacts {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    cwd: '/work/mayfly',
    title: undefined,
    model,
    provider: 'deepseek',
    mode: undefined,
    status: undefined,
    queue: [],
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

  it('uses default provider and unknown directory fallbacks and hides at zero width', () => {
    const current = facts(undefined)
    const banner = new RemoteBannerComponent(colors, components, () => ({ ...current, provider: undefined, cwd: '' }))
    const rendered = banner.render(100).join('\n')
    expect(rendered).toContain('default · default')
    expect(rendered).toContain('unknown')
    expect(banner.render(0)).toEqual([])
  })
})
