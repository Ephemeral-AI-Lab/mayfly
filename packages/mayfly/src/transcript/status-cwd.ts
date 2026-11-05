/**
 * Working-directory footer entry: the home-shortened path abbreviated to its
 * last three segments on deep paths, shed to its last segment when the row is
 * crowded. An empty path renders '' and occupies nothing.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-cwd
 */

export { shortenCwd, buildCwdStatusNode } from './status-cwd-model.ts'
