/** Renderer-neutral frontend data. No renderer objects or async values belong here. */
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

export type Action = Readonly<{ readonly kind: string; readonly [key: string]: unknown }>
export interface ToolPresentationModel { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly call?: MayflyUiNode; readonly result?: MayflyUiNode; readonly expanded?: boolean; readonly action?: Action }
export interface ThemeModel { readonly kind: 'theme'; readonly id: string; readonly name: string; readonly colors: Readonly<Record<string, string>>; readonly dark: boolean }
export interface TranscriptImageModel { readonly attachmentId: string; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly bytes: number; readonly width: number; readonly height: number; readonly name?: string | undefined; readonly originalDimensions?: Readonly<{ readonly width: number; readonly height: number }> | undefined }
interface TranscriptEntryBase {
  readonly id: string
  readonly seq: number
  readonly updatedSeq: number
  readonly turn: number
  /** Presentation revision independent of the durable event sequence. */
  readonly renderRevision?: string
}
export interface TranscriptUserModel extends TranscriptEntryBase { readonly kind: 'transcript-user'; readonly text: string; readonly images: readonly TranscriptImageModel[] }
export interface TranscriptAssistantModel extends TranscriptEntryBase { readonly kind: 'transcript-assistant'; readonly step: number; readonly text: string; readonly streaming: boolean }
export interface TranscriptThinkingModel extends TranscriptEntryBase { readonly kind: 'transcript-thinking'; readonly step: number; readonly text: string; readonly streaming: boolean; readonly outputProgress?: import('../conversation/types.ts').OutputProgress | undefined }
export interface TranscriptToolResultModel { readonly text: string; readonly fullText?: string; readonly isError: boolean; readonly endedAt: number }
/**
 * The presenter-card family a lone tool card belongs to, for the per-family
 * detail policy: `command` covers terminal cards, `edit` diff cards, `web`
 * web cards, and `other` everything else. Read/search calls group into their
 * own entry kinds and never carry this field.
 */
export type TranscriptToolFamily = 'command' | 'edit' | 'web' | 'other'
export interface TranscriptToolModel extends TranscriptEntryBase { readonly kind: 'transcript-tool'; readonly preparing?: { readonly characters: number }; readonly step: number; readonly callId: string; readonly name: string; readonly family: TranscriptToolFamily; readonly arguments: string; readonly startedAt: number; readonly result?: TranscriptToolResultModel; readonly presentation?: ToolPresentationModel }
/** One bounded preview line carried for a read window's expanded view. */
export interface ReadPreviewLine { readonly number: number; readonly text: string }
/**
 * One read call's renderer-neutral facts: what was asked for (the argument
 * window), what came back (the actual line range and totals), and a bounded
 * content preview. The model records per-call facts only — grouping reads by
 * file is a renderer concern, so any presentation shape (per-file trees,
 * flat rows) can be derived without touching producers.
 */
export interface ReadCallModel {
  readonly callId: string
  readonly seq: number
  readonly updatedSeq: number
  readonly turn: number
  readonly step: number
  readonly path?: string
  /** Row fallback when the call reads no file: the salient argument (e.g. `job_id: 5`). */
  readonly label?: string
  readonly requestedRange?: { readonly first: number; readonly last: number }
  readonly range?: { readonly first: number; readonly last: number }
  readonly totalLines?: number
  readonly state: 'pending' | 'ok' | 'error'
  readonly error?: string
  readonly previewLines?: readonly ReadPreviewLine[]
}
/** A run of consecutive read calls collapsed into one transcript entry. */
export interface TranscriptReadGroupModel extends TranscriptEntryBase { readonly kind: 'transcript-read-group'; readonly step: number; readonly reads: readonly ReadCallModel[] }
/** One bounded match preview carried for a search group's expanded view. */
export interface SearchMatchPreview { readonly lineNumber: number; readonly line: string }
/** One file's matched content as carried facts: the match count plus bounded previews. */
export interface SearchFileMatchesModel { readonly path: string; readonly count: number; readonly previews: readonly SearchMatchPreview[] }
/**
 * One search call's renderer-neutral facts — a content search (grep,
 * `shape: 'matches'`) or a path search (glob, `shape: 'paths'`), with a
 * pending call's shape still unknown. Only bounded data rides: per-file
 * match counts with a few preview lines, and a capped path page with the
 * true total, so a group never carries the raw match corpus.
 */
export interface SearchCallModel {
  readonly callId: string
  readonly seq: number
  readonly updatedSeq: number
  readonly turn: number
  readonly step: number
  readonly pattern?: string
  readonly shape?: 'matches' | 'paths'
  readonly files?: readonly SearchFileMatchesModel[]
  readonly paths?: readonly string[]
  readonly pathsTotal?: number
  readonly truncated?: boolean
  readonly total?: number
  readonly state: 'pending' | 'ok' | 'error'
  readonly error?: string
}
/** A run of consecutive search calls collapsed into one transcript entry. */
export interface TranscriptSearchGroupModel extends TranscriptEntryBase { readonly kind: 'transcript-search-group'; readonly step: number; readonly searches: readonly SearchCallModel[] }
/**
 * One terminal-card call's renderer-neutral facts: the command line, its
 * settlement state and exit status, a one-line error on failure, and a
 * bounded output tail for the group's expanded view.
 */
export interface CommandCallModel {
  readonly callId: string
  readonly seq: number
  readonly updatedSeq: number
  readonly turn: number
  readonly step: number
  /** The command line (the terminal call view's title, or the `command` argument). */
  readonly command: string
  readonly state: 'pending' | 'ok' | 'error'
  readonly exitCode?: number
  readonly signal?: string
  readonly error?: string
  readonly previewLines?: readonly string[]
}
/** A run of consecutive terminal-card calls collapsed into one transcript entry. */
export interface TranscriptCommandGroupModel extends TranscriptEntryBase { readonly kind: 'transcript-command-group'; readonly step: number; readonly commands: readonly CommandCallModel[] }
export interface TranscriptErrorModel extends TranscriptEntryBase { readonly kind: 'transcript-error'; readonly message: string; readonly code?: string }
export interface TranscriptInterruptedModel extends TranscriptEntryBase { readonly kind: 'transcript-interrupted' }
export type TranscriptEntryModel = TranscriptUserModel | TranscriptAssistantModel | TranscriptThinkingModel | TranscriptToolModel | TranscriptReadGroupModel | TranscriptSearchGroupModel | TranscriptCommandGroupModel | TranscriptErrorModel | TranscriptInterruptedModel
export interface TranscriptLiveOverlay {
  readonly turn: number
  readonly step: number
  readonly entries: readonly TranscriptEntryModel[]
}
export interface TranscriptModel {
  readonly kind: 'transcript'
  readonly id: string
  readonly generation: number
  /** Durable entries. Live entries are carried separately to preserve identity. */
  readonly entries: readonly (MayflyUiNode | TranscriptEntryModel)[]
  readonly live?: TranscriptLiveOverlay
  readonly streaming?: boolean
}

/** Materialize a complete view for consumers that need a flat entry list. */
export function materializeTranscriptEntries(model: TranscriptModel): readonly (MayflyUiNode | TranscriptEntryModel)[] {
  const live = model.live
  if (live === undefined) return model.entries
  const entries = model.entries.filter(entry => !((entry.kind === 'transcript-assistant' || entry.kind === 'transcript-thinking')
    && entry.turn === live.turn && entry.step === live.step))
  return [...entries, ...live.entries]
}

/** Only values deeply frozen here may skip a later recursive walk. */
const frozenModels = new WeakSet<object>()

export function freezeModel<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !frozenModels.has(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === 'object') freezeModel(child)
    frozenModels.add(value)
  }
  return value as Readonly<T>
}
