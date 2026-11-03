import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { RemoteBannerComponent } from '../../src/remote/banner.ts'
import type { MayflyComponents, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'
import { composeBannerLines } from '@ephemeral-ai/mayfly/banner'
import { MAYFLY_VERSION, type SplashContent } from '@ephemeral-ai/mayfly/banner-content'
import { plain, plainColors, fakeMayflyComponents } from './render-fixture.ts'
import type { RemotePresentationFacts } from '../../src/transcript/remote-model.ts'

const components = fakeMayflyComponents()
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
  it('keeps the sessionless greeting route across default picks and renderer invalidation, then follows native Session routes', () => {
    let current: RemotePresentationFacts = { ...facts('flash'), ref: undefined }
    const banner = new RemoteBannerComponent(colors, components, () => current)
    expect(banner.render(100).join('\n')).toContain('flash · deepseek')
    current = { ...current, model: 'pro' }
    banner.invalidate()
    expect(banner.render(100).join('\n')).toContain('flash · deepseek')
    current = facts('pro')
    expect(banner.render(100).join('\n')).toContain('pro · deepseek')
    current = { ...current, model: 'flash' }
    expect(banner.render(100).join('\n')).toContain('flash · deepseek')
    current = { ...facts('pro'), ref: undefined }
    expect(banner.render(100).join('\n')).toContain('pro · deepseek')
  })

  it('waits for the first catalog route and resets the greeting for another physical Host or exact Session identity', () => {
    let identity: unknown = { host: 'one' }
    let current: RemotePresentationFacts = { ...facts(undefined), ref: undefined, provider: undefined }
    const banner = new RemoteBannerComponent(colors, components, () => current, { identity: () => identity })
    expect(banner.render(100).join('\n')).toContain('default · default')
    current = { ...current, provider: 'deepseek' }
    expect(banner.render(100).join('\n')).toContain('default · deepseek')
    current = { ...current, model: 'flash' }
    expect(banner.render(100).join('\n')).toContain('flash · deepseek')
    current = { ...current, model: 'pro' }
    expect(banner.render(100).join('\n')).toContain('flash · deepseek')
    identity = { host: 'two' }
    expect(banner.render(100).join('\n')).toContain('pro · deepseek')
    current = facts('flash')
    expect(banner.render(100).join('\n')).toContain('flash · deepseek')
    current = { ...facts('pro'), ref: { host: HostKey('other'), sessionId: SessionId('session-1') } }
    expect(banner.render(100).join('\n')).toContain('pro · deepseek')
    current = { ...current, ref: { host: HostKey('other'), sessionId: SessionId('session-2') } }
    expect(banner.render(100).join('\n')).toContain('pro · deepseek')
  })

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

  it('matches the reference blank rows, gutter, Host home shortening, and fixed animation frames', () => {
    let at: number | undefined = 0
    const palette = plainColors()
    const current = { ...facts('deepseek-chat'), cwd: '/home/host/work/mayfly' }
    const banner = new RemoteBannerComponent(palette, components, () => current, { home: () => '/home/host', flyInAt: () => at })
    for (const elapsed of [0, 33, 330, 850, 1549, undefined]) {
      at = elapsed
      const composed = composeBannerLines({
        colors: palette, strong: text => components.strong(text),
        truncate: (text, width) => components.truncateToWidth(text, width, '…'),
        visibleWidth: text => components.visibleWidth(text),
      }, { version: MAYFLY_VERSION, provider: 'deepseek', model: 'deepseek-chat', cwd: '~/work/mayfly' }, 98, elapsed)
      expect(banner.render(100)).toEqual(['', ...composed, ''].map(row => ` ${row}`))
    }
    expect(plain(banner.render(100)).at(0)).toBe(' ')
    expect(plain(banner.render(100)).at(-1)).toBe(' ')
    expect(plain(banner.render(100)).join('\n')).toContain('~/work/mayfly')
  })

  it('refreshes theme and presentation sources, uses startup directory, and bounds CJK at narrow widths', () => {
    let currentComponents: MayflyComponents = { ...components, presentation: { glyphs: 'unicode', monochrome: false, reducedMotion: false } }
    let currentColors = plainColors()
    const banner = new RemoteBannerComponent(colors, components, () => ({ ...facts('模型'), cwd: '' }), {
      directory: () => '/主机/项目/五月飞', home: () => '/主机', flyInAt: () => 0,
      components: () => currentComponents, colors: () => currentColors,
    })
    expect(plain(banner.render(100)).join('\n')).not.toContain('enduring works')
    currentComponents = { ...components, presentation: { glyphs: 'ascii', monochrome: true, reducedMotion: true } }
    currentColors = { ...plainColors(), accent: text => `\x1b[31m${text}\x1b[39m` }
    expect(plain(banner.render(100)).join('\n')).toContain('enduring works')
    expect(plain(banner.render(100)).join('\n')).toContain('~/项目/五月飞')
    expect(banner.render(100).join('\n')).toContain('\x1b[31m')
    for (const width of [1, 2, 3, 4, 8, 12, 20, 40, 80, 120]) {
      for (const row of banner.render(width)) expect(components.visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width)
    }
    expect(banner.render(-1)).toEqual([])
  })

  it('reserves no pending splash rows and paints the shared recent-session launch screen at narrow and wide sizes', () => {
    let splash: SplashContent | 'pending' = 'pending'
    let rows = 24
    const banner = new RemoteBannerComponent(plainColors(), components, () => facts(undefined), {
      splash: () => splash,
      rows: () => rows,
    })
    expect(banner.render(80)).toEqual([])
    splash = {
      version: MAYFLY_VERSION,
      labels: { slogan: 'ephemeral agents, enduring works', recent: 'Recent sessions', more: '↑ browse · /sessions for all', moreFocused: '↵ resume · esc back', empty: 'No sessions here yet', emptyHint: 'Describe a task below to start one.' },
      recent: [{ id: 'one', title: '最近的会话很长 👩‍💻', project: '项目', age: 'now', live: true }],
      focus: 0,
    }
    for (const width of [1, 8, 20, 40, 80, 120]) {
      for (const row of banner.render(width)) expect(components.visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width)
    }
    expect(plain(banner.render(100)).join('\n')).toContain('Recent sessions')
    expect(plain(banner.render(100)).join('\n')).toContain('最近的会话很长')
    rows = 12
    expect(plain(banner.render(100)).join('\n')).toContain('↵ resume')
    const noViewport = new RemoteBannerComponent(plainColors(), components, () => facts(undefined), { splash: () => splash })
    expect(noViewport.render(80).length).toBeGreaterThan(0)
  })
})
