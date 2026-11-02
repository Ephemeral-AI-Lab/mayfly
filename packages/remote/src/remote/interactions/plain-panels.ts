/** Shared wire command panels for the standalone frontend. @module remote/interactions/plain-panels */
import type { Context } from '@deepseek-ai/cordis'
import { MAYFLY_VERSION } from '@ephemeral-ai/mayfly/banner-content'
import { helpNode, displayKey, SHARED_KEY_REFERENCE, interactionTranslator, mountInteractionLocale, observeInteractionLocale } from '@ephemeral-ai/mayfly/command-panels'
import { contextPercent, formatTokens } from '@ephemeral-ai/mayfly/status-context'
import { panel, ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { HostActions } from '../../frontend/host-actions.ts'
import type { RemotePresentationFacts } from '../../transcript/remote-model.ts'

/** One Host command descriptor exposed by the official Remote catalog. */
export type RemoteCommandDescriptor = Awaited<ReturnType<HostActions['listCommands']>>[number]

/** Panel operations consumed by the command router. */
export interface RemoteAppPanels {
  showHelp(commands: readonly RemoteCommandDescriptor[]): void
  showStatus(facts: RemotePresentationFacts): void
  showVersion(): void
}

const ALIASES: Readonly<Record<string, readonly string[]>> = { quit: ['q', 'exit'], new: ['clear'], sessions: ['resume'] }

/** Wire overlays retain focus and drafts in the shared frontend across renderer reload. */
export class RemotePlainPanels implements RemoteAppPanels {
  private active: MayflyOverlayHandle | undefined
  private offLocale: (() => void) | undefined
  private generation = 0
  private readonly t

  constructor(private readonly ctx: Context) {
    mountInteractionLocale(ctx)
    this.t = interactionTranslator(ctx)
    ctx.effect(() => () => { this.dispose() })
  }

  showHelp(commands: readonly RemoteCommandDescriptor[]): void {
    const unique = [...new Map(commands.map(command => [command.name, command])).values()].sort((a, b) => a.name.localeCompare(b.name))
    this.open('help', () => helpNode([
      { heading: 'Commands', labelTone: 'accent', rows: unique.map(command => ({
        label: `/${command.name}${ALIASES[command.name] === undefined ? '' : ` (${ALIASES[command.name]!.map(alias => `/${alias}`).join(', ')})`}`,
        description: command.description,
      })) },
      { heading: 'Keys', labelTone: 'warning', rows: this.ctx.mayflyKeymap.list().map(action => ({
        label: [action.keys].flat().map(displayKey).join('/'), description: action.description ?? action.label ?? action.id,
      })) },
      { heading: 'Panels and pickers', labelTone: 'warning', rows: SHARED_KEY_REFERENCE.map(row => ({ label: this.t(row.keys), description: this.t(row.action) })) },
    ], this.t))
  }

  showStatus(facts: RemotePresentationFacts): void {
    const context = facts.contextTokens <= 0 ? this.t('no usage yet') : facts.contextWindow === undefined
      ? `${formatTokens(facts.contextTokens)} tokens`
      : `${contextPercent(facts.contextTokens, facts.contextWindow)}% (${formatTokens(facts.contextTokens)}/${formatTokens(facts.contextWindow)})`
    this.open('status', () => panel({ title: this.t('Session status'), escapeLabel: 'back', body: ui.text([
      `Host: ${facts.ref?.host ?? 'none'}`, `Session: ${facts.ref?.sessionId ?? 'none'}`,
      `Directory: ${facts.cwd || 'unknown'}`, `Model: ${facts.model ?? 'default'} · ${facts.provider ?? 'default'}`,
      `Context: ${context}`, `State: ${facts.active ? facts.phase : 'idle'}`,
      ...facts.title === undefined ? [] : [`Title: ${facts.title}`],
    ].join('\n')) }))
  }

  showVersion(): void {
    this.open('version', () => panel({ title: this.t('Version'), escapeLabel: 'back', body: ui.text(`Mayfly v${MAYFLY_VERSION}`) }))
  }

  dispose(): void {
    this.generation += 1
    this.offLocale?.()
    this.offLocale = undefined
    this.active?.close()
    this.active = undefined
  }

  private open(id: string, view: () => MayflyUiNode): void {
    this.dispose()
    const generation = this.generation
    this.active = this.ctx.mayflyOverlays.open({
      id: `mayfly.${id}`, presentation: 'editor', capturing: true, dismissal: 'discard', scope: { kind: 'app', targetId: id },
      onEvent: { action: event => {
        if (generation !== this.generation) return { kind: 'cancelled' }
        if (event.kind === 'dismiss') { this.dispose(); return { kind: 'cancelled' } }
        return { kind: 'completed' }
      } },
    }, view())
    this.offLocale = observeInteractionLocale(this.ctx, () => { if (generation === this.generation) this.active?.set(view()) })
  }
}
