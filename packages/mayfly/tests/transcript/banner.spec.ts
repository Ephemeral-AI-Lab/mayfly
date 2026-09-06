/**
 * The banner's pure core — home shortening, layout boundaries, composition
 * goldens at full/compact/hidden widths, truncation edges — plus the
 * component delegation and the plugin's mount lifecycle, and the
 * version-constant guard against `package.json`.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  MayflyComponent,
  MayflyOverlayHandle,
  MayflyScreen,
  MayflySemanticColors,
} from '../../src/core/index.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  BANNER_MIN_WIDTH,
  bannerLayout,
  composeBannerLines,
  inject,
  name,
  shortenHome,
  type BannerContent,
  type BannerDeps,
} from '../../src/transcript/banner.ts'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { mountFakeScreenSlot } from '../core/fake-screen-slot.ts'
import * as banner from '../../src/transcript/banner.ts'
import { LOGO_COLS, LOGO_GRADIENT } from '../../src/transcript/banner-art.ts'
import { visibleWidth, truncateToWidth } from '../../src/core/width.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'
import { BANNER_LOCALE } from '../../src/transcript/locale.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'

/** Wrap a Mayfly mark row in its brand color gradient ANSI, as the banner paints it. */
function wrapLogo(row: string, index: number): string {
  const hex = LOGO_GRADIENT[index]!
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `\x1b[38;2;${r};${g};${b}m${row}\x1b[39m`
}

/** The Mayfly mark's uniform column width from banner-art. */
const LOGO_WIDTH_COLS = LOGO_COLS


/** Identity deps: structure assertions see text, not escape codes. */
const components = fakeMayflyComponents()
const DEPS: BannerDeps = {
  colors: {
    ...COLORS,
    modelHighlight: text => `\x1b[38;2;140;168;255m${text}\x1b[39m`,
    logoGradient: LOGO_GRADIENT.map((_hex, index) => text => wrapLogo(text, index)),
  } as MayflySemanticColors,
  strong: text => components.strong(text),
  truncate: (text, width) => components.truncateToWidth(text, width),
  visibleWidth: text => components.visibleWidth(text),
}

/** Deterministic facts; cwd and version drive the width edges below. */
const CONTENT: BannerContent = {
  version: '9.9.9-test',
  model: 'm',
  provider: 'p',
  cwd: '~/dev',
}

/** The Mayfly mark, mirrored from `banner-art.ts`'s literal. */
const LOGO = [
  '⠱⣦⣄⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⠎',
  '⠀⠙⢿⣿⣿⣷⣶⣤⣀⣀⣴⣶⣦⣀⣀⣤⣶⣾⣿⣿⡿⠋⠀',
  '⠀⠀⠀⠈⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠁⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠉⠉⠁⢸⣿⡇⠈⠉⠉⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⠊⠀⠑⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀',
]

describe('shortenHome', () => {
  it('collapses the exact home to ~', () => {
    expect(shortenHome('/home/x', '/home/x')).toBe('~')
  })

  it('collapses a child path to ~/rest', () => {
    expect(shortenHome('/home/x/dev/mayfly', '/home/x')).toBe('~/dev/mayfly')
  })

  it('keeps paths outside home and home-prefix lookalikes', () => {
    expect(shortenHome('/home/other', '/home/x')).toBe('/home/other')
    expect(shortenHome('/home/x-dev', '/home/x')).toBe('/home/x-dev')
  })

  it('keeps the path for an empty home', () => {
    expect(shortenHome('/a', '')).toBe('/a')
  })
})

describe('bannerLayout', () => {
  it('renders nothing below the minimum width', () => {
    expect(bannerLayout(BANNER_MIN_WIDTH - 1)).toBeNull()
  })

  it('leaves a four-column value cell at the minimum width', () => {
    // The logo block (23) plus the gap (2) plus the widest label (11) leave
    // the rest of the viewport to the status value.
    expect(bannerLayout(BANNER_MIN_WIDTH)).toEqual({
      total: BANNER_MIN_WIDTH,
      valueWidth: 4,
    })
  })

  it('never caps: the banner fills very wide terminals', () => {
    // 200 − 23 (logo) − 2 (gap) − 11 (label) = 164 columns of value.
    expect(bannerLayout(200)).toEqual({ total: 200, valueWidth: 164 })
  })
})

describe('composeBannerLines', () => {
  it('renders nothing below the minimum width', () => {
    expect(composeBannerLines(DEPS, CONTENT, BANNER_MIN_WIDTH - 1)).toEqual([])
  })

  it('composes the frameless Mayfly-mark banner at one hundred columns', () => {
    const lines = composeBannerLines(DEPS, CONTENT, 100)
    // Eight mark rows; the status column leads with the bold brand word and
    // the tagline (rows 1-2), then the help line tucked against the three
    // info rows at the bottom (rows 4-7).
    expect(lines).toHaveLength(8)
    expect(lines[0]!.startsWith(`${wrapLogo(LOGO[0]!.padEnd(LOGO_COLS), 0)}  `)).toBe(true)
    expect(lines[1]).toContain('\x1b[1mmayfly')
    expect(lines[2]).toContain('ephemeral agents, enduring works')
    expect(lines[4]).toContain('Send /help for help information.')
    expect(lines[5]).toContain('Directory: ~/dev')
    expect(lines[6]).toContain('Model:     m · p')
    expect(lines[7]).toContain('Version:   9.9.9-test')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100)
  })

  it('composes the same frameless block at eighty columns', () => {
    const lines = composeBannerLines(DEPS, CONTENT, 80)
    expect(lines).toHaveLength(8)
    expect(lines.join('\n')).toContain('mayfly')
    expect(lines.join('\n')).toContain('ephemeral agents, enduring works')
    expect(lines.join('\n')).toContain('Send /help for help information.')
    expect(lines.join('\n')).toContain('Directory: ~/dev')
  })

  it('localizes banner chrome without translating the brand or runtime facts', () => {
    const messages = BANNER_LOCALE.zh
    const lines = composeBannerLines({ ...DEPS, t: key => messages[key] ?? key }, CONTENT, 100)
    const text = lines.join('\n')
    expect(text).toContain('mayfly')
    expect(text).toContain('ephemeral agents, enduring works')
    expect(text).toContain('输入 /help 查看帮助信息。')
    expect(text).toContain('目录：     ~/dev')
    expect(text).toContain('模型：     m · p')
    expect(text).toContain('版本：     9.9.9-test')
  })

  it('falls back to the accent role when a theme has no model highlight', () => {
    const accent = vi.fn((text: string) => `<accent>${text}</accent>`)
    const colors = { ...DEPS.colors, accent } as MayflySemanticColors & { modelHighlight?: (text: string) => string }
    delete colors.modelHighlight
    const lines = composeBannerLines({ ...DEPS, colors }, CONTENT, 100)
    expect(lines.join('\n')).toContain('<accent>Model:     m · p')
    expect(accent).toHaveBeenCalled()
  })

  it('composes the same frameless block on narrow terminals', () => {
    const lines = composeBannerLines(DEPS, CONTENT, 48)
    expect(lines).toHaveLength(8)
    expect(lines.join('\n')).toContain('mayfly')
    expect(lines.join('\n')).toContain('Model')
  })

  it('leaves the logo rows at their natural width on wide terminals', () => {
    const lines = composeBannerLines(DEPS, CONTENT, 200)
    // The logo rows are frameless: they never stretch to the viewport width.
    // Row 3 carries no status cell, so it is exactly logo plus gap.
    expect(visibleWidth(lines[3]!)).toBe(LOGO_WIDTH_COLS + 2)
  })

  it('truncates the /help line once the value budget runs out', () => {
    const lines = composeBannerLines(DEPS, CONTENT, 40)
    // valueWidth 4 collapses every status line to one character plus the
    // reset-wrapped ellipsis.
    expect(lines.join('\n')).toContain('\x1b[0m...\x1b[0m')
    expect(lines.join('\n')).not.toContain('information.')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  it('truncates an over-long cwd to the value budget', () => {
    const lines = composeBannerLines(DEPS, { ...CONTENT, cwd: 'd'.repeat(200) }, 100)
    // valueWidth 64 at width 100, minus the 11-column label, gives 53 value
    // columns plus the pi-tui ellipsis reset.
    expect(lines.join('\n')).toContain(`Directory: ${'d'.repeat(50)}\x1b[0m...\x1b[0m`)
    expect(lines.join('\n')).not.toContain('d'.repeat(61))
  })

  it('truncates an over-long model line to the value budget', () => {
    const lines = composeBannerLines(DEPS, { ...CONTENT, model: 'm'.repeat(100) }, 100)
    expect(lines.join('\n')).toContain(`Model:     ${'m'.repeat(50)}\x1b[0m...\x1b[0m`)
    expect(lines.join('\n')).not.toContain('m'.repeat(61))
  })

  it('truncates an over-long version value to the value budget', () => {
    const lines = composeBannerLines(DEPS, { ...CONTENT, version: 'v'.repeat(100) }, 100)
    expect(lines.join('\n')).toContain(`Version:   ${'v'.repeat(50)}\x1b[0m...\x1b[0m`)
    expect(lines.join('\n')).not.toContain('v'.repeat(61))
  })
})

/** Records scroll mounts and render requests; the other mounts throw. */
class BannerFakeScreen implements MayflyScreen {
  readonly children: MayflyComponent[] = []
  readonly renderRequests: (boolean | undefined)[] = []
  readonly columns = 80
  readonly rows = 24

  mountContentSlot(id: string, component: MayflyComponent | null) {
    return mountFakeScreenSlot(id, component, shell => this.addChild(shell), target => this.setFocus(target), () => this.requestRender())
  }

  mountDockSlot(): never { throw new Error('fake mountDockSlot is out of scope for banner plugin tests') }

  addChild(component: MayflyComponent): () => void {
    this.children.push(component)
    let done = false
    return () => {
      if (done) return
      done = true
      const index = this.children.indexOf(component)
      if (index !== -1) this.children.splice(index, 1)
    }
  }

  addBottomChild(): () => void {
    throw new Error('fake addBottomChild is out of scope for banner plugin tests')
  }

  removeChild(): void {}

  setFocus(): void {}

  showOverlay(): MayflyOverlayHandle {
    throw new Error('fake showOverlay is out of scope for banner plugin tests')
  }

  requestRender(force?: boolean): void {
    this.renderRequests.push(force)
  }

  /** S31 seam: pass-through; the banner suite never suspends the screen. */
  suspend<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  setTitle(): void {}
}

/** Native current-Agent/projection pair used by the banner plugin fixture. */
function bannerState(initial: Agent | null = null) {
  let current = initial
  const agentListeners = new Set<(agent: Agent | null, revision: number) => void>()
  const projectionListeners = new Set<(session: Session, key: string, value: unknown, seq: number) => void>()
  const selections = new Map<Session, unknown>()
  return {
    currentAgent: {
      current: () => current,
      revision: () => 0,
      subscribe(listener: (agent: Agent | null, revision: number) => void) {
        agentListeners.add(listener)
        listener(current, 0)
        return () => { agentListeners.delete(listener) }
      },
    },
    projections: {
      snapshot(session: Session) {
        return { asOfSeq: 0, values: { modelSelection: selections.get(session) } }
      },
      onChanged(listener: (session: Session, key: string, value: unknown, seq: number) => void) {
        projectionListeners.add(listener)
        return () => { projectionListeners.delete(listener) }
      },
    },
    select(agent: Agent | null) {
      current = agent
      for (const listener of agentListeners) listener(agent, 1)
    },
    setSelection(agent: Agent, value: unknown) {
      selections.set(agent.session, value)
      for (const listener of projectionListeners) listener(agent.session, 'modelSelection', value, 1)
    },
  }
}

function bannerAgent(model: string, provider: string): Agent {
  const session = {
    id: `session-${model}`,
    requestHeader: () => ({ config: { model, provider } }),
  } as unknown as Session
  return { id: session.id, session } as unknown as Agent
}

/** Boot the banner plugin on a fresh root context with faked services. */
async function bootBanner(config: banner.Config = {}, localeId?: 'en' | 'zh'): Promise<{
  screen: BannerFakeScreen
  locale: MayflyLocaleService | undefined
  dispose(): Promise<void>
}> {
  const ctx = new Context()
  const locale = localeId === undefined
    ? undefined
    : new MayflyLocaleService(ctx, { systemLocale: localeId })
  const screen = new BannerFakeScreen()
  const state = bannerState()
  ctx.reflect.provide('mayflyScreen', screen)
  ctx.reflect.provide('mayflyTheme', { colors: COLORS })
  ctx.reflect.provide('mayflyComponents', fakeMayflyComponents())
  ctx.reflect.provide('mayflyCurrentAgent', state.currentAgent)
  ctx.reflect.provide('sessionProjections', state.projections)
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  const fiber = await ctx.plugin(banner, config)
  return { screen, locale, dispose: () => fiber.dispose() }
}

describe('mayfly-banner plugin', () => {
  it('declares its name and injects', () => {
    expect(name).toBe('mayfly-banner')
    expect(inject).toEqual(['mayflyScreen', 'mayflyTheme', 'mayflyComponents', 'mayflyCurrentAgent', 'sessionProjections', 'agentDefaultModel'])
  })

  it('mounts one scroll child with the snapshotted facts and requests a render', async () => {
    const { screen } = await bootBanner()
    expect(screen.children).toHaveLength(1)
    expect(screen.renderRequests.length).toBeGreaterThan(0)
    const joined = screen.children[0]?.render(100).join('\n') ?? ''
    expect(joined).toContain('ephemeral agents, enduring works')
    expect(joined).toContain(`Version:   ${MAYFLY_VERSION}`)
    expect(joined).toContain('m · p')
    // The mounted child is a GutterComponent (one column each side), so the
    // banner composes at width−2 and its info rows clip label+value TOGETHER
    // to the value-column budget (bannerLayout(98) = 98 − 23 logo block − 2
    // gap − 11 label = 62 columns); the pi-tui truncation appends a
    // reset-wrapped ellipsis inside it. Deriving the expectation from the
    // same primitives keeps the assertion honest for a deep checkout too
    // (this spec also runs in worktree copies): a cwd that fits renders
    // whole, a deeper one as its exact clipped row text.
    const budget = banner.bannerLayout(98)!.valueWidth
    const row = `${banner.DIRECTORY_LABEL}${shortenHome(process.cwd(), homedir())}`
    expect(joined).toContain(truncateToWidth(row, budget))
    // The banner is stateless; invalidation is a covered no-op.
    expect(() => screen.children[0]?.invalidate()).not.toThrow()
  })

  it('shows a profile-local identity without changing the release version', async () => {
    const displayVersion = `${MAYFLY_VERSION}+frontend-runtime.test`
    const { screen } = await bootBanner({ displayVersion })
    const joined = screen.children[0]?.render(100).join('\n') ?? ''
    expect(joined).toContain(`Version:   ${displayVersion}`)
    expect(MAYFLY_VERSION).toBe('0.1.0-alpha.3')
  })

  it('switches the mounted banner language without replacing its component', async () => {
    const { screen, locale } = await bootBanner({}, 'en')
    const mounted = screen.children[0]
    expect(mounted?.render(100).join('\n')).toContain('Send /help for help information.')
    const baseline = screen.renderRequests.length
    locale!.setPreference('zh')
    expect(screen.children[0]).toBe(mounted)
    const switched = mounted?.render(100).join('\n') ?? ''
    expect(switched).toContain('输入 /help 查看帮助信息。')
    // Brand identity stays English in every locale.
    expect(switched).toContain('ephemeral agents, enduring works')
    expect(screen.renderRequests.length).toBeGreaterThan(baseline)
  })

  it('re-derives the model line on session and model changes', async () => {
    const ctx = new Context()
    const screen = new BannerFakeScreen()
    ctx.reflect.provide('mayflyScreen', screen)
    ctx.reflect.provide('mayflyTheme', { colors: COLORS })
    ctx.reflect.provide('mayflyComponents', fakeMayflyComponents())
    ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
    const state = bannerState()
    ctx.reflect.provide('mayflyCurrentAgent', state.currentAgent)
    ctx.reflect.provide('sessionProjections', state.projections)
    await ctx.plugin(banner)
    expect(screen.children[0]?.render(100).join('\n')).toContain('m · p')
    // A committed pick shows through the live ref.
    const selected = bannerAgent('mock-pro', 'mock')
    state.select(selected)
    expect(screen.children[0]?.render(100).join('\n')).toContain('mock-pro · mock')
    state.setSelection(selected, { next: { model: 'projected', provider: 'route' } })
    expect(screen.children[0]?.render(100).join('\n')).toContain('projected · route')
    // Clearing the current Agent falls back to the default.
    state.select(null)
    expect(screen.children[0]?.render(100).join('\n')).toContain('m · p')
    // A stale projection update from the detached session is ignored.
    state.setSelection(selected, { next: { model: 'stale', provider: 'stale-route' } })
    expect(screen.children[0]?.render(100).join('\n')).toContain('m · p')
  })

  it('unmounts the child when the fiber disposes', async () => {
    const { screen, dispose } = await bootBanner()
    await dispose()
    expect(screen.children).toHaveLength(0)
  })
})

describe('MAYFLY_VERSION', () => {
  it('matches the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(MAYFLY_VERSION).toBe(pkg.version)
  })
})
