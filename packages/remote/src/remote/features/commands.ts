/**
 * Per-mount local command contributions for focused Remote features.
 * @module @ephemeral-ai/mayfly/remote/features/commands
 */

/** One feature-owned slash command; execution receives only the argument suffix. */
export interface RemoteFeatureCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  execute(rawInput: string, signal: AbortSignal): void | Promise<void>
}

/** Registration and dispatch face exposed to the foundation's eventual local command router. */
export interface RemoteFeatureCommandSource {
  list(): readonly RemoteFeatureCommandDefinition[]
  execute(name: string, rawInput: string, signal: AbortSignal): Promise<boolean>
}

/** Instance-owned command registry; no process-global command or dispatch state exists. */
export class RemoteFeatureCommandRegistry implements RemoteFeatureCommandSource {
  private readonly entries = new Map<string, RemoteFeatureCommandDefinition>()

  /** List contributed commands in stable name order. */
  list(): readonly RemoteFeatureCommandDefinition[] {
    return [...this.entries.values()].toSorted((left, right) => left.name.localeCompare(right.name))
  }

  /** Add one command and return its exact registration disposer. */
  register(definition: RemoteFeatureCommandDefinition): () => void {
    const name = definition.name.trim().toLowerCase()
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid Remote feature command name "${definition.name}"`)
    if (this.entries.has(name)) throw new Error(`Remote feature command "${name}" is already registered`)
    const entry = Object.freeze({ ...definition, name })
    this.entries.set(name, entry)
    return () => {
      if (this.entries.get(name) === entry) this.entries.delete(name)
    }
  }

  /** Execute one exact command, returning false when the name belongs to another router. */
  async execute(name: string, rawInput: string, signal: AbortSignal): Promise<boolean> {
    const command = this.entries.get(name.toLowerCase())
    if (command === undefined) return false
    await command.execute(rawInput, signal)
    return true
  }

  /** Drop every contribution without invoking command handlers. */
  clear(): void {
    this.entries.clear()
  }
}

/** Combined read of several instance-owned sources; the first source owning a name wins it. */
export function mergeRemoteFeatureCommandSources(
  ...sources: readonly RemoteFeatureCommandSource[]
): RemoteFeatureCommandSource {
  return {
    list: () => {
      const seen = new Set<string>()
      const merged: RemoteFeatureCommandDefinition[] = []
      for (const definition of sources.flatMap(source => source.list())) {
        if (seen.has(definition.name)) continue
        seen.add(definition.name)
        merged.push(definition)
      }
      return merged.toSorted((left, right) => left.name.localeCompare(right.name))
    },
    async execute(name, rawInput, signal) {
      for (const source of sources) {
        if (await source.execute(name, rawInput, signal)) return true
      }
      return false
    },
  }
}
