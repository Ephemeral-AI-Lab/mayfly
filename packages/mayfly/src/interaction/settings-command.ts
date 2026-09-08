/** Application-level settings browsing and explicit native namespace commits.
 * @module @ephemeral-ai/mayfly/interaction/settings-command
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { ui, type MayflyOverlayHandle, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { resolveExternalEditorCommand, runExternalEditor } from './external-editor.ts'
import { settingsOperations, settingsProjection, type SettingsChoices, type SettingsProjection } from './settings-model.ts'

export const name = 'mayfly-settings-command'
export const inject = ['commands', 'settings', 'mayflyOverlays']
const ROOT_ID = 'mayfly.settings'
const namespaceId = (ns: string) => `${ROOT_ID}.${Buffer.from(ns).toString('hex')}`
const source = (descriptor: SettingsDescriptor, projection: SettingsProjection) => [{ resourceId: `settings/${descriptor.ns}`, revision: descriptor.revision }, { resourceId: `settings/${descriptor.ns}/fields`, revision: projection.revision }]

async function choices(ctx: Context): Promise<SettingsChoices> {
  const permission = ctx.get('permissionPresets')?.names
  const roster = ctx.get('agentPresets')
  const agentPresets = roster === undefined ? undefined : await roster.list().then(items => items.map(item => item.id), () => undefined)
  return { ...permission === undefined ? {} : { permission }, ...agentPresets === undefined ? {} : { agentPresets } }
}

/** One namespace is one native transaction; shared UI owns every field draft. */
export async function openSettingsNamespace(ctx: Context, ns: string, callerSignal?: AbortSignal): Promise<boolean> {
  if (callerSignal?.aborted) return false
  const registry = ctx.mayflyOverlays
  const id = namespaceId(ns)
  if (registry.focus(id)) return true
  const lifetime = new AbortController()
  const signal = callerSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, callerSignal])
  const releaseLifetime = ctx.effect(() => () => lifetime.abort())
  const settings = ctx.settings
  const t = interactionTranslator(ctx)
  const descriptor = () => settings.describe({ redactSecrets: true }).find(item => String(item.ns) === ns)
  let dynamic = await choices(ctx)
  if (signal.aborted) { releaseLifetime(); return false }
  const initial = descriptor()
  if (initial === undefined) { releaseLifetime(); return false }
  if (registry.focus(id)) { releaseLifetime(); return true }
  let handle!: MayflyOverlayHandle
  let refreshSequence = 0
  const snapshot = (value: SettingsDescriptor) => {
    const projection = settingsProjection(value, settings.writable, dynamic, t)
    const node: MayflyUiNode = ui.surface({ child: projection.node, title: t('settings › {namespace}', { namespace: ns }), chrome: 'overlay', padding: 1 })
    return { projection, node, source: source(value, projection) }
  }
  const refresh = async (): Promise<void> => {
    const sequence = ++refreshSequence
    const next = await choices(ctx)
    if (handle.closed || signal?.aborted || sequence !== refreshSequence) return
    dynamic = next
    const value = descriptor()
    if (value === undefined) { handle.close(); return }
    const nextSnapshot = snapshot(value)
    handle.set(nextSnapshot.node, { reason: 'data', source: nextSnapshot.source })
  }
  const initialSnapshot = snapshot(initial)
  handle = registry.open({
    id, presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: `settings/${ns}` }, source: initialSnapshot.source,
    onEvent: { action: async (event, context): Promise<MayflyUiActionReply> => {
      if (event.kind === 'activate' && event.actionId === 'refresh') { await refresh(); return { kind: 'completed' } }
      if (event.kind !== 'submit') return { kind: 'completed' }
      if (context.signal.aborted || signal?.aborted) return { kind: 'cancelled' }
      const current = descriptor()
      if (current === undefined) return { kind: 'cancelled', dismiss: true }
      const currentSnapshot = snapshot(current)
      const expected = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}`)?.revision
      const expectedFields = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}/fields`)?.revision
      if (expected !== current.revision || expectedFields !== currentSnapshot.projection.revision) return { kind: 'conflict', node: currentSnapshot.node, source: currentSnapshot.source, message: t('Settings changed elsewhere; review before saving') }
      try {
        const form = event.submission.forms.find(form => form.formId === 'settings-form' && form.pagePath.length === 0)
        if (form === undefined) throw new Error('Missing settings form')
        const operations = settingsOperations(currentSnapshot.projection, form)
        if (operations.length > 0) await settings.mutate(ns, operations, current.revision)
        if (context.signal.aborted || signal?.aborted) return { kind: 'cancelled' }
        const saved = descriptor()
        if (saved === undefined) return { kind: 'cancelled', dismiss: true }
        const savedSnapshot = snapshot(saved)
        return { kind: 'accepted', node: savedSnapshot.node, source: savedSnapshot.source, feedback: { severity: 'success', message: t('Settings saved') } }
      } catch (error) {
        if (context.signal.aborted || signal?.aborted) return { kind: 'cancelled' }
        const latest = descriptor()
        if (latest === undefined) return { kind: 'cancelled', dismiss: true }
        const { node, source } = snapshot(latest)
        return error instanceof SettingsConflictError
          ? { kind: 'conflict', node, source, message: t('Settings changed elsewhere; review before saving') }
          : { kind: 'failed', node, source, message: t('Settings could not be saved') }
      }
    } },
  }, initialSnapshot.node)
  let scheduled = false
  const schedule = () => {
    if (scheduled || handle.closed) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (!handle.closed) void refresh() })
  }
  const offDocument = ctx.on('settings/document-updated', changed => { if (String(changed) === ns) schedule() })
  const offValue = ctx.on('settings/updated', changed => { if (String(changed) === ns) schedule() })
  const offLocale = observeInteractionLocale(ctx, schedule)
  const dynamicFibers = ['permissionPresets', 'agentPresets'].map(name => ctx.inject([name], owner => { schedule(); owner.effect(() => () => schedule()) }))
  const abort = () => handle.close()
  let cleanup!: () => void
  const offRegistry = registry.subscribe(delta => { if (delta.kind === 'remove' && delta.id === id && handle.closed) cleanup() })
  cleanup = ctx.effect(() => () => { offDocument(); offValue(); offLocale(); offRegistry(); for (const fiber of dynamicFibers) void fiber.dispose(); signal.removeEventListener('abort', abort); releaseLifetime() })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted || handle.closed) { handle.close(); cleanup() }
  return true
}

async function editDocument(ctx: Context, signal: AbortSignal): Promise<MayflyUiActionReply> {
  const t = interactionTranslator(ctx)
  if (!ctx.settings.writable) return { kind: 'failed', message: t('Settings are read-only') }
  const screen = ctx.get('mayflyScreen')
  if (screen === undefined) return { kind: 'failed', message: t('The terminal is unavailable') }
  const config = ctx.settings.get('mayfly') as { readonly editorCommand?: unknown } | undefined
  const command = resolveExternalEditorCommand(process.env, typeof config?.editorCommand === 'string' ? config.editorCommand : '')
  if (command === undefined) return { kind: 'failed', message: t('no editor configured ($VISUAL/$EDITOR)') }
  try {
    const path = await ctx.settings.prepareDocument()
    if (path === undefined) return { kind: 'failed', message: t('settings file unavailable') }
    signal.throwIfAborted()
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
  const t = interactionTranslator(ctx)
  ctx.commands.register({
    name: 'settings', description: 'Edit user settings by namespace',
    handler: () => {
      if (ctx.mayflyOverlays.focus(ROOT_ID)) return { kind: 'success' }
      const view = () => ui.surface({ child: ui.stack.column([
        ui.list({ id: 'namespaces', role: 'browse', selectedIds: [], filterable: true, items: ctx.settings.describe({ redactSecrets: true }).map(item => ({ id: String(item.ns), label: String(item.ns), ...item.applies === 'restart' ? { detail: t('restart to apply') } : {} })), empty: ui.empty({ title: t('No settings namespaces') }) }),
        ui.actions({ id: 'browser-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'open-file', label: t('Open settings.yaml in $EDITOR'), disabled: !ctx.settings.writable }, { id: 'close', label: t('Close'), dismiss: true }] }),
      ]), title: t('Settings'), chrome: 'overlay', padding: 1 })
      const handle = ctx.mayflyOverlays.open({
        id: ROOT_ID, presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'settings' },
        onEvent: { action: async (event, context) => {
          if (event.kind === 'selection-accept') return await openSettingsNamespace(ctx, event.selectedIds[0]!, lifetime.signal) ? { kind: 'completed' } : { kind: 'failed', message: t('Settings namespace is unavailable') }
          if (event.kind === 'activate' && event.actionId === 'open-file') return editDocument(ctx, context.signal)
          if (event.kind === 'activate' && event.actionId === 'refresh') handle.set(view())
          return { kind: 'completed' }
        } },
      }, view())
      const refresh = () => { handle.set(view()) }
      const offValue = ctx.on('settings/updated', refresh)
      const offDocument = ctx.on('settings/document-updated', refresh)
      const offLocale = observeInteractionLocale(ctx, refresh)
      let cleanup!: () => void
      const offRegistry = ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'remove' && delta.id === ROOT_ID && handle.closed) cleanup() })
      cleanup = ctx.effect(() => () => { offValue(); offDocument(); offLocale(); offRegistry() })
      if (handle.closed) cleanup()
      return { kind: 'success' }
    },
  })
}
