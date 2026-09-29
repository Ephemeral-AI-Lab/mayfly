/** Application-level settings browsing and explicit native namespace commits.
 * @module @ephemeral-ai/mayfly/interaction/settings-command
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { ui, type MayflyOverlayHandle, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
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
  let teardown: (() => void) | undefined
  const opened = openUiOverlay(ctx, {
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
  }, initialSnapshot.node, { signal, reopen: 'focus', onClosed: () => teardown?.() })
  /* v8 ignore next -- no await between the focus check and open; only a re-entrant listener could land a same-id overlay here */
  if (opened === undefined) { releaseLifetime(); return true }
  handle = opened
  let scheduled = false
  const schedule = () => {
    if (scheduled || handle.closed) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (!handle.closed) void refresh() })
  }
  const offDocument = ctx.on('settings/document-updated', changed => { if (String(changed) === ns) schedule() })
  const offLocale = observeInteractionLocale(ctx, schedule)
  const dynamicFibers = ['permissionPresets', 'agentPresets'].map(name => ctx.inject([name], owner => { schedule(); owner.effect(() => () => schedule()) }))
  teardown = () => { offDocument(); offLocale(); for (const fiber of dynamicFibers) void fiber.dispose(); releaseLifetime() }
  return true
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
  const t = interactionTranslator(ctx)
  ctx.commands.register({
    name: 'settings', description: 'Edit user settings by namespace',
    handler: async (request) => {
      const signal = request.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, request.signal])
      let dynamic = await choices(ctx)
      if (signal.aborted) return { kind: 'success' }
      const snapshot = () => {
        const descriptors = ctx.settings.describe({ redactSecrets: true })
        if (descriptors.length === 0) return { node: ui.empty({ title: t('No settings namespaces') }), source: [] }
        const pages = descriptors.map(descriptor => {
          const ns = String(descriptor.ns)
          const page = { controlId: 'namespaces', itemId: ns }
          const projection = settingsProjection(descriptor, ctx.settings.writable, dynamic, t, [page])
          return { ns, page, projection, source: source(descriptor, projection) }
        })
        return {
          source: pages.flatMap(page => page.source),
          node: ui.surface({ title: t('Settings'), chrome: 'overlay', padding: 1, child: ui.stack.column([
            ui.stack.row([
              ui.child(ui.tabs({ id: 'namespaces', orientation: 'vertical', activeId: pages[0]!.ns, items: pages.map(page => ({ id: page.ns, label: page.ns })) }), { basis: 24, shrink: 1, minSize: 8 }),
              ...pages.map(page => ui.child(page.projection.node, { tab: page.page, grow: 1, minSize: 1 })),
            ]),
            ui.actions({ id: 'browser-actions', items: [{ id: 'open-file', label: t('Open profile configuration in $EDITOR'), disabled: !ctx.settings.writable }] }),
          ]) }),
        }
      }
      const initial = snapshot()
      let teardown: (() => void) | undefined
      const opened = openUiOverlay(ctx, {
        id: ROOT_ID, presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'settings' }, source: initial.source,
        onEvent: { action: async (event, context) => {
          if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
          if (event.kind === 'submit' || event.kind === 'activate' && event.actionId === 'refresh') {
            const next = await choices(ctx)
            if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
            dynamic = next
          }
          if (event.kind === 'submit') {
            const form = event.submission.forms.find(value => value.formId === 'settings-form')
            const ns = form?.pagePath.find(page => page.controlId === 'namespaces')?.itemId
            const descriptor = ctx.settings.describe({ redactSecrets: true }).find(value => String(value.ns) === ns)
            if (form === undefined || ns === undefined || descriptor === undefined) return { kind: 'failed', message: t('Settings namespace is unavailable') }
            const projection = settingsProjection(descriptor, ctx.settings.writable, dynamic, t, form.pagePath)
            const expected = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}`)?.revision
            const expectedFields = event.submission.source.find(stamp => stamp.resourceId === `settings/${ns}/fields`)?.revision
            if (expected !== descriptor.revision || expectedFields !== projection.revision) return { kind: 'conflict', ...snapshot(), message: t('Settings changed elsewhere; review before saving') }
            try {
              const operations = settingsOperations(projection, form)
              if (operations.length > 0) await ctx.settings.mutate(ns, operations, descriptor.revision)
              if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
              return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: t('Settings saved') } }
            } catch (error) {
              if (context.signal.aborted || signal.aborted) return { kind: 'cancelled' }
              return error instanceof SettingsConflictError
                ? { kind: 'conflict', ...snapshot(), message: t('Settings changed elsewhere; review before saving') }
                : { kind: 'failed', ...snapshot(), message: t('Settings could not be saved') }
            }
          }
          if (event.kind === 'activate' && event.actionId === 'open-file') return editDocument(ctx, context.signal)
          if (event.kind === 'activate' && event.actionId === 'refresh') return { kind: 'accepted', ...snapshot() }
          return { kind: 'completed' }
        } },
      }, initial.node, { signal, reopen: 'focus', onClosed: () => teardown?.() })
      if (opened === undefined) return { kind: 'success' }
      let refreshSequence = 0
      const refresh = async () => {
        if (opened.closed || signal.aborted) return
        const sequence = ++refreshSequence
        const next = await choices(ctx)
        if (opened.closed || signal.aborted || sequence !== refreshSequence) return
        dynamic = next
        const value = snapshot()
        opened.set(value.node, { source: value.source })
      }
      const schedule = () => { void refresh() }
      const offDocument = ctx.on('settings/document-updated', schedule)
      const offLocale = observeInteractionLocale(ctx, schedule)
      const dynamicFibers = ['permissionPresets', 'agentPresets'].map(name => ctx.inject([name], owner => { schedule(); owner.effect(() => () => schedule()) }))
      teardown = () => { offDocument(); offLocale(); for (const fiber of dynamicFibers) void fiber.dispose() }
      return { kind: 'success' }
    },
  })
}
