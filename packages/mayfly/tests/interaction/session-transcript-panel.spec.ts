/**
 * Full-fidelity readonly subagent transcript panel over live and cold cuts.
 * @module session-transcript-panel
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { MayflyFocusable } from '../../src/core/index.ts'
import * as transcriptPanelPlugin from '../../src/interaction/session-transcript-panel.ts'
import { SessionTranscriptPanel } from '../../src/interaction/session-transcript-panel.ts'
import { PaneFakeScreen, FakeProjectionService } from '../transcript/pane-fakes.ts'
import {
  assistantEvent,
  fakeMayflyComponents,
  imageBlock,
  reasoningDelta,
  resetSeq,
  stepStart,
  toolCallEvent,
  turnStart,
  userEvent,
} from '../transcript/helpers.ts'
import { COLORS } from '../transcript/status-fakes.ts'
import { expectLinesFit } from '../core/width-scan.ts'
import { FakeKeymap } from './fakes.ts'

const ANSI_OR_OSC = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu

function session(id: string, events: SessionEvent[]): Session {
  return { id: SessionId(id), header: { cwd: '/repo', origin: 'subagent', parentSession: SessionId('parent') }, events } as unknown as Session
}

function context(options: {
  readonly live?: Session
  readonly cold?: Session
  readonly observe?: Promise<unknown>
  readonly query?: boolean
  readonly agentSession?: Session
  readonly readImage?: ReturnType<typeof vi.fn>
  readonly toolGet?: ReturnType<typeof vi.fn>
} = {}) {
  const ctx = new Context()
  const screen = new PaneFakeScreen()
  const components = fakeMayflyComponents()
  const projections = new FakeProjectionService()
  ctx.reflect.provide('mayflyScreen', screen)
  ctx.reflect.provide('mayflyTheme', { colors: COLORS })
  ctx.reflect.provide('mayflyComponents', components)
  ctx.reflect.provide('mayflyKeymap', new FakeKeymap())
  ctx.reflect.provide('sessionProjections', projections)
  ctx.reflect.provide('sessions', { list: () => options.live === undefined ? [] : [options.live] })
  ctx.reflect.provide('agents', { get: () => options.agentSession === undefined ? undefined : { session: options.agentSession } })
  ctx.reflect.provide('tools', { get: options.toolGet ?? (() => undefined) })
  if (options.readImage !== undefined) ctx.reflect.provide('attachments', { readImage: options.readImage })
  const observationDispose = vi.fn()
  const coldCut = options.cold === undefined ? undefined : projections.snapshot(options.cold as never)
  if (options.query !== false) {
    ctx.reflect.provide('sessionQuery', {
      observeSession: () => options.observe ?? Promise.resolve({
        projections: coldCut,
        [Symbol.dispose]: observationDispose,
      }),
    })
  }
  return { ctx, screen, projections, observationDispose }
}

function target(id: string, mode: 'one-shot' | 'continuable' = 'one-shot') {
  return { kind: 'subagent' as const, sessionId: id, parentSessionId: 'parent', label: 'reviewer', mode }
}

describe('SessionTranscriptPanel', () => {
  it('reads the latest live projection at render time and preserves streaming after a burst', () => {
    resetSeq()
    const events = [turnStart(1), stepStart(1, 1), userEvent('live question')]
    const live = session('live-child', events)
    const { ctx, screen, projections } = context({ live })
    const panel = new SessionTranscriptPanel(ctx, target('live-child'), () => {})
    panel.render(60)
    const requests = screen.renderRequests.length
    for (const text of ['first thought\n', 'second thought\n', 'latest thought']) {
      const event = reasoningDelta(1, 1, text)
      events.push(event)
      projections.emit(live, event)
    }
    expect(screen.renderRequests).toHaveLength(requests + 1)
    const rendered = panel.render(60).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')
    expect(rendered).toContain('thinking...')
    expect(rendered).toContain('latest thought')
    const settled = assistantEvent(1, 1, [{ type: 'text', text: 'final live answer' }])
    events.push(settled)
    projections.emit(live, settled)
    expect(panel.render(60).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')).toContain('final live answer')
    panel.dispose()
  })

  it('renders the complete live transcript through the standard core shell', () => {
    resetSeq()
    const live = session('child', [
      userEvent('inspect this'),
      assistantEvent(1, 1, [{ type: 'text', text: 'inspection complete' }]),
    ])
    const { ctx } = context({ live })
    const close = vi.fn()
    const panel = new SessionTranscriptPanel(ctx, target('child'), close)
    panel.focused = true
    expect(panel.focused).toBe(true)
    const plain = panel.render(60).map(row => row.replace(ANSI_OR_OSC, ''))
    expect(plain[0]).toContain('Subagent · reviewer')
    expect(plain.join('\n')).toContain('inspect this')
    expect(plain.join('\n')).toContain('inspection complete')
    expect(plain.at(-2)).toContain('F7 toggle · F8 close · Esc close')
    expect(plain.at(-1)).toMatch(/^╰─+╯$/u)
    panel.handleInput('\x1b')
    expect(close).toHaveBeenCalledOnce()
    panel.dispose()
  })

  it('loads a cold projection without activating an Agent', async () => {
    resetSeq()
    const cold = session('cold', [
      userEvent('cold question'),
      assistantEvent(1, 1, [{ type: 'text', text: 'cold answer' }]),
    ])
    const { ctx, observationDispose } = context({ cold })
    const panel = new SessionTranscriptPanel(ctx, target('cold', 'continuable'), () => {})
    await vi.waitFor(() => {
      expect(panel.render(60).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')).toContain('cold answer')
    })
    expect(observationDispose).toHaveBeenCalledOnce()
    panel.dispose()
  })

  it('prefers a resident child Agent and loads transcript images through attachments', async () => {
    resetSeq()
    const live = session('agent-child', [
      userEvent('see image', [imageBlock({
        attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
      } as never)]),
    ])
    const readImage = vi.fn(async () => ({ data: Uint8Array.of(1, 2, 3) }))
    const { ctx, screen } = context({ agentSession: live, readImage })
    const panel = new SessionTranscriptPanel(ctx, target('agent-child'), () => {})
    panel.render(60)
    await vi.waitFor(() => expect(readImage).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(panel.render(60).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')).toContain('<image 3B>'))
    expect(screen.renderRequests.length).toBeGreaterThan(0)
    panel.dispose()
  })

  it('resolves tool presentation against the child Agent and forwards animated renders', () => {
    resetSeq()
    const live = session('active-child', [
      turnStart(1),
      stepStart(1, 1),
      reasoningDelta(1, 1, 'thinking'),
      toolCallEvent(1, 1, 'call-1', 'inspect', '{}'),
    ])
    const toolGet = vi.fn(() => undefined)
    const { ctx, screen } = context({ agentSession: live, toolGet })
    vi.useFakeTimers()
    let panel: SessionTranscriptPanel | undefined
    try {
      panel = new SessionTranscriptPanel(ctx, target('active-child', 'continuable'), () => {})
      panel.render(60)
      expect(toolGet).toHaveBeenCalledWith('inspect', expect.objectContaining({ session: live }))
      const baseline = screen.renderRequests.length
      vi.advanceTimersByTime(1_000)
      expect(screen.renderRequests.length).toBeGreaterThan(baseline)
    } finally {
      panel?.dispose()
      vi.useRealTimers()
    }
  })

  it('renders contained cold-read failures', async () => {
    const noQuery = context({ query: false })
    const missing = new SessionTranscriptPanel(noQuery.ctx, target('missing'), () => {})
    await vi.waitFor(() => expect(missing.render(80).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')).toContain('no session query service'))
    missing.dispose()

    const observationDispose = vi.fn()
    const malformedContext = context({ observe: Promise.resolve({
      projections: { values: { mayflyConversation: { invalid: true } } },
      [Symbol.dispose]: observationDispose,
    }) })
    const malformed = new SessionTranscriptPanel(malformedContext.ctx, target('malformed'), () => {})
    await vi.waitFor(() => expect(malformed.render(80).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')).toContain('stored subagent conversation is unavailable'))
    expect(observationDispose).toHaveBeenCalledOnce()
    malformed.dispose()

    for (const reason of [new Error('query failed'), 'bare query failure']) {
      const failedContext = context({ observe: Promise.reject(reason) })
      const failed = new SessionTranscriptPanel(failedContext.ctx, target('failed'), () => {})
      await vi.waitFor(() => expect(failed.render(80).map(row => row.replace(ANSI_OR_OSC, '')).join('\n')).toContain(reason instanceof Error ? reason.message : reason))
      failed.dispose()
    }
  })

  it('disposes an observation that resolves after the panel closes', async () => {
    const gate = Promise.withResolvers<unknown>()
    const { ctx } = context({ observe: gate.promise })
    const panel = new SessionTranscriptPanel(ctx, target('late'), () => {})
    panel.dispose()
    panel.dispose()
    const observationDispose = vi.fn()
    gate.resolve({ projections: { values: {} }, [Symbol.dispose]: observationDispose })
    await vi.waitFor(() => expect(observationDispose).toHaveBeenCalledOnce())
    expect(panel.render(80)).toEqual([])

    const rejectedGate = Promise.withResolvers<unknown>()
    const rejectedContext = context({ observe: rejectedGate.promise })
    const rejected = new SessionTranscriptPanel(rejectedContext.ctx, target('late-rejection'), () => {})
    rejected.dispose()
    rejectedGate.reject(new Error('aborted after disposal'))
    await Promise.resolve()
    await Promise.resolve()
    expect(rejected.render(80)).toEqual([])
  })

  it('contains every row at adversarial widths and ignores input after disposal', () => {
    resetSeq()
    const live = session('child', [userEvent('界🙂'.repeat(30))])
    const { ctx, screen } = context({ live })
    const close = vi.fn()
    const panel = new SessionTranscriptPanel(ctx, target('child'), close)
    for (const width of [5, 10, 20, 47, 80]) {
      expectLinesFit('readonly subagent transcript', panel.render(width), width)
    }
    panel.dispose()
    const baseline = screen.renderRequests.length
    panel.handleInput('\x1b')
    panel.invalidate()
    expect(panel.render(80)).toEqual([])
    expect(screen.renderRequests).toHaveLength(baseline)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('mayfly-session-transcript-panel plugin', () => {
  it('mounts only the displayed readonly target and reuses it across toggles', async () => {
    resetSeq()
    const live = session('child', [userEvent('child transcript')])
    const { ctx } = context({ live })
    const mounted: MayflyFocusable[] = []
    let unmounts = 0
    ctx.reflect.provide('mayflyEditorPanels', {
      mount(component: MayflyFocusable) {
        mounted.push(component)
        return () => {
          unmounts += 1
          const index = mounted.indexOf(component)
          if (index >= 0) mounted.splice(index, 1)
        }
      },
    })
    let snapshot: ReturnType<Context['mayflyCurrentAgent']['view']> = {
      primarySessionId: 'parent', displayed: 'primary', auxiliary: null, revision: 0,
    }
    const listeners = new Set<() => void>()
    ctx.reflect.provide('mayflyCurrentAgent', {
      view: () => snapshot,
      subscribeView(listener: () => void) {
        listeners.add(listener)
        listener()
        return () => { listeners.delete(listener) }
      },
    })
    const publish = (next: typeof snapshot): void => {
      snapshot = next
      for (const listener of listeners) listener()
    }
    const closed = vi.fn()
    ctx.on('mayfly/request-close-agent-view', closed)
    const fiber = await ctx.plugin(transcriptPanelPlugin)
    const readonly = {
      kind: 'subagent' as const,
      sessionId: 'child',
      parentSessionId: 'parent',
      label: 'worker',
      mode: 'one-shot' as const,
      access: 'readonly' as const,
    }
    publish({ primarySessionId: 'parent', displayed: 'auxiliary', auxiliary: readonly, revision: 1 })
    expect(mounted).toHaveLength(1)
    mounted[0]!.handleInput?.('\x1b')
    expect(closed).toHaveBeenCalledOnce()

    publish({ primarySessionId: 'parent', displayed: 'primary', auxiliary: readonly, revision: 2 })
    expect(mounted).toHaveLength(0)
    publish({ primarySessionId: 'parent', displayed: 'auxiliary', auxiliary: readonly, revision: 3 })
    const retained = mounted[0]
    publish({ primarySessionId: 'parent', displayed: 'auxiliary', auxiliary: readonly, revision: 4 })
    expect(mounted).toEqual([retained])

    publish({
      primarySessionId: 'parent',
      displayed: 'auxiliary',
      auxiliary: { ...readonly, sessionId: 'other', label: 'other' },
      revision: 5,
    })
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).not.toBe(retained)
    publish({
      primarySessionId: 'parent',
      displayed: 'auxiliary',
      auxiliary: { ...readonly, access: 'interactive' },
      revision: 6,
    })
    expect(mounted).toHaveLength(0)
    await fiber.dispose()
    expect(listeners).toHaveLength(0)
    expect(unmounts).toBe(3)
  })
})
