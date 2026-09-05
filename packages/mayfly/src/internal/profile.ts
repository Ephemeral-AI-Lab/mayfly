/**
 * Profile selection shared by runtime commands and the exit resume line.
 * @module @ephemeral-ai/mayfly/internal/profile
 */

/** Read the first launcher profile flag, defaulting to the Mayfly profile. */
export function profileNameFromArgv(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== undefined && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
    if (arg === '--profile') {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) return next
    }
  }
  return 'mayfly'
}
