/**
 * The files of a patch, read from the text the model gave `apply_patch`: the Harness's applied metadata leaves out added
 * files and move destinations, and only the patch itself names every file with what happens to it. Its arguments may still
 * be streaming, so an unfinished patch reads as far as it has gone.
 *
 * @module @ephemeral-ai/mayfly/transcript/patch-files
 */

import type { TranscriptPatchFileModel } from '../frontend/models.ts'
import { trimContext } from '../core/diff-align.ts'

/** Lines of each side a hunk carries; a file's counts are taken over all of them. */
const PATCH_HUNK_LINES = 60

interface Hunk { readonly before: string[], readonly after: string[] }
interface Draft { kind: TranscriptPatchFileModel['kind'], path: string, from?: string, added: number, removed: number, hunks: Hunk[] }

const HEADERS: Readonly<Record<string, TranscriptPatchFileModel['kind']>> = { 'Add File': 'A', 'Delete File': 'D', 'Update File': 'M' }

function hunkOf(file: Draft): Hunk {
  const last = file.hunks.at(-1)
  if (last !== undefined) return last
  const first: Hunk = { before: [], after: [] }
  file.hunks.push(first)
  return first
}

/** One line of a file's body: `+` adds, `-` removes, and anything else is context on both sides. */
function readLine(file: Draft, line: string): void {
  const hunk = hunkOf(file)
  const text = line.slice(1)
  if (line.startsWith('+')) {
    hunk.after.push(text)
    file.added += 1
  } else if (line.startsWith('-')) {
    hunk.before.push(text)
    file.removed += 1
  } else {
    hunk.before.push(text)
    hunk.after.push(text)
  }
}

function finished(file: Draft): TranscriptPatchFileModel {
  let hidden = 0
  const hunks = file.hunks.map((hunk) => {
    hidden += Math.max(0, hunk.before.length - PATCH_HUNK_LINES) + Math.max(0, hunk.after.length - PATCH_HUNK_LINES)
    return trimContext(hunk.before.slice(0, PATCH_HUNK_LINES).join('\n'), hunk.after.slice(0, PATCH_HUNK_LINES).join('\n'))
  })
  return { kind: file.kind, path: file.path, ...(file.from === undefined ? {} : { from: file.from }), added: file.added, removed: file.removed, hunks, hiddenLines: hidden }
}

/**
 * Every file a patch names, in its order, with what happens to it and the lines it changes.
 * @param patch - the patch text, whole or as far as it has streamed.
 * @returns the files.
 */
export function patchFiles(patch: string): readonly TranscriptPatchFileModel[] {
  const files: Draft[] = []
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add File|Delete File|Update File|Move to): (.+)$/u.exec(line)
    const file = files.at(-1)
    if (header !== null) {
      if (header[1] !== 'Move to') files.push({ kind: HEADERS[header[1]!]!, path: header[2]!, added: 0, removed: 0, hunks: [] })
      else if (file !== undefined) Object.assign(file, { kind: 'R', from: file.path, path: header[2]! })
    } else if (file !== undefined && !line.startsWith('*** ')) {
      if (line.startsWith('@@')) file.hunks.push({ before: [], after: [] })
      else if (line !== '' || file.hunks.length > 0) readLine(file, line)
    }
  }
  return files.map(finished)
}
