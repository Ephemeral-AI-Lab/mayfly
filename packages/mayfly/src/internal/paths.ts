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
