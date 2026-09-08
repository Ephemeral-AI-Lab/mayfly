/** Persistent two-page settings edited through native services and the direct overlay registry.
 * @module @mayfly-example/overlay
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SettingsConflictError, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-commands'
import { ui, type MayflyFormAddress, type MayflyOverlayDefinition, type MayflyOverlayHandle, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

export const name = '@mayfly-example/overlay'
export const inject = ['commands', 'settings', 'mayflyOverlays']
export const SETTINGS_NAMESPACE = 'mayfly-example-overlay'

interface Settings {
  readonly connection: { readonly name: string, readonly transport: 'local' | 'remote', readonly enabled: boolean }
  readonly workspace: { readonly name: string, readonly limit: number }
}

const defaults: Settings = Object.freeze({
  connection: Object.freeze({ name: 'Default', transport: 'local', enabled: true }),
  workspace: Object.freeze({ name: 'Workspace', limit: 100 }),
})
const schema: z<Settings> = z.object({
  connection: z.object({ name: z.string().default(defaults.connection.name), transport: z.union([z.const('local'), z.const('remote')]).default(defaults.connection.transport), enabled: z.boolean().default(defaults.connection.enabled) }).default(defaults.connection),
  workspace: z.object({ name: z.string().default(defaults.workspace.name), limit: z.number().min(1).max(10000).step(1).default(defaults.workspace.limit) }).default(defaults.workspace),
})
const address = (itemId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'settings-pages', itemId }], formId: 'settings' })

function settingsNode(value: Settings, writable: boolean): MayflyUiNode {
  return ui.stack.column([
    ui.tabs({ id: 'settings-pages', activeId: 'connection', items: [{ id: 'connection', label: 'Connection' }, { id: 'workspace', label: 'Workspace' }] }),
    ui.child(ui.form({ id: 'settings', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: value.connection.name, required: true, maxLength: 80, disabled: !writable },
      { kind: 'select', id: 'transport', label: 'Transport', value: value.connection.transport, options: [{ id: 'local', label: 'Local' }, { id: 'remote', label: 'Remote' }], disabled: !writable },
      { kind: 'toggle', id: 'enabled', label: 'Enabled', value: value.connection.enabled, disabled: !writable },
    ] }), { tab: { controlId: 'settings-pages', itemId: 'connection' } }),
    ui.child(ui.form({ id: 'settings', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: value.workspace.name, required: true, maxLength: 80, disabled: !writable },
      { kind: 'number', id: 'limit', label: 'History limit', value: value.workspace.limit, min: 1, max: 10000, step: 1, disabled: !writable },
    ] }), { tab: { controlId: 'settings-pages', itemId: 'workspace' } }),
    ui.actions({ id: 'settings-actions', items: [
      { id: 'save', label: 'Save', intent: 'primary', disabled: !writable, submit: [address('connection'), address('workspace')] },
      { id: 'cancel', label: 'Cancel', dismiss: true },
    ] }),
  ], { gap: 1 })
}

/** The same initial body is inspected by packed consumers and width scans. */
export const overlayRequest: MayflyOverlayDefinition & { readonly node: MayflyUiNode } = {
  id: 'example.overlay.details',
  title: 'Example settings',
  capturing: true,
  dismissible: true,
  anchor: 'center',
  width: '70%',
  maxHeight: '70%',
  scope: { kind: 'app', targetId: SETTINGS_NAMESPACE },
  node: settingsNode(defaults, true),
}

/** Register a native settings namespace and an ordinary command on this plugin Fiber. */
export function apply(ctx: Context): void {
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, schema)
  let active: MayflyOverlayHandle | undefined
  const snapshot = () => {
    const descriptor = ctx.settings.describe().find(entry => String(entry.ns) === SETTINGS_NAMESPACE)!
    return { node: settingsNode(settings.get(), ctx.settings.writable), source: [{ resourceId: SETTINGS_NAMESPACE, revision: descriptor.revision }] }
  }
  const refresh = () => {
    if (active === undefined || active.closed) return
    const next = snapshot()
    active.set(next.node, { reason: 'data', source: next.source })
  }
  const offValues = ctx.on('settings/updated', ns => { if (String(ns) === SETTINGS_NAMESPACE) refresh() })
  const offDocument = ctx.on('settings/document-updated', ns => { if (String(ns) === SETTINGS_NAMESPACE) refresh() })
  ctx.effect(() => () => { offValues(); offDocument(); active = undefined })
  ctx.commands.register({
    name: 'example-overlay',
    description: 'Edit the example settings',
    handler: () => {
      if (active !== undefined && !active.closed) active.focus()
      else {
        const current = snapshot()
        const { node: _initialNode, ...definition } = overlayRequest
        active = ctx.mayflyOverlays.open({
          ...definition, source: current.source,
          onEvent: { action: async (event, context): Promise<MayflyUiActionReply> => {
            if (event.kind !== 'submit') return { kind: 'completed' }
            if (context.signal.aborted) return { kind: 'cancelled' }
            const revision = event.submission.source.find(stamp => stamp.resourceId === SETTINGS_NAMESPACE)?.revision
            if (typeof revision !== 'number') return { kind: 'conflict', ...snapshot(), message: 'Settings must be refreshed before saving' }
            const ops: SettingsPathOp[] = []
            for (const form of event.submission.forms) {
              const page = form.pagePath[0]?.itemId
              if (form.formId !== 'settings' || (page !== 'connection' && page !== 'workspace')) return { kind: 'failed', message: 'Unknown settings page' }
              const allowed = page === 'connection' ? ['name', 'transport', 'enabled'] : ['name', 'limit']
              for (const field of form.fields) {
                if (!allowed.includes(field.id)) return { kind: 'failed', message: 'Unknown settings field' }
                if (field.change === 'set') ops.push({ op: 'set', path: [page, field.id], value: field.value })
                else if (field.change === 'reset') ops.push({ op: 'unset', path: [page, field.id] })
              }
            }
            try {
              if (ops.length > 0) await ctx.settings.mutate(SETTINGS_NAMESPACE, ops, revision)
              if (context.signal.aborted) return { kind: 'cancelled' }
              return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: 'Settings saved' } }
            } catch (error) {
              if (context.signal.aborted) return { kind: 'cancelled' }
              return error instanceof SettingsConflictError
                ? { kind: 'conflict', ...snapshot(), message: 'Settings changed elsewhere' }
                : { kind: 'failed', message: 'Settings could not be saved' }
            }
          } },
        }, current.node)
      }
      return { kind: 'success', text: 'opened the example overlay' }
    },
  })
}
