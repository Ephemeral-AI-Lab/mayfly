/**
 * The `/permission` preset picker (S24b, D33): a bare `/permission`
 * submission intercepted by the input layer opens this panel instead of
 * the upstream command's text listing; a `/permission <name>` line
 * passes through to the upstream command untouched. The panel reads the
 * preset table through `ctx.permissionPresets` (dsh-permission-presets,
 * composed by dsh-base) — the service read is the projection's
 * `currentValue` by construction (`selectFor` folds the same knob
 * events), so the panel keeps the repo's direct-service habit. Selecting
 * a row dispatches `/permission <name>` through the command runtime —
 * the same live write path as a typed command, with `command/run` +
 * `command/done` and the `permission/preset`/`sandbox/mode`/
 * `approval/policy` knob events logged for free. The `custom` preset is
 * a display-only derived state (upstream rejects it on write), and the
 * `danger-full-access` row opens an explicit Yes/No confirmation because
 * it changes the sandbox and approval policy together.
 *
 * @module @ephemeral-ai/mayfly/interaction/permission-panel
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../app/index.ts'
// Empty type imports carry the `permissionPresets` Context merge
// (dsh-permission-presets) and the `commands` merge the dispatch uses.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-commands'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { CURRENT_MARK } from './symbols.ts'

/** The sandbox + approval bundle one preset resolves to. */
export interface PermissionPresetSpec {
  /** The sandbox mode the preset pins. */
  readonly sandbox: string
  /** The approval policy the preset pins. */
  readonly approval: string
  /** Optional display label (the dsh-base table carries none). */
  readonly name?: string
  /** Optional one-sentence description (the dsh-base table carries none). */
  readonly description?: string
}

/**
 * Structural interface for `ctx.permissionPresets` — the read surface the
 * picker consumes (the provider wizard's EditSettings precedent: a local
 * shape over the lazily probed service, never an injected dependency).
 */
export interface PermissionPresetsService {
  /** Switchable preset names in table order; `custom` is never listed. */
  readonly names: readonly string[]
  /** Domain projection used by the app boundary, retained in the structural service shape. */
  current(session: unknown): string
  /** The sandbox + approval bundle of a table preset; throws when unknown. */
  resolve(name: string): PermissionPresetSpec
  /** The display option of a table key or `custom`; throws when unknown. */
  optionOf(name: string): { readonly value: string, readonly name: string, readonly description?: string }
}

/** The derived one-line row description: the knob facts a bare table key hides. */
function presetDescription(spec: PermissionPresetSpec): string {
  return `sandbox ${spec.sandbox} · approval ${spec.approval}`
}

/** The derived-state row's refusal notice (upstream rejects writing `custom`). */
const CUSTOM_BLOCKED = 'custom is the derived state — pick a preset'

/**
 * Open the preset picker for the live agent (D30 editor-slot mount).
 * Fire-and-forget: the caller (`mayfly-input`'s bare-`/permission`
 * interception) never awaits the panel.
 * @param ctx - plugin context (`commands` via the calling plugin).
 */
export function openPermissionPanel(ctx: Context): void {
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.permission', 'permission')
  const presets = ctx.get('permissionPresets') as PermissionPresetsService | undefined
  if (presets === undefined) return
  const overlays = ctx.get('mayflyOverlays')
  if (overlays === undefined) {
    notifications.report('open', { message: 'permission picker is unavailable: the Mayfly UI registry is not mounted', severity: 'error' })
    return
  }
  const currentAgents = ctx.get('mayflyCurrentAgent')
  if (currentAgents === undefined) return
  const agent = currentAgents.current()
  if (agent === null) return
  const current = presets.current(agent.session)
  const rows: Array<{ readonly id: string, readonly label: string, readonly detail?: string, readonly badge?: string, readonly disabled?: boolean }> = presets.names.map(name => ({
    id: name,
    label: presets.optionOf(name).name,
    detail: presetDescription(presets.resolve(name)),
    ...(name === current ? { badge: CURRENT_MARK } : {}),
  }))
  if (current === 'custom') {
    rows.push({ id: 'custom', label: presets.optionOf('custom').name, disabled: true })
  }

  const dispatch = (name: string): void => {
    void ctx.commands.execute(agent, `/permission ${name}`, [], new AbortController().signal).then(
      execution => {
        if (execution === undefined) {
          notifications.report('dispatch', { message: 'permission command is unavailable', severity: 'error' })
          return
        }
        const { result } = execution
        if (result.text === undefined) return
        notifications.report('dispatch', { message: result.text, severity: result.kind === 'error' ? 'error' : 'success' })
      },
      error => {
        notifications.report('dispatch', { message: `permission dispatch failed: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' })
      },
    )
  }

  let picker!: ReturnType<typeof openUiOverlay>
  const confirmDanger = (name: string): void => {
    const t = interactionTranslator(ctx)
    const id = 'mayfly.permission.confirm'
    if (overlays.focus(id)) return
    const handle = openUiOverlay(ctx, { id, presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Full access'), scope: { kind: 'app', targetId: id }, onEvent: { action: event => {
      if (event.kind === 'activate' && event.actionId === 'yes') {
        handle.close(); picker.close()
        if (currentAgents.current() !== agent) {
          notifications.report('dispatch', { message: 'permission target changed; action cancelled', severity: 'warning' })
        } else dispatch(name)
      }
      else if (event.kind === 'activate' && event.actionId === 'no') handle.close()
      return { kind: 'completed' as const }
    } } }, ui.surface({ chrome: 'overlay', title: t('Full access'), child: ui.stack.column([
      ui.text(t('Enable {preset}?', { preset: presets.optionOf(name).name })),
      ui.text(presets.resolve(name).approval === 'never' ? t('Disable the file sandbox. Requests that still require approval will be rejected without prompting.') : t('Disable the file sandbox. Requests that require approval will still prompt.'), { tone: 'warning' }),
      ui.actions({ id: 'permission-confirm-actions', items: [{ id: 'yes', label: t('Yes'), intent: 'danger' }, { id: 'no', label: t('No'), defaultFocus: true }] }),
    ]) }))
  }

  picker = openUiOverlay(ctx, { id: 'mayfly.permission', presentation: 'editor', capturing: true, dismissal: 'discard', title: 'Permissions', scope: { kind: 'app', targetId: 'permission' }, onEvent: { action: event => {
    if (event.kind !== 'selection-accept') return { kind: 'completed' as const }
    const name = event.selectedIds[0]
    if (name === undefined) return { kind: 'completed' as const }
    if (name === 'custom') { notifications.report('custom', { message: CUSTOM_BLOCKED, severity: 'warning' }); return { kind: 'completed' as const } }
    if (presets.resolve(name).sandbox === 'danger-full-access') confirmDanger(name)
    else { picker.close(); dispatch(name) }
    return { kind: 'completed' as const }
  } } }, ui.surface({ chrome: 'overlay', title: 'Permissions', child: ui.list({ id: 'permissions', role: 'choose', selectedIds: current === 'custom' ? [] : [current], items: rows }) }))
}
