/** Application-level settings browsing and explicit native namespace commits.
 * @module @ephemeral-ai/mayfly/interaction/settings-command
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { panel, rail, ui, type MayflyOverlayHandle, type MayflySourceStamp, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { registerOwnedCommand } from './sessionless-commands.ts'
import { resolveExternalEditorCommand, runExternalEditor } from './external-editor.ts'
import { settingsOperations, settingsProjection, type SettingsChoices, type SettingsProjection } from './settings-model.ts'

export const name = 'mayfly-settings-command'
export const inject = ['commands', 'settings', 'mayflyOverlays', 'mayflyInteractionState']
const ROOT_ID = 'mayfly.settings'
const RAIL_ID = 'namespaces'

/** One live namespace page of the settings rail. */
interface SettingsEntry {
  readonly ns: string
  readonly descriptor: SettingsDescriptor
  readonly projection: SettingsProjection
}

interface SettingsSnapshot {
  readonly node: MayflyUiNode
  readonly source: readonly MayflySourceStamp[]
  readonly entries: readonly SettingsEntry[]
}

async function choices(ctx: Context): Promise<SettingsChoices> {
  const permission = ctx.get('permissionPresets')?.names
  const roster = ctx.get('agentPresets')
  const agentPresets = roster === undefined ? undefined : await roster.list().then(items => items.map(item => item.id), () => undefined)
  return { ...permission === undefined ? {} : { permission }, ...agentPresets === undefined ? {} : { agentPresets } }
}

/** Open the one settings rail, focused on `initialNs` when one is named. */
async function openSettings(ctx: Context, callerSignal?: AbortSignal, initialNs?: string): Promise<boolean> {
  if (callerSignal?.aborted) return false
  const registry = ctx.mayflyOverlays
  const lifetime = new AbortController()
  const signal = callerSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callerSignal])
  const releaseLifetime = ctx.effect(() => () => lifetime.abort())
  const settings = ctx.settings
  const t = interactionTranslator(ctx)
  let dynamic = await choices(ctx)
  if (signal.aborted) { releaseLifetime(); return false }
  const describe = (): readonly SettingsDescriptor[] => settings.describe({ redactSecrets: true })
  if (initialNs !== undefined && !describe().some(item => String(item.ns) === initialNs)) { releaseLifetime(); return false }
  /* A namespace open focuses the live rail instead of stacking a second overlay. */
  if (registry.focus(ROOT_ID)) {
    releaseLifetime()
    if (initialNs !== undefined) ctx.mayflyUiInteraction.get('overlay', ROOT_ID)?.emit({ kind: 'tab-change', pagePath: [], controlId: RAIL_ID, tabId: initialNs })
    return true
  }
  let active = initialNs ?? String(describe()[0]?.ns ?? '')
  let handle!: MayflyOverlayHandle
  let refreshSequence = 0
  const snapshot = (): SettingsSnapshot => {
    const entries = describe().flatMap((descriptor): SettingsEntry[] => {
      const ns = String(descriptor.ns)
      const projection = settingsProjection(descriptor, settings.writable, dynamic, t, [{ controlId: RAIL_ID, itemId: ns }])
      return projection.bindings.size === 0 ? [] : [{ ns, descriptor, projection }]
    })
    if (!entries.some(entry => entry.ns === active)) active = entries[0]?.ns ?? ''
    const body: MayflyUiNode = entries.length === 0
      ? ui.empty({ title: t('No settings namespaces') })
      : rail({
          rail: { id: RAIL_ID, activeId: active, items: entries.map(entry => ({ id: entry.ns, label: entry.ns })) },
          pages: Object.fromEntries(entries.map(entry => [entry.ns, entry.projection.node])),
        })
    return {
      node: panel({
        title: t('Settings'),
        escapeLabel: 'close',
        body,
        footer: ui.actions({ id: 'settings-global-actions', items: [
          { id: 'open-file', label: t('Open settings.yaml in $EDITOR'), hintLabel: 'settings.yaml', semantic: 'external', hidden: true, disabled: !settings.writable },
        ] }),
      }),
      source: entries.flatMap(entry => [
        { resourceId: `settings/${entry.ns}`, revision: entry.descriptor.revision },
        { resourceId: `settings/${entry.ns}/fields`, revision: entry.projection.revision },
      ]),
      entries,
    }
  }
  const refresh = async (): Promise<void> => {
    const sequence = ++refreshSequence
    const next = await choices(ctx)
    if (handle.closed || signal.aborted || sequence !== refreshSequence) return
    dynamic = next
    const nextSnapshot = snapshot()
    handle.set(nextSnapshot.node, { reason: 'data', source: nextSnapshot.source })
  }
  const initialSnapshot = snapshot()
  let teardown: (() => void) | undefined
  const opened = openUiOverlay(ctx, {
    id: ROOT_ID, title: t('Settings'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'settings' }, source: initialSnapshot.source,
    onEvent: {
      observe: event => {
        if (event.kind === 'tab-change' && event.pagePath.length === 0 && event.controlId === RAIL_ID) active = event.tabId
      },
      action: async (event, context): Promise<MayflyUiActionReply> => {
        if (event.kind === 'activate' && event.actionId === 'refresh') { await refresh(); return { kind: 'completed' } }
        if (event.kind === 'activate' && event.actionId === 'open-file') return editDocument(ctx, context.signal)
        if (event.kind !== 'submit') return { kind: 'completed' }
        if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
        const form = event.submission.forms.find(candidate => candidate.formId === 'settings-form')
        const ns = form?.pagePath.find(segment => segment.controlId === RAIL_ID)?.itemId
        if (form === undefined || ns === undefined) return { kind: 'failed', message: t('Settings could not be saved') }
        const current = describe().find(item => String(item.ns) === ns)
        if (current === undefined) return { kind: 'cancelled', dismiss: true }
        const currentSnapshot = snapshot()
        const entry = currentSnapshot.entries.find(candidate => candidate.ns === ns)
        if (entry === undefined) return { kind: 'cancelled', dismiss: true }
        const expected = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}`)?.revision
        const expectedFields = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}/fields`)?.revision
        if (expected !== current.revision || expectedFields !== entry.projection.revision) return { kind: 'conflict', node: currentSnapshot.node, source: currentSnapshot.source, message: t('Settings changed elsewhere; review before saving') }
        try {
          const operations = settingsOperations(entry.projection, form)
          if (operations.length > 0) await settings.mutate(ns, operations, current.revision)
          if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
          if (describe().length === 0) return { kind: 'cancelled', dismiss: true }
          const savedSnapshot = snapshot()
          return { kind: 'accepted', node: savedSnapshot.node, source: savedSnapshot.source, feedback: { severity: 'success', message: t('Settings saved') } }
        } catch (error) {
          if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
          if (describe().length === 0) return { kind: 'cancelled', dismiss: true }
          const latest = snapshot()
          return error instanceof SettingsConflictError
            ? { kind: 'conflict', node: latest.node, source: latest.source, message: t('Settings changed elsewhere; review before saving') }
            : { kind: 'failed', node: latest.node, source: latest.source, message: t('Settings could not be saved') }
        }
      },
    },
  }, initialSnapshot.node, { signal, reopen: 'focus', onClosed: () => teardown?.() })
  /* no await between the focus check and open; only a re-entrant listener could land a same-id overlay here */
  if (opened === undefined) { releaseLifetime(); return true }
  handle = opened
  let scheduled = false
  const schedule = (): void => {
    if (scheduled || handle.closed) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (!handle.closed) void refresh() })
  }
  const offDocument = ctx.on('settings/document-updated', schedule)
  const offLocale = observeInteractionLocale(ctx, schedule)
  const dynamicFibers = ['permissionPresets', 'agentPresets'].map(name => ctx.inject([name], owner => { schedule(); owner.effect(() => () => schedule()) }))
  teardown = () => { offDocument(); offLocale(); for (const fiber of dynamicFibers) void fiber.dispose(); releaseLifetime() }
  return true
}

/** Open the settings rail on one namespace; the rail replaces a namespace overlay, so a live panel is focused and switched. */
export async function openSettingsNamespace(ctx: Context, ns: string, callerSignal?: AbortSignal): Promise<boolean> {
  if (callerSignal?.aborted) return false
  if (!ctx.settings.describe({ redactSecrets: true }).some(item => String(item.ns) === ns)) return false
  return await openSettings(ctx, callerSignal, ns)
}

async function editDocument(ctx: Context, signal: AbortSignal): Promise<MayflyUiActionReply> {
  const t = interactionTranslator(ctx)
  if (!ctx.settings.writable) return { kind: 'failed', message: t('Settings are read-only') }
  const screen = ctx.get('mayflyScreen')
  if (screen === undefined) return { kind: 'failed', message: t('The terminal is unavailable') }
  const config = ctx.get('mayflyInteractionState')?.settingsSource()
  const command = resolveExternalEditorCommand(process.env, config?.editorCommand ?? '')
  if (command === undefined) return { kind: 'failed', message: t('no editor configured ($VISUAL/$EDITOR)') }
  try {
    const path: string | undefined = await ctx.settings.prepareDocument()
    signal.throwIfAborted()
    if (path === undefined) return { kind: 'failed', message: t('settings file unavailable') }
    const text = await readFile(path, 'utf8')
    const edited = await screen.suspend(() => runExternalEditor(text, command))
    if (signal.aborted) return { kind: 'cancelled' }
    if (edited === undefined || edited === text) return { kind: 'completed' }
    if (await readFile(path, 'utf8') !== text) return { kind: 'failed', message: t('The settings file changed while the editor was open') }
    signal.throwIfAborted()
    await writeFile(path, edited, 'utf8')
    return { kind: 'completed', feedback: { severity: 'success', message: t('Settings file saved') } }
  } catch { return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: t('Settings file could not be edited') } }
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  registerOwnedCommand(ctx, {
    name: 'settings', description: 'Edit user settings by namespace',
    handler: async () => {
      await openSettings(ctx, lifetime.signal)
      return { kind: 'success' }
    },
  })
}
