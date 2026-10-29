import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { HostKey } from '../../src/client/types.ts'
import { RemotePanelController } from '../../src/remote/panels.ts'
import { RemotePlainPanels } from '../../src/remote/interactions/plain-panels.ts'
import type { MayflyComponents, MayflyScreen, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

/** One mounted plain panel: it always renders, takes input, and invalidates. */
interface RemotePanelComponent {
  render(width: number): string[]
  handleInput(data: string): void
  invalidate(): void
}

function fixture() {
  const handle = { hide: vi.fn() }
  const screen = { showOverlay: vi.fn(() => handle) } as unknown as MayflyScreen
  const components = {
    truncateToWidth: (text: string, width: number) => text.slice(0, width),
  } as MayflyComponents
  const colors = {
    primary: (text: string) => text,
    accent: (text: string) => text,
    muted: (text: string) => text,
  } as MayflySemanticColors
  const restoreFocus = vi.fn()
  const overlays = new RemotePanelController(screen, restoreFocus)
  const panels = new RemotePlainPanels(overlays, components, colors)
  const panel = (): RemotePanelComponent => vi.mocked(screen.showOverlay).mock.calls.at(-1)![0] as unknown as RemotePanelComponent
  return { handle, screen, overlays, panels, panel, restoreFocus }
}

function facts(overrides: Partial<RemotePresentationFacts> = {}): RemotePresentationFacts {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    cwd: '/work/mayfly',
    title: 'Remote architecture',
    model: 'deepseek-chat',
    provider: 'deepseek',
    mode: undefined,
    status: undefined,
    queue: [],
    contextTokens: 1024,
    contextWindow: 2048,
    active: true,
    phase: 'thinking',
    ...overrides,
  }
}

function session(id: string, displayTitle: string): SessionSummary {
  return { id: SessionId(id), displayTitle, running: false, blank: false, updatedAt: 0, retainedBy: {} }
}

describe('RemotePlainPanels over RemotePanelController', () => {
  it('scrolls command help, closes with focus restoration, and disposes replacements', () => {
    const { handle, overlays, panels, panel, restoreFocus } = fixture()
    panels.showHelp(Array.from({ length: 20 }, (_, index) => ({ name: `command-${String(index)}`, description: 'test' })))
    expect(panel().render(100).join('\n')).toContain('1-14/20')
    panel().handleInput('\x1b[B')
    expect(panel().render(100).join('\n')).toContain('2-15/20')
    panel().handleInput('\x1b[A')
    expect(panel().render(100).join('\n')).toContain('1-14/20')
    panel().invalidate()
    panel().handleInput('\x1b')
    expect(handle.hide).toHaveBeenCalledOnce()
    expect(restoreFocus).toHaveBeenCalledOnce()

    const stale = panel()
    panels.showVersion()
    stale.handleInput('Q')
    expect(restoreFocus).toHaveBeenCalledOnce()
    expect(panel().render(80).join('\n')).toContain('Mayfly v')
    panels.showHelp([{ name: 'compact', description: 'Compact history' }])
    expect(handle.hide).toHaveBeenCalledTimes(2)
    overlays.dispose()
    expect(handle.hide).toHaveBeenCalledTimes(3)
    expect(restoreFocus).toHaveBeenCalledOnce()
  })

  it('renders all remote status fact variants', () => {
    const { panels, panel } = fixture()
    panels.showStatus(facts())
    expect(panel().render(120).join('\n')).toContain('50% (1k/2k)')
    expect(panel().render(120).join('\n')).toContain('State: thinking')
    panels.showStatus(facts({ contextWindow: undefined, title: undefined }))
    expect(panel().render(120).join('\n')).toContain('Context: 1k tokens')
    panels.showStatus(facts({ contextTokens: 0 }))
    expect(panel().render(120).join('\n')).toContain('Context: no usage yet')
    panels.showStatus(facts({ ref: undefined, cwd: '', model: undefined, provider: undefined, active: false }))
    const fallback = panel().render(120).join('\n')
    expect(fallback).toContain('Host: none')
    expect(fallback).toContain('Session: none')
    expect(fallback).toContain('Directory: unknown')
    expect(fallback).toContain('Model: default · default')
    expect(fallback).toContain('State: idle')
    panels.showHelp([])
    expect(panel().render(80).join('\n')).toContain('Esc close')
    panel().handleInput('\r')
    panel().handleInput('q')
  })

  it('selects Sessions with keyboard navigation and handles an empty catalog', () => {
    const { handle, panels, panel, restoreFocus } = fixture()
    const select = vi.fn()
    const current = { host: HostKey('local'), sessionId: SessionId('second') }
    panels.showSessions([session('first', 'First'), session('second', 'Second')], current, select)
    expect(panel().render(100).join('\n')).toContain('> Second')
    panel().handleInput('\x1b[A')
    expect(panel().render(100).join('\n')).toContain('> First')
    panel().handleInput('\x1b[B')
    panel().handleInput('\r')
    expect(select).toHaveBeenCalledWith('second')
    expect(handle.hide).toHaveBeenCalledOnce()
    expect(restoreFocus).toHaveBeenCalledOnce()

    panels.showSessions([], undefined, select)
    expect(panel().render(80).join('\n')).toContain('No Sessions on this Host')
    panel().handleInput('\x1b[B')
    panel().handleInput('\r')
    expect(select).toHaveBeenCalledOnce()
    panel().handleInput('\x03')
    expect(restoreFocus).toHaveBeenCalledTimes(2)
  })

  it('scrolls long selectable lists in both directions and accepts newline', () => {
    const { panels, panel } = fixture()
    const select = vi.fn()
    const sessions = Array.from({ length: 20 }, (_, index) => session(`session-${String(index)}`, `Session ${String(index)}`))
    panels.showSessions(sessions, undefined, select)
    for (let index = 0; index < 16; index += 1) panel().handleInput('\x1b[B')
    expect(panel().render(100).join('\n')).toContain('> Session 16')
    expect(panel().render(100).join('\n')).toContain('4-17/20')
    for (let index = 0; index < 3; index += 1) panel().handleInput('\x1b[B')
    expect(panel().render(100)).toHaveLength(16)
    expect(panel().render(100).join('\n')).toContain('7-20/20')
    for (let index = 0; index < 19; index += 1) panel().handleInput('\x1b[A')
    expect(panel().render(100).join('\n')).toContain('> Session 0')
    expect(panel().render(100).join('\n')).toContain('1-14/20')
    panel().handleInput('\n')
    expect(select).toHaveBeenCalledWith('session-0')
  })
})
