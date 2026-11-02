/** Explicit Host plus frontend upgrade, using native Host transactions and frontend-local staging.
 * @module remote/operations/update
 */
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { currentMayflySettings } from '@ephemeral-ai/mayfly/settings'
import { applyUpdateProgress, compareVersions, createUpdateProgressState, updatePanelModel, type UpdateProgressState } from '@ephemeral-ai/mayfly/command-panels'
import { DECISION_NO, DECISION_YES, decisionStrip } from '@ephemeral-ai/mayfly-ui'
import type { BundleInfo, ChangeResult } from '../../client/remote-face.ts'
import { RemoteFeatureController, remoteErrorMessage, remoteValue, type RemoteFeatureOperation } from '../features/official.ts'
import { remoteClientVersion } from '../features/version.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'
import { LocalFrontendUpdater, type LocalUpdateSnapshot, type PendingLocalUpdate } from './local-update.ts'

const HOST = '@ephemeral-ai/mayfly-host'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const zh = {
  'Safely update Mayfly (preflight, snapshot, smoke, auto-rollback)': '安全升级 Mayfly（预检、快照、启动检查、自动回滚）',
  'No Host is attached': '未连接 Host',
  'an update is already in progress': '已有升级正在进行',
  'cannot update while the agent is running': 'Agent 运行时无法升级',
  'No matching Mayfly release is published for this channel': '该通道尚未发布匹配的 Mayfly 版本',
  'The Host profile is linked or read-only; update it with its original installer': 'Host profile 是链接或只读安装；请使用原安装方式升级',
  'Host and TUI versions differ; repair the release set before updating': 'Host 与 TUI 版本不一致；升级前请修复发布集',
  'A previous update was interrupted; run /update recover to restore both installations before retrying.': '上一次升级被中断；重试前请运行 /update recover 恢复两端安装。',
  'The interrupted update belongs to a different Host; attach that Host before recovery.': '被中断的升级属于另一个 Host；恢复前请连接该 Host。',
  'No interrupted update needs recovery': '没有需要恢复的中断升级',
  'Restore to v{version}?': '恢复到 v{version}？',
  'Recovered Host and TUI to v{version}. Restart both to apply.': 'Host 与 TUI 已恢复到 v{version}；重启两者后生效。',
  'The update requires an exact release version': '升级需要精确发布版本',
  'The Host release changed during preparation; retry explicitly': '准备期间 Host 版本已变化；请明确重试',
  'The update is still running': '升级仍在进行',
  'update cancelled': '已取消升级',
  'up to date (v{version})': '已是最新版本（v{version}）',
  'Update to v{version}?': '升级到 v{version}？',
  'The frontend update is kept only after a successful startup check.': '只有通过前端启动检查才保留升级。',
  'Host startup verification requires restarting the Host; the official API provides no isolated boot check.': 'Host 启动验证需要重启 Host；官方 API 没有独立启动检查。',
  'Yes': '是', 'No': '否',
  'Update Mayfly': '升级 Mayfly', 'snapshot': '快照', 'install': '安装', 'verify versions': '验证版本',
  'smoke: imports': '检查：导入', 'smoke: boot': '检查：启动', 'rollback': '回滚',
  'Complete': '完成', 'Failed': '失败', 'Blocked': '已阻止', 'nothing was changed': '没有修改任何内容', 'log: {path}': '日志：{path}',
  'Updated Host and TUI to v{version}. Restart both to apply.': 'Host 与 TUI 已升级到 v{version}；重启两者后生效。',
  'Frontend import and startup checks passed. The official Host API has no isolated boot-check operation; Host startup remains unverified until restart.': '前端导入和启动检查已通过。官方 Host API 没有独立启动检查操作；Host 启动须在重启后验证。',
  'update failed — both installations restored': '升级失败——两端安装均已恢复',
  'update failed — recovery is incomplete; use the repair commands below': '升级失败——恢复未完成；请使用下面的修复命令',
} as const

function succeeded(result: ChangeResult): boolean {
  return result.application !== 'failed' && result.application !== 'cancelled'
}

/** App-wide single-flight controller; a cancelled view never retargets a running upgrade. */
export class RemoteUpdateController extends RemoteFeatureController<RemoteOperationsContext['base']> {
  private readonly t
  private panel: RemoteBrowserPanel | undefined
  private running = false
  private activeOperation: RemoteFeatureOperation | undefined

  constructor(private readonly options: RemoteOperationsContext, private readonly local = new LocalFrontendUpdater()) {
    super(options.base)
    registerRemoteOperationsLocale(options.base, 'remote-update', zh)
    this.t = memoizedLocaleTranslator(options.base.ctx, 'remote-update').translate
  }

  override dispose(): void {
    super.dispose()
    this.panel?.close()
  }

  readonly execute = async (requested: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    if (this.running) { this.options.base.notice.set(this.t('an update is already in progress')); return }
    const client = this.options.base.hosts.current()?.client ?? this.options.base.hosts.active?.()
    if (client === undefined) { this.options.base.notice.set(this.t('No Host is attached')); return }
    const operation = this.hostOperation(client, signal)
    if (operation === undefined) return
    this.running = true
    let snapshot: LocalUpdateSnapshot | undefined
    try {
      if (this.busy()) throw new Error(this.t('cannot update while the agent is running'))
      const bundles = await remoteValue(client.remote.pluginManager.listBundles())
      if (!operation.valid()) return
      const bundle = bundles.find(row => row.name === HOST && row.installed)
      const current = remoteClientVersion()
      if (bundle !== undefined && (bundle.updatable || requested.trim() === 'recover')) {
        const pending = await this.local.pending(operation.signal)
        if (!operation.valid()) return
        if (pending !== undefined) {
          snapshot = pending.snapshot
          if (pending.host !== client.key) throw new Error(this.t('The interrupted update belongs to a different Host; attach that Host before recovery.'))
          if (requested.trim() !== 'recover') {
            this.blocked(operation, current, snapshot.target, `${this.t('A previous update was interrupted; run /update recover to restore both installations before retrying.')}\n${snapshot.logPath}`)
            return
          }
          if (await this.confirm(operation, current, snapshot.current, true) && operation.valid()) await this.recover(operation, pending)
          return
        }
      }
      if (requested.trim() === 'recover') { this.options.base.notice.set(this.t('No interrupted update needs recovery')); return }
      if (bundle?.version !== current) throw new Error(this.t('Host and TUI versions differ; repair the release set before updating'))
      const targetInput = requested.trim()
      if (targetInput !== '' && !VERSION.test(targetInput)) throw new Error(this.t('The update requires an exact release version'))
      if (bundle.updatable !== true) {
        this.blocked(operation, current, targetInput || current, this.t('The Host profile is linked or read-only; update it with its original installer'))
        return
      }
      const versions = await remoteValue(client.remote.pluginManager.listVersions(HOST))
      if (!operation.valid()) return
      if (versions.status !== 'listed') throw new Error(versions.reason)
      const channel = currentMayflySettings(this.options.base.ctx).updateChannel || 'latest'
      const release = targetInput === '' ? versions.versions.find(row => row.tags.includes(channel)) : versions.versions.find(row => row.version === targetInput) ?? { version: targetInput, bundle: true, incompatible: undefined }
      if (release?.version === current) { this.options.base.notice.set(this.t('up to date (v{version})', { version: current })); return }
      if (release === undefined) {
        if (targetInput === '' && versions.versions.length === 0) this.options.base.notice.set(this.t('up to date (v{version})', { version: current }))
        else throw new Error(this.t('No matching Mayfly release is published for this channel'))
        return
      }
      if (!release.bundle || release.incompatible !== undefined) throw new Error('The selected release is not a compatible Host bundle')
      try { snapshot = await this.local.preflight(current, release.version, operation.signal) }
      catch (error) {
        if (operation.valid()) this.blocked(operation, current, release.version, remoteErrorMessage(error))
        return
      }
      if (!operation.valid()) return
      const confirmed = await this.confirm(operation, current, release.version)
      if (!operation.valid()) return
      if (!confirmed) { this.options.base.notice.set(this.t('update cancelled')); return }
      await this.perform(operation, bundle, snapshot, versions.registry)
    } catch (error) {
      if (operation.valid()) this.options.base.notice.set(remoteErrorMessage(error))
    } finally {
      if (snapshot !== undefined) await this.local.cleanup(snapshot).catch(() => {})
      if (this.activeOperation !== operation) operation.dispose()
      this.running = false
    }
  }

  private busy(): boolean {
    return this.options.base.hosts.current()?.binding.session.getSnapshot().running === true
  }

  private blocked(operation: RemoteFeatureOperation, from: string, target: string, message: string): void {
    const state = createUpdateProgressState()
    state.blockedMessage = message
    this.progressPanel(operation, state, from, target, () => false)
  }

  private confirm(operation: RemoteFeatureOperation, from: string, to: string, recovery = false): Promise<boolean> {
    return new Promise(resolveConfirm => {
      let settled = false
      const finish = (confirmed: boolean): void => {
        if (settled) return
        settled = true
        resolveConfirm(confirmed)
      }
      this.panel?.close()
      const panel = openRemoteBrowser(this.options.base, {
        id: 'mayfly.update.confirm', scope: { kind: 'app', targetId: 'mayfly.update.confirm' },
        isCurrent: () => operation.valid(), signal: operation.signal,
        view: () => decisionStrip({ title: this.t(recovery ? 'Restore to v{version}?' : 'Update to v{version}?', { version: to }), detail: [`v${from} → v${to}`, this.t('The frontend update is kept only after a successful startup check.'), this.t('Host startup verification requires restarting the Host; the official API provides no isolated boot check.')].join(' · '), yesLabel: this.t('Yes'), noLabel: this.t('No'), actionsId: 'update-confirm-actions' }),
        action: event => {
          if (event.kind === 'activate' && (event.actionId === DECISION_YES || event.actionId === DECISION_NO)) {
            finish(event.actionId === DECISION_YES)
            return { kind: 'completed', dismiss: true }
          }
          return { kind: 'completed' }
        },
        onClosed: () => { finish(false) },
      })
      this.panel = panel
      operation.onDispose(() => { panel.close(); finish(false) })
      if (panel.closed) finish(false)
    })
  }

  private progressPanel(operation: RemoteFeatureOperation, state: UpdateProgressState, from: string, target: string, inFlight: () => boolean): RemoteBrowserPanel {
    this.panel?.close()
    const panel = openRemoteBrowser(this.options.base, {
      id: state.blockedMessage === undefined ? 'mayfly.update.progress' : 'mayfly.update.blocked',
      scope: { kind: 'app', targetId: 'mayfly.update' }, isCurrent: () => operation.valid(),
      view: () => updatePanelModel(state, from, target, this.t),
      onClosed: () => {
        if (this.activeOperation === operation) { this.activeOperation = undefined; operation.dispose() }
      },
      back: () => {
        if (!inFlight()) return false
        this.options.base.notice.set(this.t('The update is still running'))
        return true
      },
    })
    this.panel = panel
    this.activeOperation = operation
    operation.onDispose(() => { panel.close() })
    return panel
  }

  private async recover(operation: RemoteFeatureOperation, pending: PendingLocalUpdate): Promise<void> {
    const { snapshot } = pending
    const state = createUpdateProgressState()
    let running = true
    const panel = this.progressPanel(operation, state, snapshot.target, snapshot.current, () => running)
    let restored = true
    try {
      applyUpdateProgress(state, { step: 'rollback', state: 'start' })
      panel.refresh()
      try {
        const result = await remoteValue(operation.client.remote.pluginManager.installBundle(`${HOST}@${snapshot.current}`, { enabled: pending.enabled, saveExact: true }))
        if (!succeeded(result)) restored = false
        else if ((await remoteValue(operation.client.remote.pluginManager.listBundles())).find(row => row.name === HOST)?.version !== snapshot.current) restored = false
      } catch { restored = false }
      try { await this.local.restore(snapshot) } catch { restored = false }
      if (restored) { try { await this.local.finish(snapshot) } catch { restored = false } }
      applyUpdateProgress(state, { step: 'rollback', state: restored ? 'ok' : 'fail' })
      state.outcome = {
        kind: restored ? 'success' : 'rollback-incomplete', fromVersion: snapshot.target, toVersion: snapshot.current, logPath: snapshot.logPath,
        message: restored ? this.t('Recovered Host and TUI to v{version}. Restart both to apply.', { version: snapshot.current }) : `${this.t('update failed — recovery is incomplete; use the repair commands below')}\n${this.repair(snapshot)}`,
      }
    } finally { running = false; if (operation.valid()) panel.refresh() }
  }

  private repair(snapshot: LocalUpdateSnapshot): string {
    return `npm install --global --ignore-scripts @ephemeral-ai/mayfly-cli@${snapshot.current}\nHost: install @ephemeral-ai/mayfly-host@${snapshot.current} with the original profile installer`
  }

  private async perform(operation: RemoteFeatureOperation, bundle: BundleInfo, snapshot: LocalUpdateSnapshot, registry: string | null): Promise<void> {
    const state = createUpdateProgressState()
    let inFlight = true
    const panel = this.progressPanel(operation, state, snapshot.current, snapshot.target, () => inFlight)
    const progress = (step: Parameters<typeof applyUpdateProgress>[1]['step'], value: 'start' | 'ok' | 'fail'): void => {
      applyUpdateProgress(state, { step, state: value })
      if (operation.valid()) panel.refresh()
    }
    let frontendTouched = false
    let hostTouched = false
    try {
      progress('snapshot', 'start')
      await this.local.stage(snapshot, operation.signal)
      if (!operation.valid()) return
      progress('snapshot', 'ok')
      progress('smoke-imports', 'ok')
      const before = await remoteValue(operation.client.remote.pluginManager.listBundles())
      if (!operation.valid()) return
      if (before.find(row => row.name === HOST)?.version !== snapshot.current) throw new Error(this.t('The Host release changed during preparation; retry explicitly'))
      if (this.busy()) throw new Error(this.t('cannot update while the agent is running'))
      await this.local.begin(snapshot, operation.client.key, bundle.enabled)
      if (!operation.valid()) { await this.local.finish(snapshot); return }
      progress('install', 'start')
      frontendTouched = true
      // After mutation starts, finish or compensate independently of UI cancellation.
      await this.local.install(snapshot)
      hostTouched = true
      let result: ChangeResult
      if (compareVersions(snapshot.target, snapshot.current) > 0) {
        result = (await remoteValue(operation.client.remote.pluginManager.updateBundle(HOST, snapshot.target, { registry }))).result
      } else {
        result = await remoteValue(operation.client.remote.pluginManager.installBundle(`${HOST}@${snapshot.target}`, { registry, enabled: bundle.enabled, saveExact: true }))
      }
      if (!succeeded(result)) {
        throw new Error(result.error?.diagnostic ?? 'Native Host update failed')
      }
      progress('install', 'ok')
      progress('verify', 'start')
      const after = await remoteValue(operation.client.remote.pluginManager.listBundles())
      if (after.find(row => row.name === HOST)?.version !== snapshot.target) throw new Error('The Host installed version does not match the target')
      progress('verify', 'ok')
      await this.local.finish(snapshot)
      state.outcome = {
        kind: 'success', fromVersion: snapshot.current, toVersion: snapshot.target, logPath: snapshot.logPath,
        message: `${this.t('Updated Host and TUI to v{version}. Restart both to apply.', { version: snapshot.target })}\n${this.t('Frontend import and startup checks passed. The official Host API has no isolated boot-check operation; Host startup remains unverified until restart.')}`,
      }
    } catch (error) {
      let restored = true
      if (frontendTouched) {
        progress('rollback', 'start')
        if (hostTouched) {
          try {
            const result = await remoteValue(operation.client.remote.pluginManager.installBundle(`${HOST}@${snapshot.current}`, { enabled: bundle.enabled, saveExact: true }))
            if (!succeeded(result)) restored = false
            else if ((await remoteValue(operation.client.remote.pluginManager.listBundles())).find(row => row.name === HOST)?.version !== snapshot.current) restored = false
          } catch { restored = false }
        }
        try { await this.local.restore(snapshot) } catch { restored = false }
        if (restored) { try { await this.local.finish(snapshot) } catch { restored = false } }
        progress('rollback', restored ? 'ok' : 'fail')
      }
      state.outcome = {
        kind: frontendTouched ? restored ? 'rolled-back' : 'rollback-incomplete' : 'failed-no-rollback',
        fromVersion: snapshot.current, toVersion: snapshot.target, logPath: snapshot.logPath,
        message: `${remoteErrorMessage(error)}\n${!frontendTouched ? this.t('nothing was changed') : this.t(restored ? 'update failed — both installations restored' : 'update failed — recovery is incomplete; use the repair commands below')}${restored ? '' : `\n${this.repair(snapshot)}`}`,
      }
    } finally {
      inFlight = false
      if (operation.valid()) panel.refresh()
    }
  }
}

/** Mount `/update` as the app-wide explicit upgrade, including sessionless use. */
export function mountRemoteUpdate(context: RemoteOperationsContext): () => void {
  const controller = new RemoteUpdateController(context)
  const unregister = context.base.commands.register({ name: 'update', scope: 'sessionless', input: { hint: '[<version>|recover]' }, description: 'Safely update Mayfly (preflight, snapshot, smoke, auto-rollback)', execute: controller.execute })
  return () => { unregister(); controller.dispose() }
}
