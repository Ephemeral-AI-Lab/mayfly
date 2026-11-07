/** Shared status-cwd presentation over readonly facts. @module */
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { displayPath, homeRelative } from '../internal/paths.ts'
import { SHED, shedNode } from './status-shed.ts'
/** How many trailing path segments a deep cwd keeps. */
const MAX_CWD_SEGMENTS = 3

/**
 * Abbreviate a working directory for the footer: `~` for the home directory
 * itself, `~` + the rest under home, and once more than
 * {@link MAX_CWD_SEGMENTS} segments remain, everything above the last three
 * collapses to a leading `…`.
 * @param path - the working directory.
 * @param home - the home directory to shorten against.
 * @returns the abbreviated cwd; `path` unchanged when empty or shallow.
 */
export function shortenCwd(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (path === '') return path
  const work = homeRelative(path, home, platform) ?? displayPath(path, platform)

  const segments = work.split('/').filter(segment => segment.length > 0)
  if (segments.length <= MAX_CWD_SEGMENTS) return work
  return `…/${segments.slice(-MAX_CWD_SEGMENTS).join('/')}`
}

/** Build the published cwd row from an already home-shortened and abbreviated path. */
export function buildCwdStatusNode(text: string): MayflyStatusNode | null {
  if (text === '') return null
  const leaf = text.split('/').filter(segment => segment.length > 0 && segment !== '…' && segment !== '~').at(-1)
  const gone = { rank: SHED.directory, node: null }
  return shedNode({ kind: 'text', content: text, tone: 'muted' }, leaf === undefined || leaf === text ? [gone] : [{ rank: SHED.cwd, node: { kind: 'text', content: leaf, tone: 'muted' } }, gone])
}
