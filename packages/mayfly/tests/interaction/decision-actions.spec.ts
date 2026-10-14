/** Decision card helpers: reading the choice and note back from an event, opening the request in the editor, and copying it.
 * @module @ephemeral-ai/mayfly/tests/interaction/decision-actions
 */
import { Context } from '@deepseek-ai/cordis'
import type { MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyDocument, openInEditor, readDecision } from '../../src/interaction/decision-actions.ts'
import { setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { setExternalEditorLauncher } from '../../src/interaction/external-editor.ts'
import { FakeScreen } from './fakes.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  setClipboardTextWriter(undefined)
  setExternalEditorLauncher(undefined)
})

const t = (key: string) => key

function activate(actionId: string, value: unknown, choice?: string): MayflyUiActionEvent {
  return {
    kind: 'activate', pagePath: [], controlId: 'decision.keys', actionId,
    inputs: {
      forms: [{ pagePath: [], formId: 'decision.note', fields: [{ id: 'note', value }] }],
      ...choice === undefined ? {} : { selections: [{ pagePath: [], controlId: 'decision.options', selectedIds: [choice] }] },
    },
  } as unknown as MayflyUiActionEvent
}

describe('readDecision', () => {
  it('reads the choice and the trimmed note of the choose action', () => {
    expect(readDecision(activate('decide', '  because  ', 'reject'))).toEqual({ action: 'choose', choice: 'reject', note: 'because' })
  })

  it('reads the note alone for the send action, and an empty note when the field holds no text', () => {
    expect(readDecision(activate('send-note', ' go ', 'ignored'))).toEqual({ action: 'send', note: 'go' })
    expect(readDecision(activate('send-note', 42))).toEqual({ action: 'send', note: '' })
  })

  it('reads nothing when no choice was selected', () => {
    expect(readDecision(activate('decide', 'x'))).toBeUndefined()
  })

  it('reads nothing from other events and other actions', () => {
    expect(readDecision({ kind: 'dismiss' } as unknown as MayflyUiActionEvent)).toBeUndefined()
    expect(readDecision({ kind: 'activate', pagePath: [], controlId: 'x', actionId: 'decide' } as unknown as MayflyUiActionEvent)).toBeUndefined()
    expect(readDecision(activate('open', 'x', 'reject'))).toBeUndefined()
  })

  it('reads an empty note when the form is missing', () => {
    const event = { kind: 'activate', pagePath: [], controlId: 'x', actionId: 'decide', inputs: { forms: [], selections: [{ pagePath: [], controlId: 'decision.options', selectedIds: ['allow-once'] }] } }
    expect(readDecision(event as unknown as MayflyUiActionEvent)).toEqual({ action: 'choose', choice: 'allow-once', note: '' })
  })
})

describe('openInEditor', () => {
  function withScreen() {
    const ctx = new Context()
    const screen = new FakeScreen()
    ctx.provide('mayflyScreen', screen as never)
    return { ctx, screen }
  }

  it('hands the text to the editor with the terminal suspended and completes', async () => {
    vi.stubEnv('VISUAL', 'my-editor --wait')
    const launcher = vi.fn(async (_text: string, _command: string): Promise<string | undefined> => undefined)
    setExternalEditorLauncher(launcher)
    const { ctx, screen } = withScreen()
    await expect(openInEditor(ctx, 'the diff', t, new AbortController().signal)).resolves.toEqual({ kind: 'completed' })
    expect(launcher).toHaveBeenCalledWith('the diff', 'my-editor --wait')
    expect(screen.suspends).toBe(1)
  })

  it('says so when the terminal is unavailable', async () => {
    await expect(openInEditor(new Context(), 'x', t, new AbortController().signal))
      .resolves.toEqual({ kind: 'failed', message: 'The terminal is unavailable' })
  })

  it('says so when no editor is configured, without suspending the terminal', async () => {
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('EDITOR', '')
    const { ctx, screen } = withScreen()
    await expect(openInEditor(ctx, 'x', t, new AbortController().signal))
      .resolves.toEqual({ kind: 'failed', message: 'no editor configured ($VISUAL/$EDITOR)' })
    expect(screen.suspends).toBe(0)
  })

  it('reports an editor that could not be opened as a failure', async () => {
    vi.stubEnv('EDITOR', 'nano')
    setExternalEditorLauncher(async () => { throw new Error('spawn failed') })
    const { ctx } = withScreen()
    await expect(openInEditor(ctx, 'x', t, new AbortController().signal))
      .resolves.toEqual({ kind: 'failed', message: 'The editor could not be opened' })
  })

  it('settles as cancelled when the operation was cancelled while the editor ran, on success or on failure', async () => {
    vi.stubEnv('EDITOR', 'nano')
    const { ctx } = withScreen()
    const succeeded = new AbortController()
    setExternalEditorLauncher(async () => { succeeded.abort(); return undefined })
    await expect(openInEditor(ctx, 'x', t, succeeded.signal)).resolves.toEqual({ kind: 'cancelled' })
    const failed = new AbortController()
    setExternalEditorLauncher(async () => { failed.abort(); throw new Error('killed') })
    await expect(openInEditor(ctx, 'x', t, failed.signal)).resolves.toEqual({ kind: 'cancelled' })
  })
})

describe('copyDocument', () => {
  it('copies the text and reports success', async () => {
    const writer = vi.fn(async (_text: string) => {})
    setClipboardTextWriter(writer)
    await expect(copyDocument('plan text', 'Copied', 'Copy failed')).resolves.toEqual({ kind: 'completed', feedback: { message: 'Copied', severity: 'success' } })
    expect(writer).toHaveBeenCalledWith('plan text')
  })

  it('reports a failure with the error message, or the thrown value when it is not an Error', async () => {
    setClipboardTextWriter(async () => { throw new Error('no clipboard') })
    await expect(copyDocument('x', 'Copied', 'Copy failed')).resolves.toEqual({ kind: 'completed', feedback: { message: 'Copy failed', severity: 'error', detail: 'no clipboard' } })
    setClipboardTextWriter(async () => { throw 'denied' })
    await expect(copyDocument('x', 'Copied', 'Copy failed')).resolves.toEqual({ kind: 'completed', feedback: { message: 'Copy failed', severity: 'error', detail: 'denied' } })
  })
})
