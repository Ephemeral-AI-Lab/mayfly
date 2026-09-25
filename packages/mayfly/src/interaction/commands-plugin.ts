/** Native command entry points, terminal help, and app-owned session selection.
 * Session catalog and archive behavior are delegated to Harness.
 * @module @ephemeral-ai/mayfly/interaction/commands-plugin
 */

import { registerPluginCommand } from './plugin-commands.ts'
import { openSessions } from './native-sessions.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
// Empty type import carries the app-owned session reader/actions Context
// merges and the `'mayfly/request-*'` Events merges this plugin emits.
import type {} from '../app/index.ts'
import { ui } from '@ephemeral-ai/mayfly-ui'
import type { HelpSection } from './help.ts'
import { helpNode } from './help.ts'
import { cycleMode } from './mode-commands.ts'
import { registerModelCommands } from './model-commands.ts'
import { registerExportCommands } from './session-export.ts'
import { registerInitCommand } from './session-init.ts'
import { registerThemeCommand } from './theme-switch.ts'
import { registerUpdateCommand } from './update-command.ts'
import { registerTraceCommand } from './trace-command.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { rewindCandidates } from './rewind.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { displayKey } from '../core/key-actions.ts'
import { SHARED_KEY_REFERENCE } from '../core/ui-key-grammar.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-commands'
/** Services required before the commands can register. */
export const inject = [
  'commands',
  'mayflyOverlays',
  'mayflyCurrentAgent',
  'mayflySkillsCatalog',
  'mayflyInteractionState',
  'sessionController',
  'sessionProjections',
  'sessions',
  'tools',
  'workspaceRegistry',
]

/**
 * Register the built-in commands on `ctx.commands`.
 * @param ctx - plugin context.
 * @param config - command presentation configuration.
 */
export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const aliasRegistry = ctx.mayflyInteractionState.aliases
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.commands', 'commands')
  /**
   * The `/sessions` handler: list this directory's persisted sessions
   * newest-first with their titles (the optional batch title read) and
   * offer them in a type-to-filter picker; picking another session emits
   * `mayfly/request-resume`, picking the live one only flashes a notice.
   * @param signal - the dispatching UI request's cancellation signal.
   * @returns the command outcome.
   */
  async function listSessions(signal: AbortSignal): Promise<CommandResult> {
    return openSessions(ctx, signal, t)
  }

  /** Open a picker of safe branch points from the live session. */
  function rewindSession(): CommandResult {
    const active = ctx.mayflyCurrentAgent.primary()
    ctx.mayflyCurrentAgent.closeAuxiliary()
    if (active === null) return { kind: 'error', text: 'no active session' }
    if (active.status !== 'idle') return { kind: 'error', text: 'cannot rewind while the agent is running' }
    const candidates = rewindCandidates(active.session.snapshotEvents())
    if (candidates.length === 0) return { kind: 'success', text: 'no user turns to rewind' }
    const first = candidates[0]!
    const id = 'mayfly.rewind'
    openUiOverlay(ctx, { id, presentation: 'editor', capturing: true, dismissal: 'discard', title: 'Rewind current session', scope: { kind: 'session', sessionId: active.id }, onEvent: { action: event => {
      if (event.kind === 'selection-accept' && event.selectedIds[0] !== undefined) {
        ctx.emit('mayfly/request-rewind', String(active.id), Number(event.selectedIds[0]))
        return { kind: 'completed' as const, dismiss: true }
      }
      return { kind: 'completed' as const }
    } } }, ui.surface({ chrome: 'overlay', title: 'Rewind current session', child: ui.stack.column([
      ui.list({ id: 'rewind-candidates', role: 'choose', selectedIds: [String(first.boundarySeq)], filterable: true, items: candidates.map(candidate => ({ id: String(candidate.boundarySeq), label: `Turn ${String(candidate.turn)} · ${candidate.prompt}`, detail: `${candidate.response === undefined ? '' : `↳ ${candidate.response} · `}rewinds ${String(candidate.discarded)} ${candidate.discarded === 1 ? 'message' : 'messages'}` })) }),
      ui.text('The original session stays available in /sessions.', { tone: 'muted' }),
    ]) }), { reopen: 'focus' })
    return { kind: 'success' }
  }

  /**
   * The `/help` handler: the framed, scrollable overlay listing the
   * registered commands and key bindings in two aligned columns; Escape,
   * Enter, or `q` closes it.
   * @returns the command outcome.
   */
  function showHelp(): CommandResult {
    const keymap = ctx.get('mayflyKeymap')
    if (keymap === undefined) return { kind: 'error', text: 'help is unavailable: the Mayfly keymap is not mounted' }
    const sections = (): HelpSection[] => [
      {
        heading: 'Commands',
        labelTone: 'accent',
        rows: (() => {
          const agent = ctx.mayflyCurrentAgent.current()
          return agent === null ? [] : ctx.commands.list(agent).map(command => ({ name: command.name, description: t(command.description) }))
        })().map(command => {
          // The kimi help-panel label: aliases join the canonical label in
          // slashed parentheses (`/quit (/q, /exit)`), visible on every
          // listing — unlike the dropdown, which shows them only when the
          // query matched one.
          const commandName = command.name
          const aliases = aliasRegistry.aliasesOf(commandName)
          return {
            label: aliases.length === 0 ? `/${commandName}` : `/${commandName} (${aliases.map(alias => `/${alias}`).join(', ')})`,
            description: command.description,
          }
        }),
      },
      {
        heading: 'Keys',
        labelTone: 'warning',
        rows: keymap.list().map(action => ({
          label: [action.keys].flat().map(displayKey).join('/'),
          description: t(action.description ?? action.id),
        })),
      },
      {
        heading: 'Panels and pickers',
        labelTone: 'warning',
        rows: SHARED_KEY_REFERENCE.map(row => ({ label: t(row.keys), description: t(row.action) })),
      },
    ]
    const view = () => helpNode(sections(), t)
    let offLocale: (() => void) | undefined
    const handle = openUiOverlay(ctx, { id: 'mayfly.help', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('help'), scope: { kind: 'app', targetId: 'help' } }, view(), { reopen: 'focus', onClosed: () => offLocale?.() })
    if (handle === undefined) return { kind: 'success' }
    offLocale = observeInteractionLocale(ctx, () => { handle.set(view()) })
    return { kind: 'success' }
  }

  ctx.effect(() => {
    const quit = ctx.commands.register({
      name: 'quit',
      description: 'Exit Mayfly',
      handler: () => {
        // `appExit` is a launcher-provided host value declared by
        // `@deepseek-ai/dsh-cmdline`; read through the store since it is
        // optional and never an injected dependency.
        const exit = ctx.get('appExit')
        if (exit === undefined) {
          return { kind: 'error' as const, text: 'exit is unavailable: the launcher provided no appExit hook' }
        }
        exit(0)
        return { kind: 'success' as const }
      },
    })
    // The alias relation lives in the command-meta registry (kimi style):
    // `/q` and `/exit` are not separate registrations — the input layer
    // rewrites an alias line to `/quit` before `ctx.commands.execute`, so
    // the session log records the canonical command.
    const quitAliases = aliasRegistry.register('quit', ['q', 'exit'])
    const fresh = ctx.commands.register({
      name: 'new',
      description: 'Start a new session',
      input: { hint: '[preset]' },
      handler: async invocation => {
        const preset = invocation.rawInput.trim()
        if (preset !== '') {
          if (invocation.signal.aborted) return { kind: 'success' as const }
          try {
            const roster = ctx.get('agentPresets')
            const usable = roster !== undefined
              && (await roster.list()).some(item => item.id === preset && item.broken === undefined)
            if (!usable) return { kind: 'error' as const, text: t('unknown agent preset {preset}', { preset }) }
          } catch (error) {
            return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
          }
          if (invocation.signal.aborted) return { kind: 'success' as const }
        }
        ctx.emit('mayfly/request-new', preset === '' ? undefined : preset)
        return { kind: 'success' as const, text: 'starting a new session' }
      },
    })
    // `/clear` is the new-session command's alias (the S27 kimi naming:
    // CC/Codex users reach for /clear to wipe the conversation), not a
    // registration — the input layer rewrites the line to `/new` before
    // dispatch, exactly like `/q` → `/quit`.
    const freshAliases = aliasRegistry.register('new', ['clear'])
    const fork = ctx.commands.register({
      name: 'fork',
      description: 'Fork the current session into a new one',
      handler: () => {
        // The command target is the UI's current session, not necessarily
        // the dispatching agent; the app layer operates on the same value.
        const current = ctx.mayflyCurrentAgent.primary()
        if (current !== null && current.status !== 'idle') {
          return { kind: 'error' as const, text: 'cannot fork while the agent is running' }
        }
        ctx.emit('mayfly/request-fork')
        return { kind: 'success' as const, text: 'forking the current session' }
      },
    })
    const rewind = ctx.commands.register({
      name: 'rewind',
      description: 'Create a branch from an earlier user turn',
      handler: () => rewindSession(),
    })
    const sessions = ctx.commands.register({
      name: 'sessions',
      description: 'List persisted sessions and switch to one (an id resumes directly)',
      input: { hint: '[<session-id>]' },
      handler: (invocation) => {
        // The direct channel the old /resume owned: an id argument skips
        // the picker and asks the app layer to resume that session.
        const sessionId = invocation.rawInput.trim()
        if (sessionId.length === 0) return listSessions(invocation.signal)
        ctx.emit('mayfly/request-resume', sessionId)
        return { kind: 'success' as const, text: `resuming session ${sessionId}` }
      },
    })
    // `/resume` is the sessions command's alias, not a registration — the
    // input layer rewrites it to `/sessions` (with the id argument intact)
    // before `ctx.commands.execute` (the S24a dogfood ruling: /resume and
    // /sessions were one command wearing two names).
    const sessionsAliases = aliasRegistry.register('sessions', ['resume'])
    const help = ctx.commands.register({
      name: 'help',
      description: 'Show available commands and key bindings',
      handler: () => showHelp(),
    })
    // The palette entry for the Shift+Tab plan cycle (mode-commands): the
    // hotkey stays the primary surface; the command exists for discovery.
    const mode = ctx.commands.register({
      name: 'mode',
      description: 'Toggle plan mode (same as Shift+Tab)',
      handler: () => {
        void cycleMode(ctx, (id, feedback) => notifications.report(id, feedback))
        return { kind: 'success' as const }
      },
    })
    const theme = registerThemeCommand(ctx)
    // The model-family commands (`/model`, `/effort`, later `/provider`)
    // live in their own module with the same lazy-service discipline.
    const models = registerModelCommands(ctx)
    // The session-info family (`/status` `/usage` `/version`).
    // The session-export family (`/export` `/copy`).
    const sessionExport = registerExportCommands(ctx)
    // The canned-prompt command (`/init`).
    const init = registerInitCommand(ctx)
    // `/trace` is a read-only view over the official session-query seam.
    const trace = registerTraceCommand(ctx)
    // `/update` is the crash-safe, preflighted profile swap.
    const update = registerUpdateCommand(ctx)
    // `/plugin` browses the marketplace index and installs or removes plugins.
    const pluginMarket = registerPluginCommand(ctx)
    return () => {
      quit()
      quitAliases()
      fresh()
      freshAliases()
      fork()
      rewind()
      sessions()
      sessionsAliases()
      help()
      mode()
      theme()
      models()
      sessionExport()
      init()
      trace()
      update()
      pluginMarket()
    }
  })
}
