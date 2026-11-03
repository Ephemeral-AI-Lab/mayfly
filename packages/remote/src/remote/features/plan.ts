/**
 * Native plan projection and command behavior, including next-Session pending selection.
 * @module @ephemeral-ai/mayfly/remote/features/plan
 */

import { memoizedLocaleTranslator, type MayflyTranslate } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyStatusRegistration } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { assertRemoteSessionWritable } from './official.ts'

interface PlanProjection {
  readonly active: boolean
  readonly pending: boolean
}

const zh = {
  'plan': '计划',
  'plan…': '计划…',
  'plan mode is unavailable': '计划模式不可用',
  'Plan mode on for the next session': '下一个会话将进入计划模式',
  'Plan mode off for the next session': '下一个会话将退出计划模式',
  'Send a message first: /plan with a message needs a session': '请先发送消息：带内容的 /plan 需要会话',
  'Toggle plan mode': '切换计划模式',
  'Enter or leave plan mode': '进入或离开计划模式',
  'mode command is unavailable: /plan': '模式命令不可用：/plan',
} as const

class RemotePlanController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly status: MayflyStatusRegistration
  private readonly unregisterKey: () => void
  private plan: PlanProjection | undefined
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
    this.disposed = true
    this.lifecycle.dispose()
    this.commandLifetime.abort()
    this.stopProjection?.()
    this.stopProjection = undefined
    this.unregisterKey()
    this.status.dispose()
  }

  private readonly attach = (generation: number): void => {
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
    }
    this.publish()
  }

  private publish(): void {
    const nextPlan = this.options.hosts.current() === undefined ? this.options.startupPlan?.pending() : undefined
    const pending = nextPlan !== undefined || this.plan?.pending === true
    const active = nextPlan === true || this.plan?.active === true || this.plan?.pending === true
    this.status.set(active ? { kind: 'text', content: this.t(pending ? 'plan…' : 'plan'), tone: 'accent' } : null)
  }

  private async cycle(parent?: AbortSignal): Promise<void> {
    if (this.disposed || parent?.aborted === true) return
    const current = this.options.hosts.current()
    if (current === undefined) {
      this.setNextPlan(!(this.options.startupPlan?.pending() ?? false), 'success')
      return
    }
    if (this.plan === undefined) {
      this.options.notice.set(this.t('plan mode is unavailable'), 'error')
      return
    }
    await this.executeNative(current, this.plan.active !== this.plan.pending ? '/plan off' : '/plan', this.lifecycle.currentGeneration(), parent, true)
  }

  private setNextPlan(active: boolean, severity: 'info' | 'success' = 'info'): void {
    if (this.options.startupPlan === undefined) { this.options.notice.set(this.t('plan mode is unavailable'), 'error'); return }
    this.options.startupPlan.set(active)
    this.plan = undefined
    this.publish()
    this.options.notice.set(this.t(active ? 'Plan mode on for the next session' : 'Plan mode off for the next session'), severity)
  }

  private async executeNative(current: RemoteFeatureSelection, line: string, generation: number, parent?: AbortSignal, cycle = false): Promise<void> {
    const signal = parent === undefined ? this.commandLifetime.signal : AbortSignal.any([this.commandLifetime.signal, parent])
    try {
      assertRemoteSessionWritable(current)
      const result = await current.client.remote.commands.execute(current.ref.sessionId, line, [], signal)
      if (!this.lifecycle.owns(generation) || signal.aborted) return
      if (!result.ok) this.options.notice.set(result.error.message, 'error')
      else if (result.value === undefined) this.options.notice.set(this.t(cycle ? 'mode command is unavailable: /plan' : 'plan mode is unavailable'), 'error')
      else if (result.value.result.text !== undefined) this.options.notice.set(result.value.result.text, result.value.result.kind === 'error' ? 'error' : cycle ? 'success' : 'info')
    } catch (error) {
      if (this.lifecycle.owns(generation) && !signal.aborted) this.options.notice.set(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  readonly execute = async (rawInput: string, signal?: AbortSignal): Promise<void> => {
    if (this.disposed || signal?.aborted === true) return
    const current = this.options.hosts.current()
    const input = rawInput.trim()
    if (current === undefined) {
      if (input !== '' && input !== 'off') {
        throw new Error(this.t('Send a message first: /plan with a message needs a session'))
      }
      this.setNextPlan(input !== 'off')
      return
    }
    await this.executeNative(current, input === '' ? '/plan' : `/plan ${input}`, this.lifecycle.currentGeneration(), signal)
  }

  readonly executeMode = async (_rawInput: string, signal?: AbortSignal): Promise<void> => {
    await this.cycle(signal)
  }
}

/** Mount native plan behavior, pending next-Session application, and its badge/key action. */
export function mountPlanFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemotePlanController(options)
  const unregister = [
    options.commands.register({
      name: 'plan',
      scope: 'sessionless',
      description: 'Enter or leave plan mode for the next session',
      input: { hint: '[off]' },
      execute: controller.execute,
    }),
    options.commands.register({
      name: 'mode',
      scope: 'sessionless',
      description: 'Toggle plan mode (same as Shift+Tab)',
      execute: controller.executeMode,
    }),
  ]
  let disposed = false
  return () => {
    // A second teardown must not re-run the registrations' disposers.
    if (disposed) return
    disposed = true
    for (const dispose of unregister) dispose()
    controller.dispose()
  }
}
