/**
 * Mount and operation contracts for Remote-owned editor features.
 * @module @ephemeral-ai/mayfly/remote/editor/types
 */

import type {
  MayflyComponents,
  MayflyEditor,
  MayflyKeymap,
  MayflyScreen,
  MayflySemanticColors,
} from '../../core.ts'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { EditorDraftStore } from './utils.ts'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  QueueAction,
  RemoteResult,
  SkillEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/client'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import type { ImageAttachmentLimits, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteNotice } from '../notice.ts'
import type { EditorExtensionRuntime } from '../../editor-presentation.ts'
import type { CapturedAttachments } from './attachments.ts'

/** An admitted transform owns only the original draft's exact attachment identities. */
export interface RemoteEditorPrepared {
  readonly text: string
  readonly captured: CapturedAttachments
}

/** Publicly inferable token span; the installed Mayfly core does not re-export its named type. */
export type EditorTokenSpan = ReturnType<NonNullable<Parameters<MayflyEditor['setTokenSource']>[0]>>[number]
/** Publicly inferable active token; no private Mayfly source import is needed. */
export type EditorToken = NonNullable<ReturnType<MayflyEditor['activeToken']>>

/** Host stat fields consumed by editor previews. */
export interface EditorHostFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}

/** Host byte-read fields consumed by editor previews. */
export interface EditorHostFileBytes extends EditorHostFileStat {
  readonly data: Uint8Array
}

/** Exact official Host file operations supplied by the foundation's Client composition. */
export interface EditorHostFiles {
  stat(sessionId: SessionId, path: string, signal: AbortSignal): Promise<RemoteResult<EditorHostFileStat>>
  readBytes(sessionId: SessionId, path: string, signal: AbortSignal): Promise<RemoteResult<EditorHostFileBytes>>
  openWorkspacePath(path: string, signal: AbortSignal): Promise<RemoteResult<{ readonly opened: true }>>
}

/** Exact selected Client generation borrowed from the foundation for one operation. */
export interface EditorFeatureSession {
  readonly ref: SessionRef
  readonly client: HostClient
  readonly session: SessionFace
  /** Foundation-owned selection and Host revision token. */
  readonly generation: number
  /** Native one-shot/unknown child views preserve drafts and reject writes. */
  readonly access?: 'interactive' | 'resumable' | 'readonly'
}

/** Command metadata used by both local routing and Host discovery. */
export interface EditorCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** An internal local admission owner omitted from help and completion. */
  readonly hidden?: boolean
  readonly input?: {
    readonly hint: string
    /** Native command admission for ordered image/file attachments. */
    readonly attachments?: boolean
  }
}

/** Parsed slash command with its untouched argument suffix. */
export interface EditorParsedCommand {
  readonly name: string
  readonly rawInput: string
}

/** Result of the foundation's local-command route. */
export type EditorLocalCommandResult =
  | { readonly kind: 'unhandled' }
  | { readonly kind: 'success', readonly text?: string, readonly exit?: boolean }
  | { readonly kind: 'error', readonly text: string }

/** Invocation offered to the local adapter before Host command dispatch. */
export interface EditorLocalCommandInvocation {
  readonly line: string
  readonly name: string
  readonly rawInput: string
  readonly attachments: readonly CommandSubmitAttachment[]
  readonly session: EditorFeatureSession | undefined
  readonly signal: AbortSignal
}

/** Narrow local-only routing owned by the foundation, never a generic Remote facade. */
export interface EditorLocalAdapter {
  /** Remote machine directory for `!` commands and local temporary files. */
  cwd(): string
  /** Local commands and their aliases, listed before Host commands. */
  list(): readonly EditorCommandDescriptor[]
  /** Resolve an additional local admission route without exposing it to help or completion. */
  resolve?(name: string): EditorCommandDescriptor | undefined
  /** Handle one canonical local command or decline it for Host execution. */
  execute(invocation: EditorLocalCommandInvocation): EditorLocalCommandResult | Promise<EditorLocalCommandResult>
  /** Exit the Remote process after the editor's normal double-Ctrl+C arm. */
  exit(): void | Promise<void>
  /** Optional configured local editor command; `$VISUAL`/`$EDITOR` remains the fallback. */
  editorCommand?(): string | undefined
  /** Optional local clipboard backend preference. */
  clipboardBackend?(): 'auto' | 'wayland' | 'x11'
}

/** Official binary HTTP upload transport supplied by the foundation's Client assembly. */
export type EditorUpload = (
  sessionId: SessionId,
  data: Blob,
  name?: string,
  signal?: AbortSignal,
) => Promise<RemoteResult<FileUploadValue>>

/** Inputs required to attach all Remote-owned editor features to the foundation's editor. */
export interface EditorFeatureOptions {
  readonly ctx: Context
  readonly editor: MayflyEditor
  readonly screen: MayflyScreen
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly keymap: MayflyKeymap
  readonly session: () => EditorFeatureSession | undefined
  /** Create the first Host Session on submission, never merely on editor mount. */
  readonly ensureSession?: () => Promise<EditorFeatureSession>
  /** Complete startup preparation after capturing the exact admitted binding. */
  readonly preparePrompt?: (selected: EditorFeatureSession, signal: AbortSignal, intent?: 'plan') => Promise<void>
  /** Restore focus through the mounted editor shell, when the frontend owns one. */
  readonly focusEditor?: () => void
  /** Foundation-owned startup prelude navigation before ordinary editor actions. */
  readonly startupKey?: (data: string, text: string) => boolean
  /** The base editor's single shared shell, autocomplete multiplexer and submit barrier owner. */
  readonly extensionRuntime?: EditorExtensionRuntime<RemoteEditorPrepared>
  readonly notice: RemoteNotice
  readonly upload: EditorUpload
  readonly files: EditorHostFiles
  readonly local: EditorLocalAdapter
  /** Optional foundation-owned store preserving draft/history across editor remounts. */
  readonly draft?: EditorDraftStore
  readonly t?: MayflyTranslate
}

/** One Host text-file snapshot suitable for a local external-editor handoff. */
export interface EditorHostFileSnapshot {
  readonly absolutePath: string
  readonly version: string
  readonly text: string
}

/** Public operations the foundation can route from conversation and panel surfaces. */
export interface EditorFeatureController {
  /** Refresh Remote-local shell presentation around the retained editor and process owner. */
  retheme(components: MayflyComponents, colors: MayflySemanticColors): void
  /** Reference footer for a strict leading slash with no command matches. */
  slashHint(): string | undefined
  /** Re-read selection and invalidate every old-generation async read. */
  selectionChanged(): void
  /** Invalidate old Host reads and refresh selection-scoped catalogs after reconnect. */
  hostReconnected(): void
  /** Refresh skills and commands after an explicit preset change. */
  presetChanged(): void
  /** Force the current Host command catalog to refresh. */
  refreshCommands(): Promise<void>
  /** Force the current Session skill catalog to refresh. */
  refreshSkills(): Promise<void>
  /** Open the skill list/detail panel for the exact selected Session. */
  openSkills(signal?: AbortSignal): Promise<void>
  /** Apply one official pending-queue mutation without replaying failures. */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<boolean>
  /** Restore one removed queue draft without submitting it. */
  restoreQueued(text: string): void
  /** Re-admit removed queue text into its original lane as a new prompt/request identity. */
  requeue(text: string, lane: 'turn' | 'step'): void
  /** Open transcript text in the Remote-local external editor without changing the prompt. */
  openText(text: string): Promise<void>
  /** Read a durable image through the selected official Session. */
  readAttachment(attachment: ImageAttachmentRef): Promise<Uint8Array | undefined>
  /** Read the selected Session's image admission limits. */
  imageLimits(): ImageAttachmentLimits | undefined
  /** Stage arbitrary Node bytes through the official file-upload transport. */
  stageFile(data: Uint8Array, name?: string): Promise<FileUploadValue | undefined>
  /** Read a Host file as UTF-8 text through workspaceFiles, never local Host-path fs. */
  readHostFile(path: string): Promise<EditorHostFileSnapshot | undefined>
  /** Copy text through the Remote machine's clipboard and terminal escape. */
  copyText(text: string): Promise<'native' | 'osc52'>
  /** Current official skills, or the last complete catalog for this selection. */
  skills(): readonly SkillEntry[]
  /** Stop async work and restore every editor/listener/process owner. */
  dispose(): void
}

/** Host DTOs and orchestration deliberately left to the Host/domain lanes. */
export const EDITOR_INTEGRATION_REQUIREMENTS = Object.freeze({
  btwFork: 'D-D/Host must fork, clean inherited queue entries, restore model and preset, select the child, then prompt.',
} as const)
