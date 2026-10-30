/**
 * `/plugins` read-only inventory and `/update` release check for the standalone
 * frontend. Both are deliberately non-mutating in this alpha: installing,
 * removing, or upgrading a Host plugin changes the Host's own dependency graph
 * and restart policy, which a remote terminal must never trigger implicitly.
 * @module @ephemeral-ai/mayfly/remote/operations/plugins
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { MayflyUiActionEvent, MayflyUiActionReply, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { remoteErrorMessage } from '../features/official.ts'
import type { HostClient } from '../../client/types.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'
import { remotePluginInventoryNode, remoteUpdateNode, type RemotePluginRow, type RemoteUpdateFacts } from '../panels/operations/plugins.ts'

const zh: Readonly<Record<string, string>> = {
  'List the Host plugins and bundles': '列出 Host 插件与 bundle',
  'Check for a newer Mayfly release': '检查 Mayfly 是否有新版本',
  'Plugins': '插件',
  'No plugins reported by this Host': '该 Host 未报告任何插件',
  'No current session': '当前没有会话',
  'This Host does not expose the plugin manager': '该 Host 未提供插件管理器',
  'Refresh': '刷新',
  'Only the Host may change its own plugins; this frontend never installs, removes, or upgrades them.':
    '只有 Host 才能更改自己的插件；本前端不会安装、删除或升级它们。',
  'Update check': '更新检查',
  'Latest release': '最新发布版本',
  'unavailable': '不可用',
  'refresh': '刷新',
  'Mayfly version': 'Mayfly 版本',
  'A newer release is available; upgrade the Host profile to apply it.':
    '有新版本可用；升级 Host profile 以应用。',
  'This build is the newest published release.': '当前构建已是最新发布版本。',
  'The registry could not be reached; try again later.': '无法连接软件源；请稍后再试。',
  'Upgrades are never automatic: they change the Host profile and require a restart.':
    '升级从不自动执行：它会改变 Host profile 并需要重启。',
}

/**
 * Compare two dotted release versions without a semver dependency. Pre-release
 * and build metadata are ignored, which is what a user asking "is there a newer
 * release" means; a host that is ahead of the registry is not told to upgrade.
 * @param left - a version string such as `0.1.4-rc.2`.
 * @param right - the version it is compared against.
 * @returns negative, zero, or positive in the usual comparator sense.
 */
function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value
    .split('-')[0]!
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(part => Number.isFinite(part) ? part : 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** One Host plugin entry as the panel renders it: no version is exposed, so the fiber phase takes that column. */
function pluginRows(plugins: readonly {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
  readonly meta?: { readonly title?: unknown } | undefined
}[]): readonly RemotePluginRow[] {
  return plugins.map((plugin) => {
    const title = plugin.meta?.title
    const named = typeof title === 'string'
      ? title
      : title !== null && typeof title === 'object' && 'en' in title && typeof (title as { en?: unknown }).en === 'string'
        ? (title as { en: string }).en
        : plugin.moduleName
    return {
      name: named,
      detail: plugin.moduleName,
      state: plugin.enabled ? 'enabled' : 'disabled',
      kind: plugin.fiberPhase ?? '',
    }
  })
}

class RemotePluginsController {
  private readonly t
  private readonly lifecycle: RemoteFeatureLifecycle
  private panel: RemoteBrowserPanel | undefined
  private error: string | undefined
  private rows: readonly RemotePluginRow[] = []
  private update: RemoteUpdateFacts | undefined
  private updateError: string | undefined
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    this.t = memoizedLocaleTranslator(context.base.ctx, 'remote-plugins').translate
    registerRemoteOperationsLocale(context.base, 'remote-plugins', zh)
    this.lifecycle = new RemoteFeatureLifecycle(context.base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.panel?.close()
  }

  private readonly attach = (): void => {
    this.panel?.close()
    this.panel = undefined
  }

  private openPlugins(filter: string): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.context.base.notice.set(this.t('No current session'))
      return
    }
    void this.loadPlugins(current.client, filter)
  }

  private async loadPlugins(client: HostClient, filter: string): Promise<void> {
    try {
      const result = await client.remote.pluginManager.listPlugins()
      if (this.disposed) return
      if (!result.ok) {
        this.error = result.error.message
        this.rows = []
      } else {
        this.error = undefined
        const needle = filter.trim().toLowerCase()
        const all = pluginRows(result.value)
        this.rows = needle === '' ? all : all.filter(row => row.name.toLowerCase().includes(needle))
      }
    } catch (error) {
      if (this.disposed) return
      this.error = remoteErrorMessage(error)
      this.rows = []
    }
    this.show()
  }

  private show(): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) return
    this.panel?.close()
    const opened = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.plugins',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remotePluginInventoryNode({ rows: this.rows, error: this.error }, this.t),
      observe: (_event: MayflyUiObservationEvent) => {},
      action: (event: MayflyUiActionEvent): MayflyUiActionReply => {
        if (event.kind === 'activate' && event.actionId === 'plugins-refresh') {
          void this.loadPlugins(current.client, '')
        }
        return { kind: 'completed' }
      },
      // Only this panel's own close may clear the field: a late close from a
      // panel that has already been replaced must not drop the live one.
      onClosed: () => { if (this.panel === opened) this.panel = undefined },
    })
    this.panel = opened
  }

  private openUpdate(): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) {
      this.context.base.notice.set(this.t('No current session'))
      return
    }
    void this.checkUpdate(current.client)
  }

  /**
   * Compare this build against the registry's published `latest`. The check is
   * read-only and unauthenticated; any failure is reported, never retried on a
   * timer, so an offline machine cannot spin.
   */
  private async checkUpdate(client: HostClient): Promise<void> {
    const capabilities = await client.remote.mayflyHost.capabilities().catch(() => undefined)
    const hostVersion = capabilities !== undefined && capabilities.ok ? capabilities.value.hostVersion : undefined
    try {
      const response = await fetch('https://registry.npmjs.org/@ephemeral-ai%2fmayfly-remote/latest', {
        signal: AbortSignal.timeout(8_000),
        headers: { accept: 'application/json' },
      })
      if (this.disposed) return
      if (!response.ok) {
        this.update = undefined
        this.updateError = this.t('The registry could not be reached; try again later.')
      } else {
        const body = await response.json() as { version?: unknown }
        // The body read is another suspension point: a teardown that landed
        // while it was pending must not reopen a panel for a dead controller.
        if (this.disposed) return
        const latest = typeof body.version === 'string' && body.version.trim() !== '' ? body.version : undefined
        if (latest === undefined) {
          // A registry document with no version is not evidence that this build
          // is current; saying so would be a confident wrong answer.
          this.update = undefined
          this.updateError = this.t('The registry could not be reached; try again later.')
        } else {
          this.updateError = undefined
          this.update = {
            current: hostVersion ?? '',
            latest,
            newer: hostVersion !== undefined && compareVersions(latest, hostVersion) > 0,
          }
        }
      }
    } catch {
      if (this.disposed) return
      this.update = undefined
      this.updateError = this.t('The registry could not be reached; try again later.')
    }
    if (this.disposed) return
    this.showUpdate()
  }

  private showUpdate(): void {
    const current = this.context.base.hosts.current()
    if (current === undefined) return
    this.panel?.close()
    const opened = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.update',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.context.base.hosts.current(), current.client, current.ref),
      view: () => remoteUpdateNode({ facts: this.update, error: this.updateError }, this.t),
      observe: (_event: MayflyUiObservationEvent) => {},
      action: (event: MayflyUiActionEvent): MayflyUiActionReply => {
        if (event.kind === 'activate' && event.actionId === 'update-refresh') void this.checkUpdate(current.client)
        return { kind: 'completed' }
      },
      onClosed: () => { if (this.panel === opened) this.panel = undefined },
    })
    this.panel = opened
  }

  readonly commands = (): ReadonlyArray<{ readonly name: string, readonly description: string, readonly run: (rawInput: string) => void }> => [
    { name: 'plugins', description: this.t('List the Host plugins and bundles'), run: rawInput => { this.openPlugins(rawInput) } },
    { name: 'update', description: this.t('Check for a newer Mayfly release'), run: () => { this.openUpdate() } },
  ]
}

/** Mount `/plugins` and `/update`. */
export function mountRemotePluginOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemotePluginsController(context)
  const unregister = controller.commands().map(command => context.base.commands.register({
    name: command.name,
    description: command.description,
    execute: (rawInput, signal) => {
      if (signal.aborted) return
      command.run(rawInput)
    },
  }))
  return () => {
    for (const dispose of unregister) dispose()
    controller.dispose()
  }
}
