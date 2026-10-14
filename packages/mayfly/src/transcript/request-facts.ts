/**
 * What the request block of a call that waits on the user shows besides the call's own arguments: the warning a command
 * earns. There is no native signal for a command that deletes files, so the warning is a documented heuristic on the
 * command text: a program that removes files, or a Git or `find` form that does. It reads the text only and never
 * decides anything: the user still chooses.
 *
 * @module @ephemeral-ai/mayfly/transcript/request-facts
 */

/** Programs that remove files or directories when they are the command itself, after a pipe, `;`, `&&`, a subshell, or `sudo`. */
const REMOVERS = /(?:^|[\s;&|(`])(?:sudo\s+(?:-\S+\s+)*)?(?:rm|rmdir|unlink|shred|del|erase|rd|trash)(?=\s|$)/iu

/** Forms of other programs that remove files: `git clean`, `git rm`, `find … -delete`, PowerShell's `Remove-Item`. */
const REMOVING_FORMS = /\bgit\s+(?:clean|rm)\b|\bfind\b[^\n;&|]*\s-delete\b|\bRemove-Item\b/iu

/**
 * Whether a command removes files.
 * @param command - the command text the tool was given.
 * @returns true when it contains a deleting program or form.
 */
export function deletesFiles(command: string): boolean {
  return REMOVERS.test(command) || REMOVING_FORMS.test(command)
}
