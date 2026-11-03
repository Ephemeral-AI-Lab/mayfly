/**
 * Host-owned Git status polling with effective-directory and stale-result fencing.
 * @module @ephemeral-ai/mayfly/remote/features/git
 */

import type { MayflyGitStatus } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyStatusRegistration, MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { buildGitStatusNode } from '@ephemeral-ai/mayfly/status-git'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { RemoteGitPoller } from '../../frontend/git.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../features.ts'
import { formatRemoteGitBadge } from '../status/git.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { hasMayflyHostFeature, unavailableCapability } from './capabilities.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'

class RemoteGitController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly poller: RemoteGitPoller<MayflyGitStatus | null>
  private readonly offPoller: () => void
  private readonly status: MayflyStatusRegistration
  private stopDirectory: (() => void) | undefined
  private operationLifetime = new AbortController()
  private ticket = 0
  private cwd: string | undefined
  private capabilityError: string | undefined
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-git').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.poller = new RemoteGitPoller((ref, signal) => {
      const current = options.hosts.current()
      if (current === undefined
        || (current.access !== undefined && current.access !== 'interactive')
        || !isRemoteFeatureSelection(current, current.client, ref)) {
        return Promise.reject(new Error('Git poll selection changed'))
      }
      return current.client.remote.mayflyHost.gitStatus({ sessionId: ref.sessionId }, signal)
    }, 5_000)
    this.offPoller = this.poller.subscribe(this.publish)
    this.status = options.ctx.mayflyStatus.register({ id: 'mayfly.status.git', priority: 10 }, null)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.ticket += 1
    this.lifecycle.dispose()
    this.operationLifetime.abort()
    this.stopDirectory?.()
    this.stopDirectory = undefined
    this.offPoller()
    this.status.dispose()
    void this.poller.dispose()
  }

  private readonly attach = (generation: number): void => {
    this.ticket += 1
    this.operationLifetime.abort()
    this.operationLifetime = new AbortController()
    this.stopDirectory?.()
    this.stopDirectory = undefined
    this.cwd = undefined
    this.capabilityError = undefined
    this.poller.attach(null)
    const current = this.lifecycle.selection(generation)
    // Passive child history has no live Agent for automatic Git reads.
    if (current !== undefined && (current.access === undefined || current.access === 'interactive')) {
      const directory = current.binding.session.projections.faceOf('workingDirectory')
      const update = (): void => {
        if (!this.lifecycle.owns(generation)) return
        const value = directory.getSnapshot()
        const cwd = typeof value === 'string' ? value : ''
        if (cwd === this.cwd) return
        this.cwd = cwd
        void this.start(current, generation, cwd)
      }
      this.stopDirectory = directory.subscribe(update)
      update()
    }
    this.publish()
  }

  private async start(current: RemoteFeatureSelection, generation: number, cwd: string): Promise<void> {
    const ticket = ++this.ticket
    const signal = this.operationLifetime.signal
    this.capabilityError = undefined
    this.poller.attach(null)
    try {
      const capable = await hasMayflyHostFeature(current.client, 'gitStatus', signal)
      if (!this.lifecycle.owns(generation) || ticket !== this.ticket || cwd !== this.cwd) return
      if (!capable) {
        this.capabilityError = unavailableCapability('gitStatus')
        this.publish()
        return
      }
      this.poller.attach({ host: current.ref.host, sessionId: current.ref.sessionId })
    } catch (error) {
      if (this.lifecycle.owns(generation) && ticket === this.ticket && !signal.aborted) {
        this.capabilityError = error instanceof Error ? error.message : String(error)
        this.publish()
      }
    }
  }

  private readonly publish = (): void => {
    if (this.capabilityError !== undefined) {
      this.status.set({ kind: 'text', content: this.capabilityError, tone: 'warning' })
      return
    }
    const snapshot = this.poller.snapshot()
    const result = snapshot.result
    if (result === undefined) {
      this.status.set(null)
      return
    }
    if (!result.ok) {
      this.status.set({ kind: 'text', content: this.t('gitStatus failed; refresh after reconnecting'), tone: 'warning' })
      return
    }
    this.status.set(buildGitStatusNode(result.value === null ? '' : formatRemoteGitBadge(result.value)))
  }
}

/** Mount Host Git polling; no Frontend Git process or Host-path filesystem read exists. */
export function mountGitFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteGitController(options)
  return controller.dispose
}
