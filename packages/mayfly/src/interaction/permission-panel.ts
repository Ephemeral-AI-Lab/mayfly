/**
 * The Mayfly-only `/permissions` panel: a terminal presentation of the native
 * permission-preset catalog and the `permissions` Session projection. The
 * native `permission-presets` package owns the `/permission` command; this
 * plugin registers a different name and never intercepts or re-registers the
 * native one.
 *
 * The panel reads `ctx.permissionPresets.catalog()` for the process catalog and
 * `current(session)` for the projection-derived effective preset. Selecting a
 * row writes through the service's `set(session, name)` — the native durable
 * `permission/preset` plus sandbox/approval knob writes — instead of replaying
 * a command line. `custom` is a derived display value and is never a target.
 * The `danger-full-access` row asks the shared No-first decision because it
 * changes the sandbox and approval policy together.
 *
 * @module @ephemeral-ai/mayfly/interaction/permission-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../app/index.ts'
// Empty type imports carry the `permissionPresets` Context merge and the
// `permissions` Session projection declaration.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { PermissionCatalog, PresetOption, PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { ui, type MayflyListItem, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { registerOwnedCommand } from './sessionless-commands.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { createInteractionNotificationOwner } from './notifications.ts'

/** The native permission-preset surface this panel consumes. */
export interface PermissionPresetsService {
  /** Configured preset names in declaration order, followed by live Auto. */
  readonly names: readonly string[]
  /** The preset a fresh Session takes. */
  readonly defaultPreset: string
  /** The complete process-level catalog of selectable presets. */
  catalog(): PermissionCatalog
  /** The projection-derived effective preset of one Session. */
  current(session: Session): string
  /** Presentation for a catalog entry or the derived `custom` value. */
  optionOf(name: string): PresetOption
  /** The sandbox/approval bundle of one selectable preset. */
  resolve(name: string): PresetSpec
  /** Record the selection and write any changed sandbox/approval knob. */
  set(session: Session, name: string): void
}

/** The derived one-line row description: the knob facts a bare table key hides. */
function presetDescription(spec: PresetSpec): string {
  return `sandbox ${spec.sandbox} · approval ${spec.approval}`
}

/** The derived-state row's refusal notice (the service rejects writing `custom`). */
const CUSTOM_BLOCKED = 'custom is the derived state — pick a preset'

/**
 * Open the native preset picker for the live Agent, or refresh the one already
 * open. With no current Agent the panel is inert: the native write is
 * session-scoped.
 * @param ctx - plugin context carrying the permission service and UI registry.
 */
export function openPermissionPanel(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.permission', 'permission')
  const presets = ctx.get('permissionPresets') as PermissionPresetsService | undefined
  if (presets === undefined) return
  const overlays = ctx.get('mayflyOverlays')
  if (overlays === undefined) {
    notifications.report('open', { message: t('permission picker is unavailable: the Mayfly UI registry is not mounted'), severity: 'error' })
    return
  }
  const currentAgents = ctx.get('mayflyCurrentAgent')
  if (currentAgents === undefined) return
  const agent = currentAgents.current()
  if (agent === null) return
  const projections = ctx.get('sessionProjections')

  /** Build the list from a fresh native catalog + projection read. */
  const rows = (): readonly MayflyListItem[] => {
    const catalog = presets.catalog()
    const current = presets.current(agent.session)
    const items: MayflyListItem[] = catalog.options.map(option => {
      let spec: PresetSpec | undefined
      try { spec = presets.resolve(option.value) } catch { spec = undefined }
      return {
        id: option.value,
        label: option.name,
        ...(spec === undefined ? {} : { detail: presetDescription(spec) }),
        ...(option.value === current ? { current: true } : {}),
        /* Full access changes the sandbox and approval policy together, so it
           runs through the shared decision with its consequence spelled out. */
        ...(spec?.sandbox === 'danger-full-access' ? { confirm: {
          title: t('Enable {preset}?', { preset: option.name }),
          detail: t(spec.approval === 'never'
            ? 'Disable the file sandbox. Requests that still require approval will be rejected without prompting.'
            : 'Disable the file sandbox. Requests that require approval will still prompt.'),
          confirmLabel: t('Enable'),
          tone: 'danger' as const,
        } } : {}),
      }
    })
    if (current === 'custom') items.push({ id: 'custom', label: presets.optionOf('custom').name, disabled: true, disabledReason: t(CUSTOM_BLOCKED) })
    return items
  }
  const view = () => {
    const current = presets.current(agent.session)
    return ui.surface({ chrome: 'overlay', title: t('Permissions'), child: ui.list({ id: 'permissions', role: 'choose', numbered: true, selectedIds: current === 'custom' ? [] : [current], items: rows() }) })
  }

  let picker: MayflyOverlayHandle | undefined
  let offAgent: (() => void) | undefined
  let offProjection: (() => void) | undefined
  let offCatalog: (() => void) | undefined
  const repaint = (): void => {
    if (picker?.closed !== false || currentAgents.current() !== agent) return
    picker.set(view())
  }
  picker = openUiOverlay(ctx, {
    id: 'mayfly.permission', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Permissions'),
    scope: { kind: 'app', targetId: 'permission' },
    onEvent: { action: event => {
      if (event.kind !== 'selection-accept' || event.controlId !== 'permissions') return { kind: 'completed' as const }
      const name = event.selectedIds[0]
      if (name === undefined) return { kind: 'completed' as const }
      const catalog = presets.catalog()
      if (!catalog.options.some(option => option.value === name)) return { kind: 'completed' as const }
      if (currentAgents.current() !== agent) {
        notifications.report('dispatch', { message: t('permission target changed; action cancelled'), severity: 'warning' })
        return { kind: 'cancelled' as const, dismiss: true }
      }
      try {
        presets.set(agent.session, name)
        notifications.report('dispatch', { message: t('Permission preset: {preset}', { preset: presets.optionOf(name).name }), severity: 'success' })
        return { kind: 'completed' as const, dismiss: true }
      } catch (error) {
        const message = t('permission dispatch failed: {error}', { error: error instanceof Error ? error.message : String(error) })
        notifications.report('dispatch', { message, severity: 'error' })
        return { kind: 'failed' as const, message }
      }
    } },
  }, view(), { reopen: 'replace', onClosed: () => { offAgent?.(); offProjection?.(); offCatalog?.() } })
  if (picker === undefined) return
  /* The picker belongs to the Agent it was opened for; replacing that Agent retires it. */
  offAgent = currentAgents.subscribe(next => { if (next !== agent) picker?.close() })
  offProjection = projections?.onChanged((session, key) => {
    if (session === agent.session && key === 'permissions') repaint()
  })
  offCatalog = ctx.on('permission-presets/catalog-changed', repaint)
}

/**
 * Register Mayfly's own `/permissions` panel command. The native
 * `/permission` command keeps its name and its argument form.
 * @returns the disposer removing both the runtime and sessionless entries.
 */
export function registerSessionlessPermission(ctx: Context): () => void {
  return registerOwnedCommand(ctx, {
    name: 'permissions',
    description: 'Choose the permission preset',
    handler: () => {
      if (ctx.get('permissionPresets') === undefined) return { kind: 'error' as const, text: interactionTranslator(ctx)('permission command is unavailable') }
      openPermissionPanel(ctx)
      return { kind: 'success' as const }
    },
  })
}
