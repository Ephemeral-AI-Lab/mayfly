/**
 * The text behind a stream row, from the frontend model rather than from the rows a level draws, so a detail a level
 * hides is still there. `text` is what a person reads or pastes (a message as its Markdown, an edit as a diff, a command
 * with its output); `raw` is the model's own JSON. It runs on demand and never per publish.
 * @module
 */
import type { CommandCallModel, ReadCallModel, SearchCallModel, TranscriptEntryModel } from '../frontend/models.ts'
import { partialStrings } from './partial-json.ts'

/** Which form of a row's content is copied: for a person, or the model's JSON. */
export type CopyMode = 'text' | 'raw'

/** One thing a row stands for: a whole entry, or one call inside a group entry. */
export interface RowPart {
  readonly entry: TranscriptEntryModel
  readonly call?: ReadCallModel | SearchCallModel | CommandCallModel
}

const join = (parts: readonly (string | undefined)[]): string => parts.filter((part): part is string => part !== undefined && part !== '').join('\n')

const prefixed = (mark: string, text: string): string => text.split('\n').map(line => `${mark}${line}`).join('\n')

type ToolEntry = Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>

/** An edit as a diff and a write as the file's head; the model carries only a bounded cut of either, and the text says so. */
function changeText(entry: ToolEntry): string | undefined {
  const change = entry.change
  if (change === undefined) return undefined
  if (change.write !== undefined) {
    const more = change.write.lines > change.write.head.length ? `… ${String(change.write.lines - change.write.head.length)} more lines` : undefined
    return join([`--- /dev/null`, `+++ ${change.path}`, prefixed('+', change.write.head.join('\n')), more])
  }
  const hunks = change.hunks.map(hunk => join(['@@', hunk.before === '' ? undefined : prefixed('-', hunk.before), hunk.after === '' ? undefined : prefixed('+', hunk.after)]))
  const hidden = change.hiddenLines > 0 ? `… ${String(change.hiddenLines)} more changed lines` : undefined
  return join([`--- ${change.path}`, `+++ ${change.path}`, ...hunks, hidden])
}

function toolText(entry: ToolEntry): string {
  const head = entry.detail === '' ? entry.name : `${entry.name}(${entry.detail})`
  const plan = partialStrings(entry.arguments).fields['plan']
  const web = entry.web === undefined ? undefined : entry.web.kind === 'search'
    ? entry.web.sources.map(source => source.title === undefined ? source.url : `${source.title} ${source.url}`).join('\n')
    : entry.web.url
  const output = entry.terminal?.output ?? entry.result?.fullText ?? entry.result?.text
  if (plan !== undefined) return plan
  const diff = changeText(entry)
  if (diff !== undefined) return diff
  if (entry.terminal !== undefined) return join([`$ ${entry.terminal.command}`, output])
  return join([head, web, output])
}

function readText(read: ReadCallModel): string {
  return join([read.path ?? read.label ?? read.detail, read.error, read.previewLines?.map(line => `${String(line.number).padStart(5)}  ${line.text}`).join('\n')])
}

function searchText(search: SearchCallModel): string {
  return join([
    search.pattern ?? search.detail,
    search.error,
    search.files?.map(file => join([file.path, ...file.previews.map(preview => `  ${String(preview.lineNumber)}: ${preview.line}`)])).join('\n'),
    search.paths?.join('\n'),
  ])
}

function commandText(command: CommandCallModel): string {
  return join([`$ ${command.commandLines?.join('\n') ?? command.command}`, command.previewLines?.join('\n'), command.error])
}

/** One call of a group entry, by the kind of group it came from. */
function callText(entry: TranscriptEntryModel, call: NonNullable<RowPart['call']>): string {
  if (entry.kind === 'transcript-read-group') return readText(call as ReadCallModel)
  if (entry.kind === 'transcript-search-group') return searchText(call as SearchCallModel)
  return commandText(call as CommandCallModel)
}

/** The text of one entry as a person reads it. */
function entryText(entry: TranscriptEntryModel): string {
  switch (entry.kind) {
    case 'transcript-user': return entry.text
    case 'transcript-assistant': return entry.text
    case 'transcript-thinking': return entry.text
    case 'transcript-tool': return toolText(entry)
    case 'transcript-read-group': return entry.reads.map(readText).join('\n\n')
    case 'transcript-search-group': return entry.searches.map(searchText).join('\n\n')
    case 'transcript-command-group': return entry.commands.map(commandText).join('\n\n')
    case 'transcript-error': return entry.message
    case 'transcript-interrupted': return ''
    case 'transcript-compaction': return join([entry.detail, entry.summary, entry.error])
  }
}

/**
 * The content of one part of a row.
 * @param part - an entry, or a call of a group entry.
 * @param mode - `text` for a person (Markdown for a message, a diff for an edit, a command with its output), `raw` for the model's JSON.
 * @returns the text to copy or read in the editor.
 */
export function partText(part: RowPart, mode: CopyMode): string {
  if (mode === 'raw') return JSON.stringify(part.call ?? part.entry, null, 2)
  return part.call === undefined ? entryText(part.entry) : callText(part.entry, part.call)
}
