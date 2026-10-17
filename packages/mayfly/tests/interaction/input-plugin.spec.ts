/**
 * Tests for the `mayfly-input` plugin over the real session store and command
 * runtime with the fake component factory: slash-command dispatch,
 * follow-up submission, slash hints, the shared editor reference, and
 * mount/dispose behavior.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyComponent, MayflyFocusable } from '../../src/core/types.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MayflyEditorSubmitRequest, MayflyEditorSubmitValue } from '@ephemeral-ai/mayfly-ui'
import type { MayflyConversationView } from '../../src/app/conversation-views.ts'
import * as inputPlugin from '../../src/interaction/input-plugin.ts'
import { ACTION_MOVE_DOWN, ACTION_MOVE_UP } from '../../src/interaction/keys.ts'
import { __setCatalogForTest } from '../../src/interaction/skills-catalog.ts'
import {
  getSharedEditor,
} from '../../src/interaction/editor-instance.ts'
import { registerSubmitTransformer } from '../../src/interaction/prompt-submit-pipeline.ts'
import { setExternalEditorLauncher } from '../../src/interaction/external-editor.ts'
import { fakeMayflyContext, FakeMayflyEditor, KEY, type FakeMayflyComponents, type FakeScreen } from './fakes.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { renderRequest } from './request-fixture.ts'

/** One settled-skill double for the catalog seam. */
function skillOf(name: string): SkillSummary {
  return {
    name,
    description: `The ${name} skill`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: 'spec',
  }
}

/** In-memory inbox double with a stubbed, recordable removal. */
function fakeInbox(options: {
  nextTurn?: UserMessage[]
  nextStep?: UserMessage[]
  remove?: (id: string) => boolean
} = {}) {
  const nextTurn = options.nextTurn ?? []
  const nextStep = options.nextStep ?? []
  return {
    nextTurn,
    nextStep,
    remove: vi.fn(options.remove ?? (() => true)),
    get hasPending(): boolean {
      return nextTurn.length > 0 || nextStep.length > 0
    },
  }
}

function queued(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function installEditorTransform(
  ctx: Context,
  transform: (
    request: MayflyEditorSubmitRequest,
    signal?: AbortSignal,
  ) => MayflyEditorSubmitValue | Promise<MayflyEditorSubmitValue>,
): void {
  ctx.mayflyEditorExtensions.register({
    id: 'spec.input-transform',
    transformSubmit: (request, context) => transform(request, context.signal),
  })
}

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: 12,
    width: 2,
    height: 2,
  }
}

/** The displayed conversation and registry revision an input test routes against. */
interface DisplayedFixture {
  readonly displayed: MayflyConversationView
  readonly revision: number
}

/** A displayed side conversation at one registry revision. */
type SideView = Extract<MayflyConversationView, { readonly kind: 'btw' | 'subagent' }>
type Unregistered<View> = View extends unknown ? Omit<View, 'id' | 'residency'> : never
type SideFixture = Unregistered<SideView>

function sideView(side: SideFixture, revision: number): DisplayedFixture {
  return { displayed: { ...side, id: `session:${side.sessionId}`, residency: 'displayed' } as MayflyConversationView, revision }
}

/** The lane each mounted hint reads its notices from: the notices left the footer for the notification pane. */
const noticeLanes = new WeakMap<MayflyComponent, Context>()

/** The lane's notices, written as the footer used to draw them: a severity sigil, its glyph, then the message. */
function noticesOf(hint: MayflyComponent): string[] {
  const sigil = { info: '^', success: '^', warning: '?', error: '!' } as const
  const glyph = { info: 'ℹ', success: '✓', warning: '⚠', error: '✗' } as const
  const ctx = noticeLanes.get(hint)
  // A warning or an error carries its sigil twice before the message and once after it (the emphasis of its tone).
  return (ctx?.mayflyUiInteraction?.notificationSnapshot() ?? []).map((record) => {
    const mark = sigil[record.severity]
    const emphasis = record.severity === 'error' || record.severity === 'warning'
    return `${mark}${glyph[record.severity]} ${emphasis ? mark : ''}${mark}${record.message}${emphasis ? mark : ''}`
  })
}

async function mount(options: {
  withAgent?: boolean
  running?: boolean
  appExit?: (code: number) => void
  inbox?: ReturnType<typeof fakeInbox>
  modelRef?: unknown
  retract?: (messageId: string) => boolean
  view?: DisplayedFixture
  subagents?: { prompt: ReturnType<typeof vi.fn>, interruptByParent: ReturnType<typeof vi.fn> }
  uiImages?: unknown
} = {}): Promise<{
  ctx: Context
  screen: FakeScreen
  editor: FakeMayflyEditor
  editorRoot: MayflyFocusable & MayflyComponent
  hint: MayflyComponent
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  fiber: { dispose(): Promise<void> }
}> {
  const { ctx, screen, components } = fakeMayflyContext()
  new UiInteractionService(ctx)
  mountUiRegistryObservers(ctx)
  await Promise.resolve()
  // This suite exercises only the editor slot. The shared fake now owns the
  // transcript dock service's stable empty bottom root; remove that unrelated
  // fixture root so the existing slot assertions stay local to mayfly-input.
  for (const child of screen.children) screen.removeChild(child)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('input-spec'))
  const followup = vi.fn()
  const cancel = vi.fn()
  const steer = vi.fn()
  const agent = {
    id: session.id,
    session,
    ctx: new Context(),
    status: options.running === true ? 'running' : 'idle',
    followup,
    cancel,
    steer,
    inbox: options.inbox ?? fakeInbox(),
  } as unknown as Agent
  ctx.provide('testSession', { current: options.withAgent === false ? null : agent, modelRef: options.modelRef ?? undefined })
  if (options.view !== undefined) {
    vi.spyOn(ctx.mayflyConversations, 'displayed').mockReturnValue(options.view.displayed)
    vi.spyOn(ctx.mayflyConversations, 'revision').mockReturnValue(options.view.revision)
  }
  if (options.subagents !== undefined) ctx.set('subagents', options.subagents as never)
  if (options.uiImages !== undefined) ctx.provide('mayflyUiImages', options.uiImages as never)
  if (options.retract !== undefined) {
    ctx.set('mayflyRetractions', { tryRetract: options.retract })
  }
  if (options.appExit !== undefined) ctx.provide('appExit', options.appExit)
  const fiber = await ctx.plugin(inputPlugin)
  const editor = components.editors.at(-1)!
  const editorRoot = screen.children[0] as MayflyFocusable & MayflyComponent
  const hint: MayflyComponent = {
    render: width => editorRoot.render(width).slice(editor.render(width).length + 2),
    invalidate: () => editorRoot.invalidate(),
  }
  noticeLanes.set(hint, ctx)
  // The terminal paints one frame before it can deliver focused input. The
  // shell compiler synchronizes its nested editor focus during that frame.
  editorRoot.render(screen.columns)
  return { ctx, screen, editor, editorRoot, hint, agent, followup, cancel, steer, fiber }
}

function type(editor: FakeMayflyEditor, text: string): void {
  for (const char of text) editor.handleInput(char)
}

describe('mayfly-input plugin', () => {
  it('declares every direct service used by request, retraction, and extension paths', () => {
    expect(inputPlugin.inject).toContain('sessionProjections')
    expect(inputPlugin.inject).toContain('mayflyRequests')
    expect(inputPlugin.inject).toContain('mayflyRetractions')
    expect(inputPlugin.inject).toContain('mayflyEditorExtensions')
    expect(inputPlugin.inject).toContain('mayflyOverlays')
  })

  it('mounts the editor and hint line focused at the bottom of the tree', async () => {
    const { ctx, screen, editor, editorRoot, hint } = await mount()
    expect(screen.children).toEqual([editorRoot])
    expect(screen.focused).toBe(editorRoot)
    expect(editor.focused).toBe(true)
    // The editor mounts as a plain prompt (its frame is the Editor component's, around the buffer) and the hint
    // row renders nothing at rest (the persistent tier retired with S15).
    expect(editor.shellMode).toBe(false)
    expect((ctx.mayflyComponents as unknown as FakeMayflyComponents).editorOptions[0]).toBeUndefined()
    expect(hint.render(80)).toEqual([])
    hint.invalidate()
  })

  it('mirrors the current session title into the editor frame while session facts exist', async () => {
    const { ctx, screen, editorRoot, fiber } = await mount()
    const top = (): string => editorRoot.render(80)[0] ?? ''
    expect(top()).not.toContain('dock-transcript-redesign')
    const listeners = new Set<(title: string | undefined) => void>()
    const facts = {
      subscribeTitle(listener: (title: string | undefined) => void) {
        listeners.add(listener)
        listener('dock-transcript-redesign')
        return () => { listeners.delete(listener) }
      },
    }
    const renders = screen.renderRequests
    const offFacts = ctx.provide('mayflySessionFacts', facts as never)
    await vi.waitFor(() => { expect(top()).toContain('#dock-transcript-redesign') })
    expect(screen.renderRequests).toBeGreaterThan(renders)
    for (const listener of listeners) listener(undefined)
    expect(top()).not.toContain('dock-transcript-redesign')
    for (const listener of listeners) listener('renamed')
    expect(top()).toContain('#renamed')

    offFacts()
    await vi.waitFor(() => { expect(listeners.size).toBe(0) })
    expect(top()).not.toContain('renamed')

    ctx.provide('mayflySessionFacts', facts as never)
    await vi.waitFor(() => { expect(top()).toContain('#dock-transcript-redesign') })
    await fiber.dispose()
    await vi.waitFor(() => { expect(listeners.size).toBe(0) })
  })

  it('stays pinned below transcript content mounted after it', async () => {
    const { screen, editorRoot } = await mount()
    // Transcript components only mount once a session exists — long after
    // the editor — yet must render above it.
    const transcriptRow: Parameters<FakeScreen['addChild']>[0] = { render: () => ['transcript'], invalidate: () => {} }
    screen.addChild(transcriptRow)
    expect(screen.children).toEqual([transcriptRow, editorRoot])
  })

  it('pages the transcript from the editor and resumes the tail on End', async () => {
    const { ctx, screen, editor, editorRoot, hint, fiber } = await mount()
    screen.contentScrollResult = true
    screen.contentPaused = true
    let jumps = 0
    ctx.on('mayfly/request-new-messages', () => { jumps += 1 })

    type(editor, 'draft')
    expect(screen.sendContentInput('\x1b[5~')).toBe(true)
    expect(screen.sendContentInput('\x1b[6~')).toBe(true)
    expect(screen.sendContentInput(KEY.up)).toBe(false)
    expect(screen.sendContentInput(KEY.down)).toBe(false)
    expect(screen.contentScrolls).toEqual([
      { direction: 'up', amount: 20 },
      { direction: 'down', amount: 20 },
    ])
    expect(screen.sendContentInput('\x1b[F')).toBe(false)
    // Ctrl+↓ asks for the messages that arrived while away even with a draft, for keyboards without End.
    expect(screen.sendContentInput('\x1b[1;5B')).toBe(true)
    expect(jumps).toBe(1)
    expect(screen.followCount).toBe(0)
    editor.setText('')
    expect(screen.sendContentInput('\x1b[F')).toBe(true)
    expect(screen.followCount).toBe(1)
    expect(screen.contentPaused).toBe(false)
    expect(hint.render(80)).toEqual([])

    screen.setFocus(null)
    expect(screen.sendContentInput('x')).toBe(false)
    screen.setFocus(editorRoot)
    expect(screen.sendContentInput('x')).toBe(false)

    await fiber.dispose()
    expect(screen.sendContentInput('\x1b[F')).toBe(false)
  })

  it('publishes the editor and submit router through the shared reference', async () => {
    const { ctx, editor } = await mount()
    const shared = getSharedEditor(ctx)
    expect(shared?.editor).toBe(editor)
    expect(shared?.submitPrompt).toBeTypeOf('function')
    type(editor, 'clear me')
    shared?.abortPrompt?.()
    expect(editor.getText()).toBe('')
  })

  it('abortPrompt interrupts a running flow and preserves the draft', async () => {
    const { ctx, editor, cancel } = await mount({ running: true })
    type(editor, 'keep me')
    getSharedEditor(ctx)?.abortPrompt?.()
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(editor.getText()).toBe('keep me')
  })

  it('abortPrompt clears the draft when no session is attached', async () => {
    const { ctx, editor } = await mount({ withAgent: false })
    type(editor, 'no session draft')
    getSharedEditor(ctx)?.abortPrompt?.()
    expect(editor.getText()).toBe('')
  })

  it('clears input-owned navigation feedback when the session switch settles', async () => {
    const { ctx, hint, agent } = await mount()
    getSharedEditor(ctx)?.report?.('navigation', { message: 'creating rewind branch...', severity: 'info' })
    expect(noticesOf(hint)).toEqual(['^ℹ ^creating rewind branch...'])
    ctx.emit('test/session-changed', agent)
    expect(hint.render(80)).toEqual([])
    ;(ctx.get('testSession') as { current: Agent | null }).current = null
    ctx.emit('test/session-changed', null)
  })

  it('submits plain text as a user follow-up message, records history, and clears the buffer', async () => {
    const { editor, followup } = await mount()
    type(editor, 'hello there')
    editor.handleInput(KEY.enter)
    expect(followup).toHaveBeenCalledOnce()
    const message = followup.mock.calls[0]?.[0] as {
      role: string
      content: Array<{ type: string; text: string }>
      source: { kind: string }
    }
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: 'hello there' }])
    expect(message.source).toEqual({ kind: 'user' })
    expect(editor.getText()).toBe('')
    expect(editor.history).toEqual(['hello there'])
  })

  it('uses the ordinary editor for BTW and records the BTW request scope', async () => {
    const view = sideView({ kind: 'btw' as const, sessionId: 'input-spec', parentSessionId: 'primary', label: 'side', access: 'interactive' as const }, 1)
    const { ctx, editor, followup } = await mount({ view })
    type(editor, 'continue the side question')
    editor.handleInput(KEY.enter)
    expect(followup).toHaveBeenCalledOnce()
    expect(ctx.mayflyRequests.active()?.scope).toBe('btw')
  })

  it('uses the BTW request scope for Ctrl+Enter steering too', async () => {
    const view = sideView({ kind: 'btw' as const, sessionId: 'input-spec', parentSessionId: 'primary', label: 'side', access: 'interactive' as const }, 2)
    const { ctx, editor, steer } = await mount({ view })
    type(editor, 'steer the side question')
    expect(editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    expect(steer).toHaveBeenCalledOnce()
    expect(ctx.mayflyRequests.active()?.scope).toBe('btw')
    expect(editor.getText()).toBe('')
  })

  it('routes interactive subagent input through the native parent address', async () => {
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'subagent-message' }))
    const interruptByParent = vi.fn()
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 2)
    const { ctx, editor, followup } = await mount({ view, subagents: { prompt, interruptByParent } })
    type(editor, 'continue the work')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      parentSessionId: 'parent',
      childSessionId: 'input-spec',
      mode: 'continuable',
      content: [{ type: 'text', text: 'continue the work' }],
    })
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.mayflyRequests.active()?.scope).toBe('subagent')
  })

  it('routes interactive subagent input when the editor lacks the draft seam', async () => {
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'subagent-message' }))
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 6)
    const { editor } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    ;(editor as { consumeSubmittedDraft?: unknown }).consumeSubmittedDraft = undefined
    type(editor, 'seamless subagent text')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: 'seamless subagent text' }],
    })
  })

  it('converts image blocks for the native subagent prompt API', async () => {
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'subagent-image-message' }))
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 3)
    const { ctx, editor } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    const ref = { ...imageRef('subagent-image'), name: 'plot.png' }
    ctx.provide('attachments', {
      readImage: async () => ({ ref, data: Uint8Array.of(1, 2, 3) }),
    } as never)
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: `extended:${request.text}` }))

    type(editor, '[image #1 70 B] caption')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      content: [
        { type: 'text', text: 'extended:caption' },
        { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'plot.png' },
      ],
    })
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.has('[image #1 70 B]')).toBe(false)
  })

  it('restores subagent text, history, and images when prompt delivery fails', async () => {
    const prompt = vi.fn(async () => { throw 'child rejected the prompt' })
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 4)
    const { ctx, editor, hint } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    const ref = imageRef('failed-subagent-image')
    ctx.provide('attachments', {
      readImage: async () => ({ ref, data: Uint8Array.of(1) }),
    } as never)
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: request.text }))

    type(editor, '[image #1 70 B] keep this')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(noticesOf(hint)).toEqual(['!✗ !!child rejected the prompt!']))
    expect(editor.getText()).toBe('[image #1 70 B] keep this')
    expect(editor.history).toEqual([])
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref)
  })

  it('contains missing attachment storage and unsupported subagent blocks', async () => {
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 40)
    const missing = await mount({ view, subagents: { prompt: vi.fn(), interruptByParent: vi.fn() } })
    const ref = imageRef('missing-store-image')
    missing.ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(missing.ctx, request => ({ text: request.text }))
    type(missing.editor, '[image #1 70 B] caption')
    missing.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(noticesOf(missing.hint)).toEqual(['!✗ !!image delivery requires the attachment store!']))
    expect(missing.ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref)
    await missing.fiber.dispose()

    const unsupported = await mount({ view, subagents: { prompt: vi.fn(), interruptByParent: vi.fn() } })
    registerSubmitTransformer(unsupported.ctx, () => [{ type: 'reasoning', text: 'not human input' } as never])
    type(unsupported.editor, 'unsupported')
    unsupported.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(noticesOf(unsupported.hint)).toEqual(['!✗ !!unsupported human prompt block: reasoning!']))
    expect(unsupported.editor.getText()).toBe('unsupported')
    await unsupported.fiber.dispose()
  })

  it('restores a subagent submission rejected before delivery starts', async () => {
    const prompt = vi.fn()
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'readonly' as const,
      }, 5)
    const { editor, hint } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    type(editor, 'keep the race-safe draft')
    editor.handleInput(KEY.enter)
    expect(prompt).not.toHaveBeenCalled()
    expect(editor.getText()).toBe('keep the race-safe draft')
    expect(editor.history).toEqual([])
    expect(noticesOf(hint)).toEqual(['!✗ !!the subagent is no longer available for input!'])
  })

  it('never sends a subagent draft once its child is no longer displayed', async () => {
    const prompt = vi.fn()
    const child = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 41)
    const rig = await mount({ view: child, subagents: { prompt, interruptByParent: vi.fn() } })
    const primary = { kind: 'primary' as const, id: 'session:parent', sessionId: 'parent', access: 'interactive' as const, residency: 'displayed' as const }
    vi.mocked(rig.ctx.mayflyConversations.displayed).mockReturnValue(primary)
    type(rig.editor, 'race-safe prompt')
    rig.editor.handleInput(KEY.enter)
    expect(prompt).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('restores subagent images after a successful prompt is safely retracted', async () => {
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'retract-subagent-message' }))
    const retract = vi.fn(() => true)
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 6)
    const { ctx, editor } = await mount({ running: true, retract, view, subagents: { prompt, interruptByParent: vi.fn() } })
    const ref = imageRef('retracted-subagent-image')
    ctx.provide('attachments', {
      readImage: async () => ({ ref, data: Uint8Array.of(1) }),
    } as never)
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: request.text }))

    type(editor, '[image #1 70 B] revise child')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(editor.onKey?.(KEY.escape)).toBe(true)
    expect(retract).toHaveBeenCalledWith('retract-subagent-message')
    expect(editor.getText()).toBe('[image #1 70 B] revise child')
    expect(editor.history).toEqual([])
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref)
  })

  it('routes Ctrl+Enter through the subagent API and preserves a readonly target draft', async () => {
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'steered-subagent-message' }))
    const interactive = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 7)
    const sent = await mount({ view: interactive, subagents: { prompt, interruptByParent: vi.fn() } })
    vi.spyOn(sent.ctx.mayflyCurrentAgent, 'current').mockReturnValue(sent.agent)
    type(sent.editor, 'steer child')
    expect(sent.editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(sent.editor.getText()).toBe('')
    expect(sent.ctx.mayflyRequests.active()?.scope).toBe('subagent')
    await sent.fiber.dispose()

    const readonly = await mount({
      view: { displayed: { ...interactive.displayed, access: 'readonly' }, revision: 8 },
      subagents: { prompt: vi.fn(), interruptByParent: vi.fn() },
    })
    type(readonly.editor, 'keep child steer')
    expect(readonly.editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    expect(readonly.editor.getText()).toBe('keep child steer')
    await readonly.fiber.dispose()
  })

  it('rolls back attachments when a pending subagent prompt fails after unload', async () => {
    const gate = Promise.withResolvers<{ messageId: string }>()
    const prompt = vi.fn(() => gate.promise)
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 9)
    const { ctx, editor, fiber } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    const ref = imageRef('late-subagent-image')
    ctx.provide('attachments', { readImage: async () => ({ ref, data: Uint8Array.of(1) }) } as never)
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: request.text }))
    type(editor, '[image #1 70 B] late child')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    await fiber.dispose()
    gate.reject(new Error('late rejection'))
    await vi.waitFor(() => expect(ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref))
  })

  it('drops a late subagent receipt after a view or Agent switch', async () => {
    const gate = Promise.withResolvers<{ messageId: string }>()
    const prompt = vi.fn(() => gate.promise)
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 50)
    const interruptByParent = vi.fn()
    const rig = await mount({ running: true, view, subagents: { prompt, interruptByParent } })
    type(rig.editor, 'late receipt')
    rig.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    vi.mocked(rig.ctx.mayflyConversations.revision).mockReturnValue(51)
    gate.resolve({ messageId: 'late-message' })
    await Promise.resolve()
    await Promise.resolve()
    expect(rig.editor.onKey?.(KEY.escape)).toBe(true)
    expect(interruptByParent).toHaveBeenCalledOnce()

    const abortGate = Promise.withResolvers<{ messageId: string }>()
    const abortPrompt = vi.fn(() => abortGate.promise)
    const aborted = await mount({ view, subagents: { prompt: abortPrompt, interruptByParent: vi.fn() } })
    type(aborted.editor, 'abort on session change')
    aborted.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(abortPrompt).toHaveBeenCalledOnce())
    const nextAgent = { ...aborted.agent, id: SessionId('next-agent') } as Agent
    ;(aborted.ctx.get('testSession') as { current: Agent | null }).current = nextAgent
    aborted.ctx.emit('test/session-changed', nextAgent)
    abortGate.resolve({ messageId: 'aborted-message' })
    await Promise.resolve()
    await aborted.fiber.dispose()
    await rig.fiber.dispose()
  })

  it('interrupts an interactive subagent through its parent address', async () => {
    const prompt = vi.fn()
    const interruptByParent = vi.fn()
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 3)
    const { editor, cancel } = await mount({ running: true, view, subagents: { prompt, interruptByParent } })
    editor.handleInput(KEY.escape)
    expect(interruptByParent).toHaveBeenCalledWith('input-spec', 'parent', 'continuable')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('leaves running descendants running when Esc interrupts the selected main Agent', async () => {
    const { ctx, editor, agent, cancel } = await mount({ running: true })
    const child = {
      id: SessionId('running-child'), status: 'running', cancel: vi.fn(),
      session: { header: { parentSession: agent.id } },
    } as unknown as Agent
    const interrupt = vi.fn()
    ctx.set('agents', {
      list: () => [agent, child],
    } as never)
    ctx.set('subagents', { interrupt, interruptByParent: vi.fn(), prompt: vi.fn() } as never)

    // Interrupt scope (interaction-model.md): Esc stops the displayed Agent's turn only.
    expect(editor.onKey?.(KEY.escape)).toBe(true)
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('leaves a running descendant of an idle main Agent alone on Esc', async () => {
    const { ctx, editor, agent, cancel } = await mount()
    const child = {
      id: SessionId('running-child'), status: 'running', cancel: vi.fn(),
      session: { header: { parentSession: agent.id } },
    } as unknown as Agent
    ctx.set('agents', {
      list: () => [agent, child],
    } as never)
    const interrupt = vi.fn()
    ctx.set('subagents', { interrupt, interruptByParent: vi.fn(), prompt: vi.fn() } as never)

    editor.onKey?.(KEY.escape)
    expect(cancel).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('ignores whitespace-only submissions', async () => {
    const { editor, followup } = await mount()
    type(editor, '   ')
    editor.handleInput(KEY.enter)
    expect(followup).not.toHaveBeenCalled()
    expect(editor.history).toEqual([])
  })

  it('restores the action failure notice when a follow-up is rejected', async () => {
    const { editor, hint, followup } = await mount()
    followup.mockImplementationOnce(() => { throw new Error('follow-up rejected') })
    type(editor, 'cannot send')
    editor.handleInput(KEY.enter)
    expect(followup).toHaveBeenCalledOnce()
    expect(noticesOf(hint)).toEqual(['!✗ !!follow-up rejected!'])

    followup.mockImplementationOnce(() => { throw 'bare follow-up rejection' })
    type(editor, 'still cannot send')
    editor.handleInput(KEY.enter)
    expect(noticesOf(hint)).toEqual(['!✗ !!bare follow-up rejection!'])
  })

  it('restores transformed image attachments when the follow-up is rejected', async () => {
    const { ctx, editor, hint, followup } = await mount()
    const ref = imageRef('rejected-extension-image')
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: `extended:${request.text}` }))
    followup.mockImplementationOnce(() => { throw new Error('extension follow-up rejected') })

    type(editor, '[image #1 70 B] caption')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(noticesOf(hint)).toEqual(['!✗ !!extension follow-up rejected!']))
    expect(followup).toHaveBeenCalledOnce()
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref)
  })

  it('routes an editor extension failure notice through the hint line', async () => {
    const { ctx, editor, hint, followup } = await mount()
    installEditorTransform(ctx, () => { throw new Error('extension transform rejected') })

    type(editor, 'keep this draft')
    editor.handleInput(KEY.enter)

    await vi.waitFor(() => expect(noticesOf(hint)).toEqual(['!✗ !!extension transform rejected!']))
    expect(editor.getText()).toBe('keep this draft')
    expect(followup).not.toHaveBeenCalled()
  })

  it('restores transformed image attachments after a safe retraction', async () => {
    const retract = vi.fn(() => true)
    const { ctx, editor, followup } = await mount({ running: true, retract })
    const ref = imageRef('retracted-extension-image')
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: `extended:${request.text}` }))

    type(editor, '[image #1 70 B] caption')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(followup).toHaveBeenCalledOnce())
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.has('[image #1 70 B]')).toBe(false)
    const message = followup.mock.calls[0]?.[0] as { readonly content: readonly { readonly type: string, readonly text?: string }[] }
    expect(message.content.map(block => block.type === 'text' ? block.text : block.type)).toEqual(['extended:caption', 'image'])

    expect(editor.onKey?.(KEY.escape)).toBe(true)
    expect(retract).toHaveBeenCalledOnce()
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref)
    expect(editor.getText()).toBe('[image #1 70 B] caption')
  })

  it('rewrites #skill tokens on the follow-up path while history keeps the original', async () => {
    const { ctx, editor, followup } = await mount()
    __setCatalogForTest(ctx, [skillOf('deploy-check')])
    type(editor, 'run #deploy-check now')
    editor.handleInput(KEY.enter)
    expect(followup).toHaveBeenCalledOnce()
    const message = followup.mock.calls[0]?.[0] as {
      content: Array<{ type: string; text: string }>
    }
    // The gesture form reaches the model; the history entry keeps the
    // `#name` the user typed (Up-recall edits what was typed).
    expect(message.content).toEqual([{ type: 'text', text: 'run /deploy-check now' }])
    expect(editor.history).toEqual(['run #deploy-check now'])
  })

  it('passes unknown #tags through untouched on the follow-up path', async () => {
    const { ctx, editor, followup } = await mount()
    __setCatalogForTest(ctx, [skillOf('deploy-check')])
    // The unknown tag stays; the trailing period breaks the recognized
    // token's end boundary, so it stays too.
    type(editor, 'see #unknown-tag and #deploy-check.')
    editor.handleInput(KEY.enter)
    const message = followup.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }> }
    expect(message.content).toEqual([{ type: 'text', text: 'see #unknown-tag and #deploy-check.' }])
  })

  it('notices instead of submitting without an attached session', async () => {
    const { screen, editor, hint } = await mount({ withAgent: false })
    type(editor, 'hello')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(noticesOf(hint)).toEqual(['!✗ !!could not start a session: no active session!']) })
    expect(screen.renderRequests).toBeGreaterThan(0)
  })

  it('keeps a draft typed into a readonly conversation and says why it was not sent', async () => {
    const view = sideView({ kind: 'subagent', sessionId: 'once', parentSessionId: 'parent', label: 'once', mode: 'one-shot', access: 'readonly' }, 4)
    const { ctx, editor, hint, followup } = await mount({ view })
    vi.spyOn(ctx.mayflyCurrentAgent, 'current').mockReturnValue(null)
    type(editor, 'please continue')
    editor.handleInput(KEY.enter)
    expect(noticesOf(hint)).toEqual(['?⚠ ??this conversation is read-only?'])
    expect(editor.getText()).toBe('please continue')
    expect(editor.history).toEqual([])
    expect(followup).not.toHaveBeenCalled()
  })

  it('seeds the editor from a plugin request for a stored child and sends only on Enter, queued for its next turn', async () => {
    const view = sideView({ kind: 'subagent', sessionId: 'cold', parentSessionId: 'parent', label: 'cold', mode: 'continuable', access: 'resumable' }, 5)
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'queued-for-cold' }))
    const { ctx, editor, followup } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    vi.spyOn(ctx.mayflyCurrentAgent, 'current').mockReturnValue(null)
    ctx.emit('mayfly/request-subagent-reply', { kind: 'subagent', sessionId: 'cold', parentSessionId: 'parent', label: 'cold', mode: 'continuable' }, 'resume with this')
    expect(editor.getText()).toBe('resume with this')
    expect(prompt).not.toHaveBeenCalled()
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      childSessionId: 'cold',
      delivery: 'queue',
      content: [{ type: 'text', text: 'resume with this' }],
    })
    expect(editor.getText()).toBe('')
    expect(followup).not.toHaveBeenCalled()
  })

  it('steers a running subagent with Ctrl+Enter', async () => {
    const view = sideView({ kind: 'subagent', sessionId: 'live', parentSessionId: 'parent', label: 'live', mode: 'continuable', access: 'interactive' }, 7)
    const prompt = vi.fn(async (_request: unknown) => ({ messageId: 'steered' }))
    const { ctx, editor, agent } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    vi.spyOn(ctx.mayflyCurrentAgent, 'current').mockReturnValue(agent)
    type(editor, 'change direction')
    expect(editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ childSessionId: 'live', delivery: 'steer' })
  })

  it('runs commands against the primary while a conversation without a driven Agent is displayed', async () => {
    const view = sideView({ kind: 'subagent', sessionId: 'once', parentSessionId: 'parent', label: 'once', mode: 'one-shot', access: 'readonly' }, 6)
    const { ctx, editor, hint, agent } = await mount({ view })
    vi.spyOn(ctx.mayflyCurrentAgent, 'current').mockReturnValue(null)
    const handler = vi.fn(() => ({ kind: 'success' as const, text: 'ran' }))
    ctx.commands.register({ name: 'poke', description: 'Poke the primary', handler })
    type(editor, '/poke')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(noticesOf(hint)).toEqual(['^ℹ ^ran']))
    expect(ctx.commands.find(agent, 'poke')).toBeDefined()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('dispatches slash commands through the real registry and logs lifecycle events', async () => {
    const { ctx, editor, hint, agent, followup } = await mount()
    ctx.commands.register({
      name: 'poke',
      description: 'Poke the test',
      handler: () => ({ kind: 'success', text: 'poked' }),
    })
    type(editor, '/poke now')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['^ℹ ^poked'])
    })
    expect(followup).not.toHaveBeenCalled()
    const events = agent.session.snapshotEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')
    expect(events.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(ctx.commands.find(agent, 'poke')).toBeDefined()
    expect(editor.history).toEqual(['/poke now'])
  })

  it('rewrites an alias line to its canonical command before dispatch', async () => {
    const { ctx, editor, hint } = await mount()
    ctx.commands.register({
      name: 'quit',
      description: 'Exit Mayfly',
      handler: (invocation) => ({ kind: 'success', text: `bye${invocation.rawInput}` }),
    })
    const clear = ctx.mayflyInteractionState.aliases.register('quit', ['q', 'exit'])
    try {
      // `/q now` reaches the `/quit` handler with its raw input intact — the
      // kimi resolution: the alias is not a registered command, the rewrite
      // happens before `ctx.commands.execute`.
      type(editor, '/q now')
      editor.handleInput(KEY.enter)
      await vi.waitFor(() => {
        expect(noticesOf(hint)).toEqual(['^ℹ ^bye now'])
      })
    } finally {
      clear()
    }
  })

  it('notices unknown commands', async () => {
    const { editor, hint } = await mount()
    type(editor, '/missing')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['!✗ !!unknown command: /missing!'])
    })
  })

  it('renders no command catalog for slash input — the dropdown owns discovery (D43)', async () => {
    const { ctx, editor, hint } = await mount()
    ctx.commands.register({
      name: 'poke',
      description: 'Poke the agent',
      handler: () => ({ kind: 'success' as const, text: 'poked' }),
    })
    ctx.commands.register({ name: 'plain', description: 'Plain command', handler: () => ({ kind: 'success' }) })
    // A match (bare slash or a prefix) renders nothing whether the dropdown
    // is up or closed — the S34 dogfood verdict retired the discovery tier
    // that double-rendered the catalog next to it; only the empty-result
    // notice below survives from the S14 tier.
    type(editor, '/')
    expect(hint.render(80)).toEqual([])
    editor.showingAutocomplete = true
    expect(hint.render(80)).toEqual([])
    editor.showingAutocomplete = false
    type(editor, 'po')
    expect(hint.render(80)).toEqual([])
    editor.setText('/plain')
    expect(hint.render(80)).toEqual([])
    hint.invalidate()
  })

  it('opens the bare /permission picker with a sibling service and dispatches only a selection', async () => {
    const { ctx, editor, hint } = await mount()
    const handler = vi.fn(() => ({ kind: 'success' as const, text: 'should not run' }))
    ctx.commands.register({ name: 'permission', description: 'spy standing in for the upstream command', handler })
    await ctx.plugin({
      name: 'test-permission-presets',
      apply(provider) {
        provider.provide('permissionPresets', {
          names: ['read-only', 'workspace-write'],
          current: () => 'workspace-write',
          resolve: (name: string) => ({ sandbox: `${name}-sandbox`, approval: 'ask' }),
          optionOf: (name: string) => ({ value: name, name }),
        })
      },
    })
    type(editor, '/permission')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')).toBeDefined() })
    const panel = ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')!
    const rendered = renderRequest(panel)
    const frame = rendered.component.render(80).join('\n')
    expect(frame).toContain('Permissions')
    expect(frame).toContain('✓')
    expect(handler).not.toHaveBeenCalled()
    expect(hint.render(80)).toEqual([])
    panel.requestClose()
    await vi.waitFor(() => expect(panel.disposed).toBe(true))
    expect(handler).not.toHaveBeenCalled()
    rendered.runtime.dispose()

    type(editor, '/permission')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')).toBeDefined())
    ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'permissions', selectedIds: ['workspace-write'] })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ rawInput: ' workspace-write' }))
    await vi.waitFor(() => expect(ctx.mayflyUiInteraction.get('overlay', 'mayfly.permission')).toBeUndefined())
  })

  it('passes a with-argument /permission line through to the command', async () => {
    const { ctx, editor, hint, screen } = await mount()
    const handler = vi.fn(() => ({ kind: 'success' as const, text: 'preset read-only' }))
    ctx.commands.register({ name: 'permission', description: 'spy standing in for the upstream command', handler })
    ctx.provide('permissionPresets', {
      names: ['read-only'],
      current: () => 'read-only',
      resolve: (name: string) => ({ sandbox: name, approval: 'ask' }),
      optionOf: (name: string) => ({ value: name, name }),
    })
    type(editor, '/permission read-only')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(noticesOf(hint)).toEqual(['^ℹ ^preset read-only']) })
    expect(handler).toHaveBeenCalledOnce()
    // No panel ever took the editor slot.
    expect(screen.children).toHaveLength(1)
  })

  it('falls through a bare /permission to unknown-command without the preset service', async () => {
    const { editor, hint } = await mount()
    type(editor, '/permission')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['!✗ !!unknown command: /permission!'])
    })
  })

  it('notices command error results and handler rejections', async () => {
    const { ctx, editor, hint } = await mount()
    ctx.commands.register({
      name: 'fail',
      description: 'Fail by result',
      handler: () => ({ kind: 'error', text: 'broken' }),
    })
    type(editor, '/fail')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['!✗ !!broken!'])
    })
    ctx.commands.register({
      name: 'throw',
      description: 'Fail by throwing',
      handler: () => {
        throw new Error('boom')
      },
    })
    type(editor, '/throw')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['!✗ !!boom!'])
    })
  })

  it('folds a multi-line command result into a summary and retains the original detail', async () => {
    const { ctx, editor, hint } = await mount()
    ctx.commands.register({
      name: 'multiline',
      description: 'Return a structured status notice',
      handler: () => ({
        kind: 'success',
        text: 'Goal created\r\nStatus: active\n\n  Activation: armed',
      }),
    })
    type(editor, '/multiline')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['^ℹ ^Goal created · Status: active · Activation: armed'])
    })
    expect(ctx.mayflyUiInteraction.notificationSnapshot().at(-1)?.detail).toBe('Goal created\nStatus: active\n\n  Activation: armed')
  })

  it('keeps successful goal output in Todo/footer surfaces while preserving errors', async () => {
    const { ctx, editor, hint, agent } = await mount()
    ctx.commands.register({
      name: 'goal',
      description: 'Manage the current goal',
      handler: invocation => invocation.rawInput === ' fail'
        ? { kind: 'error', text: 'goal failed' }
        : {
            kind: 'success',
            text: 'Goal created\nStatus: active\nObjective: harmless test\nRounds: 0/256\nActivation: armed',
          },
    })
    type(editor, '/goal create')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().some(event => event.type === 'command/done')).toBe(true)
    })
    // Successful output goes to the Todo and footer surfaces, not the notice lane.
    expect(noticesOf(hint)).toEqual([])

    type(editor, '/goal fail')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(noticesOf(hint)).toEqual(['!✗ !!goal failed!'])
    })
  })

  it('drops the result notice when the fiber unloads before the command settles', async () => {
    const { ctx, screen, editor, hint, agent, fiber } = await mount()
    // A handler gate the test settles by hand, so the unload can land while
    // execute() is still in flight — the /theme crash shape.
    const gate = Promise.withResolvers<CommandResult>()
    ctx.commands.register({
      name: 'slow',
      description: 'Settle late',
      handler: () => gate.promise,
    })
    type(editor, '/slow')
    editor.handleInput(KEY.enter)
    await fiber.dispose()
    const renderRequests = screen.renderRequests
    gate.resolve({ kind: 'success', text: 'late' })
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().some(event => event.type === 'command/done')).toBe(true)
    })
    // The continuation saw the unloaded fiber: no notice lands — the row
    // stays empty — no re-render, and no throw
    // through the dead context.
    expect(hint.render(80)).toEqual([])
    expect(screen.renderRequests).toBe(renderRequests)
  })

  it('drops the error notice when the fiber unloads before the command rejects', async () => {
    const { ctx, screen, editor, hint, agent, fiber } = await mount()
    const gate = Promise.withResolvers<CommandResult>()
    ctx.commands.register({
      name: 'late-fail',
      description: 'Reject late',
      handler: () => gate.promise,
    })
    type(editor, '/late-fail')
    editor.handleInput(KEY.enter)
    await fiber.dispose()
    const renderRequests = screen.renderRequests
    gate.reject(new Error('late boom'))
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().some(event => event.type === 'command/done')).toBe(true)
    })
    expect(hint.render(80)).toEqual([])
    expect(screen.renderRequests).toBe(renderRequests)
  })

  it('keeps only the empty-result notice for slash-prefixed input', async () => {
    const { ctx, editor, hint } = await mount()
    ctx.commands.register({ name: 'resume', description: 'Resume a previous session', handler: () => ({ kind: 'success' }) })
    ctx.commands.register({ name: 'restart', description: 'Restart everything', handler: () => ({ kind: 'success' }) })
    // A match renders nothing (D43: the dropdown owns discovery); the empty
    // result keeps its notice — the dropdown closes itself on an empty
    // match, so the notice is the only feedback.
    type(editor, '/res')
    expect(hint.render(80)).toEqual([])
    type(editor, 'x')
    expect(hint.render(80)).toEqual(['~no matching command: /resx~'])
    editor.setText('/res')
    expect(hint.render(80)).toEqual([])
  })

  it('reports an empty slash match without an attached session', async () => {
    const { editor, hint } = await mount({ withAgent: false })
    type(editor, '/res')
    expect(hint.render(80)).toEqual(['~no matching command: /res~'])
  })

  it('renders no hint row when the slash line is not a command', async () => {
    const { editor, hint } = await mount()
    type(editor, '/1')
    expect(hint.render(80)).toEqual([])
  })

  it('keeps an over-wide rejection whole in the lane; the notification pane truncates it at its cap', async () => {
    const { editor, hint } = await mount({ withAgent: false })
    type(editor, 'x'.repeat(300))
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(noticesOf(hint)).toHaveLength(1) })
    const [notice] = noticesOf(hint)
    expect(notice).toMatch(/^!✗ !/u)
    expect(notice).toContain('could not start a session')
  })

  it('renders no hint row when a command succeeds without text', async () => {
    const { ctx, editor, hint, agent } = await mount()
    ctx.commands.register({
      name: 'quiet',
      description: 'Succeed silently',
      handler: () => ({ kind: 'success' }),
    })
    type(editor, '/quiet')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().some(event => event.type === 'command/done')).toBe(true)
    })
    expect(hint.render(80)).toEqual([])
  })

  it('folds multi-line feedback into one summary and retains its detail', async () => {
    const { ctx, hint } = await mount()
    const message = Array.from({ length: 10 }, (_, index) => index === 0 ? '' : `notice ${String(index)}`).join('\n')
    getSharedEditor(ctx)?.report?.('long', { message: message.replace(/\s*[\r\n]+\s*/gu, ' · ').trim(), severity: 'info', detail: message })
    const rows = noticesOf(hint)
    expect(rows.join('')).toContain('notice 1')
    expect(ctx.mayflyUiInteraction.notificationSnapshot().at(-1)?.detail).toBe(message)
  })

  it('keeps equally severe notifications in the lane in creation order', async () => {
    const { ctx, hint } = await mount()
    const owner = ctx.mayflyUiInteraction.createNotificationOwner('input-order')
    owner.report('first', { kind: 'app', targetId: 'prompt' }, { severity: 'info', message: 'First' })
    owner.report('second', { kind: 'app', targetId: 'prompt' }, { severity: 'info', message: 'Second' })
    // The lane keeps both, in creation order; the notification pane shows the one to read first (pane-notification.spec).
    expect(noticesOf(hint)).toEqual(['^ℹ ^First', '^ℹ ^Second'])
    owner.dispose()
  })

  it('contains synchronous hint refresh reentry from invalid extension feedback', async () => {
    const { ctx, hint } = await mount()
    ctx.mayflyEditorExtensions.register({ id: 'input.invalid-after' }, { after: { kind: 'actions', id: 'interactive-after', items: [] } as never })
    expect(noticesOf(hint).join('\n')).toContain('editor extension after must be passive')
  })

  it('renders no persistent row in any state — the footer tips teach the affordances', async () => {
    // The S15 dogfood verdict retired the persistent key-affordance tier:
    // idle, running, and with every enhancement attached, the hint row
    // stays empty unless a notice or slash feedback owns it.
    const idle = await mount()
    expect(idle.hint.render(80)).toEqual([])
    await idle.fiber.dispose()

    const running = await mount({ running: true })
    expect(running.hint.render(80)).toEqual([])
    await running.fiber.dispose()
  })

  it('unmounts the editor, clears the shared reference, and releases focus on dispose', async () => {
    const { ctx, screen, fiber } = await mount()
    expect(screen.children).toHaveLength(1)
    expect(getSharedEditor(ctx)).toBeDefined()
    await fiber.dispose()
    expect(screen.children).toHaveLength(0)
    expect(screen.focused).toBeNull()
    expect(getSharedEditor(ctx)).toBeUndefined()
  })

  it('restores the prompt history across the theme-swap reload', async () => {
    // `/theme <name>` rebuilds this fiber as its own effect: the editor
    // component (and pi-tui's in-component history) dies with it. The
    // stash mirrors the history at submit time and the remount replays it.
    const first = await mount()
    type(first.editor, 'hello')
    first.editor.handleInput(KEY.enter)
    type(first.editor, '/theme dark')
    first.editor.handleInput(KEY.enter)
    expect(first.editor.history).toEqual(['/theme dark', 'hello'])
    await first.fiber.dispose()
    await first.ctx.plugin(inputPlugin)
    const second = (first.ctx.mayflyComponents as unknown as FakeMayflyComponents).editors.at(-1)!
    expect(second.history).toEqual(['/theme dark', 'hello'])
  })

  describe('editor-context keys', () => {
    it('interrupts a running agent on Escape and preserves the draft', async () => {
      const { editor, cancel } = await mount({ running: true })
      type(editor, 'draft')
      expect(editor.onKey?.(KEY.escape)).toBe(true)
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
      expect(editor.getText()).toBe('draft')
    })

    it('latches the app-owned stop request when Escape interrupts', async () => {
      const { ctx, editor } = await mount({ running: true })
      expect(ctx.mayflyRequests.stopPending()).toBe(false)
      expect(editor.onKey?.(KEY.escape)).toBe(true)
      expect(ctx.mayflyRequests.stopPending()).toBe(true)
    })

    it('clears the buffer on Escape when text is present and the agent is idle, keeping it one Up away', async () => {
      const { editor, cancel, hint } = await mount()
      type(editor, 'draft')
      editor.handleInput(KEY.escape)
      expect(editor.getText()).toBe('')
      expect(editor.getHistory()[0]).toBe('draft')
      expect(noticesOf(hint).join('')).toContain('draft cleared · ↑ restores')
      expect(cancel).not.toHaveBeenCalled()
    })

    it('interrupts a running agent on Escape with an empty buffer', async () => {
      const { editor, cancel } = await mount({ running: true })
      expect(editor.onKey?.(KEY.escape)).toBe(true)
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    })

    it('restores the submitted message and removes its history entry after a safe Escape retraction', async () => {
      const retract = vi.fn(() => true)
      const { ctx, editor, followup, cancel } = await mount({ running: true, retract })
      type(editor, 'revise this prompt')
      editor.handleInput(KEY.enter)
      const message = followup.mock.calls[0]?.[0] as { id: string }
      expect(editor.getText()).toBe('')
      expect(editor.history).toEqual(['revise this prompt'])

      // Status, command, and mode updates republish the same session. They
      // are not session switches and must not discard the receipt.
      ctx.emit('test/session-changed', ctx.mayflyCurrentAgent.current())
      expect(editor.onKey?.(KEY.escape)).toBe(true)
      expect(retract).toHaveBeenCalledWith(String(message.id))
      expect(editor.getText()).toBe('revise this prompt')
      expect(editor.history).toEqual([])
      expect(cancel).not.toHaveBeenCalled()
    })

    it('interrupts without retracting on Escape when a draft is present', async () => {
      const retract = vi.fn(() => true)
      const { editor, followup, cancel } = await mount({ running: true, retract })
      type(editor, 'first message')
      editor.handleInput(KEY.enter)
      expect(followup).toHaveBeenCalledOnce()
      type(editor, 'new draft')

      expect(editor.onKey?.(KEY.escape)).toBe(true)
      expect(retract).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
      expect(editor.getText()).toBe('new draft')
    })

    it('passes Escape through with an empty buffer and an idle agent', async () => {
      const { editor, cancel } = await mount()
      expect(editor.onKey?.(KEY.escape)).toBe(false)
      expect(cancel).not.toHaveBeenCalled()
    })

    it('passes Escape through with an empty buffer and no session', async () => {
      const { editor } = await mount({ withAgent: false })
      expect(editor.onKey?.(KEY.escape)).toBe(false)
    })

    it('lets the editor close an open autocomplete dropdown on Escape', async () => {
      const { editor, cancel } = await mount({ running: true })
      editor.showingAutocomplete = true
      type(editor, 'draft')
      expect(editor.onKey?.(KEY.escape)).toBe(false)
      expect(editor.getText()).toBe('draft')
      expect(cancel).not.toHaveBeenCalled()
    })

    it('clears a next-message draft on Ctrl-C without interrupting the running flow', async () => {
      const { editor, cancel } = await mount({ running: true })
      type(editor, 'draft')
      expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
      expect(editor.getText()).toBe('')
      expect(cancel).not.toHaveBeenCalled()
    })

    it('interrupts a running agent on Ctrl-C with an empty buffer', async () => {
      const { ctx, editor, cancel } = await mount({ running: true })
      expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
      expect(ctx.mayflyRequests.stopPending()).toBe(true)
    })

    it('never arms the exit while a session flow is in progress', async () => {
      const exit = vi.fn()
      const { editor } = await mount({ running: true, appExit: exit })
      vi.useFakeTimers()
      try {
        vi.setSystemTime(5_000_000)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        vi.setSystemTime(5_000_500)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        expect(exit).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('never retracts the submitted message on Ctrl-C', async () => {
      const retract = vi.fn(() => true)
      const { editor, followup, cancel } = await mount({ running: true, retract })
      type(editor, 'interrupt without retracting')
      editor.handleInput(KEY.enter)
      expect(followup).toHaveBeenCalledOnce()

      expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
      expect(retract).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
      expect(editor.getText()).toBe('')
      expect(editor.history).toEqual(['interrupt without retracting'])
    })

    it('still clears an idle draft when there is no work to interrupt', async () => {
      const { ctx, editor, cancel } = await mount()
      type(editor, 'idle draft')
      editor.handleInput(KEY.ctrlC)
      expect(editor.getText()).toBe('')
      expect(cancel).not.toHaveBeenCalled()
      expect(ctx.mayflyRequests.stopPending()).toBe(false)
    })

    it('flashes the exit hint on the first idle Ctrl-C', async () => {
      const { editor, hint } = await mount()
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000_000)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        expect(noticesOf(hint)).toEqual(['?⚠ ??press Ctrl+C again to exit?'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('exits through the launcher hook on a second idle Ctrl-C within the window', async () => {
      const exit = vi.fn()
      const { editor, cancel } = await mount({ appExit: exit })
      vi.useFakeTimers()
      try {
        vi.setSystemTime(2_000_000)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        expect(exit).not.toHaveBeenCalled()
        vi.setSystemTime(2_000_500)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        expect(exit).toHaveBeenCalledWith(0)
        expect(cancel).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('re-arms the hint when the double-press window expires', async () => {
      const exit = vi.fn()
      const { editor, hint } = await mount({ appExit: exit })
      vi.useFakeTimers()
      try {
        vi.setSystemTime(3_000_000)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        vi.setSystemTime(3_002_000)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        expect(exit).not.toHaveBeenCalled()
        expect(noticesOf(hint)).toEqual(['?⚠ ??press Ctrl+C again to exit?'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('consumes the double press when the launcher provided no appExit hook', async () => {
      const { editor } = await mount()
      vi.useFakeTimers()
      try {
        vi.setSystemTime(4_000_000)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
        vi.setSystemTime(4_000_500)
        expect(editor.onKey?.(KEY.ctrlC)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('steers the current turn with the draft on Ctrl+Enter and clears the buffer', async () => {
      const { editor, steer } = await mount()
      type(editor, 'steer this')
      editor.handleInput(KEY.ctrlEnter)
      expect(steer).toHaveBeenCalledOnce()
      const message = steer.mock.calls[0]?.[0] as {
        role: string
        content: Array<{ type: string, text: string }>
        source: { kind: string }
      }
      expect(message.role).toBe('user')
      expect(message.content).toEqual([{ type: 'text', text: 'steer this' }])
      expect(message.source).toEqual({ kind: 'user' })
      expect(editor.getText()).toBe('')
    })

    it('rewrites #skill tokens on the Ctrl+Enter steer path too', async () => {
      const { ctx, editor, steer } = await mount()
      __setCatalogForTest(ctx, [skillOf('deploy-check')])
      type(editor, 'steer #deploy-check')
      editor.handleInput(KEY.ctrlEnter)
      expect(steer).toHaveBeenCalledOnce()
      const message = steer.mock.calls[0]?.[0] as { content: Array<{ type: string, text: string }> }
      expect(message.content).toEqual([{ type: 'text', text: 'steer /deploy-check' }])
    })

    it('keeps the draft when the structured steer action is rejected', async () => {
      const { editor, hint, steer } = await mount()
      steer.mockImplementationOnce(() => { throw new Error('steer rejected') })
      type(editor, 'keep this')
      expect(editor.onKey?.(KEY.ctrlEnter)).toBe(true)
      expect(editor.getText()).toBe('keep this')
      expect(steer).toHaveBeenCalledOnce()

      steer.mockImplementationOnce(() => { throw 'bare steer rejection' })
      expect(editor.onKey?.(KEY.ctrlEnter)).toBe(true)
      expect(noticesOf(hint)).toEqual(['!✗ !!bare steer rejection!'])
    })

    it('dispatches Shift+Tab through the native plan command', async () => {
      const { ctx, editor } = await mount()
      const plan = vi.fn(() => ({ kind: 'success' as const, text: 'plan enabled' }))
      ctx.commands.register({ name: 'plan', description: 'Toggle plan mode', handler: plan })
      vi.spyOn(ctx.sessionProjections, 'snapshot').mockReturnValue({
        asOfSeq: -1,
        values: { plan: { active: false, pending: false } },
      })
      expect(editor.onKey?.(KEY.shiftTab)).toBe(true)
      await vi.waitFor(() => expect(plan).toHaveBeenCalledOnce())
    })

    it('passes Ctrl+Enter through with an empty buffer', async () => {
      const { editor, steer } = await mount()
      expect(editor.onKey?.(KEY.ctrlEnter)).toBe(false)
      expect(steer).not.toHaveBeenCalled()
    })

    it('passes Ctrl+Enter through without a session', async () => {
      const { editor } = await mount({ withAgent: false })
      type(editor, 'draft')
      expect(editor.onKey?.(KEY.ctrlEnter)).toBe(false)
      expect(editor.getText()).toBe('draft')
    })
  })

  describe('external editor (Ctrl-G, S31)', () => {
    const savedVisual = process.env.VISUAL
    const savedEditor = process.env.EDITOR

    beforeEach(() => {
      process.env.VISUAL = 'mayfly-spec-editor'
    })

    afterEach(() => {
      process.env.VISUAL = savedVisual
      process.env.EDITOR = savedEditor
      setExternalEditorLauncher(undefined)
    })

    /** Install a recording launcher; `impl` decides each call's outcome. */
    function fakeLauncher(impl: (seed: string) => Promise<string | undefined>): string[] {
      const seeds: string[] = []
      setExternalEditorLauncher((seed, command) => {
        seeds.push(`${command}: ${seed}`)
        return impl(seed)
      })
      return seeds
    }

    /** Let the async flow settle past its final await chain. */
    async function settle(): Promise<void> {
      await new Promise<void>(resolve => {
        setImmediate(resolve)
      })
    }

    it('hands the draft over, suspends once, and writes the edit back with the mirrors synced', async () => {
      const { ctx, editor, screen } = await mount()
      const seeds = fakeLauncher(() => Promise.resolve('edited\r\n\r\n'))
      type(editor, 'draft here')
      editor.handleInput(KEY.ctrlG)
      await vi.waitFor(() => {
        expect(editor.getText()).toBe('edited\n')
      })
      // The seed is the expanded draft and the command is the resolved
      // $VISUAL; the CRLF pair collapses and one trailing newline drops.
      expect(seeds).toEqual(['mayfly-spec-editor: draft here'])
      expect(screen.suspends).toBe(1)
      expect(ctx.mayflyInteractionState.draft.getStashedDraft()?.raw).toBe('edited\n')
    })

    it('keeps the draft untouched on a nonzero editor exit (:cq)', async () => {
      const { ctx, editor, screen, hint } = await mount()
      fakeLauncher(() => Promise.resolve(undefined))
      type(editor, 'keep me')
      editor.handleInput(KEY.ctrlG)
      await vi.waitFor(() => {
        expect(screen.suspends).toBe(1)
      })
      await settle()
      expect(editor.getText()).toBe('keep me')
      expect(ctx.mayflyInteractionState.draft.getStashedDraft()?.raw).toBe('keep me')
      expect(hint.render(80)).toEqual([])
    })

    it('notices instead of suspending when no editor is configured', async () => {
      process.env.VISUAL = ''
      process.env.EDITOR = ''
      const { editor, screen, hint } = await mount()
      expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
      expect(screen.suspends).toBe(0)
      expect(noticesOf(hint)).toEqual(['?⚠ ??set $VISUAL or $EDITOR to edit drafts externally?'])
    })

    it('notices a launcher failure and re-arms for the next press', async () => {
      const { editor, screen, hint } = await mount()
      let outcome: Promise<string | undefined> = Promise.reject(new Error('editor gone'))
      fakeLauncher(() => outcome)
      editor.handleInput(KEY.ctrlG)
      await vi.waitFor(() => {
        expect(noticesOf(hint)).toEqual(['!✗ !!editor gone!'])
      })
      expect(screen.suspends).toBe(1)
      // A non-Error rejection stringifies into the notice.
      outcome = Promise.reject('plain failure')
      editor.handleInput(KEY.ctrlG)
      await vi.waitFor(() => {
        expect(noticesOf(hint)).toEqual(['!✗ !!plain failure!'])
      })
      expect(screen.suspends).toBe(2)
      outcome = Promise.resolve('second try')
      editor.handleInput(KEY.ctrlG)
      await vi.waitFor(() => {
        expect(editor.getText()).toBe('second try')
      })
      expect(screen.suspends).toBe(3)
    })

    it('consumes a second Ctrl-G while a session is in flight and re-arms after', async () => {
      const { editor, screen } = await mount()
      const gate = Promise.withResolvers<string | undefined>()
      fakeLauncher(() => gate.promise)
      editor.handleInput(KEY.ctrlG)
      expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
      expect(screen.suspends).toBe(1)
      gate.resolve('late edit')
      await vi.waitFor(() => {
        expect(editor.getText()).toBe('late edit')
      })
      expect(screen.suspends).toBe(1)
      editor.handleInput(KEY.ctrlG)
      await vi.waitFor(() => {
        expect(screen.suspends).toBe(2)
      })
    })

    it('leaves the draft alone when the fiber unloads mid-session', async () => {
      const { editor, screen, fiber } = await mount()
      const gate = Promise.withResolvers<string | undefined>()
      fakeLauncher(() => gate.promise)
      type(editor, 'draft survives')
      editor.handleInput(KEY.ctrlG)
      await fiber.dispose()
      gate.resolve('must not land')
      await settle()
      expect(editor.getText()).toBe('draft survives')
      expect(screen.suspends).toBe(1)
    })

    it('drops the failure notice when the fiber unloads before the launcher rejects', async () => {
      const { editor, hint, fiber } = await mount()
      const gate = Promise.withResolvers<string | undefined>()
      fakeLauncher(() => gate.promise)
      editor.handleInput(KEY.ctrlG)
      await fiber.dispose()
      gate.reject(new Error('late boom'))
      await settle()
      expect(hint.render(80)).toEqual([])
    })
  })

  describe('entering the views', () => {
    it.each([['Alt+Down', KEY.altDown], ['F5', KEY.f5]])('enters the views on %s with an empty prompt', async (_name, key) => {
      const { editor, screen } = await mount()
      screen.enterViewsResult = true
      expect(editor.onKey?.(key)).toBe(true)
      expect(screen.enterViewsCalls).toBe(1)
    })

    it('leaves the key to the editor when no view can be entered, the buffer has text, or a completion list is open', async () => {
      const { editor, screen } = await mount()
      expect(editor.onKey?.(KEY.altDown)).toBe(false)
      expect(screen.enterViewsCalls).toBe(1)
      screen.enterViewsResult = true
      editor.setText('draft')
      expect(editor.onKey?.(KEY.altDown)).toBe(false)
      editor.setText('')
      editor.showingAutocomplete = true
      expect(editor.onKey?.(KEY.altDown)).toBe(false)
      expect(screen.enterViewsCalls).toBe(1)
    })
  })

  describe('queued-message actions (e, s, d, u)', () => {
    it('edit takes a queued message out of its lane into the prompt', async () => {
      const inbox = fakeInbox({ nextTurn: [queued('first'), queued('second')] })
      const { ctx, editor } = await mount({ inbox })
      ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextTurn[1]!.id))
      expect(inbox.remove).toHaveBeenCalledOnce()
      expect(inbox.remove).toHaveBeenCalledWith(inbox.nextTurn[1]!.id)
      expect(editor.getText()).toBe('second')
    })

    it('steer moves a queued message into the steer lane', async () => {
      const inbox = fakeInbox({ nextTurn: [queued('follow-up')] })
      const { ctx, steer } = await mount({ inbox })
      ctx.emit('mayfly/queued-action', 'steer', String(inbox.nextTurn[0]!.id))
      expect(inbox.remove).toHaveBeenCalledWith(inbox.nextTurn[0]!.id)
      expect(steer).toHaveBeenCalledOnce()
    })

    it('cancel leaves the message out, and undo within eight seconds returns it to its lane', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      try {
        const inbox = fakeInbox({ nextTurn: [queued('later')] })
        const { ctx, followup, editor } = await mount({ inbox })
        ctx.emit('mayfly/queued-action', 'cancel', String(inbox.nextTurn[0]!.id))
        expect(inbox.remove).toHaveBeenCalledWith(inbox.nextTurn[0]!.id)
        expect(editor.getText()).toBe('')
        now.mockReturnValue(1_000 + 7_000)
        ctx.emit('mayfly/queued-action', 'undo', undefined)
        expect(followup).toHaveBeenCalledOnce()
      } finally {
        now.mockRestore()
      }
    })

    it('undo after the eight-second window does nothing', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      try {
        const inbox = fakeInbox({ nextTurn: [queued('later')] })
        const { ctx, followup } = await mount({ inbox })
        ctx.emit('mayfly/queued-action', 'cancel', String(inbox.nextTurn[0]!.id))
        now.mockReturnValue(1_000 + 8_001)
        ctx.emit('mayfly/queued-action', 'undo', undefined)
        expect(followup).not.toHaveBeenCalled()
      } finally {
        now.mockRestore()
      }
    })

    it('says the agent already read a message that is no longer queued', async () => {
      const inbox = fakeInbox({ nextTurn: [queued('read')], remove: () => false })
      const { ctx, editor, hint } = await mount({ inbox })
      ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextTurn[0]!.id))
      expect(noticesOf(hint).join('\n')).toContain('The agent already read it')
      expect(editor.getText()).toBe('')
    })

    it('does nothing for an id that is not queued', async () => {
      const inbox = fakeInbox({ nextTurn: [queued('here')] })
      const { ctx, editor } = await mount({ inbox })
      ctx.emit('mayfly/queued-action', 'edit', 'missing')
      expect(inbox.remove).not.toHaveBeenCalled()
      expect(editor.getText()).toBe('')
    })
  })

})

describe('the Alt+M model cycle key', () => {
  it('switches the session model without touching the draft', async () => {
    const writes: unknown[] = []
    const state = { current: { provider: 'mock', model: 'mock' } }
    const modelRef = {
      get current() { return state.current },
      set current(next: { provider: string, model: string }) { state.current = next; writes.push(next) },
    }
    const { ctx, editor } = await mount({ modelRef })
    ctx.provide('llm', {
      listModels: async () => [{ id: 'mock', name: 'Mock' }, { id: 'mock-pro', name: 'Mock Pro' }],
    } as never)
    type(editor, 'keep this draft')
    editor.handleInput(KEY.altM)
    // The press is consumed before the Editor sees it, so the draft
    // survives byte for byte — the point of the hotkey.
    expect(editor.getText()).toBe('keep this draft')
    await vi.waitFor(() => { expect(ctx.mayflyUiInteraction.notificationSnapshot()).toHaveLength(1) })
    expect(ctx.mayflyUiInteraction.notificationSnapshot()[0]!.message).toBe('Switched to mock-pro (mock)')
    expect(writes).toEqual([{ provider: 'mock', model: 'mock-pro' }])
  })

  it('still consumes the press without a session, flashing the guard notice', async () => {
    const { ctx, editor } = await mount({ withAgent: false })
    type(editor, 'draft')
    editor.handleInput(KEY.altM)
    expect(editor.getText()).toBe('draft')
    await vi.waitFor(() => { expect(ctx.mayflyUiInteraction.notificationSnapshot().map(item => item.message)).toEqual(['the model selection is unavailable']) })
  })
})

describe('the prompt beside the conversation', () => {
  it.each([['Alt+Up', 'alt+up'], ['F4', 'f4']])('moves focus up into the conversation on %s with an empty prompt', async (_name, key) => {
    const { editor, screen } = await mount()
    screen.focusConversationResult = true
    expect(editor.onKey?.(key)).toBe(true)
    expect(screen.focusConversationCalls).toBe(1)
  })

  it('leaves the key to the editor when the conversation cannot take focus or a completion list is open', async () => {
    const { editor, screen } = await mount()
    expect(editor.onKey?.('alt+up')).toBe(false)
    expect(screen.focusConversationCalls).toBe(1)
    // A draft does not hold the key: Alt+↑ reaches the queued rows whatever the buffer holds.
    screen.focusConversationResult = true
    editor.setText('draft')
    expect(editor.onKey?.('alt+up')).toBe(true)
    editor.setText('')
    editor.showingAutocomplete = true
    expect(editor.onKey?.('alt+up')).toBe(false)
    expect(screen.focusConversationCalls).toBe(2)
  })

  it('scrolls the transcript three rows per wheel notch while the prompt is focused, whatever the buffer holds', async () => {
    const { editor, screen } = await mount()
    type(editor, 'draft')
    expect(screen.sendContentInput('\x1b[<64;10;5M')).toBe(true)
    expect(screen.sendContentInput('\x1b[<65;10;5M')).toBe(true)
    expect(screen.contentScrolls).toEqual([{ direction: 'up', amount: 3 }, { direction: 'down', amount: 3 }])
  })

  it('leaves a wheel notch to the core when the keymap binds neither direction to the arrows', async () => {
    const { ctx, screen } = await mount()
    const matches = ctx.mayflyKeymap.matches.bind(ctx.mayflyKeymap)
    vi.spyOn(ctx.mayflyKeymap, 'matches').mockImplementation((data, action) => action !== ACTION_MOVE_UP && action !== ACTION_MOVE_DOWN && matches(data, action))
    expect(screen.sendContentInput('\x1b[<64;10;5M')).toBe(false)
    expect(screen.sendContentInput('\x1b[<65;10;5M')).toBe(false)
    expect(screen.contentScrolls).toEqual([])
  })
})

describe('slash feedback and command failures', () => {
  it('filters commands that advertise an input hint like any other when nothing matches', async () => {
    const { ctx, editor, hint } = await mount()
    ctx.commands.register({ name: 'deploy', description: 'Deploy a build', input: { hint: '<environment>' }, handler: () => ({ kind: 'success' }) })
    type(editor, '/dep')
    expect(hint.render(80)).toEqual([])
    type(editor, 'qz')
    expect(hint.render(80)).toEqual(['~no matching command: /depqz~'])
  })

  it('shows a non-Error rejection of the command runtime as the notice text', async () => {
    const { ctx, editor, hint } = await mount()
    vi.spyOn(ctx.commands, 'execute').mockRejectedValue('runtime exploded')
    type(editor, '/anything')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => { expect(noticesOf(hint)).toEqual(['!✗ !!runtime exploded!']) })
  })

  it('does not re-enter the footer refresh when a presentation change edits the buffer', async () => {
    const { editor, screen } = await mount()
    let nested = 0
    const requestRender = screen.requestRender.bind(screen)
    vi.spyOn(screen, 'requestRender').mockImplementation(() => {
      requestRender()
      if (nested > 0) return
      nested += 1
      // A render observer that edits the draft while the footer is being recompiled.
      editor.setText('/nested')
    })
    type(editor, '/')
    expect(nested).toBe(1)
    expect(editor.getText()).toBe('/nested')
  })
})

describe('editor token actions', () => {
  const savedVisual = process.env.VISUAL
  beforeEach(() => {
    process.env.VISUAL = 'mayfly-spec-editor'
  })
  afterEach(() => {
    process.env.VISUAL = savedVisual
    setExternalEditorLauncher(undefined)
  })

  it('lets the editor take a token on Backspace, and passes the key on when it has none', async () => {
    const { editor } = await mount()
    editor.backspaceTakesToken = true
    expect(editor.onKey?.(KEY.backspace)).toBe(true)
    editor.backspaceTakesToken = false
    expect(editor.onKey?.(KEY.backspace)).toBe(false)
  })

  it('shows an image token in a preview overlay, and does nothing for an image the tree no longer holds', async () => {
    const { ctx, editor } = await mount()
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', imageRef('preview-image'))
    editor.token = { kind: 'image', text: '[image #1 70 B]', selected: false }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toContain('mayfly.image-preview')
    editor.token = { kind: 'image', text: '[image #9 1 B]', selected: false }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    expect(ctx.mayflyOverlays.list().filter(entry => entry.id === 'mayfly.image-preview')).toHaveLength(1)
  })

  it('notices a mentioned file that is gone instead of opening it', async () => {
    const { editor, hint } = await mount()
    setExternalEditorLauncher(() => Promise.resolve(undefined))
    editor.token = { kind: 'mention', text: '@no-such-file-here.ts', selected: false }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('no-such-file-here.ts does not exist'))
  })

  it('opens an existing mentioned file in the external editor, suspending the screen once', async () => {
    const { editor, screen } = await mount()
    const launches: string[] = []
    setExternalEditorLauncher((seed, command) => {
      launches.push(`${command}:${seed}`)
      return Promise.resolve(undefined)
    })
    editor.token = { kind: 'mention', text: `@${process.cwd()}/package.json`, selected: false }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(screen.suspends).toBe(1))
    expect(launches).toEqual([])
  })

  it('opens a pasted block as text and puts the saved text in its place', async () => {
    const { editor, screen } = await mount()
    setExternalEditorLauncher(seed => Promise.resolve(`${seed}!`))
    editor.token = { kind: 'paste', text: '[paste #1 +3 lines]', selected: false, content: 'a\nb\nc' }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(editor.replaced).toEqual(['a\nb\nc!']))
    expect(screen.suspends).toBe(1)
  })

  it('opens the focused file of the @ list with Ctrl-G, and leaves a folder row to the Enter key', async () => {
    const { editor, screen } = await mount()
    setExternalEditorLauncher(() => Promise.resolve(undefined))
    editor.showingAutocomplete = true
    editor.completionView = {
      kind: 'files',
      prefix: '@',
      index: 0,
      items: [{ label: 'src/a.ts', value: `@${process.cwd()}/package.json` }, { label: 'src/', value: '@src/' }],
    }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(screen.suspends).toBe(1))
    editor.completionView = { ...editor.completionView, index: 1 }
    expect(editor.onKey?.(KEY.enter)).toBe(true)
    expect(editor.inserted).toContain(' ')
  })
})

describe('queued messages: restore records', () => {
  it('edits a sent message back into the prompt, moving a draft that was typed meanwhile into the history', async () => {
    const inbox = fakeInbox()
    const rig = await mount({ running: true, inbox })
    rig.followup.mockImplementation((message: UserMessage) => { inbox.nextTurn.push(message) })
    type(rig.editor, 'hello')
    rig.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(inbox.nextTurn).toHaveLength(1))
    type(rig.editor, 'draft')
    rig.ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextTurn[0]!.id))
    expect(rig.editor.getText()).toBe('hello')
    expect(rig.editor.history).toContain('draft')
  })

  it('steers a queued message, keeping its restore record while it waits in the steer lane', async () => {
    const inbox = fakeInbox({ nextTurn: [queued('change course')] })
    const { ctx, steer } = await mount({ inbox })
    ctx.emit('mayfly/queued-action', 'steer', String(inbox.nextTurn[0]!.id))
    expect(steer).toHaveBeenCalledOnce()
  })

  it('undoes a cancelled steering message back into the steer lane', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    try {
      const inbox = fakeInbox({ nextStep: [queued('steer me')] })
      const { ctx, steer } = await mount({ inbox })
      ctx.emit('mayfly/queued-action', 'cancel', String(inbox.nextStep[0]!.id))
      ctx.emit('mayfly/queued-action', 'undo', undefined)
      expect(steer).toHaveBeenCalledOnce()
    } finally {
      now.mockRestore()
    }
  })

  it('restores an image in a sent message as a fresh marker the editor can show', async () => {
    const image = { type: 'image' as const, attachment: { attachmentId: 'queued-image', mediaType: 'image/png', bytes: 70 } }
    const message = createUserMessage({ content: [{ type: 'text', text: 'see ' }, image as never], source: { kind: 'user' } })
    const inbox = fakeInbox({ nextTurn: [message] })
    const { ctx, editor } = await mount({ inbox })
    ctx.emit('mayfly/queued-action', 'edit', String(message.id))
    expect(editor.getText()).toMatch(/^see \[image #\d+ 70 B\]$/u)
  })
})

describe('prompt wiring', () => {
  it('sets the shell mode through the shared editor, and ignores a repeat of the same mode', async () => {
    const { editor, ctx } = await mount()
    const shared = getSharedEditor(ctx)!
    shared.setShell(true)
    expect(editor.shellMode).toBe(true)
    shared.setShell(true)
    shared.setShell(false)
    expect(editor.shellMode).toBe(false)
  })

  it('drops the restore record of a message the agent claims or discards, and ignores another agent', async () => {
    const inbox = fakeInbox()
    const rig = await mount({ running: true, inbox })
    rig.followup.mockImplementation((message: UserMessage) => { inbox.nextTurn.push(message) })
    type(rig.editor, 'pending')
    rig.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(inbox.nextTurn).toHaveLength(1))
    const message = inbox.nextTurn[0]!
    rig.ctx.emit('agent/inbox/claimed', { agent: { id: 'someone-else' } as never, message } as never)
    rig.ctx.emit('agent/inbox/discarded', { agent: rig.agent, message } as never)
    rig.ctx.emit('agent/inbox/claimed', { agent: rig.agent, message } as never)
    rig.ctx.emit('mayfly/queued-action', 'edit', String(message.id))
    // Without its record the message restores from its own content.
    expect(rig.editor.getText()).toBe('pending')
  })

  it('re-reads the placeholder when the mayfly settings change, and when a turn status changes', async () => {
    const { ctx, editor } = await mount()
    expect(() => {
      ctx.emit('settings/document-updated', 'mayfly' as never, 2)
      ctx.emit('settings/document-updated', 'shell' as never, 2)
    }).not.toThrow()
    expect(editor.getText()).toBe('')
  })
})

describe('token hints and steering without an Agent', () => {
  it('announces the keys of the token on show: Ctrl+G opens, and shows an image', async () => {
    const { ctx, editor } = await mount()
    const hints: Array<string | undefined> = []
    ctx.on('mayfly/prompt-hint-changed', (text: string | undefined) => { hints.push(text) })
    editor.onTokenChange?.({ kind: 'image', text: '[image #1 70 B]', selected: true })
    editor.onTokenChange?.({ kind: 'mention', text: '@src/a.ts', selected: true })
    editor.onTokenChange?.(undefined)
    expect(hints).toEqual(['Ctrl+G shows it · Backspace removes', 'Ctrl+G opens · Backspace removes', undefined])
  })

  it('publishes the history position once per move', async () => {
    const { ctx, editor } = await mount()
    const positions: unknown[] = []
    ctx.on('mayfly/prompt-recall-changed', (position: unknown) => { positions.push(position) })
    let position: { index: number, total: number } | undefined = { index: 1, total: 3 }
    ;(editor as unknown as { getHistoryPosition(): unknown }).getHistoryPosition = () => position
    editor.onChange?.('a')
    editor.onChange?.('b')
    position = { index: 2, total: 3 }
    editor.onChange?.('c')
    expect(positions).toEqual([{ index: 1, total: 3 }, { index: 2, total: 3 }])
  })

  it('leaves Ctrl+Enter to the editor when there is no Agent to steer', async () => {
    const { ctx, editor } = await mount()
    vi.spyOn(ctx.mayflyCurrentAgent, 'current').mockReturnValue(null)
    type(editor, 'steer nothing')
    expect(editor.onKey?.(KEY.ctrlEnter)).toBe(false)
    expect(editor.getText()).toBe('steer nothing')
  })
})

describe('external editor failures, the help key, and queued actions without a record', () => {
  const savedVisual = process.env.VISUAL
  const savedEditor = process.env.EDITOR
  beforeEach(() => {
    process.env.VISUAL = 'mayfly-spec-editor'
    delete process.env.EDITOR
  })
  afterEach(() => {
    process.env.VISUAL = savedVisual
    if (savedEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = savedEditor
    setExternalEditorLauncher(undefined)
  })

  it('says an editor must be set, for a token and for a focused file of the @ list', async () => {
    delete process.env.VISUAL
    const { editor, hint } = await mount()
    editor.token = { kind: 'paste', text: '[paste #1 +3 lines]', selected: false, content: 'a\nb\nc' }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('set $VISUAL or $EDITOR to edit drafts externally'))
    editor.token = undefined
    editor.showingAutocomplete = true
    editor.completionView = { kind: 'files', prefix: '@', index: 0, items: [{ label: 'a.ts', value: '@a.ts' }] }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('set $VISUAL'))
  })

  it('reports a launcher failure of a token as an error, with a non-Error rejection as its text', async () => {
    const { editor, hint } = await mount()
    setExternalEditorLauncher(() => Promise.reject(new Error('editor crashed')))
    editor.token = { kind: 'paste', text: '[paste #1 +3 lines]', selected: false, content: 'a\nb\nc' }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('editor crashed'))
    setExternalEditorLauncher(() => Promise.reject('plain text failure'))
    editor.token = { kind: 'paste', text: '[paste #2 +3 lines]', selected: false, content: 'x' }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('plain text failure'))
  })

  it('leaves a pasted block as it was when the editor saves nothing, and edits the text when the block has no content', async () => {
    const { editor, screen } = await mount()
    const seeds: string[] = []
    setExternalEditorLauncher((seed) => {
      seeds.push(seed)
      return Promise.resolve(undefined)
    })
    editor.token = { kind: 'paste', text: '[paste #1 +3 lines]', selected: false, content: 'a\nb\nc' }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(screen.suspends).toBe(1))
    expect(editor.replaced).toEqual([])
    await vi.waitFor(() => expect(seeds).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    editor.token = { kind: 'paste', text: '[paste #2 +1 lines]', selected: false }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(seeds).toEqual(['a\nb\nc', '[paste #2 +1 lines]']))
  })

  it('notices a focused file of the @ list that is gone, and reports its launcher failure', async () => {
    const { editor, hint, screen } = await mount()
    editor.showingAutocomplete = true
    editor.completionView = { kind: 'files', prefix: '@', index: 0, items: [{ label: 'missing.ts', value: '@missing-focused.ts' }] }
    expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('missing-focused.ts does not exist'))
    expect(screen.suspends).toBe(0)
  })

  it('answers ? with the key help on an empty prompt only, not on a draft, a shell line, or an open list', async () => {
    const { ctx, editor } = await mount()
    const help = vi.fn()
    ctx.on('mayfly/request-help' as never, help as never)
    expect(editor.onKey?.('?')).toBe(true)
    expect(help).toHaveBeenCalledOnce()
    type(editor, 'a')
    expect(editor.onKey?.('?')).toBe(false)
    editor.setText('')
    getSharedEditor(ctx)!.setShell(true)
    expect(editor.onKey?.('?')).toBe(false)
    getSharedEditor(ctx)!.setShell(false)
    editor.showingAutocomplete = true
    expect(editor.onKey?.('?')).toBe(false)
    expect(help).toHaveBeenCalledOnce()
  })

  it('keeps a quoted folder of the @ list inside its closing quote, and a plain one outside it', async () => {
    const { editor } = await mount()
    editor.showingAutocomplete = true
    editor.completionView = { kind: 'files', prefix: '@', index: 0, items: [{ label: 'my dir/', value: '@"my dir/"' }] }
    expect(editor.onKey?.(KEY.enter)).toBe(true)
    expect(editor.inserted).toContain(' ')
    editor.completionView = { kind: 'files', prefix: '@', index: 0, items: [{ label: 'src/', value: '@src/' }] }
    expect(editor.onKey?.(KEY.enter)).toBe(true)
    expect(editor.inserted.filter(text => text === ' ')).toHaveLength(2)
  })

  it('undoes a cancelled message back into the follow-up lane within the window, and not after it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    try {
      const late = fakeInbox({ nextTurn: [queued('later')] })
      const lateRig = await mount({ inbox: late })
      lateRig.ctx.emit('mayfly/queued-action', 'cancel', String(late.nextTurn[0]!.id))
      now.mockReturnValue(5_000 + 8_001)
      lateRig.ctx.emit('mayfly/queued-action', 'undo', undefined)
      expect(lateRig.followup).not.toHaveBeenCalled()
      now.mockReturnValue(5_000)
      const inbox = fakeInbox({ nextTurn: [queued('again')] })
      const rig = await mount({ inbox })
      rig.ctx.emit('mayfly/queued-action', 'cancel', String(inbox.nextTurn[0]!.id))
      now.mockReturnValue(5_001)
      rig.ctx.emit('mayfly/queued-action', 'undo', undefined)
      expect(rig.followup).toHaveBeenCalledOnce()
      expect(noticesOf(rig.hint).join('\n')).toContain('Message queued again')
    } finally {
      now.mockRestore()
    }
  })

  it('acts on nothing without an Agent, and says the agent already read a message it no longer holds', async () => {
    const detached = await mount({ withAgent: false })
    detached.ctx.emit('mayfly/queued-action', 'edit', 'anything')
    expect(detached.editor.getText()).toBe('')
    const inbox = fakeInbox()
    const { ctx, hint } = await mount({ inbox })
    ctx.emit('mayfly/queued-action', 'edit', 'gone-message')
    await vi.waitFor(() => expect(noticesOf(hint).join('\n')).toContain('The agent already read it'))
    ctx.emit('mayfly/queued-action', 'edit', undefined)
    expect(inbox.remove).not.toHaveBeenCalled()
  })

  it('steers a queued message whose restore record follows it into the steer lane', async () => {
    const inbox = fakeInbox()
    const rig = await mount({ running: true, inbox })
    rig.followup.mockImplementation((message: UserMessage) => { inbox.nextTurn.push(message) })
    type(rig.editor, 'keep me')
    rig.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(inbox.nextTurn).toHaveLength(1))
    rig.ctx.emit('mayfly/queued-action', 'steer', String(inbox.nextTurn[0]!.id))
    expect(rig.steer).toHaveBeenCalledOnce()
    rig.ctx.emit('mayfly/queued-action', 'cancel', String(inbox.nextTurn[0]!.id))
    expect(noticesOf(rig.hint).join('\n')).toContain('Cancelled · u undo')
  })
})

describe('steering, the reload draft, the @ list views, and the status line', () => {
  it('restores a steered message to the editor on edit, from the record Ctrl+Enter kept', async () => {
    const inbox = fakeInbox()
    const rig = await mount({ running: true, inbox })
    rig.steer.mockImplementation((message: UserMessage) => { inbox.nextStep.push(message) })
    type(rig.editor, 'steer me')
    expect(rig.editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    await vi.waitFor(() => expect(inbox.nextStep).toHaveLength(1))
    rig.editor.setText('')
    rig.ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextStep[0]!.id))
    expect(rig.editor.getText()).toBe('steer me')
  })

  it('keeps an unsent draft across a reload, in the editor it was typed into', async () => {
    const first = await mount()
    type(first.editor, 'unsent words')
    await first.fiber.dispose()
    await first.ctx.plugin(inputPlugin)
    const second = (first.ctx.mayflyComponents as unknown as FakeMayflyComponents).editors.at(-1)!
    expect(second.getText()).toBe('unsent words')
  })

  it('re-reads the placeholder when the agent status changes for the selected agent only', async () => {
    const { ctx, agent, editor } = await mount()
    expect(() => ctx.emit('agent/status', { agent: { id: 'someone-else' } } as never)).not.toThrow()
    expect(() => ctx.emit('agent/status', { agent } as never)).not.toThrow()
    expect(editor.getText()).toBe('')
  })
})

describe('queued follow-ups: the restore record of an image, and an editor without the capture seam', () => {
  it('restores the image of a queued follow-up with its marker when the message is edited back', async () => {
    const inbox = fakeInbox()
    const { ctx, editor, followup } = await mount({ running: true, inbox })
    followup.mockImplementation((message: UserMessage) => { inbox.nextTurn.push(message) })
    const ref = imageRef('queued-restore-image')
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    installEditorTransform(ctx, request => ({ text: `extended:${request.text}` }))
    type(editor, '[image #1 70 B] caption')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(inbox.nextTurn).toHaveLength(1))
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.has('[image #1 70 B]')).toBe(false)
    ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextTurn[0]!.id))
    expect(ctx.mayflyInteractionState.pasteImage.pastedImages.get('[image #1 70 B]')).toBe(ref)
    expect(editor.getText()).toBe('[image #1 70 B] caption')
  })

  it('queues a follow-up on an editor without the capture seam, and edits it back to its text', async () => {
    const inbox = fakeInbox()
    const rig = await mount({ running: true, inbox })
    rig.followup.mockImplementation((message: UserMessage) => { inbox.nextTurn.push(message) })
    ;(rig.editor as { captureDraft?: unknown }).captureDraft = undefined
    type(rig.editor, 'plain follow-up')
    rig.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(inbox.nextTurn).toHaveLength(1))
    expect(rig.editor.getText()).toBe('')
    rig.ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextTurn[0]!.id))
    expect(rig.editor.getText()).toBe('plain follow-up')
  })
})

describe('input plugin decision branches', () => {
  it('opens a subagent a reply request names, and keeps a draft the user has typed since', async () => {
    const { ctx, editor } = await mount()
    const open = vi.fn()
    ;(ctx.mayflyConversations as { open?: unknown }).open = open
    const target = { kind: 'subagent', sessionId: 'reply-child', parentSessionId: 'input-spec', label: 'reply', mode: 'continuable' } as const
    ctx.emit('mayfly/request-subagent-reply', target as never, 'first seed')
    expect(open).toHaveBeenCalledWith(target)
    expect(editor.getText()).toBe('first seed')
    type(editor, ' mine')
    ctx.emit('mayfly/request-subagent-reply', target as never, 'second seed')
    expect(editor.getText()).toBe('first seed mine')
  })

  it('keeps a pending subagent prompt whose child becomes the new Agent, and aborts the prompts of any other', async () => {
    const gate = Promise.withResolvers<{ messageId: string }>()
    const signals: AbortSignal[] = []
    const prompt = vi.fn((_request: unknown, signal?: AbortSignal) => {
      signals.push(signal!)
      return gate.promise
    })
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'wake-child',
        parentSessionId: 'input-spec',
        label: 'wake',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 70)
    const rig = await mount({ running: true, view, subagents: { prompt, interruptByParent: vi.fn() } })
    type(rig.editor, 'wake it')
    rig.editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    const woken = { ...rig.agent, id: SessionId('wake-child') } as Agent
    ;(rig.ctx.get('testSession') as { current: Agent | null }).current = woken
    rig.ctx.emit('test/session-changed', woken)
    expect(signals[0]!.aborted).toBe(false)
    const other = { ...rig.agent, id: SessionId('elsewhere') } as Agent
    ;(rig.ctx.get('testSession') as { current: Agent | null }).current = other
    rig.ctx.emit('test/session-changed', other)
    expect(signals[0]!.aborted).toBe(true)
    gate.resolve({ messageId: 'woken-message' })
    await rig.fiber.dispose()
  })

  it('serves the bytes of a pasted image, and answers nothing for an unknown or an unreadable one', async () => {
    let loader: ((id: string, signal: AbortSignal) => Promise<unknown>) | undefined
    const { ctx } = await mount({
      uiImages: { provide: (fn: typeof loader) => { loader = fn; return () => {} } },
    })
    const signal = new AbortController().signal
    const ref = imageRef('served-image')
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', ref)
    expect(await loader!(String(ref.attachmentId), signal)).toBeUndefined()
    let reads: (() => Promise<unknown>) | undefined
    ctx.provide('attachments', { readImage: async () => reads!() } as never)
    reads = async () => ({ ref, data: Uint8Array.of(7) })
    expect(await loader!(String(ref.attachmentId), signal)).toEqual({ data: Uint8Array.of(7), mediaType: 'image/png' })
    const named = { ...imageRef('named-image'), name: 'shot.png' }
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #2 70 B]', named)
    reads = async () => ({ ref: named, data: Uint8Array.of(7) })
    expect(await loader!('named-image', signal)).toEqual({ data: Uint8Array.of(7), mediaType: 'image/png', name: 'shot.png' })
    expect(await loader!('unknown-image', signal)).toBeUndefined()
    reads = async () => { throw new Error('store gone') }
    expect(await loader!(String(ref.attachmentId), signal)).toBeUndefined()
  })

  it('withdraws a subagent message its child still holds, with the buffer it was typed from', async () => {
    const message = queued('child queued')
    const inbox = fakeInbox({ nextTurn: [message] })
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 80)
    const prompt = vi.fn(async () => ({ messageId: String(message.id) }))
    const { ctx, editor } = await mount({ view, inbox, subagents: { prompt, interruptByParent: vi.fn() } })
    type(editor, 'child text')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(editor.getText()).toBe(''))
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    ctx.emit('mayfly/queued-action', 'edit', String(message.id))
    expect(editor.getText()).toBe('child text')
  })

  it('restores a subagent submission into an editor without the restore seam, as its raw text', async () => {
    const prompt = vi.fn(async () => { throw 'child rejected the prompt' })
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 90)
    const { ctx, editor, hint } = await mount({ view, subagents: { prompt, interruptByParent: vi.fn() } })
    ;(editor as { restoreSubmittedDraft?: unknown }).restoreSubmittedDraft = undefined
    ctx.mayflyInteractionState.pasteImage.pastedImages.set('[image #1 70 B]', imageRef('seamless-restore'))
    ctx.provide('attachments', { readImage: async () => ({ ref: imageRef('seamless-restore'), data: Uint8Array.of(1) }) } as never)
    installEditorTransform(ctx, request => ({ text: request.text }))
    type(editor, '[image #1 70 B] raw')
    editor.handleInput(KEY.enter)
    await vi.waitFor(() => expect(noticesOf(hint)).toEqual(['!✗ !!child rejected the prompt!']))
    expect(editor.getText()).toBe('[image #1 70 B] raw')
  })

  it('restores an unsent draft across a reload into an editor without the restore seam', async () => {
    const first = await mount()
    type(first.editor, 'seamless words')
    await first.fiber.dispose()
    const seam = FakeMayflyEditor.prototype.restoreSubmittedDraft
    Reflect.deleteProperty(FakeMayflyEditor.prototype, 'restoreSubmittedDraft')
    try {
      await first.ctx.plugin(inputPlugin)
      const second = (first.ctx.mayflyComponents as unknown as FakeMayflyComponents).editors.at(-1)!
      expect(second.getText()).toBe('seamless words')
    } finally {
      FakeMayflyEditor.prototype.restoreSubmittedDraft = seam
    }
  })

  it('withdraws a steered message with its rollback, rebuilt from its content when the editor cannot capture it', async () => {
    const inbox = fakeInbox()
    const rig = await mount({ running: true, inbox })
    rig.steer.mockImplementation((message: UserMessage) => { inbox.nextStep.push(message) })
    const rollback = vi.fn()
    registerSubmitTransformer(rig.ctx, text => ({ blocks: [{ type: 'text', text: text.toUpperCase() }], rollback }))
    ;(rig.editor as { captureDraft?: unknown }).captureDraft = undefined
    type(rig.editor, 'steer me')
    expect(rig.editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    await vi.waitFor(() => expect(inbox.nextStep).toHaveLength(1))
    rig.ctx.emit('mayfly/queued-action', 'edit', String(inbox.nextStep[0]!.id))
    expect(rollback).toHaveBeenCalledOnce()
    expect(rig.editor.getText()).toBe('STEER ME')
  })

  it('withdraws a steered subagent message with its rollback, and without a buffer when none is captured', async () => {
    const message = queued('child steer')
    const inbox = fakeInbox({ nextTurn: [message] })
    const view = sideView({
        kind: 'subagent' as const,
        sessionId: 'input-spec',
        parentSessionId: 'parent',
        label: 'worker',
        mode: 'continuable' as const,
        access: 'interactive' as const,
      }, 100)
    const prompt = vi.fn(async () => ({ messageId: String(message.id) }))
    const rig = await mount({ view, inbox, subagents: { prompt, interruptByParent: vi.fn() } })
    const rollback = vi.fn()
    registerSubmitTransformer(rig.ctx, text => ({ blocks: [{ type: 'text', text: text.toUpperCase() }], rollback }))
    ;(rig.editor as { captureDraft?: unknown }).captureDraft = undefined
    type(rig.editor, 'steer child')
    expect(rig.editor.onKey?.(KEY.ctrlEnter)).toBe(true)
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    rig.ctx.emit('mayfly/queued-action', 'edit', String(message.id))
    expect(rollback).toHaveBeenCalledOnce()
    expect(rig.editor.getText()).toBe('child steer')
  })

  it('does not start a second external editor while one is running, for a focused file or a token', async () => {
    const { editor, screen } = await mount()
    setExternalEditorLauncher(() => new Promise(() => {}))
    try {
      editor.showingAutocomplete = true
      editor.completionView = {
        kind: 'files',
        prefix: '@',
        index: 0,
        items: [{ label: 'src/a.ts', value: `@${process.cwd()}/package.json` }],
      }
      expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
      await vi.waitFor(() => expect(screen.suspends).toBe(1))
      expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
      editor.showingAutocomplete = false
      editor.token = { kind: 'paste', text: '[paste #1 +3 lines]', selected: false, content: 'a\nb\nc' }
      expect(editor.onKey?.(KEY.ctrlG)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(screen.suspends).toBe(1)
    } finally {
      setExternalEditorLauncher(undefined)
    }
  })
})
