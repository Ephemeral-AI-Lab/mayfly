/**
 * The model-family commands: `/model` (picker over the llm catalog with the
 * footer thinking-segment control, or a direct id switch), `/effort`
 * (horizontal segment selector or a direct level switch), and the shared
 * commit path they both funnel into — call the app-owned model action for
 * the next step's route and, unless session-only, persist the new
 * default through `agentDefaultModel.saveSelection`. The Alt+M hotkey
 * cycle (`cycleSessionModel`, matched in the editor key chain) funnels
 * into the same commit path on the session-only channel. The S23 seam
 * supplies the handle; this module never injects a display or harness
 * service, it resolves everything through `ctx.get` (the `/theme`
 * fiber-dispose trap).
 *
 * @module @ephemeral-ai/mayfly/interaction/model-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { ModelSelection as MayflySessionModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
// Empty type imports carry the `llm` and `agentDefaultModel` Context merges
// plus the app-owned session-action merge this module reads.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '../app/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setTimeout as delay } from 'node:timers/promises'
import { ui, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { formatContextWindow, type ModelPickerItem } from './model-picker-model.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator } from './locale.ts'
import type { InteractionFeedbackReporter } from './notifications.ts'
import { getSharedEditor } from './editor-instance.ts'

/** Render one failure reason for an error result. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the live session's immutable model selection.
 * @param ctx - plugin context.
 * @returns the selection, or the guard's error text.
 */
function readSelection(
  ctx: Context,
): { read: MayflySessionModelSelection } | { error: string } {
  const selection = currentModelSelection(ctx)
  return selection === undefined ? { error: 'no session is live yet' } : { read: selection }
}

/** Read the official next model selection for Mayfly's current Agent. */
export function currentModelSelection(ctx: Context): MayflySessionModelSelection | undefined {
  const agent = ctx.get('mayflyCurrentAgent')?.current()
  const projections = ctx.get('sessionProjections')
  if (agent == null || projections === undefined) return undefined
  const projected = projections.snapshot(agent.session, ['modelSelection']).values.modelSelection
  return projected?.next ?? projected?.lastUsed ?? ctx.get('agentDefaultModel')?.currentSelection()
}

/**
 * Whether two selections agree on every field.
 * @param a - one selection.
 * @param b - the other selection.
 * @returns `true` when provider, model, and effort all match.
 */
function sameSelection(a: MayflySessionModelSelection, b: MayflySessionModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** How the persisted-default write went. */
export type ModelSaveState = 'saved' | 'skipped' | 'session-only' | 'unavailable' | 'failed'

/**
 * The model-switch notice family (the kimi five-state wording, folded to
 * Mayfly's notice channel): what changed, then how the default write went.
 * @param previous - the selection before the switch.
 * @param next - the selection after the switch.
 * @param saveState - the persisted-default outcome.
 * @param failureDetail - the save error's message, for the `failed` state.
 * @returns the single-line notice text.
 */
export function modelSwitchNotice(
  previous: MayflySessionModelSelection,
  next: MayflySessionModelSelection,
  saveState: ModelSaveState,
  failureDetail?: string,
): string {
  const modelChanged = previous.provider !== next.provider || previous.model !== next.model
  const effortChanged = previous.reasoningEffort !== next.reasoningEffort
  let base: string
  if (modelChanged) {
    base = `Switched to ${next.model} (${next.provider})`
    if (next.reasoningEffort !== undefined) base += ` · thinking ${String(next.reasoningEffort)}`
  } else if (effortChanged) {
    base = next.reasoningEffort === undefined
      ? 'Thinking set to provider default'
      : `Thinking set to ${String(next.reasoningEffort)}`
  } else {
    base = `Already using ${next.model} (${next.provider})`
  }
  switch (saveState) {
    case 'session-only':
      return `${base} · session only`
    case 'unavailable':
      return `${base} — default not saved: no default-model service`
    case 'failed':
      /* v8 ignore next -- the catch always passes describe(error) */
      return `${base} — failed to save default: ${failureDetail ?? 'unknown error'}`
    default:
      return base
  }
}

/**
 * Commit one selection through the app-owned action and, unless
 * session-only, persist the new default.
 * @param ctx - plugin context (`agentDefaultModel` resolved lazily).
 * @param next - the selection to commit.
 * @param persist - `false` for an explicit session-only action.
 * @returns the notice text describing the outcome.
 */
interface ModelCommitResult { readonly text: string, readonly state: ModelSaveState, readonly selected?: MayflySessionModelSelection }

async function commitModelSelection(
  ctx: Context,
  next: MayflySessionModelSelection,
  persist: boolean,
  signal?: AbortSignal,
  expected?: unknown,
): Promise<ModelCommitResult> {
  const agent = ctx.get('mayflyCurrentAgent')?.current()
  const controller = ctx.get('sessionController')
  if (agent == null || controller === undefined) return { text: 'no session is live yet', state: 'failed' }
  /* A write computed for one Agent never lands on its replacement. */
  if (expected !== undefined && agent !== expected) return { text: 'agent changed before model selection completed', state: 'failed' }
  const previous = readSelection(ctx)
  if ('error' in previous) return { text: previous.error, state: 'failed' }
  const selected = sameSelection(previous.read, next) ? { selected: previous.read } : await controller.selectModel({ sessionId: agent.id, ...next })
  if (signal?.aborted || ctx.get('mayflyCurrentAgent')?.current() !== agent) return { text: 'agent changed before model selection completed', state: 'failed' }
  const result = (state: ModelSaveState, failure?: string): ModelCommitResult => ({ state, selected: selected.selected, text: modelSwitchNotice(previous.read, selected.selected, state, failure) })
  if (!persist || signal?.aborted) return result('session-only')
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined) return result('unavailable')
  const persisted = {
    provider: selected.selected.provider,
    model: selected.selected.model,
    ...(selected.selected.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selected.selected.reasoningEffort) }),
  }
  if (sameSelection(defaults.currentSelection(), persisted)) {
    return result('skipped')
  }
  try {
    if (ctx.get('mayflyCurrentAgent')?.current() !== agent) return result('failed', 'agent changed before saving model default')
    await defaults.saveSelection(persisted)
    return result('saved')
  } catch (error) {
    return result('failed', describe(error))
  }
}

/** The llm surface the display-name helper reads. */
interface ListingLlm {
  listProviders(): { id: string, name: string }[]
}

/** How long a hotkey cycle trusts a cached provider model listing. */
const MODEL_CACHE_TTL_MS = 60_000

/** The cached provider model listing behind the Alt+M cycle. */
interface ModelListCacheValue {
  readonly provider: string
  readonly ids: string[]
  readonly fetchedAt: number
}

/** Fiber-owned cache state for the Alt+M model cycle. */
export interface ModelListCache {
  value?: ModelListCacheValue
}

/** Create empty cache state for one input-plugin Fiber. */
export function createModelListCache(): ModelListCache {
  return {}
}

/**
 * The provider's advertised model ids for the hotkey cycle, cached
 * briefly: `llm.listModels` can be a network round on discovery-based
 * routes, and a hotkey pressed in rhythm must not re-issue it per press.
 * A failed listing never poisons the cache — the next press retries.
 * @param ctx - plugin context (`llm` resolved lazily).
 * @param provider - the provider route to list.
 * @returns the advertised model ids, or the guard's error text.
 */
async function providerModelIds(
  ctx: Context,
  provider: string,
  cache: ModelListCache,
): Promise<{ ids: string[] } | { error: string }> {
  const cached = cache.value
  if (cached !== undefined && cached.provider === provider
    && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return { ids: cached.ids }
  }
  const llm = ctx.get('llm')
  if (llm === undefined) return { error: 'the llm service is unavailable' }
  try {
    const models = await llm.listModels(provider)
    const ids = models.map(model => model.id)
    cache.value = { provider, ids, fetchedAt: Date.now() }
    return { ids }
  } catch (error) {
    return { error: `could not list the provider's models: ${describe(error)}` }
  }
}

/**
 * Cycle the session model within the current provider — the Alt+M hotkey.
 * The next advertised model commits through the session-only channel: the
 * persisted default stays untouched (a deliberate one-press switch must
 * not rewrite configuration — `/model` is the durable path), and the
 * reasoning effort is not carried, matching the `/model <id>` direct
 * switch (the cycled model uses its provider default). The press never
 * reaches the Editor, so the typed draft is intact by construction.
 * @param ctx - plugin context.
 */
export async function cycleSessionModel(ctx: Context, cache: ModelListCache, reporter?: InteractionFeedbackReporter): Promise<void> {
  const report = reporter ?? getSharedEditor(ctx)?.report ?? (() => {})
  const selection = readSelection(ctx)
  if ('error' in selection) {
    report('model-cycle', { message: selection.error, severity: 'error' })
    return
  }
  const currentSelection = selection.read
  const agent = ctx.get('mayflyCurrentAgent')?.current()
  const listing = await providerModelIds(ctx, currentSelection.provider, cache)
  if ('error' in listing) {
    report('model-cycle', { message: listing.error, severity: 'error' })
    return
  }
  if (listing.ids.length === 0) {
    report('model-cycle', { message: 'the current provider advertises no models', severity: 'warning' })
    return
  }
  const current = currentSelection.model
  const index = listing.ids.indexOf(current)
  const next = listing.ids[index === -1 ? 0 : (index + 1) % listing.ids.length]!
  try {
    const result = await commitModelSelection(
      ctx,
      { provider: currentSelection.provider, model: next },
      false,
      undefined,
      agent,
    )
    report('model-cycle', { message: result.text, severity: result.state === 'failed' ? 'warning' : 'success' })
  } catch (error) {
    /* v8 ignore next -- the catch guards only the append-failure loud path
       (the cycleMode discipline); commitModelSelection itself never throws
       on the session-only channel */
    ctx.logger.warn(`model cycle commit failed: ${describe(error)}`)
  }
}

/**
 * The provider's display name for row labels, falling back to its id.
 * @param llm - the llm service.
 * @param id - the provider route id.
 * @returns the display name.
 */
function providerDisplayName(llm: ListingLlm, id: string): string {
  const name = llm.listProviders().find(provider => provider.id === id)?.name
  return name !== undefined && name.length > 0 ? name : id
}

/** The catalog rows with their resolved metadata, or the guard's error text. */
type CatalogResult = { items: ModelPickerItem[] } | { error: string }

/**
 * Collect the advertised models across the configured providers, attaching
 * each row's resolved context window and reasoning efforts. A provider
 * whose catalog listing fails is skipped (the catalog is advisory); a
 * metadata lookup that fails leaves the row without suffixes.
 * @param ctx - plugin context (`llm` resolved lazily).
 * @param signal - the dispatching UI request's cancellation signal.
 * @returns the rows, or the guard's error text.
 */
async function catalogRows(
  ctx: Context,
  signal: AbortSignal,
  filterProvider?: string,
): Promise<CatalogResult> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { error: 'the llm service is unavailable' }
  const providers = llm.listProviders()
  /* v8 ignore next 3 -- callers pass routes taken from listProviders; the
     guard only trips when a route vanishes between the listing and here */
  if (filterProvider !== undefined && !providers.some(provider => provider.id === filterProvider)) {
    return { error: `provider "${filterProvider}" is not registered` }
  }
  // The row label renders `Provider Name/model` (the dogfood ruling), so
  // the display names ride along from the provider listing.
  const providerLabel = (id: string): string => providerDisplayName(llm, id)
  const rows: { provider: string, id: string, name: string }[] = []
  for (const provider of providers) {
    if (filterProvider !== undefined && provider.id !== filterProvider) continue
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        rows.push({ provider: provider.id, id: model.id, name: model.name.length > 0 ? model.name : model.id })
      }
    } catch {
      // A provider whose catalog cannot be listed simply contributes no rows.
    }
  }
  const infos = await Promise.allSettled(
    rows.map(row => llm.resolveModelInfo(row.provider, row.id, signal)),
  )
  const items = rows.map((row, index) => {
    const info = infos[index]?.status === 'fulfilled' ? infos[index].value : undefined
    const reasoning = info?.reasoning
    const efforts = reasoning !== undefined && reasoning.efforts.length > 0
      ? reasoning.efforts.map(effort => String(effort.id))
      : undefined
    return {
      ...row,
      providerLabel: providerLabel(row.provider),
      ...(info?.context?.contextWindow !== undefined
        ? { contextWindow: info.context.contextWindow }
        : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(reasoning?.defaultEffort !== undefined
        ? { defaultEffort: String(reasoning.defaultEffort) }
        : {}),
    } satisfies ModelPickerItem
  })
  return { items }
}

/**
 * Commit the picker's resolved row: `segmentId` carries the row's live
 * thinking-effort segment (undefined/'default' means provider default),
 * `persist` selects the default write or the session-only channel.
 * @param scope - the overlay's exact-Agent context.
 * @param item - the catalog row being committed.
 * @param segmentId - the row's effective segment option id.
 * @param persist - whether to also save the selection as the default.
 * @param signal - the UI request's cancellation signal.
 * @returns the action reply: dismiss+notice on success, inline failure otherwise.
 */
async function commitPickerRow(
  scope: Context,
  item: ModelPickerItem | undefined,
  segmentId: string | undefined,
  persist: boolean,
  signal: AbortSignal,
  t: (text: string) => string,
): Promise<MayflyUiActionReply> {
  if (item === undefined) return { kind: 'failed', message: t('The model is no longer available') }
  const result = await commitModelSelection(scope, {
    provider: item.provider, model: item.id,
    ...(segmentId === undefined || segmentId === 'default' ? {} : { reasoningEffort: ReasoningEffortId(segmentId) }),
  }, persist, signal)
  if (signal.aborted) return { kind: 'cancelled' }
  if (result.state === 'failed' || result.state === 'unavailable') return { kind: 'failed', message: result.text }
  /* The notice must outlive the dismissing overlay, so it goes through the
     shared editor's channel (the Alt+M cycle's), not reply feedback. */
  const report = getSharedEditor(scope)?.report ?? (() => {})
  report('model-commit', { severity: 'success', message: result.text })
  return { kind: 'completed', dismiss: true }
}

/**
 * The shared picker surface for `/model` and `/effort`: a browse list whose
 * Enter runs `acceptActionId` through the ordinary invoke pipeline (so the
 * row's segment state rides the selections projection) and whose actions row
 * carries the Alt+Enter session-only twin.
 * @param ctx - plugin context.
 * @param agent - the exact Agent the overlay is scoped to.
 * @param overlayId - the registration id (reopen focuses a live one).
 * @param title - the overlay title.
 * @param list - the browse list node.
 * @param signal - the dispatching UI request's cancellation signal.
 * @param commit - turns the resolved selection into a reply.
 * @returns the overlay handle.
 */
async function openPickerOverlay(
  ctx: Context,
  agent: Agent,
  overlayId: string,
  title: string,
  options: { readonly items: readonly MayflyListItem[], readonly filterable?: boolean, readonly numbered?: boolean, readonly empty?: MayflyUiNode },
  signal: AbortSignal,
  commit: (scope: Context, selectedId: string | undefined, segmentId: string | undefined, persist: boolean, eventSignal: AbortSignal) => Promise<MayflyUiActionReply>,
): Promise<MayflyOverlayHandle | undefined> {
  const t = interactionTranslator(ctx)
  return openAgentOverlay(ctx, agent, { id: overlayId, title, presentation: 'editor', capturing: true }, ui.stack.column([
    ui.list({
      id: 'selection', role: 'browse', selectedIds: [], items: options.items, acceptActionId: 'default',
      ...(options.filterable === undefined ? {} : { filterable: options.filterable }),
      ...(options.numbered === undefined ? {} : { numbered: options.numbered }),
      ...(options.empty === undefined ? {} : { empty: options.empty }),
    }),
    ui.actions({ id: `${overlayId}-actions`, items: [
      { id: 'default', label: t('Set as default'), intent: 'primary', selections: [{ pagePath: [], controlId: 'selection' }] },
      { id: 'session', label: t('Use for this session'), key: 'alt+enter', selections: [{ pagePath: [], controlId: 'selection' }] },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ]), scope => async (event, context) => {
    if (event.kind !== 'activate' || (event.actionId !== 'default' && event.actionId !== 'session')) return { kind: 'completed' }
    const selection = event.inputs?.selections?.find(entry => entry.controlId === 'selection')
    return commit(scope, selection?.selectedIds[0], selection?.segmentId, event.actionId === 'default', context.signal)
  }, { signal, reopen: 'focus' })
}

/** Open a native-Agent-scoped catalog using the shared collection and form controls. */
export async function openModelPicker(ctx: Context, signal: AbortSignal, filterProvider?: string): Promise<CommandResult> {
  const agent = ctx.get('mayflyCurrentAgent')?.current()
  const registry = ctx.get('mayflyOverlays')
  const selection = readSelection(ctx)
  if (agent == null || 'error' in selection) return { kind: 'error', text: 'no session is live yet' }
  if (registry === undefined) return { kind: 'error', text: 'model picker is unavailable' }
  if (registry.focus('mayfly.models')) return { kind: 'success' }
  const lifetime = new AbortController()
  const combined = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => lifetime.abort())
  try {
    const llm = ctx.get('llm')
    if (filterProvider !== undefined && llm !== undefined) {
      const deadline = Date.now() + 2000
      while (!llm.listProviders().some(provider => provider.id === filterProvider)) {
        if (Date.now() >= deadline) return { kind: 'success' }
        await delay(100, undefined, { signal: combined })
      }
    }
    const catalog = await catalogRows(ctx, combined, filterProvider)
    if (combined.aborted || ctx.get('mayflyCurrentAgent')?.current() !== agent) return { kind: 'success' }
    if ('error' in catalog) return { kind: 'error', text: catalog.error }
    const t = interactionTranslator(ctx)
    const byId = new Map(catalog.items.map(item => [JSON.stringify([item.provider, item.id]), item]))
    const rows = catalog.items.map(item => ({
      id: JSON.stringify([item.provider, item.id]), label: `${item.providerLabel}/${item.name}`, group: item.providerLabel,
      ...(item.contextWindow === undefined ? {} : { detail: `${formatContextWindow(item.contextWindow)} context` }),
      ...(item.provider === selection.read.provider && item.id === selection.read.model ? { badge: t('current') } : {}),
      ...(item.efforts === undefined ? {} : { segment: {
        label: t('Thinking'),
        options: [{ id: 'default', label: t('Provider default') }, ...item.efforts.map(id => ({ id, label: id }))],
        selectedId: item.provider === selection.read.provider && item.id === selection.read.model && selection.read.reasoningEffort !== undefined && item.efforts.includes(String(selection.read.reasoningEffort)) ? String(selection.read.reasoningEffort) : 'default',
      } }),
    }))
    await openPickerOverlay(ctx, agent, 'mayfly.models', t('Select a model'), {
      items: rows, filterable: true, empty: ui.empty({ title: t('No models advertised') }),
    }, signal, (scope, selectedId, segmentId, persist, eventSignal) =>
      commitPickerRow(scope, selectedId === undefined ? undefined : byId.get(selectedId), segmentId, persist, eventSignal, t))
    return { kind: 'success' }
  } catch (error) {
    return combined.aborted ? { kind: 'success' } : { kind: 'error', text: describe(error) }
  } finally { cleanup() }
}

export function registerModelCommands(ctx: Context): () => void {
  /**
   * Set when this fiber unloads: the catalog awaits can still be in flight
   * (a tree unload lands between `listModels` and the panel mount), and the
   * continuation must not reach for services through the dead context.
   */
  let unloaded = false
  const stopUnloaded = ctx.effect(() => () => {
    unloaded = true
  })

  /**
   * The `/model` handler: no argument opens the picker over the catalog
   * with each row's context metadata and the footer thinking control; an
   * argument switches straight to that model id (the live provider's match
   * wins an ambiguity).
   * @param rawInput - the command's argument text.
   * @param signal - the dispatching UI request's cancellation signal.
   * @returns the command outcome.
   */
  async function switchModel(rawInput: string, signal: AbortSignal): Promise<CommandResult> {
    const selection = readSelection(ctx)
    if ('error' in selection) return { kind: 'error', text: selection.error }
    const current = selection.read
    const catalog = await catalogRows(ctx, signal)
    if ('error' in catalog) return { kind: 'error', text: catalog.error }
    if (unloaded) return { kind: 'success' }
    const argument = rawInput.trim()
    if (argument !== '') {
      const exact = catalog.items.filter(item => item.id === argument)
      if (exact.length === 0) {
        return { kind: 'error', text: `unknown model: ${argument}` }
      }
      const chosen = exact.length === 1
        ? exact[0]
        : exact.find(item => item.provider === current.provider)
      if (chosen === undefined) {
        return {
          kind: 'error',
          text: `ambiguous model id: ${argument} (${exact.map(item => `${item.provider}/${item.id}`).join(', ')})`,
        }
      }
      const result = await commitModelSelection(
        ctx,
        { provider: chosen.provider, model: chosen.id },
        true,
        signal,
      )
      return { kind: result.state === 'failed' || result.state === 'unavailable' ? 'error' : 'success', text: result.text }
    }
    return openModelPicker(ctx, signal)
  }

  /**
   * The `/effort` handler: no argument opens the horizontal segment
   * selector over the current model's reasoning efforts; an argument
   * switches straight to that level (`default` restores the provider
   * default).
   * @param rawInput - the command's argument text.
   * @param signal - the dispatching UI request's cancellation signal.
   * @returns the command outcome.
   */
  async function switchEffort(rawInput: string, signal: AbortSignal): Promise<CommandResult> {
    const selection = readSelection(ctx)
    if ('error' in selection) return { kind: 'error', text: selection.error }
    const current = selection.read
    const llm = ctx.get('llm')
    if (llm === undefined) return { kind: 'error', text: 'the llm service is unavailable' }
    let info
    try {
      info = await llm.resolveModelInfo(current.provider, current.model, signal)
    } catch (error) {
      return { kind: 'error', text: `could not resolve the current model: ${describe(error)}` }
    }
    if (unloaded) return { kind: 'success' }
    const efforts = info.reasoning?.efforts ?? []
    if (efforts.length === 0) {
      return { kind: 'error', text: 'the current model exposes no reasoning efforts' }
    }
    const argument = rawInput.trim()
    if (argument === '') {
      const agent = ctx.get('mayflyCurrentAgent')?.current()
      if (agent == null) return { kind: 'error', text: 'no session is live yet' }
      const t = interactionTranslator(ctx)
      const activeEffort = current.reasoningEffort === undefined ? 'default' : String(current.reasoningEffort)
      const items: MayflyListItem[] = [
        { id: 'default', label: t('Provider default'), ...(activeEffort === 'default' ? { badge: t('current') } : {}) },
        ...efforts.map(effort => ({ id: String(effort.id), label: String(effort.id), ...(activeEffort === String(effort.id) ? { badge: t('current') } : {}) })),
      ]
      const opened = await openPickerOverlay(ctx, agent, 'mayfly.effort', `${providerDisplayName(llm, current.provider)}/${current.model}`, { items, numbered: true }, signal,
        (scope, selectedId, _segmentId, persist, eventSignal) => {
          const effort = items.find(item => item.id === selectedId)
          return commitPickerRow(scope, effort === undefined ? undefined : { provider: current.provider, providerLabel: providerDisplayName(llm, current.provider), id: current.model, name: current.model }, effort?.id, persist, eventSignal, t)
        })
      return opened !== undefined ? { kind: 'success' } : { kind: 'error', text: 'model picker is unavailable' }
    }
    if (argument === 'default') {
      const result = await commitModelSelection(
        ctx,
        { provider: current.provider, model: current.model },
        true,
        signal,
      )
      return { kind: result.state === 'failed' || result.state === 'unavailable' ? 'error' : 'success', text: result.text }
    }
    const normalized = argument.toLowerCase()
    const match = efforts.find(effort =>
      String(effort.id).toLowerCase() === normalized
      || effort.name.toLowerCase() === normalized)
    if (match === undefined) {
      return {
        kind: 'error',
        text: `unsupported thinking effort "${argument}" for ${current.model}: available: default, ${efforts.map(effort => String(effort.id)).join(', ')}`,
      }
    }
    const result = await commitModelSelection(
      ctx,
      {
        provider: current.provider,
        model: current.model,
        reasoningEffort: ReasoningEffortId(String(match.id)),
      },
      true,
      signal,
    )
    return { kind: result.state === 'failed' || result.state === 'unavailable' ? 'error' : 'success', text: result.text }
  }

  const model = ctx.commands.register({
    name: 'model',
    description: 'Switch the session model (no argument opens the picker)',
    input: { hint: '[name]' },
    handler: invocation => switchModel(invocation.rawInput, invocation.signal),
  })
  const effort = ctx.commands.register({
    name: 'effort',
    description: 'Switch the thinking effort of the current model',
    input: { hint: '[level]' },
    handler: invocation => switchEffort(invocation.rawInput, invocation.signal),
  })
  // The kimi alias: `/thinking` is not a separate registration — the input
  // layer rewrites it to `/effort` before `ctx.commands.execute`.
  const effortAliases = ctx.mayflyInteractionState.aliases.register('effort', ['thinking'])
  return () => {
    model()
    effort()
    effortAliases()
    stopUnloaded()
  }
}
