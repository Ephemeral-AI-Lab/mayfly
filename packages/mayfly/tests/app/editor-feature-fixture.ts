/** Real core editor plus transport-boundary fixtures for independent feature decisions. @module mayfly-remote/tests/editor-feature-fixture */
import { afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MayflyComponentsService, type MayflyComponentsDeps } from '../../src/core/components.ts'
import type { MayflyScreen } from '../../src/core/types.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { BeginSubmissionInput, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-remotes/client'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import { EditorAttachments } from '../../src/app/editor/attachments.ts'
import { EditorCommands } from '../../src/app/editor/commands.ts'
import { EditorSkills } from '../../src/app/editor/skills.ts'
import { EditorSubmit } from '../../src/app/editor/submit.ts'
import { EditorDraftStore } from '../../src/app/editor/utils.ts'
import type { EditorFeatureSession, EditorLocalAdapter } from '../../src/app/editor/types.ts'
import type { RemoteNotice } from '../../src/app/notice.ts'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const flush = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
export const accepted = { ok: true as const, value: { accepted: true as const } }
export const denied = (message: string) => ({ ok: false as const, error: new RemoteError('gateway/internal', message, {}) })
export const translate = (text: string, values?: Readonly<Record<string, unknown>>): string => text.replace(/\{([^}]+)\}/gu, (_token, key: string) => String(values?.[key] ?? ''))

export function wire(host = 'one', generation = 1) {
  const begin: BeginSubmissionInput[] = []
  const handles: Array<{ requestId: SessionRequestId, abandon: ReturnType<typeof vi.fn> }> = []
  const prompt = vi.fn<SessionFace['prompt']>(async () => accepted)
  const cancel = vi.fn<SessionFace['cancel']>(async () => accepted)
  const updateQueue = vi.fn<SessionFace['updateQueue']>(async () => accepted)
  const listCommands = vi.fn(async () => ({ ok: true as const, value: [{ name: 'host-only', description: 'Host command', input: { hint: '<value>' } }] }))
  const executeCommand = vi.fn(async (_id: SessionId, _line: string, _attachments: readonly PromptContentPart[], _signal: AbortSignal) => ({ ok: true as const, value: { result: { kind: 'success' as const, text: 'Host completed' } } }))
  const listSkills = vi.fn(async () => ({ ok: true as const, value: { skills: [{ name: 'review', description: 'Review code' }] } }))
  const session = Object.assign({} as SessionFace, {
    beginSubmission: (input: BeginSubmissionInput) => {
      begin.push(input)
      const handle = { requestId: `request-${host}-${String(handles.length + 1)}` as SessionRequestId, abandon: vi.fn() }
      handles.push(handle)
      return handle
    },
    prompt, cancel, updateQueue,
  })
  const client = Object.assign({} as HostClient, {
    key: HostKey(host),
    state: { getSnapshot: () => ({ status: 'connected', generation: 1 }) },
    remote: { commands: { list: listCommands, execute: executeCommand }, skills: { list: listSkills } },
  })
  const selected: EditorFeatureSession = { ref: { host: HostKey(host), sessionId: 'same-session' as SessionId }, client, session, generation }
  return { selected, prompt, cancel, updateQueue, listCommands, executeCommand, listSkills, begin, handles }
}

const cleanup = new Set<() => void>()
afterEach(() => { for (const dispose of cleanup) dispose(); cleanup.clear() })

/** Only external Host I/O and terminal scheduling are doubled; all editor feature classes are real. */
export function submissionFixture(initial?: EditorFeatureSession, ensureSession?: () => Promise<EditorFeatureSession>, preparePrompt?: (selected: EditorFeatureSession, signal: AbortSignal, intent?: 'plan') => Promise<void>, targetNotice?: RemoteNotice) {
  const requestRender = vi.fn()
  const components = new MayflyComponentsService(new Context(), {
    theme: { colors: new Proxy({}, { get: () => (text: string) => text }) },
    tui: { requestRender },
  } as unknown as MayflyComponentsDeps)
  const editor = components.createEditor()
  const screen = { requestRender, setFocus: vi.fn() } as unknown as MayflyScreen
  let current: EditorFeatureSession | undefined = initial
  const notices: string[] = []
  const feedback: Array<{ readonly text: string, readonly severity: Parameters<RemoteNotice['set']>[1] }> = []
  const notice: RemoteNotice = { set: (text, severity) => { notices.push(text); feedback.push({ text, severity }); targetNotice?.set(text, severity) } }
  const local: EditorLocalAdapter = { cwd: () => '/workspace', list: () => [], execute: () => ({ kind: 'unhandled' }), exit: vi.fn() }
  const draft = new EditorDraftStore()
  const attachments = new EditorAttachments(components, async () => { throw new Error('upload fixture not configured') })
  const skills = new EditorSkills(() => current)
  const commands = new EditorCommands({ session: () => current, local, notice, t: translate })
  const exit = vi.fn()
  const submit = new EditorSubmit({ editor, screen, session: () => current, ...(ensureSession === undefined ? {} : { ensureSession }), ...preparePrompt === undefined ? {} : { preparePrompt }, commands, skills, attachments, draft, notice, t: translate, exit })
  editor.onSubmit = value => { submit.submit(value) }
  cleanup.add(() => { submit.dispose(); attachments.dispose(); skills.dispose() })
  return {
    editor, screen, components, notices, feedback, local, commands, attachments, skills, draft, submit, exit,
    select: (selected: EditorFeatureSession | undefined) => { current = selected },
    enter: (text: string) => { editor.setText(text); editor.handleInput?.('\r') },
    file: () => attachments.addFile({ receiptId: 'receipt-1', file: { attachmentId: 'attachment-1', name: 'notes.txt', bytes: 12 } } as FileUploadValue, current!),
  }
}
