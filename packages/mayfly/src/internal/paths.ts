/** Platform filesystem paths and renderer-neutral display paths.
 * @module @ephemeral-ai/mayfly/internal/paths
 */
import { posix, win32 } from 'node:path'

export function platformPath(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

export function displayPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/** The `~`-relative view of `path` under `home`, or `undefined` when it is outside. */
export function homeRelative(path: string, home: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (home === '') return undefined
  const paths = platformPath(platform)
  const relative = displayPath(paths.relative(home, path), platform)
  if (relative === '') return '~'
  if (relative !== '..' && !relative.startsWith('../') && !paths.isAbsolute(relative)) return `~/${relative}`
  return undefined
}
