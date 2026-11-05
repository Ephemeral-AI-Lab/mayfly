/** The reference wire skill browser over one exact native catalog. @module remote/editor/skills-panel */
import type { Context } from '@deepseek-ai/cordis'
import { skillsNode } from '../../interaction/skills-model.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from '../../interaction/locale.ts'
import type { MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import type { EditorSkills } from './skills.ts'
import type { EditorFeatureSession } from './types.ts'

interface SkillsPanelOptions {
  readonly ctx: Context
  readonly skills: EditorSkills
  readonly session: () => EditorFeatureSession | undefined
  readonly restoreFocus: () => void
}

/** A plain official Host can list skills without composing Mayfly's native metadata capability. */
export const REMOTE_SKILLS_METADATA_LIMITATION = 'This Host does not provide the Mayfly skillCatalog capability; source and provider metadata are unavailable.'

/** An ordinary editor overlay; native selection and catalog owners supply every fact. */
export class EditorSkillsPanel {
  private handle: MayflyOverlayHandle | undefined
  private cleanup: (() => void) | undefined
  private generation = 0
  private lifetime: AbortController | undefined
  private offCaller: (() => void) | undefined
  private readonly t

  constructor(private readonly options: SkillsPanelOptions) {
    mountInteractionLocale(options.ctx)
    this.t = interactionTranslator(options.ctx)
  }

  get open(): boolean { return this.handle?.closed === false }

  async show(parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    if (this.open) { this.options.ctx.mayflyOverlays.focus('mayfly.skills'); return }
    const selected = this.options.session()
    if (selected === undefined) return
    const generation = ++this.generation
    const connectionGeneration = selected.client.state.getSnapshot().generation
    this.offCaller?.()
    this.lifetime?.abort()
    const lifetime = new AbortController()
    this.lifetime = lifetime
    const abort = (): void => { if (this.lifetime === lifetime) this.close() }
    parent?.addEventListener('abort', abort, { once: true })
    this.offCaller = () => { parent?.removeEventListener('abort', abort) }
    const isCurrent = (): boolean => {
      const current = this.options.session()
      return !lifetime.signal.aborted && generation === this.generation && current?.client === selected.client
        && current.session === selected.session && current.generation === selected.generation
        && current.ref.host === selected.ref.host && current.ref.sessionId === selected.ref.sessionId
        && selected.client.state.getSnapshot().generation === connectionGeneration
    }
    await this.options.skills.refresh(lifetime.signal)
    if (!isCurrent()) { if (this.lifetime === lifetime) this.close(); return }
    let focused: string | undefined
    let detailMode = false
    const view = () => {
      const snapshot = this.options.skills.snapshot()
      return skillsNode(snapshot.skills.map(skill => ({
        name: skill.name, description: skill.description,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
        ...skill.source === undefined ? {} : { source: skill.source },
        ...skill.provider === undefined ? {} : { provider: skill.provider },
        invocation: { modelInvocable: skill.modelInvocable },
      })), snapshot.complete, this.t, { focused, detailMode, ...snapshot.metadataUnavailable ? { metadataNote: REMOTE_SKILLS_METADATA_LIMITATION } : {} })
    }
    const refresh = (): void => {
      if (!isCurrent()) { this.close(); return }
      const names = this.options.skills.list().map(skill => skill.name)
      if (focused === undefined || !names.includes(focused)) focused = names[0]
      if (detailMode && focused === undefined) detailMode = false
      if (this.open) this.handle!.set(view())
    }
    const handle = this.options.ctx.mayflyOverlays.open({
      id: 'mayfly.skills', presentation: 'editor', capturing: true, dismissal: 'discard',
      scope: { kind: 'session', sessionId: selected.ref.sessionId },
      onEvent: { action: async (event, context) => {
        if (context.signal.aborted || !isCurrent()) return { kind: 'cancelled', dismiss: true }
        if (event.kind === 'dismiss') {
          if (detailMode) { detailMode = false; refresh(); return { kind: 'completed', dismiss: false } }
          this.close()
          this.options.restoreFocus()
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept' && (event.controlId === 'skills' || event.controlId === 'skills-narrow')) {
          const name = event.selectedIds[0]
          if (name === undefined || !this.options.skills.list().some(skill => skill.name === name)) return { kind: 'cancelled' }
          focused = name
          if (event.controlId === 'skills-narrow') detailMode = true
          refresh()
          return { kind: 'completed' }
        }
        if (event.kind === 'activate' && event.actionId === 'refresh') {
          await this.options.skills.refresh(AbortSignal.any([lifetime.signal, context.signal]))
          if (context.signal.aborted || !isCurrent()) return { kind: 'cancelled', dismiss: true }
          refresh()
        }
        return { kind: 'completed' }
      } },
    }, view())
    this.handle = handle
    const offSkills = this.options.skills.subscribe(refresh)
    const offLocale = observeInteractionLocale(this.options.ctx, refresh)
    const offRegistry = this.options.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'remove' && delta.id === 'mayfly.skills' && handle.closed) this.finish(handle)
    })
    this.cleanup = () => { offSkills(); offLocale(); offRegistry() }
    if (handle.closed) { this.finish(handle); return }
    refresh()
  }

  close(): void {
    this.generation += 1
    this.offCaller?.()
    this.offCaller = undefined
    this.lifetime?.abort()
    this.lifetime = undefined
    const handle = this.handle
    if (handle !== undefined) { handle.close(); this.finish(handle) }
  }

  private finish(handle: MayflyOverlayHandle): void {
    if (this.handle !== handle) return
    this.generation += 1
    this.offCaller?.()
    this.offCaller = undefined
    this.lifetime?.abort()
    this.lifetime = undefined
    this.handle = undefined
    const cleanup = this.cleanup
    this.cleanup = undefined
    cleanup?.()
  }
}
