/**
 * Native plan projection and command behavior, including next-Session pending selection.
 * @module @ephemeral-ai/mayfly/remote/features/plan
 */

import { memoizedLocaleTranslator, type MayflyTranslate } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyStatusRegistration } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

interface PlanProjection {
  readonly active: boolean
  readonly pending: boolean
}

const zh = {
  'plan': '计划',
  'plan…': '计划…',
  'plan mode is unavailable': '计划模式不可用',
  'Plan mode on for the next session': '已为下个会话开启计划模式',
  'Plan mode off for the next session': '已为下个会话关闭计划模式',
  'Send a message first: /plan with a message needs a session': '请先发送消息：带消息的 /plan 需要会话',
  'Toggle plan mode': '切换计划模式',
  'Enter or leave plan mode': '进入或离开计划模式',
} as const

class RemotePlanController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly status: MayflyStatusRegistration
  private readonly unregisterKey: () => void
  private plan: PlanProjection | undefined
  private nextPlan: boolean | undefined
  private stopProjection: (() => void) | undefined
  private commandLifetime = new AbortController()
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-plan').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.status = options.ctx.mayflyStatus.register({ id: 'mayfly.status.mode', priority: 2 }, null)
    this.unregisterKey = options.ctx.mayflyKeymap.register([{
      id: 'mayfly.interaction.cycle-mode',
      keys: ['shift+tab'],
      scope: 'editor',
      description: this.t('Toggle plan mode'),
      handler: () => { void this.cycle() },
    }])
    options.ctx.effect(() => options.ctx.mayflyLocale.register('remote-plan', {
      en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
      zh,
    }))
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.commandLifetime.abort()
    this.stopProjection?.()
    this.stopProjection = undefined
    this.unregisterKey()
    this.status.dispose()
  }

  private readonly attach = (generation: number): void => {
    if (this.disposed) return
    this.commandLifetime.abort()
    this.commandLifetime = new AbortController()
    this.stopProjection?.()
    this.stopProjection = undefined
    this.plan = undefined
    const current = this.lifecycle.selection(generation)
    if (current !== undefined) {
      const projection = current.binding.session.projections.faceOf('plan')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        this.plan = projection.getSnapshot() as PlanProjection | undefined
        this.publish()
      }
      this.stopProjection = projection.subscribe(update)
      update()
      const pending = this.nextPlan
      if (pending !== undefined) {
        this.nextPlan = undefined
        void this.executeNative(current, pending ? '/plan' : '/plan off', generation)
      }
    }
    this.publish()
  }

  private publish(): void {
    const pending = this.nextPlan !== undefined || this.plan?.pending === true
    const active = this.nextPlan === true || this.plan?.active === true || this.plan?.pending === true
    this.status.set(active ? { kind: 'text', content: this.t(pending ? 'plan…' : 'plan'), tone: 'accent' } : null)
  }

  private async cycle(): Promise<void> {
    const current = this.options.hosts.current()
    if (current === undefined) {
      this.setNextPlan(!(this.nextPlan ?? false))
      return
    }
    if (this.plan === undefined) {
      this.options.notice.set(this.t('plan mode is unavailable'))
      return
    }
    await this.executeNative(current, this.plan.active !== this.plan.pending ? '/plan off' : '/plan', this.lifecycle.currentGeneration())
  }

  private setNextPlan(active: boolean): void {
    this.nextPlan = active
    this.plan = undefined
    this.publish()
    this.options.notice.set(this.t(active ? 'Plan mode on for the next session' : 'Plan mode off for the next session'))
  }

  private async executeNative(current: RemoteFeatureSelection, line: string, generation: number): Promise<void> {
    const signal = this.commandLifetime.signal
    if (signal.aborted) return
    try {
      const result = await current.client.remote.commands.execute(current.ref.sessionId, line, [], signal)
      if (!this.lifecycle.owns(generation) || signal.aborted) return
      if (!result.ok) this.options.notice.set(result.error.message)
      else if (result.value === undefined) this.options.notice.set(this.t('plan mode is unavailable'))
      else if (result.value.result.text !== undefined) this.options.notice.set(result.value.result.text)
    } catch (error) {
      if (this.lifecycle.owns(generation) && !signal.aborted) this.options.notice.set(error instanceof Error ? error.message : String(error))
    }
  }

  readonly execute = async (rawInput: string): Promise<void> => {
    const current = this.options.hosts.current()
    const input = rawInput.trim()
    if (current === undefined) {
      if (input !== '' && input !== 'off') {
        this.options.notice.set(this.t('Send a message first: /plan with a message needs a session'))
        return
      }
      this.setNextPlan(input !== 'off')
      return
    }
    if (input === '') {
      await this.cycle()
      return
    }
    if (!isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref)) return
    await this.executeNative(current, `/plan ${input}`, this.lifecycle.currentGeneration())
  }
}

/** Mount native plan behavior, pending next-Session application, and its badge/key action. */
export function mountPlanFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemotePlanController(options)
  // `/mode` is the name the in-process TUI also answers to; the local command
  // registry has no alias table, so the same executor is registered twice.
  const unregister = [
    options.commands.register({
      name: 'plan',
      description: 'Enter or leave plan mode',
      input: { hint: '[off]' },
      execute: controller.execute,
    }),
    options.commands.register({
      name: 'mode',
      description: 'Toggle plan mode (same as /plan or Shift+Tab)',
      input: { hint: '[off]' },
      execute: controller.execute,
    }),
  ]
  return () => {
    for (const dispose of unregister) dispose()
    controller.dispose()
  }
}
