/** Pure tool-name presentation classification shared by transcript consumers. @module */

/** Native spawn tools use the base name or a configured provider suffix. */
export function isSpawnToolName(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}
