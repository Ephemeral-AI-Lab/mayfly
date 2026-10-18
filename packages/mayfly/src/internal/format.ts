/**
 * Shared formatting for values that cross a feature boundary: an unknown
 * thrown value as its message, with the String form kept for a non-Error
 * throw. Callers that need a stack or a cause chain format that themselves.
 *
 * @module @ephemeral-ai/mayfly/internal/format
 */

/**
 * The message of an unknown thrown value: an Error's message, else its String
 * form. The one-way conversion every error report uses, so a caught value is
 * never silently read as `[object Object]`.
 * @param error - the caught value.
 * @returns the message text.
 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
