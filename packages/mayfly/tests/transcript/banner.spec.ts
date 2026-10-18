/**
 * The welcome banner: the pure four-line layout (mark, no mark, ASCII, tabs,
 * truncation, fly-in and rest), its home shortening and version labels, and
 * the plugin that mounts it — the live model re-derivation, the one-shot
 * fly-in and its frame clock, the greeting fallback, the launch screen with
 * its recent-session list, and the facts of version and locale.
 *
 * The agent-facing golden is in `banner-art.spec.ts`; the splash geometry is
 * pinned in `splash.spec.ts`.
 */

import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BANNER_MIN_WIDTH,
  composeBannerLines,
  inject,
  name,
  shortenHome,
  apply,
  type BannerContent,
  type BannerDeps,
  type Config,
} from '../../src/transcript/banner.ts'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { MARK_ROWS } from '../../src/transcript/banner-art.ts'
import { FLY_IN_FRAME_MS, FLY_IN_TOTAL_MS, markColumns } from '../../src/core/quad-mark.ts'
import type { MayflyComponent, MayflyOverlayHandle, MayflyScreen, MayflyScreenSlot } from '../../src/core/types.ts'
import { mountFakeScreenSlot } from '../core/fake-screen-slot.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { plainColors } from '../helpers.ts'
import { INTERACTION_LOCALE } from '../../src/interaction/locale.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'

const QUADRANT = /[▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]/u

/** Identity deps: structure assertions read plain text, not ANSI. */
const components = fakeMayflyComponents()
const DEPS: BannerDeps = {
  colors: plainColors(),
  strong: text => text,
  truncate: (text, width) => components.truncateToWidth(text, width),
  visibleWidth: text => components.visibleWidth(text),
}

const CONTENT: BannerContent = { version: '9.9.9-test', model: 'm', provider: 'p', cwd: '~/dev' }

/** The column the text starts at: the mark and the two-column gap. */
const TEXT_COLUMN = markColumns(MARK_ROWS) + 2

describe('shortenHome', () => {
  it('collapses the exact home to ~ and a child path to ~/rest', () => {
    expect(shortenHome('/home/x', '/home/x')).toBe('~')
    expect(shortenHome('/home/x/dev/mayfly', '/home/x')).toBe('~/dev/mayfly')
  })

  it('keeps paths outside home, home-prefix lookalikes, and an empty home', () => {
    expect(shortenHome('/home/other', '/home/x')).toBe('/home/other')
    expect(shortenHome('/home/x-dev', '/home/x')).toBe('/home/x-dev')
    expect(shortenHome('/a', '')).toBe('/a')
  })
})

describe('composeBannerLines', () => {
  it('renders no rows for a non-positive width', () => {
    expect(composeBannerLines(DEPS, CONTENT, 0)).toEqual([])
    expect(composeBannerLines(DEPS, CONTENT, -4)).toEqual([])
  })

  it('draws the mark and four lines at rest from the minimum width up', () => {
    const lines = composeBannerLines(DEPS, CONTENT, BANNER_MIN_WIDTH)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('mayfly')
    expect(lines[0]!.slice(TEXT_COLUMN)).toBe('mayfly v9.9.9-test')
    expect(lines[1]!.slice(TEXT_COLUMN)).toContain('ephemeral agents')
    expect(lines[2]!.slice(TEXT_COLUMN)).toBe('m · p')
    expect(lines[3]!.slice(TEXT_COLUMN)).toBe('~/dev')
    expect(QUADRANT.test(lines[0]!)).toBe(true)
    for (const line of lines) expect(DEPS.visibleWidth(line)).toBeLessThanOrEqual(BANNER_MIN_WIDTH)
  })

  it('drops the mark below the minimum width and leaves four plain lines', () => {
    const lines = composeBannerLines(DEPS, CONTENT, BANNER_MIN_WIDTH - 1)
    expect(lines).toHaveLength(4)
    expect(QUADRANT.test(lines.join('\n'))).toBe(false)
    expect(lines[0]).toBe('mayfly v9.9.9-test')
    expect(lines[1]).toContain('ephemeral agents')
    expect(lines[2]).toBe('m · p')
    expect(lines[3]).toBe('~/dev')
    for (const line of lines) expect(DEPS.visibleWidth(line)).toBeLessThanOrEqual(BANNER_MIN_WIDTH - 1)
  })

  it('leaves the mark out in ASCII glyph mode even when the width allows it', () => {
    const lines = composeBannerLines({ ...DEPS, ascii: true }, CONTENT, 100)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('mayfly v9.9.9-test')
    expect(lines[1]).toBe('ephemeral agents, enduring works')
    expect(QUADRANT.test(lines.join('\n'))).toBe(false)
  })

  it('prefixes a release version with v and leaves another identity as it is', () => {
    expect(composeBannerLines({ ...DEPS, ascii: true }, { ...CONTENT, version: '1.2.3' }, 100)[0]).toBe('mayfly v1.2.3')
    expect(composeBannerLines({ ...DEPS, ascii: true }, { ...CONTENT, version: 'nightly' }, 100)[0]).toBe('mayfly nightly')
  })

  it('normalizes tabs to three cells before measuring and painting', () => {
    const lines = composeBannerLines({ ...DEPS, ascii: true }, { ...CONTENT, cwd: '\tdev' }, 100)
    expect(lines[3]).toBe('   dev')
    expect(lines[3]).not.toContain('\t')
  })

  it('truncates over-wide runs with the renderer ellipsis and drops the rest', () => {
    const truncate = vi.fn((text: string, target: number) => components.truncateToWidth(text, target))
    const lines = composeBannerLines(
      { ...DEPS, truncate },
      { version: '1.0.0', model: 'm'.repeat(80), provider: 'p', cwd: 'd'.repeat(80) },
      BANNER_MIN_WIDTH,
    )
    expect(truncate).toHaveBeenCalled()
    expect(lines[2]).not.toContain('m'.repeat(40))
    expect(lines[3]).not.toContain('d'.repeat(40))
    for (const line of lines) expect(components.visibleWidth(line)).toBeLessThanOrEqual(BANNER_MIN_WIDTH)
  })

  it('breaks once the first run fills the row exactly', () => {
    const lines = composeBannerLines({ ...DEPS, ascii: true }, CONTENT, 'mayfly'.length)
    expect(lines[0]).toBe('mayfly')
  })

  it('holds the four lines and keeps the mark off screen at the fly-in start', () => {
    const lines = composeBannerLines(DEPS, CONTENT, 100, 0)
    expect(lines).toHaveLength(4)
    expect(lines.join('')).toBe('')
  })

  it('shows the text only in the mark\u2019s wake in flight and lands at rest', () => {
    const flying = composeBannerLines(DEPS, CONTENT, 100, 550)
    expect(flying.join('\n')).not.toContain('mayfly')
    expect(flying.join('\n')).toContain('works')
    expect(composeBannerLines(DEPS, CONTENT, 100, FLY_IN_TOTAL_MS)).toEqual(composeBannerLines(DEPS, CONTENT, 100))
  })
})

/** Records render requests and content mounts; every other mount is out of scope. */
class BannerFakeScreen implements MayflyScreen {
  readonly children: MayflyComponent[] = []
  readonly renderRequests: (boolean | undefined)[] = []
  readonly columns = 100
  readonly rows: number
  readonly editorRowsFromBottom: number

  constructor(options: { readonly rows?: number, readonly editorRows?: number } = {}) {
    this.rows = options.rows ?? 24
    this.editorRowsFromBottom = options.editorRows ?? 4
  }

  mountContentSlot(id: string, component: MayflyComponent | null): MayflyScreenSlot {
    return mountFakeScreenSlot(id, component, shell => {
      this.children.push(shell)
      return () => {
        const index = this.children.indexOf(shell)
        if (index !== -1) this.children.splice(index, 1)
      }
    }, target => this.setFocus(target), () => this.requestRender())
  }

  mountDockSlot(): never { throw new Error('fake mountDockSlot is out of scope for banner tests') }

  addChild(component: MayflyComponent): () => void {
    this.children.push(component)
    return () => {
      const index = this.children.indexOf(component)
      if (index !== -1) this.children.splice(index, 1)
    }
  }

  addBottomChild(): never { throw new Error('fake addBottomChild is out of scope for banner tests') }

  removeChild(): void {}

  setFocus(_component: MayflyComponent | null): void {}

  showOverlay(): MayflyOverlayHandle {
    throw new Error('fake showOverlay is out of scope for banner tests')
  }

  requestRender(force?: boolean): void {
    this.renderRequests.push(force)
  }

  suspend<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  setTitle(): void {}

  scrollContent(): boolean { return false }
  followContent(): void {}
  setContentScrollHandler(): () => void { return () => {} }
}

/** A fake primary Agent session: a request header, a log of events, and an id. */
function fakeAgent(id: string, options: {
  readonly model?: string
  readonly provider?: string
  readonly requestHeader?: boolean
  readonly events?: readonly { readonly type: string }[]
} = {}): Agent {
  const session = {
    id: SessionId(id),
    snapshotEvents: () => options.events ?? [],
    requestHeader: () => options.requestHeader === false
      ? undefined
      : { config: { model: options.model ?? 'm', provider: options.provider ?? 'p' } },
  }
  return { id: session.id, session } as unknown as Agent
}

/** A native catalog summary. */
function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: SessionId(id),
    updatedAt: Date.now(),
    running: false,
    blank: false,
    cwd: process.cwd(),
    agentAvailable: false,
    ...over,
  } as unknown as SessionSummary
}

interface BootOptions {
  readonly initialAgent?: Agent | null
  readonly boot?: boolean
  readonly reducedMotion?: boolean
  readonly ascii?: boolean
  readonly startup?: 'conversation' | 'splash'
  readonly items?: readonly SessionSummary[]
  readonly listError?: Error
  readonly locale?: 'en' | 'zh'
  readonly rows?: number
  readonly editorRows?: number
  readonly config?: Config
  readonly interactionState?: boolean
  /** Hold the catalog read open until {@link Bench.finishList}. */
  readonly holdList?: boolean
}

interface Bench {
  readonly ctx: Context
  readonly screen: BannerFakeScreen
  readonly state: {
    current: Agent | null
    readonly browse: { ids: string[], focus: number | undefined }
    readonly settings: { startup: 'conversation' | 'splash', reducedMotion: boolean }
    readonly list: ReturnType<typeof vi.fn>
  }
  readonly boot: () => void
  readonly select: (agent: Agent | null) => void
  readonly setSelection: (agent: Agent, value: unknown) => void
  readonly projectionChanged: (agent: Agent, key: string, value?: unknown) => void
  readonly finishList: (error?: Error) => void
  readonly dispose: () => Promise<void>
}

const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Settle the plugin's catalog read and painter mount without depending on timers. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

/** Mount the banner plugin on a fresh root context with the native services faked. */
async function bootBanner(options: BootOptions = {}): Promise<Bench> {
  const ctx = new Context()
  roots.push(ctx)
  const screen = new BannerFakeScreen({ ...(options.rows === undefined ? {} : { rows: options.rows }), ...(options.editorRows === undefined ? {} : { editorRows: options.editorRows }) })
  let resolveList: ((value: { items: readonly SessionSummary[] }) => void) | undefined
  let rejectList: ((error: unknown) => void) | undefined
  const state = {
    current: (options.initialAgent ?? null) as Agent | null,
    browse: { ids: [] as string[], focus: undefined as number | undefined },
    settings: {
      startup: options.startup ?? 'conversation',
      reducedMotion: options.reducedMotion === true,
    },
    list: options.holdList === true
      ? vi.fn(() => new Promise<{ items: readonly SessionSummary[] }>((resolve, reject) => {
          resolveList = resolve
          rejectList = reject
        }))
      : options.listError === undefined
        ? vi.fn(async () => ({ items: options.items ?? [] }))
        : vi.fn(async () => { throw options.listError }),
  }
  const listeners = new Set<(agent: Agent | null, revision: number) => void>()
  const projectionListeners = new Set<(session: Agent['session'], key: string, value: unknown, seq: number) => void>()
  const bootListeners = new Set<() => void>()
  const selections = new Map<unknown, unknown>()
  const locale = options.locale === undefined ? undefined : new MayflyLocaleService(ctx, { systemLocale: options.locale })
  if (locale !== undefined) {
    ctx.effect(() => locale.register('interaction', INTERACTION_LOCALE))
  }
  ctx.reflect.provide('mayflyScreen', screen)
  ctx.reflect.provide('mayflyTheme', { colors: plainColors(), logoGradient: [] })
  ctx.reflect.provide('mayflyComponents', {
    ...fakeMayflyComponents(),
    presentation: {
      glyphs: options.ascii === true ? 'ascii' : 'unicode',
      monochrome: false,
      reducedMotion: options.reducedMotion === true,
    },
  })
  ctx.reflect.provide('mayflyCurrentAgent', {
    current: () => state.current,
    primary: () => state.current,
    revision: () => 0,
    subscribe(listener: (agent: Agent | null, revision: number) => void) {
      listeners.add(listener)
      listener(state.current, 0)
      return () => { listeners.delete(listener) }
    },
  })
  ctx.reflect.provide('sessionProjections', {
    snapshot(session: unknown) {
      return { asOfSeq: 0, values: { modelSelection: selections.get(session) } }
    },
    onChanged(listener: (session: Agent['session'], key: string, value: unknown, seq: number) => void) {
      projectionListeners.add(listener)
      return () => { projectionListeners.delete(listener) }
    },
  })
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) })
  ctx.reflect.provide('mayflySessionStart', {
    onBooted(listener: () => void) {
      bootListeners.add(listener)
      if (options.boot !== false) listener()
      return () => { bootListeners.delete(listener) }
    },
  })
  if (options.interactionState !== false) {
    ctx.reflect.provide('mayflyInteractionState', {
      settingsSource: () => state.settings,
      splash: state.browse,
    })
  }
  ctx.reflect.provide('sessionController', { list: state.list })
  const fiber = await ctx.plugin({ name, inject, apply: (applyCtx: Context) => apply(applyCtx, options.config) })
  await settle()
  return {
    ctx,
    screen,
    state,
    boot() {
      for (const listener of bootListeners) listener()
    },
    select(agent) {
      state.current = agent
      for (const listener of listeners) listener(agent, 1)
    },
    setSelection(agent, value) {
      selections.set(agent.session, value)
      for (const listener of projectionListeners) listener(agent.session, 'modelSelection', value, 1)
    },
    projectionChanged(agent, key, value) {
      if (key === 'modelSelection') selections.set(agent.session, value)
      for (const listener of projectionListeners) listener(agent.session, key, value, 1)
    },
    finishList(error) {
      if (error === undefined) resolveList?.({ items: options.items ?? [] })
      else rejectList?.(error)
    },
    dispose: () => fiber.dispose(),
  }
}

/** The mounted banner's rows, at the default 100-column screen (the gutter leaves 98). */
function rowsOf(screen: BannerFakeScreen, width = 100): string[] {
  return screen.children[0]?.render(width) ?? []
}

/** The mounted rows with ANSI styling removed, for text assertions. */
function plainRows(screen: BannerFakeScreen, width = 100): string {
  return rowsOf(screen, width).join('\n').replace(/\x1b\[[0-9;]*m/gu, '')
}

describe('mayfly-banner plugin', () => {
  it('declares its name and injects', () => {
    expect(name).toBe('mayfly-banner')
    expect(inject).toEqual(['mayflyScreen', 'mayflyCurrentAgent', 'mayflySessionStart', 'sessionProjections', 'agentDefaultModel', 'sessionController'])
  })

  it('mounts one scroll child with the boot facts and requests a render', async () => {
    const bench = await bootBanner({ reducedMotion: true })
    expect(bench.screen.children).toHaveLength(1)
    expect(bench.screen.renderRequests.length).toBeGreaterThan(0)
    const text = plainRows(bench.screen)
    expect(text).toContain('ephemeral agents, enduring works')
    expect(text).toContain(`v${MAYFLY_VERSION}`)
    expect(text).toContain('m · p')
    expect(text).toContain(shortenHome(process.cwd(), homedir()))
    await bench.dispose()
    expect(bench.screen.children).toHaveLength(0)
  })

  it('shows a profile-local identity without changing the release version', async () => {
    const numeric = await bootBanner({ config: { displayVersion: '2.0.0' }, reducedMotion: true })
    expect(plainRows(numeric.screen)).toContain('mayfly v2.0.0')
    const named = await bootBanner({ config: { displayVersion: 'next' }, reducedMotion: true })
    expect(plainRows(named.screen)).toContain('mayfly next')
    expect(plainRows(named.screen)).not.toContain('vnext')
    expect(MAYFLY_VERSION).toBe('0.1.3-rc.2')
  })

  it('re-derives the model line on session switches, projections, and fallbacks', async () => {
    const bench = await bootBanner({ reducedMotion: true })
    expect(rowsOf(bench.screen).join('\n')).toContain('m · p')
    const selected = fakeAgent('session-selected', { model: 'mock-pro', provider: 'mock' })
    bench.select(selected)
    expect(rowsOf(bench.screen).join('\n')).toContain('mock-pro · mock')
    bench.setSelection(selected, { next: { model: 'projected', provider: 'route' } })
    expect(rowsOf(bench.screen).join('\n')).toContain('projected · route')
    // A null projected pick falls back to the request header.
    bench.setSelection(selected, { next: null })
    expect(rowsOf(bench.screen).join('\n')).toContain('mock-pro · mock')
    // No header and no projection: the default-model service.
    bench.select(fakeAgent('session-headerless', { requestHeader: false }))
    expect(rowsOf(bench.screen).join('\n')).toContain('m · p')
    // Clearing the current Agent falls back too.
    bench.select(null)
    expect(rowsOf(bench.screen).join('\n')).toContain('m · p')
    // A projection update from the detached session renders nothing now...
    bench.setSelection(selected, { next: { model: 'stale', provider: 'stale-route' } })
    expect(rowsOf(bench.screen).join('\n')).toContain('m · p')
    // ...though the retained snapshot is what the next selection reads.
    bench.select(selected)
    expect(rowsOf(bench.screen).join('\n')).toContain('stale · stale-route')
    // Another projection key is ignored, and a current model pick re-derives.
    bench.projectionChanged(selected, 'title')
    expect(rowsOf(bench.screen).join('\n')).toContain('stale · stale-route')
    bench.projectionChanged(selected, 'modelSelection', { next: { model: 'fresh', provider: 'route' } })
    expect(rowsOf(bench.screen).join('\n')).toContain('fresh · route')
  })

  it('returns the composed rows by identity at rest and recomposes on width or invalidation', async () => {
    const bench = await bootBanner({ reducedMotion: true })
    const mounted = bench.screen.children[0]!
    const rows = mounted.render(100)
    expect(mounted.render(100)).toBe(rows)
    expect(mounted.render(90)).not.toBe(rows)
    mounted.invalidate()
    const recomposed = mounted.render(100)
    expect(recomposed).not.toBe(rows)
    expect(recomposed).toEqual(rows)
  })

  it('plays the fly-in for a fresh session and ends it at rest on the frame clock', async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const bench = await bootBanner({ initialAgent: fakeAgent('session-fresh') })
    const flying = rowsOf(bench.screen).join('\n')
    expect(flying).not.toContain('mayfly')
    const requests = bench.screen.renderRequests.length
    // A tick before the deadline keeps the fly-in running.
    now = FLY_IN_FRAME_MS
    await vi.advanceTimersByTimeAsync(FLY_IN_FRAME_MS)
    expect(bench.screen.renderRequests.length).toBeGreaterThan(requests)
    now = FLY_IN_TOTAL_MS + 1
    await vi.advanceTimersByTimeAsync(FLY_IN_TOTAL_MS + 33)
    expect(bench.screen.renderRequests.length).toBeGreaterThan(requests)
    const rest = rowsOf(bench.screen).join('\n')
    expect(rest).toContain('mayfly')
    expect(rest).toContain('ephemeral agents, enduring works')
  })

  it('shows a resumed session at rest and never replays its fly-in', async () => {
    const bench = await bootBanner({ initialAgent: fakeAgent('session-resumed', { events: [{ type: 'turn/start' }] }) })
    expect(rowsOf(bench.screen).join('\n')).toContain('mayfly')
    const requests = bench.screen.renderRequests.length
    bench.select(fakeAgent('session-resumed', { events: [{ type: 'turn/start' }] }))
    expect(rowsOf(bench.screen).join('\n')).toContain('mayfly')
    expect(bench.screen.renderRequests.length).toBeGreaterThanOrEqual(requests)
  })

  it('plays the start surface once and does not replay it when a session takes its place', async () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const bench = await bootBanner({ boot: false })
    bench.boot()
    expect(plainRows(bench.screen).trim()).toBe('')
    now = FLY_IN_TOTAL_MS
    const session = fakeAgent('session-after-start')
    bench.select(session)
    const text = plainRows(bench.screen)
    expect(text).toContain('mayfly')
    expect(text).toContain('m · p')
    // The start surface's frame clock sees the fly-in cleared and stops on its next tick.
    const requests = bench.screen.renderRequests.length
    await vi.advanceTimersByTimeAsync(FLY_IN_FRAME_MS)
    expect(bench.screen.renderRequests.length).toBeGreaterThan(requests)
  })

  it('ends the fly-in at rest under reduced motion', async () => {
    const bench = await bootBanner({ initialAgent: fakeAgent('session-still'), reducedMotion: true })
    const text = plainRows(bench.screen)
    expect(text).toContain('mayfly')
    expect(text).toContain('ephemeral agents, enduring works')
  })

  it('shows the banner at rest after the greeting wait when no conversation arrives', async () => {
    vi.useFakeTimers()
    const bench = await bootBanner({ boot: false })
    const pending = plainRows(bench.screen)
    expect(pending.trim()).toBe('')
    await vi.advanceTimersByTimeAsync(1000)
    expect(plainRows(bench.screen)).toContain('mayfly')
  })

  it('keeps a greeted banner unchanged when the greeting wait fires', async () => {
    vi.useFakeTimers()
    const bench = await bootBanner({ initialAgent: fakeAgent('session-greeted', { events: [{ type: 'turn/start' }] }) })
    const rows = rowsOf(bench.screen)
    await vi.advanceTimersByTimeAsync(1000)
    expect(rowsOf(bench.screen)).toBe(rows)
  })

  it('composes without an interaction state service and falls back to the conversation', async () => {
    const bench = await bootBanner({
      interactionState: false,
      initialAgent: fakeAgent('session-no-state', { events: [{ type: 'turn/start' }] }),
    })
    expect(plainRows(bench.screen)).toContain('mayfly')
    bench.select(fakeAgent('session-no-state-2', { events: [{ type: 'turn/start' }] }))
    expect(plainRows(bench.screen)).toContain('mayfly')
  })
})

describe('mayfly-banner launch screen', () => {
  it('paints nothing as pending before the first conversation booted', async () => {
    const bench = await bootBanner({ startup: 'splash', boot: false, reducedMotion: true })
    expect(rowsOf(bench.screen)).toEqual([])
    bench.boot()
    await settle()
    expect(plainRows(bench.screen)).toContain('mayfly')
  })

  it('lists this directory\u2019s sessions first with titles, projects, ages, and running state', async () => {
    const cwd = process.cwd()
    const bench = await bootBanner({
      startup: 'splash',
      items: [
        summary('session-running', {
          cwd,
          running: true,
          updatedAt: Date.now() - 60_000,
          projections: { values: { title: 'Fix the build' } },
        } as never),
        summary('session-blank', { cwd, blank: true } as never),
        summary('session-child', { cwd, parentSessionId: SessionId('parent') } as never),
        summary('session-here', {
          cwd,
          updatedAt: Date.now() - 2 * 60_000,
        } as never),
        summary('session-other', {
          cwd: '/tmp/other-project',
          updatedAt: Date.now() - 3 * 60 * 60_000,
        } as never),
        summary('session-nowhere', {
          cwd: undefined,
          projections: { values: { title: 'No project' } },
        } as never),
      ],
    })
    const text = rowsOf(bench.screen).join('\n')
    expect(text).toContain('Recent sessions')
    expect(text).toContain('Fix the build')
    expect(text).toContain('running')
    expect(text).toContain('Untitled')
    expect(text).toContain('other-project')
    expect(text).toContain('No project')
    expect(text).toContain('2m ago')
    expect(text).not.toContain('session-blank')
    expect(bench.state.browse.ids).toEqual(['session-running', 'session-here', 'session-other', 'session-nowhere'])
  })

  it('fills the list with other projects only when this directory has room', async () => {
    const cwd = process.cwd()
    const near = [1, 2, 3].map(index => summary(`session-near-${String(index)}`, {
      cwd,
      projections: { values: { title: `Near ${String(index)}` } },
    } as never))
    const far = summary('session-far', {
      cwd: '/tmp/far',
      projections: { values: { title: 'Far away' } },
    } as never)
    const bench = await bootBanner({ startup: 'splash', items: [...near, far] })
    const text = rowsOf(bench.screen).join('\n')
    expect(text).toContain('Far away')
    expect(bench.state.browse.ids).toHaveLength(4)

    const full = await bootBanner({
      startup: 'splash',
      items: [1, 2, 3, 4].map(index => summary(`session-here-${String(index)}`, {
        cwd,
        projections: { values: { title: `Here ${String(index)}` } },
      } as never)).concat([far]),
    })
    expect(rowsOf(full.screen).join('\n')).not.toContain('Far away')
    expect(full.state.browse.ids).toHaveLength(4)
  })

  it('publishes the ids and clamps a focus the list no longer holds', async () => {
    const bench = await bootBanner({
      startup: 'splash',
      items: [summary('session-a', { projections: { values: { title: 'A' } } } as never)],
    })
    expect(bench.state.browse.ids).toEqual(['session-a'])
    bench.state.browse.focus = 3
    bench.ctx.emit('mayfly/session-catalog-changed')
    await settle()
    expect(bench.state.browse.focus).toBeUndefined()
  })

  it('starts browsing at the list when focus is set and clears it when a session takes over', async () => {
    const bench = await bootBanner({
      startup: 'splash',
      items: [
        summary('session-a', { projections: { values: { title: 'A' } } } as never),
        summary('session-b', { projections: { values: { title: 'B' } } } as never),
      ],
    })
    bench.state.browse.focus = 1
    const text = rowsOf(bench.screen).join('\n')
    expect(text).toContain('\u203a')
    bench.select(fakeAgent('session-live'))
    expect(bench.state.browse.ids).toEqual([])
    expect(bench.state.browse.focus).toBeUndefined()
    expect(rowsOf(bench.screen).join('\n')).toContain('m · p')
  })

  it('shows the empty notice when the catalog has no sessions, then the banner once a session appears', async () => {
    const bench = await bootBanner({ startup: 'splash' })
    const text = rowsOf(bench.screen).join('\n')
    expect(text).toContain('No sessions here yet')
    expect(text).toContain('Describe a task below to start one.')
    bench.select(fakeAgent('session-empty'))
    expect(rowsOf(bench.screen).join('\n')).toContain('m · p')
  })

  it('warns and shows the empty notice when the catalog read fails', async () => {
    const bench = await bootBanner({ startup: 'splash', listError: new Error('catalog offline') })
    const loggerWarn = vi.spyOn(bench.ctx.logger, 'warn')
    bench.ctx.emit('mayfly/session-catalog-changed')
    await settle()
    expect(loggerWarn).toHaveBeenCalled()
    expect(rowsOf(bench.screen).join('\n')).toContain('No sessions here yet')
  })

  it('follows the startup setting in both directions and reacts to the source-ready event', async () => {
    const bench = await bootBanner({
      reducedMotion: true,
      items: [summary('session-a', { projections: { values: { title: 'A' } } } as never)],
    })
    expect(rowsOf(bench.screen).join('\n')).not.toContain('Recent sessions')
    bench.state.settings.startup = 'splash'
    bench.ctx.emit('settings/document-updated', 'mayfly' as never, 1)
    await settle()
    expect(rowsOf(bench.screen).join('\n')).toContain('Recent sessions')
    // Another namespace is ignored.
    bench.state.settings.startup = 'conversation'
    bench.ctx.emit('settings/document-updated', 'other' as never, 2)
    await settle()
    expect(rowsOf(bench.screen).join('\n')).toContain('Recent sessions')
    bench.ctx.emit('mayfly/settings-source-ready', bench.state.settings)
    await settle()
    // A ready event while the setting did not move renders nothing.
    const quiet = bench.screen.renderRequests.length
    bench.ctx.emit('mayfly/settings-source-ready', bench.state.settings)
    await settle()
    expect(bench.screen.renderRequests.length).toBe(quiet)
    expect(plainRows(bench.screen)).toContain('m · p')
    bench.state.settings.startup = 'splash'
    bench.ctx.emit('mayfly/settings-source-ready', bench.state.settings)
    await settle()
    expect(rowsOf(bench.screen).join('\n')).toContain('Recent sessions')
  })

  it('translates the launch-screen chrome while the brand and version stay as facts', async () => {
    const bench = await bootBanner({
      startup: 'splash',
      locale: 'zh',
      reducedMotion: true,
      items: [summary('session-a', { projections: { values: { title: 'A' } } } as never)],
    })
    const text = plainRows(bench.screen)
    expect(text).toContain('最近的会话')
    expect(text).toContain('↑ 浏览 · /sessions 查看全部')
    expect(text).toContain('mayfly')
    expect(text).toContain(`v${MAYFLY_VERSION}`)
    expect(text).toContain('ephemeral agents, enduring works')
  })

  it('drops a catalog failure that lands after the plugin unloaded', async () => {
    const bench = await bootBanner({ startup: 'splash', reducedMotion: true, holdList: true })
    const loggerWarn = vi.spyOn(bench.ctx.logger, 'warn')
    await bench.dispose()
    const requests = bench.screen.renderRequests.length
    bench.finishList(new Error('late failure'))
    await settle()
    expect(loggerWarn).not.toHaveBeenCalled()
    expect(bench.screen.renderRequests.length).toBe(requests)
  })

  it('reads the catalog only for the splash with no primary session, one read at a time', async () => {
    const bench = await bootBanner({
      startup: 'splash',
      items: [summary('session-a')],
    })
    const reads = bench.state.list.mock.calls.length
    bench.ctx.emit('mayfly/session-catalog-changed')
    bench.ctx.emit('mayfly/session-catalog-changed')
    await settle()
    expect(bench.state.list.mock.calls.length).toBeGreaterThan(reads)
    bench.state.settings.startup = 'conversation'
    bench.ctx.emit('settings/document-updated', 'mayfly' as never, 3)
    await settle()
    const settled = bench.state.list.mock.calls.length
    bench.ctx.emit('mayfly/session-catalog-changed')
    await settle()
    expect(bench.state.list.mock.calls.length).toBe(settled)
  })
})
