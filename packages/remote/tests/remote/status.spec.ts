import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { RemoteStatusComponent } from '../../src/remote/status.ts'
import type { MayflyComponents, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

const components = {
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
} as MayflyComponents
const colors = { muted: (text: string) => text } as MayflySemanticColors

function facts(overrides: Partial<RemotePresentationFacts> = {}): RemotePresentationFacts {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    cwd: '/work/mayfly',
    title: 'Remote architecture',
    model: 'deepseek-chat',
    provider: 'deepseek',
    contextTokens: 1024,
    contextWindow: 2048,
    active: false,
    phase: 'idle',
    ...overrides,
  }
}

describe('RemoteStatusComponent', () => {
  it('renders model, cwd, title, and context instead of transient Host text', () => {
    const status = new RemoteStatusComponent(components, colors, () => facts())
    const lines = status.render(120)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('deepseek-chat')
    expect(lines[0]).toContain('/work/mayfly')
    expect(lines[0]).toContain('Remote architecture')
    expect(lines[1]).toContain('context: 50% (1k/2k)')
    expect(() => status.invalidate()).not.toThrow()
  })

  it('degrades empty facts, missing windows, and narrow widths without overflow', () => {
    let current = facts({ ref: undefined, cwd: '', title: undefined, model: undefined, contextTokens: 0, contextWindow: undefined })
    const status = new RemoteStatusComponent(components, colors, () => current)
    expect(status.render(20)).toEqual([])
    current = facts({ model: undefined, title: undefined, contextWindow: undefined })
    expect(status.render(120)[0]).toContain('default')
    expect(status.render(120)[1]).toContain('ctx 1k')
    expect(status.render(0)).toEqual(['', ''])
    for (const line of status.render(12)) expect(line.length).toBeLessThanOrEqual(12)
  })
})
