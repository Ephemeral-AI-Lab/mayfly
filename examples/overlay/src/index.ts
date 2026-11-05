/** A two-page settings form opened from an editor action through the direct overlay registry.
 * @module @mayfly-example/overlay
 */
import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyFormAddress, type MayflyOverlayDefinition, type MayflyOverlayHandle, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

export const name = '@mayfly-example/overlay'
export const inject = ['mayflyEditorExtensions', 'mayflyOverlays']
/** The editor action that opens the overlay; editor actions need a modifier key. */
export const OPEN_KEY = 'alt+o'
/** Source-stamp id correlating snapshots and submissions. */
const SETTINGS_STAMP = 'mayfly-example-overlay.settings'

/** The values the form edits; they live as long as the plugin Fiber. */
export interface Settings {
  readonly connection: { readonly name: string, readonly transport: 'local' | 'remote', readonly enabled: boolean }
  readonly workspace: { readonly name: string, readonly limit: number }
}

/** What a reset field returns to. */
export const defaults: Settings = Object.freeze({
  connection: Object.freeze({ name: 'Default', transport: 'local', enabled: true }),
  workspace: Object.freeze({ name: 'Workspace', limit: 100 }),
})

type Page = keyof Settings
const FIELDS: { readonly [P in Page]: readonly (keyof Settings[P])[] } = {
  connection: ['name', 'transport', 'enabled'],
  workspace: ['name', 'limit'],
}

/** Whether `value` is acceptable for the field, by the same rules the form declares. */
function valid(page: Page, field: string, value: unknown): boolean {
  if (field === 'name') return typeof value === 'string' && value.trim() !== '' && value.length <= 80
  if (page === 'connection' && field === 'transport') return value === 'local' || value === 'remote'
  if (page === 'connection' && field === 'enabled') return typeof value === 'boolean'
  return page === 'workspace' && field === 'limit' && Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10000
}

const address = (itemId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'settings-pages', itemId }], formId: 'settings' })

function settingsNode(value: Settings): MayflyUiNode {
  return ui.stack.column([
    ui.tabs({ id: 'settings-pages', activeId: 'connection', items: [{ id: 'connection', label: 'Connection' }, { id: 'workspace', label: 'Workspace' }] }),
    ui.child(ui.form({ id: 'settings', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: value.connection.name, required: true, maxLength: 80 },
      { kind: 'select', id: 'transport', label: 'Transport', value: value.connection.transport, options: [{ id: 'local', label: 'Local' }, { id: 'remote', label: 'Remote' }] },
      { kind: 'toggle', id: 'enabled', label: 'Enabled', value: value.connection.enabled },
    ] }), { tab: { controlId: 'settings-pages', itemId: 'connection' } }),
    ui.child(ui.form({ id: 'settings', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: value.workspace.name, required: true, maxLength: 80 },
      { kind: 'number', id: 'limit', label: 'History limit', value: value.workspace.limit, min: 1, max: 10000, step: 1 },
    ] }), { tab: { controlId: 'settings-pages', itemId: 'workspace' } }),
    ui.actions({ id: 'settings-actions', items: [
      { id: 'save', label: 'Save', intent: 'primary', submit: [address('connection'), address('workspace')] },
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
  scope: { kind: 'app', targetId: 'example.overlay' },
  node: settingsNode(defaults),
}

/** Register the editor action; activating it opens the overlay, or focuses the one already open. */
export function apply(ctx: Context): void {
  let settings = defaults
  let revision = 0
  let active: MayflyOverlayHandle | undefined
  const snapshot = () => ({ node: settingsNode(settings), source: [{ resourceId: SETTINGS_STAMP, revision }] })
  ctx.effect(() => () => { active = undefined })

  const save: NonNullable<NonNullable<MayflyOverlayDefinition['onEvent']>['action']> = (event, context): MayflyUiActionReply => {
    if (event.kind !== 'submit') return { kind: 'completed' }
    if (context.signal.aborted) return { kind: 'cancelled' }
    const stamped = event.submission.source.find(stamp => stamp.resourceId === SETTINGS_STAMP)?.revision
    if (stamped !== revision) return { kind: 'conflict', ...snapshot(), message: 'Settings changed since the form opened' }
    const next = { connection: { ...settings.connection }, workspace: { ...settings.workspace } } as Record<Page, Record<string, unknown>>
    for (const form of event.submission.forms) {
      const page = form.pagePath[0]?.itemId
      if (form.formId !== 'settings' || (page !== 'connection' && page !== 'workspace')) return { kind: 'failed', message: 'Unknown settings page' }
      for (const field of form.fields) {
        if (!(FIELDS[page] as readonly string[]).includes(field.id)) return { kind: 'failed', message: 'Unknown settings field' }
        if (field.change === 'unchanged') continue
        const value = field.change === 'reset' ? (defaults[page] as Record<string, unknown>)[field.id] : field.value
        if (!valid(page, field.id, value)) return { kind: 'failed', message: `Invalid ${page} ${field.id}` }
        next[page][field.id] = value
      }
    }
    settings = Object.freeze({ connection: Object.freeze(next.connection), workspace: Object.freeze(next.workspace) }) as unknown as Settings
    revision += 1
    return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: 'Settings saved' } }
  }

  const open = (): void => {
    if (active !== undefined && !active.closed) { active.focus(); return }
    const current = snapshot()
    const { node: _initialNode, ...definition } = overlayRequest
    active = ctx.mayflyOverlays.open({ ...definition, source: current.source, onEvent: { action: save } }, current.node)
  }

  ctx.mayflyEditorExtensions.register({
    id: 'example.overlay.open',
    onEvent: {
      action: (event) => {
        if (event.kind === 'activate' && event.actionId === 'open') open()
        return { kind: 'completed' }
      },
    },
  }, { actions: [{ id: 'open', label: 'Example settings', key: OPEN_KEY }] })
}
