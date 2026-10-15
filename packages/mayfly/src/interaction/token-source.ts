/**
 * The inline tokens of the editor buffer that the interaction layer owns: a pasted image's marker and an `@` mention.
 * A marker is a token while the tree still holds its image (a key of the image map), so text that merely looks like one
 * stays text. Pasted blocks are the editor's own and need no source.
 *
 * @module @ephemeral-ai/mayfly/interaction/token-source
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyEditorTokenSource, MayflyEditorTokenSpan } from '../core/types.ts'
import { mentionPath } from '../internal/mention.ts'
import { sessionCwd } from './editor-plus.ts'
import { IMAGE_MARKER } from './image-marker.ts'

/** A whole mention in a line: `@path`, or a quoted path; a word that starts after whitespace, a quote, or `=`. */
const MENTION = /(?<=^|[\s"'=])@(?:"[^"]*"|'[^']*'|[^\s"'=]+)(?=\s|$)/gu

/** Where a mention's path lies: `~` is the home directory, a relative path is under the session's directory. */
export function mentionFile(mention: string, cwd: string): string {
  const path = mentionPath(mention)
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  return isAbsolute(path) ? path : join(cwd, path)
}

/**
 * The token source of the tree's editor. A mention is a token when it was accepted from the completion list, or when it
 * names a file or folder that exists, so a path typed out in full or recalled from history is one too.
 * @param ctx - plugin context carrying the interaction state.
 * @returns the function from a buffer line to its token spans.
 */
export function createTokenSource(ctx: Context): MayflyEditorTokenSource {
  return line => {
    const state = ctx.mayflyInteractionState
    const spans: MayflyEditorTokenSpan[] = []
    if (line.includes('[image #')) {
      for (const match of line.matchAll(IMAGE_MARKER)) {
        if (state.pasteImage.pastedImages.has(match[0])) spans.push({ start: match.index, end: match.index + match[0].length, kind: 'image' })
      }
    }
    if (line.includes('@')) {
      const cwd = sessionCwd(ctx)
      for (const match of line.matchAll(MENTION)) {
        if (state.mentions.has(match[0]) || (match[0].length > 1 && existsSync(mentionFile(match[0], cwd)))) {
          spans.push({ start: match.index, end: match.index + match[0].length, kind: 'mention' })
        }
      }
    }
    return spans
  }
}
