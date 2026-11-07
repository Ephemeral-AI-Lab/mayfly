import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** What a sessionless handler may read: no Agent, no command id, no attachments. */
type SessionlessInvocation = Pick<CommandInvocation, 'rawInput' | 'signal'>

/** A command definition whose handler needs nothing from the receiving Agent. */
interface SessionlessDefinition extends Omit<CommandDefinition, 'handler'> {
  readonly handler: (invocation: SessionlessInvocation) => CommandResult | Promise<CommandResult>
}

/** The shape a discovery surface (dropdown, hint, `/help`) lists. */
interface CommandListing {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
}

/** Frontend-tree-scoped table of the commands that run with no session. */
export class SessionlessCommandRegistry {
  private readonly byName = new Map<string, SessionlessDefinition>()

  /**
   * Record one definition; the object itself is the generation token, so an
   * old disposer cannot remove a replacement.
   * @returns the disposer removing only this registration.
   */
  register(definition: SessionlessDefinition): () => void {
    this.byName.set(definition.name, definition)
    return () => {
      if (this.byName.get(definition.name) === definition) this.byName.delete(definition.name)
    }
  }

  find(name: string): SessionlessDefinition | undefined {
    return this.byName.get(name)
  }

  /** The registered commands, name-sorted like `ctx.commands.list`. */
  list(): readonly CommandListing[] {
    return [...this.byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(command => ({
        name: command.name,
        description: command.description,
        ...(command.input?.hint === undefined ? {} : { input: { hint: command.input.hint } }),
      }))
  }

  clear(): void {
    this.byName.clear()
  }
}

