/**
 * The commands that run before any session exists. Mayfly starts without a
 * session and creates one only for the first message, but dsh's command
 * runtime resolves and executes commands against an Agent. The Mayfly-owned
 * commands that never read the Agent register here as well, so the editor
 * can run, list, and hint them while no Agent is selected; every other
 * command answers with a "send a message first" notice.
 *
 * @module @ephemeral-ai/mayfly/interaction/sessionless-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** What a sessionless handler may read: no Agent, no command id, no attachments. */
export type SessionlessInvocation = Pick<CommandInvocation, 'rawInput' | 'signal'>

/** A command definition whose handler needs nothing from the receiving Agent. */
export interface SessionlessDefinition extends Omit<CommandDefinition, 'handler'> {
  readonly handler: (invocation: SessionlessInvocation) => CommandResult | Promise<CommandResult>
}

/** The shape a discovery surface (dropdown, hint, `/help`) lists. */
export interface CommandListing {
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

/**
 * Register a Mayfly-owned command with the dsh runtime and with the
 * sessionless table.
 * @returns the disposer unregistering both.
 */
export function registerOwnedCommand(ctx: Context, definition: SessionlessDefinition): () => void {
  const offRuntime = ctx.commands.register(definition)
  const offSessionless = ctx.mayflyInteractionState.sessionless.register(definition)
  // The table lives in the parent frontend tree and survives a theme-swap
  // rebuild, so the registering fiber's unload must remove the entry itself.
  ctx.effect(() => offSessionless)
  return () => {
    offRuntime()
    offSessionless()
  }
}

/**
 * Register a command that runs only while no session exists. The dsh runtime
 * already owns a command of the same name for a live Agent (`/permission`);
 * this one answers the start surface, where the same words set the default
 * a new session takes.
 * @returns the disposer.
 */
export function registerSessionlessCommand(ctx: Context, definition: SessionlessDefinition): () => void {
  const off = ctx.mayflyInteractionState.sessionless.register(definition)
  ctx.effect(() => off)
  return off
}

/**
 * The commands a discovery surface lists now: the Agent's effective commands,
 * or the sessionless set while no Agent is selected.
 */
export function listCommands(ctx: Context, agent: Agent | null): readonly CommandListing[] {
  return agent === null
    ? ctx.mayflyInteractionState.sessionless.list()
    : ctx.commands.list(agent).map(command => ({
      name: command.name,
      description: command.description,
      ...(command.input?.hint === undefined ? {} : { input: { hint: command.input.hint } }),
    }))
}

/** The advertised argument hint of one command, for the editor's ghost text. */
export function commandHint(ctx: Context, agent: Agent | null, name: string): string | undefined {
  return agent === null
    ? ctx.mayflyInteractionState.sessionless.find(name)?.input?.hint
    : ctx.commands.find(agent, name)?.input?.hint
}
