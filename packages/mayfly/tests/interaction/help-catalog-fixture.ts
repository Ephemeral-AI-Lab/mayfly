/** The shipped Remote command families and shared key reference in Help order.
 * @module @ephemeral-ai/mayfly/tests/interaction/help-catalog-fixture
 */
import { remoteCommandCatalog, type RemoteCommandDescriptor } from '../../../remote/src/remote/command-catalog.ts'
import { displayKey } from '../../src/core/key-actions.ts'
import { SHARED_KEY_REFERENCE } from '../../src/core/ui-key-grammar.ts'
import type { HelpSection } from '../../src/interaction/help.ts'
import { INTERACTION_KEY_ACTIONS } from '../../src/interaction/key-definitions.ts'

// Readonly descriptors from the feature, configuration, and operations mounts.
// Keep the actual names/aliases and descriptions: Help must admit the shipped
// catalog before any external plugin contributes further commands or keys.
const COMPOSITION_COMMANDS: readonly RemoteCommandDescriptor[] = [
  { name: 'goal', description: 'Set or view the goal for a long-running task' },
  { name: 'jobs', description: 'Browse background jobs' },
  { name: 'schedule', description: 'Inspect session reminders' },
  { name: 'mcp', description: 'List the MCP servers the host connects to' },
  { name: 'tools', description: 'List the tools visible to the current session' },
  { name: 'plan', description: 'Enter or leave plan mode for the next session' },
  { name: 'mode', description: 'Toggle plan mode (same as Shift+Tab)' },
  { name: 'model', description: 'Switch the model (no argument opens the picker)' },
  { name: 'effort', aliases: ['thinking'], description: 'Switch the thinking effort of the current model' },
  { name: 'account', group: 'remote', description: 'Open the DeepSeek account panel' },
  { name: 'settings', description: 'Edit user settings by namespace' },
  { name: 'permissions', description: 'Choose the permission preset' },
  { name: 'theme', description: 'Switch the color theme' },
  { name: 'language', group: 'remote', description: 'Choose the interface language' },
  { name: 'onboarding', group: 'remote', description: 'Run the first-run setup guide' },
  { name: 'agents', description: 'Browse this session\'s subagents, view one, or stop a continuable child' },
  { name: 'btw', description: 'Ask a side question in a temporary Agent session' },
  { name: 'retract', description: 'Retract a running tool-free turn by message id' },
  { name: 'export', description: 'Export the current session as Markdown' },
  { name: 'save', description: 'Save the current session as a Markdown file' },
  { name: 'trace', description: 'Browse and copy the current session execution trace' },
  { name: 'stats', description: 'Show this session, the history of your sessions, and the usage per model' },
  { name: 'plugin', description: 'Browse, install, and remove plugins' },
  { name: 'update', description: 'Safely update Mayfly (preflight, snapshot, smoke, auto-rollback)' },
  { name: 'copy', description: 'Copy the last assistant message to the clipboard' },
  { name: 'files', description: 'Browse files delivered by the agent' },
  { name: 'preset', description: 'List agent presets or switch (blank sessions; sets the default before one starts)' },
  { name: 'provider', description: 'Configure providers or choose their models' },
]

/** A complete writable-session catalog, without retaining a Client or Session. */
export function helpCatalogSections(): readonly HelpSection[] {
  const commands = remoteCommandCatalog(true, [], COMPOSITION_COMMANDS)
  const row = (command: RemoteCommandDescriptor) => ({
    label: `/${command.name}${command.aliases === undefined ? '' : ` (${command.aliases.map(alias => `/${alias}`).join(', ')})`}`,
    description: command.description,
  })
  return [
    { heading: 'Commands', labelTone: 'accent', rows: commands.filter(command => command.group !== 'remote').map(row) },
    { heading: 'Keys', labelTone: 'warning', rows: INTERACTION_KEY_ACTIONS.map(action => ({
      label: [action.keys].flat().map(displayKey).join('/'), description: action.description!,
    })) },
    { heading: 'Panels and pickers', labelTone: 'warning', rows: SHARED_KEY_REFERENCE.map(row => ({ label: row.keys, description: row.action })) },
    { heading: 'Remote', labelTone: 'accent', rows: commands.filter(command => command.group === 'remote').map(row) },
  ]
}
