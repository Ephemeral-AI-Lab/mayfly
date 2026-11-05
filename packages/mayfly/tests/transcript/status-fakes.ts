/**
 * Shared fakes for the status-entry plugin specs: identity colors, a
 * render-request-recording screen, a structural `mayflyStatus` registry, a
 * structural Agent whose session carries the durable header and the request
 * header fold, and a boot helper driving one plugin module through a real
 * Cordis context (services via `ctx.reflect.provide`, as in plugin.spec).
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MayflyStatusService } from '../../../ui/src/provider.ts'
import type { MayflyComponent, MayflyOverlayHandle, MayflyScreen } from '../../src/core/types.ts'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { fakeAgent as sharedFakeAgent, plainColors } from '../helpers.ts'
import { mountFakeScreenSlot } from '../core/fake-screen-slot.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Test-side broadcast of the bound session, for the consumers that follow it. */
    'test/session-binding-changed'(binding: { readonly id: string, readonly session: unknown, readonly cwd?: string | undefined }): void
  }
}

export const COLORS = plainColors()

/** Records render requests; mounting methods are out of scope here. */
export class StatusFakeScreen implements MayflyScreen {
  readonly renderRequests: (boolean | undefined)[] = []
  readonly columns = 80
  readonly rows = 24

  mountContentSlot(id: string, component: MayflyComponent | null) {
    return mountFakeScreenSlot(id, component, () => () => {}, target => this.setFocus(target), () => this.requestRender())
  }

  mountDockSlot(id: string, component: MayflyComponent | null) {
    return mountFakeScreenSlot(id, component, () => () => {}, target => this.setFocus(target), () => this.requestRender())
  }

  addChild(): () => void {
    throw new Error('fake addChild is out of scope for status plugin tests')
  }

  addBottomChild(_component: MayflyComponent): () => void {
    return () => {}
  }

  removeChild(): void {}

  setFocus(_component: MayflyComponent | null): void {}

  showOverlay(): MayflyOverlayHandle {
    throw new Error('fake showOverlay is out of scope for status plugin tests')
  }

  requestRender(force?: boolean): void {
    this.renderRequests.push(force)
  }

  /** S31 seam: pass-through; the status suites never suspend the screen. */
  suspend<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  /** Title writes recorded for the OSC-mirror assertions, if any. */
  readonly titles: string[] = []

  setTitle(title: string): void {
    this.titles.push(title)
  }

  scrollContent(): boolean { return false }
  followContent(): void {}
  setContentScrollHandler(): () => void { return () => {} }
}

/** Status-model facade retained for concise producer assertions. */
export interface StatusEntryView {
  readonly id: string
  readonly priority: number
  readonly align: 'left' | 'right' | undefined
  render(width: number): string
}

/** Structural stand-in for the parts of `Session` the status plugins read. */
export interface FakeSession {
  events: SessionEvent[]
  header: { cwd?: string }
  snapshotEvents(): readonly SessionEvent[]
  requestHeader(): { config: { model: string, reasoningEffort?: string } } | undefined
  requestContext(): { contextWindow?: number } | undefined
}

/** Structural stand-in for the real `Agent`; cast at the typed emit sites. */
export interface FakeAgent {
  id: SessionId
  status: 'idle' | 'running'
  options: { provider?: string, model?: string, reasoningEffort?: string }
  session: FakeSession
}

let agentCounter = 0

/**
 * A fake agent whose session is a plain event-log object.
 * @param events - the session's event snapshot.
 * @param options - agent options (model/provider/effort fallbacks) and the
 *   durable header cwd / request-header model the plugins may prefer.
 */
export function fakeAgent(
  events: SessionEvent[],
  options: {
    model?: string
    provider?: string
    effort?: string
    cwd?: string
    headerModel?: string
    headerEffort?: string
    contextWindow?: number
  } = {},
): FakeAgent {
  agentCounter += 1
  return sharedFakeAgent(`fake-agent-${agentCounter}`, { events, ...options }) as unknown as FakeAgent
}

/** Narrow a fake to the app-owned event payload type. */
export function asAgent(fake: FakeAgent): Agent {
  return fake as unknown as Agent
}

/** A plugin module shape accepted by `ctx.plugin`. */
export interface StatusPluginModule {
  name: string
  inject: string[]
  apply: (ctx: Context) => void
}

export interface StatusPluginHarness {
  ctx: Context
  screen: StatusFakeScreen
  entry: StatusEntryView
  models: MayflyStatusService
  /** Seed one session's `modelSelection` snapshot and fire its change feed. */
  setModelSelection(session: unknown, value: unknown): void
  dispose(): Promise<void>
}
