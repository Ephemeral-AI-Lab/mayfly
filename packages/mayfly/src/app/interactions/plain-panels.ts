/** Shared wire command panels for the standalone frontend. @module remote/interactions/plain-panels */
import type { Context } from '@deepseek-ai/cordis'
import { MAYFLY_VERSION } from '../../transcript/banner-content.ts'
import { helpNode } from '../../interaction/help.ts'
import { displayKey } from '../../core/key-actions.ts'
import { SHARED_KEY_REFERENCE } from '../../core/ui-key-grammar.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from '../../interaction/locale.ts'
import { changelogNode, versionNode, usageNode } from '../../interaction/session-info-model.ts'
import { CHANGELOG_ENTRIES } from '../../interaction/changelog-content.ts'
import { rewindNode, type RewindCandidate } from '../../interaction/rewind.ts'
import { renamePanelModel } from '../../interaction/rename-model.ts'
import { contextPercent, formatTokens } from '../../transcript/status-context-model.ts'
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
  showRename(title: string, save: (title: string) => Promise<void>, isCurrent: () => boolean, subscribe: (invalidate: () => void) => () => void): void
  showVersion(harness?: string): void
  showChangelog(): void
}

/** Wire overlays retain focus and drafts in the shared frontend across renderer reload. */
export class RemotePlainPanels implements RemoteAppPanels {
  private active: MayflyOverlayHandle | undefined
  private offLocale: (() => void) | undefined
  private offSource: (() => void) | undefined
  private offOverlay: (() => void) | undefined
  private renameCurrent: (() => boolean) | undefined
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

  showRename(title: string, save: (title: string) => Promise<void>, isCurrent: () => boolean, subscribe: (invalidate: () => void) => () => void): void {
    if (!isCurrent()) return
    if (this.renameCurrent?.() === true && this.active?.closed === false) {
      this.active.focus()
      return
    }
    this.open('rename', () => renamePanelModel(title, this.t), async event => {
      if (!isCurrent()) return { kind: 'cancelled', dismiss: true }
      if (event.kind !== 'activate' || event.actionId !== 'save') return { kind: 'completed' }
      const value = event.inputs?.forms[0]?.fields.find(field => field.id === 'title')?.value
      if (typeof value !== 'string' || value.trim() === '') return { kind: 'failed', message: this.t('Enter a session name') }
      try {
        await save(value.trim())
        return isCurrent() ? { kind: 'completed', dismiss: true } : { kind: 'cancelled' }
      } catch (error) {
        return isCurrent() ? { kind: 'failed', message: error instanceof Error ? error.message : String(error) } : { kind: 'cancelled' }
      }
    }, 'confirm-dirty')
    this.renameCurrent = isCurrent
    const generation = this.generation
    const stop = subscribe(() => { if (generation === this.generation && !isCurrent()) this.dispose() })
    if (generation === this.generation) this.offSource = stop
    else stop()
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
    this.offOverlay?.()
    this.offOverlay = undefined
    this.renameCurrent = undefined
    this.active?.close()
    this.active = undefined
  }

  private open(id: string, view: () => MayflyUiNode, action?: (event: MayflyUiActionEvent) => Promise<MayflyUiActionReply>, dismissal: 'confirm-dirty' | 'discard' = 'discard'): void {
    this.dispose()
    const generation = this.generation
    this.active = this.ctx.mayflyOverlays.open({
      id: `mayfly.${id}`, presentation: 'editor', capturing: true, dismissal, scope: { kind: 'app', targetId: id },
      onEvent: { action: async event => {
        if (generation !== this.generation) return { kind: 'cancelled' }
        if (event.kind === 'dismiss') { this.dispose(); return { kind: 'cancelled' } }
        if (action !== undefined) {
          const reply = await action(event)
          return generation === this.generation ? reply : { kind: 'cancelled' }
        }
        if (event.kind === 'activate' && event.actionId === 'refresh') this.active?.set(view())
        return { kind: 'completed' }
      } },
    }, view())
    this.offOverlay = this.ctx.mayflyOverlays.subscribe(delta => {
      if (generation === this.generation && delta.kind === 'remove' && delta.id === `mayfly.${id}`) this.dispose()
    })
    this.offLocale = observeInteractionLocale(this.ctx, () => { if (generation === this.generation) this.active?.set(view()) })
  }
}
