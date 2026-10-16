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
 * `danger-full-access` row asks the shared No-first decision because it
 * changes the sandbox and approval policy together.
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
import { persist } from './onboarding-language.ts'
import { registerSessionlessCommand } from './sessionless-commands.ts'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { openUiOverlay } from './ui-overlay.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { ui, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'

/** The sandbox + approval bundle one preset resolves to. */
interface PermissionPresetSpec {
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
  /** The preset a session created now takes. */
  readonly defaultPreset: string
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
 * Open the preset picker for the live agent (D30 editor-slot mount). With no session
 * it picks the default preset a new session takes.
 * Fire-and-forget: the caller (`mayfly-input`'s bare-`/permission`
 * interception) never awaits the panel.
 * @param ctx - plugin context (`commands` via the calling plugin).
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
  const current = agent === null ? presets.defaultPreset : presets.current(agent.session)
  const rows: MayflyListItem[] = presets.names.map(name => {
    const spec = presets.resolve(name)
    const label = presets.optionOf(name).name
    return {
      id: name,
      label,
      detail: presetDescription(spec),
      ...(name === current ? { current: true } : {}),
      /* Full access changes the sandbox and approval policy together, so it
         runs through the shared decision with its consequence spelled out. */
      ...(spec.sandbox === 'danger-full-access' ? { confirm: {
        title: t('Enable {preset}?', { preset: label }),
        detail: t(spec.approval === 'never'
          ? 'Disable the file sandbox. Requests that still require approval will be rejected without prompting.'
          : 'Disable the file sandbox. Requests that require approval will still prompt.'),
        confirmLabel: t('Enable'),
        tone: 'danger' as const,
      } } : {}),
    }
  })
  if (current === 'custom') rows.push({ id: 'custom', label: presets.optionOf('custom').name, disabled: true, disabledReason: t(CUSTOM_BLOCKED) })

  const dispatch = (name: string): void => {
    if (agent === null) {
      void setDefaultPreset(ctx, presets, name).then(result => {
        notifications.report('dispatch', { message: result.text ?? '', severity: result.kind === 'error' ? 'error' : 'success' })
      })
      return
    }
    void ctx.commands.execute(agent, `/permission ${name}`, [], new AbortController().signal).then(
      execution => {
        if (execution === undefined) {
          notifications.report('dispatch', { message: t('permission command is unavailable'), severity: 'error' })
          return
        }
        const { result } = execution
        if (result.text === undefined) return
        notifications.report('dispatch', { message: result.text, severity: result.kind === 'error' ? 'error' : 'success' })
      },
      error => {
        notifications.report('dispatch', { message: t('permission dispatch failed: {error}', { error: error instanceof Error ? error.message : String(error) }), severity: 'error' })
      },
    )
  }

  // 'replace' re-reads the preset table on every invocation, so a stale
  // picker never shows an outdated current mark.
  let offAgent: (() => void) | undefined
  const picker = openUiOverlay(ctx, { id: 'mayfly.permission', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Permissions'), scope: { kind: 'app', targetId: 'permission' }, onEvent: { action: event => {
    if (event.kind !== 'selection-accept') return { kind: 'completed' as const }
    const name = event.selectedIds[0]
    if (name === undefined || !presets.names.includes(name)) return { kind: 'completed' as const }
    if (currentAgents.current() !== agent) {
      notifications.report('dispatch', { message: t('permission target changed; action cancelled'), severity: 'warning' })
      return { kind: 'cancelled' as const, dismiss: true }
    }
    dispatch(name)
    return { kind: 'completed' as const, dismiss: true }
  } } }, ui.surface({ chrome: 'overlay', title: t('Permissions'), child: ui.list({ id: 'permissions', role: 'choose', numbered: true, selectedIds: current === 'custom' ? [] : [current], items: rows }) }), { reopen: 'replace', onClosed: () => offAgent?.() })
  /* The picker belongs to the Agent it was opened for; replacing that Agent retires it. */
  offAgent = currentAgents.subscribe(next => { if (next !== agent) picker.close() })
}

/**
 * Set the default preset a session created later takes (no session exists to write to).
 * @returns the outcome with the notice text.
 */
async function setDefaultPreset(ctx: Context, presets: PermissionPresetsService, name: string): Promise<CommandResult> {
  const t = interactionTranslator(ctx)
  if (!presets.names.includes(name)) return { kind: 'error', text: t('unknown permission preset: {preset}', { preset: name }) }
  if (name !== presets.defaultPreset) await persist(ctx, 'permission', { op: 'set', path: ['defaultPreset'], value: name })
  return { kind: 'success', text: t('Default permission preset: {preset}', { preset: presets.optionOf(name).name }) }
}

/**
 * `/permission` before a session exists: no argument opens the picker, `<name>` sets the default preset a new session
 * takes. While a session is live the dsh command of the same name writes that session instead.
 * @returns the disposer.
 */
export function registerSessionlessPermission(ctx: Context): () => void {
  return registerSessionlessCommand(ctx, {
    name: 'permission',
    description: 'Choose the default permission preset (a session takes it when it starts)',
    input: { hint: '[<preset>]' },
    handler: async (invocation): Promise<CommandResult> => {
      const presets = ctx.get('permissionPresets') as PermissionPresetsService | undefined
      if (presets === undefined) return { kind: 'error', text: interactionTranslator(ctx)('permission command is unavailable') }
      const name = invocation.rawInput.trim()
      if (name === '') {
        openPermissionPanel(ctx)
        return { kind: 'success' }
      }
      return setDefaultPreset(ctx, presets, name)
    },
  })
}
