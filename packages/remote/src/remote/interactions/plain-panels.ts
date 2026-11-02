/** Shared wire command panels for the standalone frontend. @module remote/interactions/plain-panels */
import type { Context } from '@deepseek-ai/cordis'
import { MAYFLY_VERSION } from '@ephemeral-ai/mayfly/banner-content'
import { helpNode, displayKey, SHARED_KEY_REFERENCE, interactionTranslator, mountInteractionLocale, observeInteractionLocale, changelogNode, CHANGELOG_ENTRIES, versionNode, usageNode, rewindNode, type RewindCandidate } from '@ephemeral-ai/mayfly/command-panels'
import { contextPercent, formatTokens } from '@ephemeral-ai/mayfly/status-context'
import { panel, ui, type MayflyOverlayHandle, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { RemotePresentationFacts } from '../../transcript/remote-model.ts'
import type { RemoteCommandDescriptor } from '../command-catalog.ts'
import type { RemoteContextPanelSource } from '../session-information.ts'

export type { RemoteCommandDescriptor } from '../command-catalog.ts'

/** Panel operations consumed by the command router. */
export interface RemoteAppPanels {
  showHelp(commands: readonly RemoteCommandDescriptor[]): void
  showStatus(facts: RemotePresentationFacts): void
  showContext(source: RemoteContextPanelSource): void
  showRewind?(candidates: readonly RewindCandidate[], choose: (seq: number) => Promise<void>, isCurrent: () => boolean, subscribe: (invalidate: () => void) => () => void): void
  showVersion(harness?: string): void
  showChangelog(): void
}

/** Wire overlays retain focus and drafts in the shared frontend across renderer reload. */
export class RemotePlainPanels implements RemoteAppPanels {
  private active: MayflyOverlayHandle | undefined
  private offLocale: (() => void) | undefined
  private offSource: (() => void) | undefined
  private generation = 0
  private readonly t

  constructor(private readonly ctx: Context) {
    mountInteractionLocale(ctx)
    this.t = interactionTranslator(ctx)
    ctx.effect(() => () => { this.dispose() })
  }

  showHelp(commands: readonly RemoteCommandDescriptor[]): void {
    const seen = new Set<string>()
    const unique = commands.filter(command => {
      if (seen.has(command.name)) return false
      seen.add(command.name)
      return true
    }).toSorted((a, b) => a.name.localeCompare(b.name))
    const row = (command: RemoteCommandDescriptor) => ({
      label: `/${command.name}${command.aliases === undefined || command.aliases.length === 0 ? '' : ` (${command.aliases.map(alias => `/${alias}`).join(', ')})`}`,
      description: this.t(command.description),
    })
    const remote = unique.filter(command => command.group === 'remote')
    this.open('help', () => helpNode([
      { heading: 'Commands', labelTone: 'accent', rows: unique.filter(command => command.group !== 'remote').map(row) },
      { heading: 'Keys', labelTone: 'warning', rows: this.ctx.mayflyKeymap.list().map(action => ({
        label: [action.keys].flat().map(displayKey).join('/'), description: this.t(action.description ?? action.label ?? action.id),
      })) },
      { heading: 'Panels and pickers', labelTone: 'warning', rows: SHARED_KEY_REFERENCE.map(row => ({ label: this.t(row.keys), description: this.t(row.action) })) },
      ...remote.length === 0 ? [] : [{ heading: 'Remote', labelTone: 'accent' as const, rows: remote.map(row) }],
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

  showContext(source: RemoteContextPanelSource): void {
    const view = (): MayflyUiNode => {
      const facts = source.read()
      return panel({ title: this.t('Context'), escapeLabel: 'back',
        body: ui.stack.column([ui.child(ui.scroll(facts === undefined
          ? ui.text(this.t('Session information unavailable'), { tone: 'danger' })
          : usageNode(facts, this.t), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })]),
        footer: ui.actions({ id: 'information-actions', items: [{ id: 'refresh', label: this.t('Refresh'), hintLabel: this.t('refresh'), semantic: 'refresh', hidden: true }] }),
      })
    }
    this.open('context', view)
    const generation = this.generation
    this.offSource = source.subscribe(() => {
      if (generation !== this.generation) return
      if (source.read() === undefined) this.dispose()
      else this.active?.set(view())
    })
  }

  showRewind(candidates: readonly RewindCandidate[], choose: (seq: number) => Promise<void>, isCurrent: () => boolean, subscribe: (invalidate: () => void) => () => void): void {
    this.open('rewind', () => rewindNode(candidates, this.t), async event => {
      if (!isCurrent()) return { kind: 'cancelled', dismiss: true }
      if (event.kind !== 'selection-accept' || !candidates.some(candidate => String(candidate.boundarySeq) === event.selectedIds[0])) return { kind: 'completed' }
      await choose(Number(event.selectedIds[0]))
      return { kind: 'completed', dismiss: true }
    })
    this.offSource = subscribe(() => { if (!isCurrent()) this.dispose() })
  }

  showVersion(harness?: string): void {
    this.open('version', () => panel({ title: this.t('Version'), escapeLabel: 'back', body: versionNode({ mayfly: MAYFLY_VERSION, harness: harness ?? this.t('not advertised by the Host') }) }))
  }

  showChangelog(): void {
    this.open('changelog', () => panel({ title: this.t('Changelog'), escapeLabel: 'back',
      body: ui.stack.column([ui.child(ui.scroll(changelogNode(CHANGELOG_ENTRIES, this.t), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })]),
    }))
  }

  dispose(): void {
    this.generation += 1
    this.offLocale?.()
    this.offLocale = undefined
    this.offSource?.()
    this.offSource = undefined
    this.active?.close()
    this.active = undefined
  }

  private open(id: string, view: () => MayflyUiNode, action?: (event: MayflyUiActionEvent) => Promise<MayflyUiActionReply>): void {
    this.dispose()
    const generation = this.generation
    this.active = this.ctx.mayflyOverlays.open({
      id: `mayfly.${id}`, presentation: 'editor', capturing: true, dismissal: 'discard', scope: { kind: 'app', targetId: id },
      onEvent: { action: event => {
        if (generation !== this.generation) return { kind: 'cancelled' }
        if (event.kind === 'dismiss') { this.dispose(); return { kind: 'cancelled' } }
        if (action !== undefined) return action(event)
        if (event.kind === 'activate' && event.actionId === 'refresh') this.active?.set(view())
        return { kind: 'completed' }
      } },
    }, view())
    this.offLocale = observeInteractionLocale(this.ctx, () => { if (generation === this.generation) this.active?.set(view()) })
  }
}
