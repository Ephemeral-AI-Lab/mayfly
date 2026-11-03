/** Explicit Host plus frontend upgrade, using native Host transactions and frontend-local staging.
 * @module remote/operations/update
 */
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { setTimeout as delay } from 'node:timers/promises'
import { currentMayflySettings } from '@ephemeral-ai/mayfly/settings'
import { applyUpdateProgress, compareVersions, createUpdateProgressState, updatePanelModel, type UpdateProgressState } from '@ephemeral-ai/mayfly/command-panels'
import { DECISION_NO, DECISION_YES, decisionStrip } from '@ephemeral-ai/mayfly-ui'
import type { BundleInfo, ChangeResult } from '../../client/remote-face.ts'
import { RemoteFeatureController, remoteErrorMessage, remoteValue, type RemoteFeatureOperation } from '../features/official.ts'
import { remoteClientVersion } from '../features/version.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'
import { LocalFrontendUpdater, type LocalUpdateReleases, type LocalUpdateSnapshot, type PendingLocalUpdate } from './local-update.ts'

const HOST = '@ephemeral-ai/mayfly-host'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const VERSION_FLOOR = '0.1.0-alpha.1'
const REGISTRY_RETRY_DELAYS = [1_500, 4_000] as const
const zh = {
  'Safely update Mayfly (preflight, snapshot, smoke, auto-rollback)': '安全升级 Mayfly（预检、快照、启动检查、自动回滚）',
  'No Host is attached': '未连接 Host',
  'an update is already in progress': '已有升级正在进行',
  'the agent is running — wait for the current turn to finish before updating': 'Agent 正在运行——请等待当前轮次结束后再升级',
  'checking the registry for {package} updates…': '正在查询 {package} 的注册表更新…',
  'registry unreachable, retrying ({attempt}/{total})…': '注册表不可达，正在重试（{attempt}/{total}）…',
  '"{version}" is not a version (try /update 0.1.0-alpha.1)': '“{version}”不是版本号（可尝试 /update 0.1.0-alpha.1）',
  'the registry carries no "{channel}" tag for @ephemeral-ai/mayfly — pick a version with /update <version>': '注册表中 @ephemeral-ai/mayfly 没有“{channel}”标签——请用 /update <version> 指定版本',
  'the "{channel}" tag points at "{version}", which does not parse as a version': '“{channel}”标签指向“{version}”，它不是可解析的版本号',
  'version {version} is not published under @ephemeral-ai/mayfly (registry knows: {versions})': '@ephemeral-ai/mayfly 尚未发布版本 {version}（注册表已有：{versions}）',
  "version {version} predates Mayfly's first release; pick >= {floor}": '版本 {version} 早于 Mayfly 首个发布版本；请选择 >= {floor}',
  'The Host profile is linked or read-only; update it with its original installer': 'Host profile 是链接或只读安装；请使用原安装方式升级',
  'Host and TUI versions differ; repair the release set before updating': 'Host 与 TUI 版本不一致；升级前请修复发布集',
  'A previous update was interrupted; run /update recover to restore both installations before retrying.': '上一次升级被中断；重试前请运行 /update recover 恢复两端安装。',
  'The interrupted update belongs to a different Host; attach that Host before recovery.': '被中断的升级属于另一个 Host；恢复前请连接该 Host。',
  'No interrupted update needs recovery': '没有需要恢复的中断升级',
  'Restore to v{version}?': '恢复到 v{version}？',
  'Recovered Host and TUI to v{version}. Restart both to apply.': 'Host 与 TUI 已恢复到 v{version}；重启两者后生效。',
  'The Host release changed during preparation; retry explicitly': '准备期间 Host 版本已变化；请明确重试',
  'The update is still running': '升级仍在进行',
  'update cancelled': '已取消升级',
  'up to date (v{version}; {channel} tag: {target})': '已是最新版本（v{version}；{channel} 标签：{target}）',
  'Update to v{version}?': '升级到 v{version}？',
  'The frontend update is kept only after a successful startup check.': '只有通过前端启动检查才保留升级。',
  'Host startup verification requires restarting the Host; the official API provides no isolated boot check.': 'Host 启动验证需要重启 Host；官方 API 没有独立启动检查。',
  'The Host enforces its release-age policy during installation; its cooldown setting is not exposed.': 'Host 在安装时执行其发布等待策略；API 未提供其等待时长设置。',
  'warning: publish time unknown — cooldown cannot be forecast': '警告：发布时间未知——无法预估发布等待窗口',
  'warning: v{version} is older than the installed v{installed} — a downgrade reinstalls @ephemeral-ai/mayfly at the older version': '警告：v{version} 早于已安装的 v{installed}——降级会以较旧版本重新安装 @ephemeral-ai/mayfly',
  'Yes': '是', 'No': '否',
  'Update Mayfly': '升级 Mayfly', 'snapshot': '快照', 'install': '安装', 'verify versions': '验证版本',
  'smoke: imports': '检查：导入', 'smoke: boot': '检查：启动', 'rollback': '回滚',
  'Complete': '完成', 'Failed': '失败', 'Blocked': '已阻止', 'nothing was changed': '没有修改任何内容', 'log: {path}': '日志：{path}',
  'Updated Host and TUI to v{version}. Restart both to apply.': 'Host 与 TUI 已升级到 v{version}；重启两者后生效。',
  'Frontend import and startup checks passed. The official Host API has no isolated boot-check operation; Host startup remains unverified until restart.': '前端导入和启动检查已通过。官方 Host API 没有独立启动检查操作；Host 启动须在重启后验证。',
  'update failed — both installations restored': '升级失败——两端安装均已恢复',
  'update failed — recovery is incomplete; use the repair commands below': '升级失败——恢复未完成；请使用下面的修复命令',
  'update failed — rolled back to v{version}': '升级失败——已回滚到 v{version}',
  'update failed — the repair recipe is in the update panel': '升级失败——修复步骤位于升级面板中',
  'Host restoration failed: {message}': 'Host 恢复失败：{message}',
  'Frontend restoration failed: {message}': '前端恢复失败：{message}',
  'Recovery marker cleanup failed: {message}': '恢复标记清理失败：{message}',
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
  private readonly notifications

  constructor(private readonly options: RemoteOperationsContext, private readonly local = new LocalFrontendUpdater()) {
    super(options.base)
    registerRemoteOperationsLocale(options.base, 'remote-update', zh)
    this.t = memoizedLocaleTranslator(options.base.ctx, 'remote-update').translate
    this.notifications = options.base.ctx.mayflyUiInteraction.createNotificationOwner('mayfly.remote.update')
  }

  override dispose(): void {
    super.dispose()
    this.panel?.close()
    this.notifications.dispose()
  }

  readonly execute = async (requested: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    if (this.running) { this.options.base.notice.set(this.t('an update is already in progress'), 'error'); return }
    const client = this.options.base.hosts.current()?.client ?? this.options.base.hosts.active?.()
    if (client === undefined) { this.options.base.notice.set(this.t('No Host is attached'), 'error'); return }
    const operation = this.hostOperation(client, signal)
    if (operation === undefined) return
    this.running = true
    let snapshot: LocalUpdateSnapshot | undefined
    try {
      if (this.busy()) throw new Error(this.t('the agent is running — wait for the current turn to finish before updating'))
      const bundles = await remoteValue(client.remote.pluginManager.listBundles())
      if (!operation.valid()) return
      const bundle = bundles.find(row => row.name === HOST && row.installed)
      const current = remoteClientVersion()
      if (bundle?.updatable === true || requested.trim() === 'recover') {
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
      if (requested.trim() === 'recover') { this.options.base.notice.set(this.t('No interrupted update needs recovery'), 'info'); return }
      if (bundle?.version !== current) throw new Error(this.t('Host and TUI versions differ; repair the release set before updating'))
      const targetInput = requested.trim()
      if (targetInput !== '' && !VERSION.test(targetInput)) throw new Error(this.t('"{version}" is not a version (try /update 0.1.0-alpha.1)', { version: targetInput }))
      if (bundle.updatable !== true) {
        this.blocked(operation, current, targetInput || current, this.t('The Host profile is linked or read-only; update it with its original installer'))
        return
      }
      const catalog = await this.releaseCatalog(operation)
      if (!operation.valid()) return
      const channel = currentMayflySettings(this.options.base.ctx).updateChannel || 'latest'
      const target = targetInput || catalog.tags[channel]
      if (target === undefined) throw new Error(this.t('the registry carries no "{channel}" tag for @ephemeral-ai/mayfly — pick a version with /update <version>', { channel }))
      if (!VERSION.test(target)) throw new Error(this.t('the "{channel}" tag points at "{version}", which does not parse as a version', { channel, version: target }))
      if (targetInput === '' && compareVersions(target, current) <= 0) {
        this.options.base.notice.set(this.t('up to date (v{version}; {channel} tag: {target})', { version: current, channel, target }), 'info')
        return
      }
      if (!catalog.versions.includes(target)) {
        this.blocked(operation, current, target, this.t('version {version} is not published under @ephemeral-ai/mayfly (registry knows: {versions})', { version: target, versions: catalog.versions.join(', ') }))
        return
      }
      if (compareVersions(target, VERSION_FLOOR) < 0) {
        this.blocked(operation, current, target, this.t("version {version} predates Mayfly's first release; pick >= {floor}", { version: target, floor: VERSION_FLOOR }))
        return
      }
      const versions = await remoteValue(client.remote.pluginManager.listVersions(HOST, undefined, operation.signal))
      if (!operation.valid()) return
      if (versions.status !== 'listed') throw new Error(versions.reason)
      const release = versions.versions.find(row => row.version === target)
      if (release !== undefined && (!release.bundle || release.incompatible !== undefined)) throw new Error('The selected release is not a compatible Host bundle')
      try { snapshot = await this.local.preflight(current, target, operation.signal) }
      catch (error) {
        if (operation.valid()) this.blocked(operation, current, target, remoteErrorMessage(error))
        return
      }
      if (!operation.valid()) return
      const publishedAt = release?.publishedAt ?? catalog.time[target]
      const confirmed = await this.confirm(operation, current, target, false, publishedAt)
      if (!operation.valid()) return
      if (!confirmed) { this.options.base.notice.set(this.t('update cancelled'), 'info'); return }
      await this.perform(operation, bundle, snapshot, versions.registry)
    } catch (error) {
      if (operation.valid()) this.options.base.notice.set(remoteErrorMessage(error), 'error')
    } finally {
      if (snapshot !== undefined) await this.local.cleanup(snapshot).catch(() => {})
      if (this.activeOperation !== operation) operation.dispose()
      this.running = false
    }
  }

  private async releaseCatalog(operation: RemoteFeatureOperation): Promise<LocalUpdateReleases> {
    const scope = { kind: 'app', targetId: `profile/${operation.client.key}` } as const
    operation.onDispose(() => { this.notifications.clear('registry') })
    this.notifications.report('registry', scope, { message: this.t('checking the registry for {package} updates…', { package: '@ephemeral-ai/mayfly' }), severity: 'info', purpose: 'progress' }, 'registry')
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (attempt > 0) {
          this.notifications.report('registry', scope, { message: this.t('registry unreachable, retrying ({attempt}/{total})…', { attempt: attempt + 1, total: REGISTRY_RETRY_DELAYS.length + 1 }), severity: 'warning', purpose: 'progress' }, 'registry')
          await delay(REGISTRY_RETRY_DELAYS[attempt - 1]!, undefined, { signal: operation.signal })
        }
        try { return await this.local.releases(operation.signal) }
        catch (error) {
          if (!operation.valid() || attempt === REGISTRY_RETRY_DELAYS.length) throw error
        }
      }
    } finally { this.notifications.clear('registry') }
  }

  private busy(): boolean {
    return this.options.base.hosts.current()?.binding.session.getSnapshot().running === true
  }

  private blocked(operation: RemoteFeatureOperation, from: string, target: string, message: string): void {
    const state = createUpdateProgressState()
    state.blockedMessage = message
    this.progressPanel(operation, state, from, target, () => false)
  }

  private confirm(operation: RemoteFeatureOperation, from: string, to: string, recovery = false, publishedAt?: string): Promise<boolean> {
    const published = Date.parse(publishedAt ?? '')
    const hours = Math.max(0, Math.round((Date.now() - published) / 3_600_000))
    const detail = [
      `v${from} → v${to}`,
      Number.isNaN(published) ? this.t('warning: publish time unknown — cooldown cannot be forecast') : hours >= 48 ? `published ${Math.round(hours / 24)}d ago` : `published ${hours}h ago`,
      ...compareVersions(to, from) < 0 ? [this.t('warning: v{version} is older than the installed v{installed} — a downgrade reinstalls @ephemeral-ai/mayfly at the older version', { version: to, installed: from })] : [],
      this.t('The frontend update is kept only after a successful startup check.'),
      this.t('Host startup verification requires restarting the Host; the official API provides no isolated boot check.'),
      this.t('The Host enforces its release-age policy during installation; its cooldown setting is not exposed.'),
    ].join(' · ')
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
        view: () => decisionStrip({ title: this.t(recovery ? 'Restore to v{version}?' : 'Update to v{version}?', { version: to }), detail, yesLabel: this.t('Yes'), noLabel: this.t('No'), actionsId: 'update-confirm-actions' }),
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
        this.options.base.notice.set(this.t('The update is still running'), 'error')
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
    const failures: string[] = []
    try {
      applyUpdateProgress(state, { step: 'rollback', state: 'start' })
      panel.refresh()
      try {
        await this.installExactHost(operation, snapshot, snapshot.current, pending.enabled)
      } catch (error) { restored = false; failures.push(this.t('Host restoration failed: {message}', { message: remoteErrorMessage(error) })) }
      try { await this.local.restore(snapshot) } catch (error) { restored = false; failures.push(this.t('Frontend restoration failed: {message}', { message: remoteErrorMessage(error) })) }
      if (restored) { try { await this.local.finish(snapshot) } catch (error) { restored = false; failures.push(this.t('Recovery marker cleanup failed: {message}', { message: remoteErrorMessage(error) })) } }
      applyUpdateProgress(state, { step: 'rollback', state: restored ? 'ok' : 'fail' })
      state.outcome = {
        kind: restored ? 'success' : 'rollback-incomplete', fromVersion: snapshot.target, toVersion: snapshot.current, logPath: snapshot.logPath,
        message: restored ? this.t('Recovered Host and TUI to v{version}. Restart both to apply.', { version: snapshot.current }) : `${this.t('update failed — recovery is incomplete; use the repair commands below')}\n${failures.join('\n')}\n${this.repair(snapshot)}`,
      }
    } finally { running = false; if (operation.valid()) panel.refresh() }
  }

  private repair(snapshot: LocalUpdateSnapshot): string {
    return `npm install --global --ignore-scripts @ephemeral-ai/mayfly-cli@${snapshot.current}\nHost: install @ephemeral-ai/mayfly-host@${snapshot.current} with the original profile installer`
  }

  private async installExactHost(operation: RemoteFeatureOperation, snapshot: LocalUpdateSnapshot, version: string, enabled: boolean, registry?: string | null): Promise<void> {
    const manager = operation.client.remote.pluginManager
    const read = async (): Promise<BundleInfo | undefined> => (await remoteValue(manager.listBundles())).find(row => row.name === HOST && row.installed)
    const before = await read()
    if (before !== undefined && before.version !== snapshot.current && before.version !== snapshot.target) {
      throw new Error('The Host release changed outside this update; refusing to replace it')
    }
    // Native updateBundle may already have restored the previous exact release.
    if (before?.version === version && before.enabled === enabled) return
    const requireChange = (result: ChangeResult, step: string): void => {
      if (!succeeded(result)) throw new Error(`${step}: ${result.error?.diagnostic ?? result.error?.code ?? result.application}`)
    }
    if (before?.version === version) {
      requireChange(await remoteValue(manager.setBundleEnabled(HOST, enabled)), 'Host enablement failed')
    } else {
      const options = { enabled, saveExact: true, ...registry === undefined ? {} : { registry } }
      const install = (): Promise<ChangeResult> => remoteValue(manager.installBundle(`${HOST}@${version}`, options))
      let result = await install()
      // Startup-only profiles allow replacement. HMR profiles first require the
      // installed bundle to stop and leave the profile through removeBundle.
      if (result.application === 'failed' && result.error?.code === 'already-installed') {
        const current = await read()
        if (before === undefined || current === undefined || current.version !== before.version || current.enabled !== before.enabled) {
          throw new Error('The Host release changed before removal; refusing to replace it')
        }
        requireChange(await remoteValue(manager.removeBundle(HOST)), 'Host removal failed')
        if (await read() !== undefined) throw new Error('Host removal did not release the installed bundle')
        result = await install()
      }
      requireChange(result, 'Host installation failed')
    }
    const after = await read()
    if (after?.version !== version || after.enabled !== enabled) throw new Error('The restored Host version or enablement does not match the transaction')
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
      if (this.busy()) throw new Error(this.t('the agent is running — wait for the current turn to finish before updating'))
      await this.local.begin(snapshot, operation.client.key, bundle.enabled)
      if (!operation.valid()) { await this.local.finish(snapshot); return }
      progress('install', 'start')
      frontendTouched = true
      // After mutation starts, finish or compensate independently of UI cancellation.
      await this.local.install(snapshot)
      hostTouched = true
      if (compareVersions(snapshot.target, snapshot.current) > 0) {
        const result = (await remoteValue(operation.client.remote.pluginManager.updateBundle(HOST, snapshot.target, { registry }))).result
        if (!succeeded(result)) throw new Error(result.error?.diagnostic ?? 'Native Host update failed')
      } else {
        await this.installExactHost(operation, snapshot, snapshot.target, bundle.enabled, registry)
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
      const failures: string[] = []
      if (frontendTouched) {
        progress('rollback', 'start')
        if (hostTouched) {
          try {
            await this.installExactHost(operation, snapshot, snapshot.current, bundle.enabled)
          } catch (restoreError) { restored = false; failures.push(this.t('Host restoration failed: {message}', { message: remoteErrorMessage(restoreError) })) }
        }
        try { await this.local.restore(snapshot) } catch (restoreError) { restored = false; failures.push(this.t('Frontend restoration failed: {message}', { message: remoteErrorMessage(restoreError) })) }
        if (restored) { try { await this.local.finish(snapshot) } catch (restoreError) { restored = false; failures.push(this.t('Recovery marker cleanup failed: {message}', { message: remoteErrorMessage(restoreError) })) } }
        progress('rollback', restored ? 'ok' : 'fail')
      }
      state.outcome = {
        kind: frontendTouched ? restored ? 'rolled-back' : 'rollback-incomplete' : 'failed-no-rollback',
        fromVersion: snapshot.current, toVersion: snapshot.target, logPath: snapshot.logPath,
        message: `${remoteErrorMessage(error)}\n${!frontendTouched ? this.t('nothing was changed') : this.t(restored ? 'update failed — both installations restored' : 'update failed — recovery is incomplete; use the repair commands below')}${restored ? '' : `\n${failures.join('\n')}\n${this.repair(snapshot)}`}`,
      }
    } finally {
      inFlight = false
      if (operation.valid()) {
        panel.refresh()
        const outcome = state.outcome!
        this.options.base.notice.set(outcome.kind === 'success'
          ? this.t('Updated Host and TUI to v{version}. Restart both to apply.', { version: snapshot.target })
          : outcome.kind === 'rolled-back'
            ? this.t('update failed — rolled back to v{version}', { version: snapshot.current })
            : this.t('update failed — the repair recipe is in the update panel'), outcome.kind === 'success' ? 'info' : 'error')
      }
    }
  }
}

/** Mount `/update` as the app-wide explicit upgrade, including sessionless use. */
export function mountRemoteUpdate(context: RemoteOperationsContext): () => void {
  const controller = new RemoteUpdateController(context)
  const unregister = context.base.commands.register({ name: 'update', scope: 'sessionless', input: { hint: '[<version>|recover]' }, description: 'Safely update Mayfly (preflight, snapshot, smoke, auto-rollback)', execute: controller.execute })
  return () => { unregister(); controller.dispose() }
}
