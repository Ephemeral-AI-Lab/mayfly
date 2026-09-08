/**
 * The S29 skills catalog: a frontend-tree-scoped cache of the current
 * session's user-invocable skills, the pure `#`-token helpers, and the
 * service keeping the cache warm. The catalog feeds three consumers from one settle: the
 * `mayfly-editor-plus` `#` autocomplete branch (fuzzy over the same
 * `./slash-filter.ts` the slash dropdown uses), the `mayfly-input` submit
 * rewrite (`#name` → `/name`, mirroring the harness tool-skill gesture
 * boundary verbatim so every rewritten token is one the upstream pre-step
 * recognizes), and the `/skills` listing panel (`./skills-command.ts`).
 *
 * Discovery reads native skills with the exact selected Agent and its cwd.
 * Incomplete observations retain the last complete catalog for that Agent;
 * changing the Agent clears it immediately. Native invalidation, replacement,
 * and unload abort old discovery, with an epoch check fencing late results.
 *
 * @module @ephemeral-ai/mayfly/interaction/skills-catalog
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { freezeWire } from '@ephemeral-ai/mayfly-ui'
import type {} from '../app/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflySkillsCatalog: SkillsCatalogService }
}

/**
 * A `#name` skill token: the harness tool-skill gesture boundary with `#`
 * in place of its `/` — string start or whitespace before, whitespace or
 * string end after (the `(?=\\s|$)` lookahead), and the public kebab-case
 * skill-name grammar between. Mirroring the boundary verbatim guarantees
 * every token {@link rewriteSkillTokens} rewrites is one the upstream
 * pre-step regex recognizes, and no other (`#heading` in mid-sentence
 * prose, `#3` of a paste marker, a trailing `#name.` period — none match).
 */
const SKILL_TOKEN = /(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * A `#`-token in progress at the cursor: string start or whitespace, the
 * `#`, then a partial query of name characters reaching the cursor. The
 * captured query may be empty (a bare `#` just typed); callers decide
 * whether an empty query opens the dropdown.
 */
const SKILL_PREFIX = /(^|\s)#([a-z0-9-]*)$/

/** Frontend-tree-scoped skill cache and invalidation owner. */
export class SkillsCatalogService extends Service {
  private settled: readonly SkillSummary[] | undefined
  private complete = false
  private epoch = 0
  private flight: { readonly epoch: number, readonly promise: Promise<void>, readonly controller: AbortController } | undefined
  private observedAgent: Agent | null
  private readonly listeners = new Set<() => void>()
  private readonly sessionRegistration: () => void
  private readonly skillRegistration: () => void
  private disposed = false

  /** @param ownerCtx - stable consumer context with native skills and Agent selection. */
  constructor(private readonly ownerCtx: Context) {
    const ctx = ownerCtx
    super(ctx, 'mayflySkillsCatalog')
    this.observedAgent = ctx.mayflyCurrentAgent.current()
    this.sessionRegistration = ctx.mayflyCurrentAgent.subscribe(agent => {
      if (agent === this.observedAgent) return
      this.observedAgent = agent
      this.invalidate(true)
      void this.refresh()
    })
    this.skillRegistration = ctx.on('skills/change', () => {
      this.invalidate(false)
      void this.refresh()
    })
    void this.refresh()
  }

  /** Settled user-invocable skills, synchronously readable by autocomplete. */
  userInvocable(): readonly SkillSummary[] {
    return this.settled?.filter(skill => skill.invocation.userInvocable) ?? []
  }

  snapshot(): { readonly skills: readonly SkillSummary[], readonly complete: boolean } {
    return { skills: this.userInvocable(), complete: this.complete }
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return this.ctx.effect(() => () => { this.listeners.delete(listener) })
  }

  private changed(): void { for (const listener of this.listeners) { try { listener() } catch { /* observers do not own catalog settlement */ } } }

  /** Refresh once per epoch, preserving a last-good complete observation. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const agent = this.ownerCtx.mayflyCurrentAgent.current()
    if (agent !== this.observedAgent) {
      this.observedAgent = agent
      this.invalidate(true)
    }
    if (this.flight?.epoch === this.epoch) return this.flight.promise
    const ticket = this.epoch
    const controller = new AbortController()
    const promise = this.settle(ticket, agent, controller.signal)
    this.flight = { epoch: ticket, promise, controller }
    void promise.finally(() => {
      if (this.flight?.promise === promise) this.flight = undefined
      controller.abort()
    })
    return promise
  }

  /** Release listeners and prevent late refreshes from publishing. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sessionRegistration()
    this.skillRegistration()
    this.invalidate(true)
    this.listeners.clear()
  }

  /** Test-only direct settlement seam, scoped to this service instance. */
  setForTest(skills: readonly SkillSummary[] | undefined): void {
    this.invalidate(true)
    this.settled = skills === undefined ? undefined : freezeWire(skills)
    this.complete = skills !== undefined
    this.changed()
  }

  private invalidate(clear: boolean): void {
    this.epoch += 1
    this.flight?.controller.abort()
    this.complete = false
    if (clear) this.settled = undefined
    this.changed()
  }

  private async settle(ticket: number, agent: Agent | null, signal: AbortSignal): Promise<void> {
    if (agent === null) {
      this.settled = undefined
      return
    }
    let result: Awaited<ReturnType<typeof this.ownerCtx.skills.snapshot>>
    try {
      result = await this.ownerCtx.skills.snapshot({ cwd: agent.session.header.cwd, scope: agent, signal })
      if (this.disposed || ticket !== this.epoch || signal.aborted) return
      if (this.ownerCtx.mayflyCurrentAgent.current() !== agent) return
      if (result.complete) this.settled = freezeWire(result.skills)
      this.complete = result.complete
      this.changed()
    } catch {
      if (!this.disposed && ticket === this.epoch && !signal.aborted) { this.complete = false; this.changed() }
      return
    }
  }
}

export const name = 'mayfly-skills-catalog'
export const inject = ['skills', 'mayflyCurrentAgent']
export function apply(ctx: Context): void {
  const service = new SkillsCatalogService(ctx)
  ctx.effect(() => () => service.dispose())
}

/** Read the current tree's settled user-invocable skills. */
export function userInvocableSkills(ctx: Context): readonly SkillSummary[] {
  return ctx.mayflySkillsCatalog.userInvocable()
}

/**
 * Rewrite every `#name` token naming a settled user-invocable skill into the
 * harness gesture form `/name` (the submit-side half of the `#` pipeline:
 * the rewritten token rides the follow-up message, where the tool-skill
 * pre-step loads the skill body as an injected `skill-invocation` message —
 * resume/replay-safe because the injection is an ordinary session event).
 * Tokens naming anything else — unknown tags, `[image #3]` markers, pasted
 * prose — pass through untouched, and the rewritten text keeps the original
 * leading boundary (string start or whitespace) so the gesture regex still
 * sees the token it was handed.
 * @param text - the submitted line.
 * @returns the line with recognized skill tokens rewritten.
 */
export function rewriteSkillTokens(ctx: Context, text: string): string {
  const names = new Set(userInvocableSkills(ctx).map(skill => skill.name))
  if (names.size === 0) return text
  return text.replace(SKILL_TOKEN, (token, lead: string, name: string) =>
    names.has(name) ? `${lead}/${name}` : token)
}

/**
 * Extract the `#`-skill query in progress before the cursor.
 * @param textBeforeCursor - the line's text up to (not including) the cursor.
 * @returns the query after the `#`, or `null` when the cursor does not sit
 *   in a skill token. A bare `#` yields the empty string; callers requiring
 *   at least one typed character treat that as no trigger (markdown `#`
 *   headings — `#` followed by a space — never match, and neither does a
 *   mid-word `#` like `C#`).
 */
export function extractSkillPrefix(textBeforeCursor: string): string | null {
  const match = SKILL_PREFIX.exec(textBeforeCursor)
  /* v8 ignore next -- a successful exec always defines the capture group */
  return match === null ? null : match[2] ?? ''
}

export function refresh(ctx: Context): Promise<void> {
  return ctx.mayflySkillsCatalog.refresh()
}

/**
 * Replace the settled catalog directly (the tests' seam — the
 * `setFdProbe`/`setShellExecutor` idiom: unit suites without a live
 * `skills` service pin the settled list and assert the pure readers).
 * @param skills - the summaries to settle, or `undefined` to drop.
 */
export function __setCatalogForTest(ctx: Context, skills: readonly SkillSummary[] | undefined): void {
  ctx.mayflySkillsCatalog.setForTest(skills)
}
