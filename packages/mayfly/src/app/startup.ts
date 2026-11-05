/** Frontend-owned greeting and launch-screen presentation over the native catalog. @module remote/startup */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyScreenService } from '../core/screen.ts'
import { FLY_IN_FRAME_MS, FLY_IN_TOTAL_MS } from '../core/quad-mark.ts'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { SPLASH_RECENT_MAX, type SplashContent, type SplashSession } from '../transcript/splash.ts'
import { currentMayflySettings } from '../frontend/settings.ts'
import { formatAgo } from '../interaction/session-list-model.ts'
import { interactionTranslator, mountInteractionLocale } from '../interaction/locale.ts'
import type { HostClient, SessionRef } from '../client/types.ts'

/** Borrowed native selection; the launch screen never retains or creates a Session. */
interface RemoteStartupOptions {
  readonly client: () => HostClient | undefined
  readonly current: () => SessionRef | undefined
  readonly directory: () => string
  readonly subscribe: (listener: () => void) => () => void
  readonly resume: (sessionId: string) => void | Promise<void>
  readonly autocomplete: () => boolean
}

/** The reference greeting survives palette changes; only local observation and animation live here. */
export class RemoteStartupController {
  private readonly off: readonly (() => void)[]
  private catalogOff: (() => void) | undefined
  private stateOff: (() => void) | undefined
  private client: HostClient | undefined
  private generation: number | undefined
  private epoch = 0
  private shown = false
  private booted = false
  private disposed = false
  private loading = false
  private loaded = false
  private recent: readonly SplashSession[] | undefined
  private focus: number | undefined
  private flyInStart: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly t

  constructor(private readonly ctx: Context, private readonly screen: MayflyScreenService, private readonly options: RemoteStartupOptions) {
    mountInteractionLocale(ctx)
    this.t = interactionTranslator(ctx)
    this.off = [
      options.subscribe(() => { this.sync() }),
      ctx.on('mayfly/settings-source-ready', () => { this.sync() }),
      ctx.mayflyLocale.subscribe(() => { if (!this.disposed) { this.readRecent(); screen.requestRender() } }),
    ]
  }

  /** Startup routing selects any requested existing Session before greeting the start view. */
  start(): void {
    if (this.disposed || this.booted) return
    this.booted = true
    this.sync()
  }

  /** Read elapsed animation time at render; reduced motion always rests. */
  flyInAt(): number | undefined {
    if (!this.booted && !this.reducedMotion()) return 0
    return this.flyInStart === undefined || this.reducedMotion() ? undefined : Math.max(0, performance.now() - this.flyInStart)
  }

  /** The same pure launch-screen model used by the immutable reference. */
  splash(): SplashContent | 'pending' | undefined {
    if (this.disposed || !this.isSplash()) return undefined
    if (!this.booted) return 'pending'
    return {
      version: MAYFLY_VERSION,
      labels: {
        slogan: 'ephemeral agents, enduring works', recent: this.t('Recent sessions'),
        more: this.t('↑ browse · /sessions for all'), moreFocused: this.t('↵ resume · esc back'),
        empty: this.t('No sessions here yet'), emptyHint: this.t('Describe a task below to start one.'),
      },
      recent: this.recent, focus: this.focus,
    }
  }

  /** Empty-prompt arrows browse recent Sessions; other keys immediately return to the editor. */
  handleInput(data: string, text: string): boolean {
    if (this.disposed || !this.isSplash() || this.recent === undefined || this.recent.length === 0) return false
    const keymap = this.ctx.mayflyKeymap
    if (this.focus === undefined) {
      if (!keymap.matches(data, 'ui.up') || text !== '' || this.options.autocomplete()) return false
      this.focus = 0
    } else if (keymap.matches(data, 'ui.up')) this.focus = Math.max(0, this.focus - 1)
    else if (keymap.matches(data, 'ui.down')) this.focus = this.focus + 1 >= this.recent.length ? undefined : this.focus + 1
    else if (keymap.matches(data, 'ui.accept')) {
      // Every recent list is dense and every synchronous cursor update stays in bounds.
      const id = this.recent[this.focus]!.id
      this.focus = undefined
      void this.options.resume(id)
    } else if (keymap.matches(data, 'ui.cancel')) this.focus = undefined
    else {
      this.focus = undefined
      this.screen.requestRender()
      return false
    }
    this.screen.requestRender()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch += 1
    for (const off of this.off) off()
    this.catalogOff?.()
    this.stateOff?.()
    this.stopAnimation()
  }

  private isSplash(): boolean {
    return currentMayflySettings(this.ctx).startup === 'splash' && this.options.current() === undefined
  }

  private reducedMotion(): boolean { return currentMayflySettings(this.ctx).reducedMotion }

  private sync(): void {
    if (this.disposed) return
    const client = this.options.client()
    const generation = client?.state.getSnapshot().generation
    if (client !== this.client || generation !== this.generation) {
      if (client !== this.client) {
        this.stateOff?.()
        this.stateOff = client?.state.subscribe(() => { this.sync() })
      }
      this.epoch += 1
      this.catalogOff?.()
      this.catalogOff = undefined
      this.client = client
      this.generation = generation
      this.loading = false
      this.loaded = false
      this.recent = undefined
      this.focus = undefined
    }
    if (this.booted && this.options.current() === undefined) {
      if (!this.shown) {
        this.shown = true
        if (!this.reducedMotion()) this.animate()
      }
    } else {
      this.shown = false
      this.focus = undefined
      this.stopAnimation()
    }
    if (this.reducedMotion()) this.stopAnimation()
    if (this.booted && this.isSplash() && client !== undefined) {
      if (this.catalogOff === undefined) {
        const epoch = this.epoch
        this.catalogOff = client.sessions.list.subscribe(() => {
          if (this.disposed || epoch !== this.epoch) return
          this.readRecent()
          this.screen.requestRender()
        })
      }
      if (!this.loaded && !this.loading) void this.loadRecent(client, this.epoch)
    } else {
      if (this.catalogOff !== undefined) {
        this.epoch += 1
        this.loading = false
        this.recent = undefined
      }
      this.catalogOff?.()
      this.catalogOff = undefined
      this.focus = undefined
      this.loaded = false
    }
    this.screen.requestRender()
  }

  private async loadRecent(client: HostClient, epoch: number): Promise<void> {
    this.loading = true
    try {
      await client.sessions.refresh()
      if (this.disposed || epoch !== this.epoch || !this.isSplash()) return
      this.loaded = true
      this.readRecent()
    } catch {
      if (this.disposed || epoch !== this.epoch || !this.isSplash()) return
      this.loaded = true
      this.recent = []
    } finally {
      if (!this.disposed && epoch === this.epoch) {
        this.loading = false
        this.screen.requestRender()
      }
    }
  }

  private readRecent(): void {
    if (this.disposed || this.client === undefined || !this.isSplash()) return
    const snapshot = this.client.sessions.list.getSnapshot()
    const rows = snapshot.ids.flatMap(id => {
      const summary = snapshot.byId[id]
      return summary === undefined || summary.blank || summary.parentId !== undefined || summary.origin === 'subagent' ? [] : [summary]
    }).toSorted((left, right) => right.updatedAt - left.updatedAt)
    const cwd = this.options.directory()
    const here = rows.filter(row => row.cwd === cwd)
    this.recent = [...here, ...rows.filter(row => row.cwd !== cwd)].slice(0, SPLASH_RECENT_MAX).map(row => ({
      id: row.id, title: row.title?.trim() || this.t('Untitled'), project: basename(row.cwd ?? ''),
      age: row.running ? this.t('running') : formatAgo(Date.now() - row.updatedAt, this.t), live: row.running,
    }))
    if (this.focus !== undefined && this.focus >= this.recent.length) this.focus = undefined
  }

  private animate(): void {
    this.stopAnimation()
    this.flyInStart = performance.now()
    this.timer = setInterval(() => {
      if (this.flyInStart === undefined || performance.now() - this.flyInStart >= FLY_IN_TOTAL_MS) this.stopAnimation()
      this.screen.requestRender()
    }, FLY_IN_FRAME_MS)
    this.timer.unref()
  }

  private stopAnimation(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.flyInStart = undefined
  }
}
