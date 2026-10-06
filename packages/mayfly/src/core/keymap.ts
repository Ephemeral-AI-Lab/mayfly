/**
 * `ctx.mayflyKeymap` service: the Mayfly keybinding registry and its
 * runtime rebinding (spec §3.5). Every key the runtime dispatches belongs to
 * a named action; a key is that action's current binding. Registration
 * declares an action's default keys and scope and fails loud on a conflict,
 * so within one scope a key is claimed by at most one registered action at a
 * time (a `global` action claims its key in every scope). `bind` replaces an
 * action's keys for the session: a rebound-away key is dead, not an alias,
 * and a binding that collides with another action in an overlapping scope
 * is refused with that action's owner. Component actions that only appear in
 * admitted nodes are recorded as seen, so `list` can offer them for
 * rebinding too. Key matching delegates to pi-tui's `matchesKey`; `dispatch`
 * runs the global half of the registry: handler-carrying actions fire in
 * registration order ahead of focus routing.
 *
 * @module @ephemeral-ai/mayfly/core/keymap
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { type KeyId, matchesKey } from '@earendil-works/pi-tui'
import { ACTION_CANCEL, ACTION_SUBMIT, isKeyId, printableKey } from './key-actions.ts'
import type { MayflyKeyAction, MayflyKeyBinding, MayflyKeymap, MayflyKeyScope, MayflySeenAction } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyKeymap: MayflyKeymapService
  }
}

/** Stable error taxonomy for keymap registration and binding failures. */
export type MayflyKeymapErrorCode = 'KEY_CONFLICT' | 'DUPLICATE_ACTION' | 'INVALID_BINDING'

/** Stable error taxonomy for keymap registration failures. */
export class MayflyKeymapError extends Error {
  /** Machine-readable failure kind. */
  readonly code: MayflyKeymapErrorCode

  /**
   * @param message - the conflicting key and the actions claiming it.
   * @param code - the failure kind.
   */
  constructor(message: string, code: MayflyKeymapErrorCode) {
    super(message)
    this.name = 'MayflyKeymapError'
    this.code = code
  }
}

interface RegisteredAction {
  keys: string[]
  scope: MayflyKeyScope
  description?: string
  handler?: () => void
}

/** One key claimed by an action in a scope. */
interface KeyClaim {
  readonly id: string
  readonly scope: MayflyKeyScope
}

/** A runtime override, with the label to list it under when its action is neither registered nor seen. */
interface Override {
  readonly keys: string[]
  readonly label?: string
}

/** A dotted `<owner>.<action>` id: lowercase words of letters, digits, and hyphens. */
const ACTION_ID = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u

/** The keys a binding must keep: Escape always cancels and Enter always accepts. */
const FIXED_KEYS: Readonly<Record<string, string>> = { [ACTION_CANCEL]: 'escape', [ACTION_SUBMIT]: 'enter' }

/** The plain second defaults of the Alt keys; the first press of one tells the keymap the host may not deliver Alt. */
const PLAIN_ALT_ALTERNATIVES: readonly KeyId[] = ['f2', 'f3', 'f4', 'f5']

/** Two scopes overlap when they are equal or either is global. */
function overlaps(left: MayflyKeyScope, right: MayflyKeyScope): boolean {
  return left === right || left === 'global' || right === 'global'
}

/** The owner of a dotted `<owner>.<action>` id. */
export function actionOwner(id: string): string {
  return id.split('.', 1)[0]!
}

/** Dedupe one action's key list, preserving order. */
function normalizeKeys(keys: string | readonly string[]): string[] {
  const list = typeof keys === 'string' ? [keys] : keys
  return [...new Set(list)]
}

/** Keys that carry Alt sort after the others while the host prefers plain keys. */
function plainFirst(keys: readonly string[]): string[] {
  return keys.toSorted((left, right) => Number(left.includes('alt+')) - Number(right.includes('alt+')))
}

/**
 * The `mayflyKeymap` service. Unregistered automatically when the plugin's
 * fiber unloads.
 */
export class MayflyKeymapService extends Service implements MayflyKeymap {
  private readonly actions = new Map<string, RegisteredAction>()
  private readonly keyClaims = new Map<string, KeyClaim[]>()
  private readonly overrides = new Map<string, Override>()
  private readonly seen = new Map<string, MayflySeenAction>()
  private readonly listeners = new Set<() => void>()
  private changes = 0
  private plainForSession = false
  private plainForGood = false

  /**
   * Counts every committed change to what a key means (registrations, bindings, and the plain-key preference), so a
   * cache of anything derived from the keymap can tell it is stale.
   */
  get revision(): number { return this.changes }

  /** Whether hint rows show an action's key without Alt first: set by a setting, or for the session by the first F2-F5 press. */
  get preferPlain(): boolean { return this.plainForGood || this.plainForSession }

  /**
   * Create and register the service.
   * @param ctx - the owning Cordis context.
   */
  constructor(ctx: Context) {
    super(ctx, 'mayflyKeymap')
  }

  /**
   * Register a batch of actions after validating it as a unit.
   * @param actions - the actions to register.
   * @returns a disposer unregistering exactly this batch; safe to call twice.
   */
  register(actions: MayflyKeyAction[]): () => void {
    // Validate the whole batch against existing registrations and itself
    // before committing anything, so a failure leaves the registry untouched.
    const batch = new Map<string, RegisteredAction>()
    const batchClaims = new Map<string, KeyClaim[]>()
    for (const action of actions) {
      if (this.actions.has(action.id) || batch.has(action.id)) {
        throw new MayflyKeymapError(`key action "${action.id}" is already registered`, 'DUPLICATE_ACTION')
      }
      const keys = normalizeKeys(action.keys)
      const scope = action.scope ?? 'global'
      for (const key of keys) {
        const owner = [...this.keyClaims.get(key) ?? [], ...batchClaims.get(key) ?? []].find(claim => overlaps(claim.scope, scope))
        if (owner !== undefined) {
          throw new MayflyKeymapError(
            `key "${key}" is claimed by both "${owner.id}" and "${action.id}" (${actionOwner(owner.id)} owns it in the ${owner.scope} scope)`,
            'KEY_CONFLICT',
          )
        }
        batchClaims.set(key, [...batchClaims.get(key) ?? [], { id: action.id, scope }])
      }
      const entry: RegisteredAction = {
        keys,
        scope,
        // exactOptionalPropertyTypes forbids assigning undefined to the
        // optional slots, so each is spread in only when present.
        ...(action.description === undefined ? {} : { description: action.description }),
        ...(action.handler === undefined ? {} : { handler: action.handler }),
      }
      batch.set(action.id, entry)
    }
    for (const [id, entry] of batch) {
      this.actions.set(id, entry)
      for (const key of entry.keys) this.keyClaims.set(key, [...this.keyClaims.get(key) ?? [], { id, scope: entry.scope }])
    }
    this.changed()

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const [id, entry] of batch) {
        this.actions.delete(id)
        for (const key of entry.keys) {
          const remaining = this.keyClaims.get(key)!.filter(claim => claim.id !== id)
          if (remaining.length === 0) this.keyClaims.delete(key)
          else this.keyClaims.set(key, remaining)
        }
      }
      this.changed()
    }
  }

  /**
   * Test whether one input sequence triggers an action through its effective keys.
   * @param data - the input sequence as read from the terminal.
   * @param action - the action id; an action with no keys never matches.
   * @returns whether the input triggers the action.
   */
  matches(data: string, action: string): boolean {
    // KeyId is a compile-time union over key-id strings; L1 accepts plain
    // strings per its own contract and pi-tui matches them at runtime.
    return this.getKeys(action).some(key => matchesKey(data, key as KeyId))
  }

  /**
   * Run the global dispatch: walk handler-carrying actions in registration
   * order (Map insertion order), invoking the first whose effective key matches.
   * @param data - the input sequence as read from the terminal.
   * @returns whether a handler ran for the input.
   */
  dispatch(data: string): boolean {
    for (const [id, entry] of this.actions) {
      if (entry.handler === undefined) continue
      if (this.matches(data, id)) {
        entry.handler()
        return true
      }
    }
    return false
  }

  /**
   * Resolve the key ids an action answers now: its override, else its registered or seen defaults.
   * @param action - the action id.
   * @returns the effective key ids, plain keys first while `preferPlain` holds; empty for unknown actions.
   */
  getKeys(action: string): string[] {
    return this.resolve(action, this.seen.get(action)?.keys ?? [])
  }

  /**
   * Resolve a component action's keys from the node that declares it: its override, else a registered default, else
   * the declared default.
   * @param action - the action id.
   * @param fallback - the default the declaring node gives.
   * @returns the effective key ids, plain keys first while `preferPlain` holds.
   */
  resolve(action: string, fallback: readonly string[]): string[] {
    const keys = this.overrides.get(action)?.keys ?? this.actions.get(action)?.keys ?? fallback
    return this.preferPlain ? plainFirst(keys) : [...keys]
  }

  /**
   * Record component actions that appeared in an admitted node, so `list` offers them for rebinding. Seeing an action
   * changes no key, so it does not move the revision.
   * @param actions - the actions with their labels and declared default keys.
   */
  see(actions: readonly MayflySeenAction[]): void {
    for (const action of actions) {
      if (this.actions.has(action.id)) continue
      this.seen.set(action.id, { id: action.id, label: action.label, keys: [...action.keys] })
    }
  }

  /**
   * Bind an action to new keys for the session, replacing its defaults: every key it gave up stops working.
   * @param action - the `<owner>.<action>` id, registered, seen, or not yet loaded.
   * @param keys - the new key ids, possibly none.
   * @param label - the label to list the action under while it is neither registered nor seen.
   * @throws MayflyKeymapError `INVALID_BINDING` for a malformed id or key, an Escape or Enter given up or taken, or a
   *   printable key where text is typed; `KEY_CONFLICT`, naming the owner, when another action answers the key in an
   *   overlapping scope.
   */
  bind(action: string, keys: string | readonly string[], label?: string): void {
    const next = this.checkBinding(action, keys)
    this.overrides.set(action, { keys: next, ...(label === undefined ? {} : { label }) })
    this.changed()
  }

  /**
   * Restore an action's default keys.
   * @param action - the action id; an action without an override is left alone.
   */
  reset(action: string): void {
    if (this.overrides.delete(action)) this.changed()
  }

  /** Restore every action's default keys. */
  resetAll(): void {
    if (this.overrides.size === 0) return
    this.overrides.clear()
    this.changed()
  }

  /**
   * Replace every override at once, as a saved settings document states them. Entries that are invalid or collide
   * are skipped and returned, so one bad line never blocks the rest.
   * @param overrides - action id to keys and the label saved beside them, in document order.
   * @returns the refusals, one per skipped entry.
   */
  applyOverrides(overrides: Readonly<Record<string, { readonly keys: readonly string[], readonly label?: string }>>): MayflyKeymapError[] {
    const before = JSON.stringify([...this.overrides])
    this.overrides.clear()
    const refused: MayflyKeymapError[] = []
    for (const [action, override] of Object.entries(overrides)) {
      try {
        const keys = this.checkBinding(action, override.keys)
        this.overrides.set(action, { keys, ...(override.label === undefined ? {} : { label: override.label }) })
      } catch (error) { refused.push(error as MayflyKeymapError) }
    }
    if (JSON.stringify([...this.overrides]) !== before) this.changed()
    return refused
  }

  /**
   * Set or clear the plain-key preference for good (the `preferPlainKeys` setting).
   * @param value - whether hints lead with the key that has no Alt.
   */
  setPreferPlain(value: boolean): void {
    if (this.plainForGood === value) return
    const before = this.preferPlain
    this.plainForGood = value
    if (this.preferPlain !== before) this.changed()
  }

  /**
   * Watch the input for the first plain alternative of an Alt key (`F2`-`F5`): a user who reaches for one is on a
   * host that may not deliver Alt, so hints lead with the plain key for the rest of the session.
   * @param data - one decoded input sequence.
   */
  notePlainKey(data: string): void {
    if (this.plainForSession || !PLAIN_ALT_ALTERNATIVES.some(key => matchesKey(data, key))) return
    const before = this.preferPlain
    this.plainForSession = true
    if (this.preferPlain !== before) this.changed()
  }

  /**
   * Listen for a change in what keys mean, so painted hints can follow a rebind at once.
   * @param listener - called after each committed change.
   * @returns a disposer; safe to call twice.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Snapshot every action: the registered ones in registration order, then the component actions seen in admitted
   * nodes, then the overridden actions neither registered nor seen. Each entry is a fresh object with copied key
   * lists, so callers cannot reach the registry's internal state through the result.
   * @returns the actions with their labels, scopes, owners, default keys, effective keys, and whether they are rebound.
   */
  list(): readonly MayflyKeyBinding[] {
    const ids = [...new Set([...this.actions.keys(), ...this.seen.keys(), ...this.overrides.keys()])]
    return ids.map(id => {
      const registered = this.actions.get(id)
      const seen = this.seen.get(id)
      const defaults = registered?.keys ?? seen?.keys ?? []
      return {
        id,
        keys: this.resolve(id, defaults),
        scope: this.scopeOf(id),
        label: registered?.description ?? seen?.label ?? this.overrides.get(id)?.label ?? id,
        owner: actionOwner(id),
        defaults: [...defaults],
        overridden: this.overrides.has(id),
        // exactOptionalPropertyTypes forbids assigning undefined to the
        // optional slot, so it is spread in only when present.
        ...(registered?.description === undefined ? {} : { description: registered.description }),
      }
    })
  }

  /** The keys a binding would take, or the refusal: the rules of `bind`, against the current bindings. */
  private checkBinding(action: string, keys: string | readonly string[]): string[] {
    if (!ACTION_ID.test(action)) throw new MayflyKeymapError(`"${action}" is not an <owner>.<action> id`, 'INVALID_BINDING')
    const next = normalizeKeys(keys)
    const invalid = next.find(key => !isKeyId(key))
    if (invalid !== undefined) throw new MayflyKeymapError(`"${invalid}" is not a key id`, 'INVALID_BINDING')
    const fixed = FIXED_KEYS[action]
    if (fixed !== undefined && !next.includes(fixed)) throw new MayflyKeymapError(`"${action}" must keep ${fixed}: Esc and Enter cannot be unbound`, 'INVALID_BINDING')
    const scope = this.scopeOf(action)
    for (const key of next) {
      const holder = Object.entries(FIXED_KEYS).find(([id, kept]) => kept === key && id !== action)
      if (holder !== undefined) throw new MayflyKeymapError(`${key} belongs to "${holder[0]}": Esc and Enter cannot be unbound`, 'INVALID_BINDING')
      if (scope !== 'surface' && scope !== 'stream' && printableKey(key)) throw new MayflyKeymapError(`"${key}" would type text in the ${scope} scope; use a modifier key`, 'INVALID_BINDING')
      const owner = this.list().find(other => other.id !== action && overlaps(other.scope, scope) && other.keys.includes(key))
      if (owner !== undefined) {
        throw new MayflyKeymapError(`key "${key}" already means "${owner.label}" (${owner.id}, owned by ${owner.owner}); rebind that action first`, 'KEY_CONFLICT')
      }
    }
    return next
  }

  /** A registered action's scope; component actions live in surfaces. */
  private scopeOf(action: string): MayflyKeyScope {
    return this.actions.get(action)?.scope ?? 'surface'
  }

  private changed(): void {
    this.changes += 1
    for (const listener of [...this.listeners]) listener()
  }
}
