/** Live local/feature discovery without retaining Host Session objects. @module remote/command-catalog */
import type { RemoteFeatureCommandDefinition } from './features/commands.ts'

/** Renderer-neutral command discovery data; execution stays with its owning router. */
export interface RemoteCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  readonly input?: { readonly hint: string }
  readonly group?: 'remote'
}

/** Built-in commands implemented by this Remote composition. */
export const FRONTEND_COMMANDS: readonly (RemoteCommandDescriptor & Pick<RemoteFeatureCommandDefinition, 'scope' | 'hidden'>)[] = [
  { name: 'quit', description: 'Exit Mayfly', aliases: ['q', 'exit'], scope: 'sessionless' },
  { name: 'new', description: 'Start a new session', aliases: ['clear'], scope: 'sessionless' },
  { name: 'sessions', description: 'List persisted sessions and switch to one (an id resumes directly)', aliases: ['resume'], input: { hint: '[<session-id>]' }, scope: 'sessionless' },
  { name: 'rename', description: 'Rename the current session: /rename <title>', input: { hint: '<title>' } },
  { name: 'fork', description: 'Fork the current session into a new one', input: { hint: '[atSeq]' } },
  { name: 'rewind', description: 'Create a branch from an earlier user turn', input: { hint: '[seq]' } },
  { name: 'host', description: 'List attached Hosts', scope: 'sessionless', group: 'remote' },
  { name: 'attach', description: 'Attach a Host URL', scope: 'sessionless', group: 'remote', input: { hint: '<host-url>' } },
  { name: 'detach', description: 'Detach the current Host without stopping it', scope: 'sessionless', group: 'remote' },
  { name: 'skills', description: 'List available skills (the # prompt invokes one)' },
  { name: 'help', description: 'Show available commands and key bindings', scope: 'sessionless' },
  { name: 'host-status', description: 'Show current Host and Session diagnostics', group: 'remote' },
  { name: 'context', description: 'Show token usage and the context window' },
  { name: 'version', description: 'Show the Mayfly and harness versions' },
  { name: 'init', description: 'Analyze the codebase and write AGENTS.md' },
]

/** A mounted local command keeps precedence over feature and native duplicates. */
export function remoteCommandCatalog(
  hasWritableSession: boolean,
  features: readonly RemoteFeatureCommandDefinition[],
  native: readonly RemoteCommandDescriptor[] = [],
): readonly RemoteCommandDescriptor[] {
  const seen = new Set<string>()
  const commands: RemoteCommandDescriptor[] = []
  for (const command of [...FRONTEND_COMMANDS, ...features]) {
    if (command.hidden === true || (!hasWritableSession && command.scope !== 'sessionless')) continue
    append(command)
  }
  if (hasWritableSession) for (const command of native) append(command)
  return commands.toSorted((left, right) => left.name.localeCompare(right.name))

  function append(command: RemoteCommandDescriptor): void {
    if (seen.has(command.name)) return
    seen.add(command.name)
    const aliases = command.aliases?.filter(alias => !seen.has(alias)) ?? []
    for (const alias of aliases) seen.add(alias)
    commands.push({
      name: command.name,
      description: command.description,
      ...aliases.length === 0 ? {} : { aliases },
      ...command.input === undefined ? {} : { input: command.input },
      ...command.group === undefined ? {} : { group: command.group },
    })
  }
}
