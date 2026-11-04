/**
 * The rc.2 marketplace UI driven by the selected official Host plugin manager.
 * Host writes are explicit and never replayed after a lost response.
 * @module @ephemeral-ai/mayfly/remote/operations/plugin-marketplace
 */

import type { MayflyStatusRegistration, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext, MayflyUiNode, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { currentMayflySettings } from '@ephemeral-ai/mayfly/settings'
import {
  DEFAULT_MARKET_INDEX_URL, loadMarketCatalog, buildRows, defaultInstallSource, entrySupportsSource,
  GROUP_MODES, groupRows, MARKET_TABS, marketEntryInstallBlock, isMayflyProductPackage, newerVersion, rowName, rowSpec, tabRows,
  usefulInTui, detailFacts, groupModeLabel, tabFacts, listId, MARKET_BREAKPOINT,
  PluginMarketplace, PluginMarketplaceLoading, PluginMarketplaceOffline, PluginMarketplaceUnavailable,
  interactionTranslator, mountInteractionLocale, observeInteractionLocale,
  type CatalogResult, type GroupMode, type InstallSource, type MarketRow, type MarketTab, type FactsEnv,
  type MarketEntry, type MarketInstallRow,
} from '@ephemeral-ai/mayfly/plugin-marketplace'
import type { BundleInfo, ChangeResult, ManagementError, ClientPluginManager } from '../../client/remote-face.ts'
import type { HostClient } from '../../client/types.ts'
import { remoteValue } from '../features/official.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { RemoteOperationsContext } from './support.ts'

interface MarketplaceController {
  execute(rawInput: string, signal: AbortSignal): Promise<CommandOutcome>
  dispose(): void
}

/** Command outcome reused by every early-exit branch. */
type CommandOutcome = { readonly kind: 'success', readonly text?: string } | { readonly kind: 'error', readonly text: string }

/** One operation message shown either in the panel or the prompt editor. */
interface OperationStatus {
  readonly text: string
  readonly tone: 'muted' | 'warning' | 'success' | 'danger'
}

type OperationReporter = (status: OperationStatus) => void

/** The keyed operations of a row. */
type RowAction = 'install' | 'update' | 'remove'

const HOUR_MS = 3_600_000

/** A failure kept to one short line: the head says what failed, the tail how the profile was left. */
function shorten(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > 150 ? `${flat.slice(0, 110)}… ${flat.slice(-30)}` : flat
}

/** The manager's refusal in words. Its diagnostic is shown verbatim when it has one. */
function managementText(error: ManagementError | undefined): string {
  if (error === undefined) return 'the native plugin manager refused the change'
  switch (error.code) {
    case 'incompatible-version':
      return `incompatible with this DSH: ${(error.incompatible ?? []).map(item => `${item.name}@${item.version}`).join(', ')}`
    case 'management-required': return 'the plugin manager protects this bundle'
    case 'unaddressable': return 'the plugin manager cannot address this bundle'
    case 'not-removable': return 'this bundle is not removable'
    case 'not-bundle': return 'this package declares no bundle patch'
    case 'already-installed': return 'this package is already installed'
    case 'stop-profile': return 'restart Mayfly before removing this running bundle'
    case 'bundle-in-use': return 'this bundle is still in use'
    case 'stale-approval': return 'a saved build approval is out of date'
    case 'invalid-spec': return 'the package spec is invalid'
    case 'ambiguous-install': return 'the installation added more than one package'
    case 'unknown-plugin': return 'the plugin is no longer installed'
    case 'unsupported-platform': return 'this bundle does not support the Host platform'
    case 'operation-error': return error.diagnostic === undefined || error.diagnostic === '' ? 'the package operation failed' : error.diagnostic
  }
}

/** A failed native change as one short line, including any build scripts the manager is waiting on. */
function failureText(result: ChangeResult): string {
  const pending = result.pendingBuilds === undefined || result.pendingBuilds.length === 0
    ? ''
    : ` — pending builds: ${result.pendingBuilds.join(', ')}`
  const diagnostic = managementText(result.error)
  const output = result.packageResult?.output.trim()
  const detail = result.error?.code === 'operation-error' && output !== undefined && output !== '' ? output : diagnostic
  return `${detail}${pending}`
}

/**
 * Register `/plugin`.
 * @param ctx - the interaction context.
 * @returns the disposer removing the command.
 */
function createMarketplace(context: RemoteOperationsContext, client: HostClient): MarketplaceController {
  const ctx = context.base.ctx
  const t = interactionTranslator(ctx)
  const notifications = ctx.get('mayflyUiInteraction')?.createNotificationOwner('mayfly.remote.market')
  let unloaded = false
  const owner = new AbortController()
  const generation = client.state.getSnapshot().generation
  const isCurrent = (signal: AbortSignal): boolean => !unloaded && !signal.aborted
    && client.state.getSnapshot().generation === generation
    && (context.base.hosts.current()?.client ?? context.base.hosts.active?.() ?? context.base.hosts.list()[0]) === client
  let chip: MayflyStatusRegistration | undefined
  const panels = new Set<RemoteBrowserPanel>()
  const dispose = (): void => {
    unloaded = true
    owner.abort()
    chip?.dispose()
    chip = undefined
    notifications?.dispose()
    for (const panel of panels) panel.close()
    panels.clear()
    offLocale()
  }
  /** The loaded catalog; `undefined` until the first load settles. */
  let catalog: CatalogResult | undefined
  /** Latest catalog-load claim; slower earlier requests cannot replace newer data. */
  let reloadGeneration = 0
  /** The manager's current bundles; `undefined` until the first native read settles. */
  let bundles: readonly BundleInfo[] | undefined
  /** Why the last native bundle read failed, if it did. */
  let bundleError: string | undefined
  /** Latest native-read claim; slower earlier reads cannot replace newer data. */
  let bundleGeneration = 0
  /** One install, update, removal, or enable at a time. */
  let operationInFlight = false
  /** Successful changes whose result asked for a restart. */
  let pendingChanges = 0
  /** The install source picked with `s`, per entry id. */
  const sources = new Map<string, InstallSource>()

  /** The active UI locale, for entry descriptions that ship both languages. */
  const locale = (): 'zh' | 'en' => {
    return ctx.mayflyLocale.snapshot.locale
  }
  const env = (): FactsEnv => ({ t, locale: locale() })

  /** The configured index URL; the empty default means the official chain. */
  const indexUrl = (): string => currentMayflySettings(ctx).marketIndexUrl || DEFAULT_MARKET_INDEX_URL

  /** Load (or force-reload) the read-only catalog. */
  const reload = (force: boolean, signal: AbortSignal): Promise<CatalogResult> => {
    const generation = ++reloadGeneration
    return loadMarketCatalog(indexUrl(), force).then(result => {
      if (!isCurrent(signal) || generation !== reloadGeneration) return result
      catalog = result
      return result
    })
  }

  /** Read the native bundle list; the panel never derives installed state from the profile itself. */
  const refreshBundles = async (manager: ClientPluginManager, signal: AbortSignal): Promise<boolean> => {
    const generation = ++bundleGeneration
    try {
      const loaded = await remoteValue(manager.listBundles())
      if (!isCurrent(signal) || generation !== bundleGeneration) return false
      bundles = loaded
      bundleError = undefined
      return true
    } catch (error) {
      if (!isCurrent(signal) || generation !== bundleGeneration) return false
      bundleError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /** Entries currently on hand (empty while offline or unloaded). */
  const entries = (): readonly MarketEntry[] => {
    /* row paths run only after a load settled */
    if (catalog === undefined || catalog.status === 'offline') return []
    return catalog.index.entries
  }

  const rows = (): readonly MarketRow[] => buildRows(entries(), bundles!)

  /** Find a row by marketplace id, by one of its row package names, or by an unlisted bundle name. */
  const findRow = (id: string): MarketRow | undefined => {
    const visible = rows().find(row => row.id === id || row.entry?.id === id || row.entry?.install.rows.some(item => item.name === id) === true || row.bundle?.name === id)
    if (visible !== undefined) return visible
    // A removed entry is not a visible row until the profile carries it, but `/plugin info` and an install attempt
    // still need its refusal.
    const entry = entries().find(candidate => candidate.id === id || candidate.install.rows.some(item => item.name === id))
    return entry === undefined ? undefined : { id: entry.id, entry, state: 'removed', installed: false, partial: false, removable: false }
  }

  /** Show the pending restart in the status footer. */
  const syncChip = (): void => {
    if (unloaded || pendingChanges === 0) return
    const status = ctx.get('mayflyStatus')
    if (status === undefined) return
    chip ??= status.register({ id: 'mayfly.plugin-restart', priority: 3, overflow: 'hide' }, null)
    chip.set(ui.text(t(pendingChanges === 1 ? '↻ {count} plugin change' : '↻ {count} plugin changes', { count: pendingChanges }), { tone: 'warning' }))
  }
  const offLocale = observeInteractionLocale(ctx, syncChip)

  /** Report an operation to the notification area, keyed by what it changes. */
  const notifyInto = (operationId: string, signal: AbortSignal): OperationReporter => status => {
    if (!isCurrent(signal)) return
    notifications?.report(operationId, { kind: 'app', targetId: 'plugin-market' }, {
      message: status.text,
      severity: status.tone === 'danger' ? 'error' : status.tone === 'muted' ? 'info' : status.tone,
      ...(status.tone === 'muted' ? { purpose: 'progress' as const } : {}),
    }, operationId)
  }

  /**
   * The install call one catalog row makes. A native on-demand target names one exact released version, so it is saved
   * exactly, as the Host's other official installs are; a catalog spec keeps pnpm's own saving rule.
   */
  function installCall(row: MarketInstallRow, bundle: BundleInfo | undefined, source: InstallSource): { readonly spec: string, readonly saveExact: boolean } {
    if (source === 'npm' && bundle?.installTarget !== undefined) return { spec: bundle.installTarget.spec, saveExact: true }
    return { spec: rowSpec(row, source)!, saveExact: false }
  }

  /** Whether an installed row is deselected and needs only a native switch-on. */
  function needsEnable(entry: MarketEntry, row: MarketInstallRow, bundle: BundleInfo | undefined): boolean {
    if (bundle === undefined) return false
    if (bundle.availability === 'installation' && !bundle.installed) return true
    return bundle.installed && !bundle.enabled && newerVersion(row, bundle, entry) === undefined
  }

  /** Install, update, or enable every present row of one entry through the native manager. */
  async function installEntry(
    manager: ClientPluginManager,
    row: MarketRow,
    source: InstallSource,
    report: OperationReporter,
    signal: AbortSignal,
  ): Promise<boolean> {
    const entry = row.entry!
    const current = await remoteValue(manager.listBundles())
    if (!isCurrent(signal)) return false
    const updating = entry.install.rows.some(item => current.some(bundle => bundle.name === item.name && bundle.installed))
    report({
      text: t(updating ? 'updating "{name}" via {source}...' : 'installing "{name}" via {source}...', { name: entry.displayName, source }),
      tone: 'muted',
    })
    let restart = false
    for (const item of entry.install.rows) {
      const bundle = current.find(candidate => candidate.name === item.name)
      const call = installCall(item, bundle, source)
      const result = needsEnable(entry, item, bundle)
        ? await remoteValue(manager.setBundleEnabled(item.name, true))
        : await remoteValue(manager.installBundle(call.spec, { enabled: true, ...call.saveExact ? { saveExact: true } : {} }))
      if (!isCurrent(signal)) return false
      if (result.application === 'failed') {
        await refreshBundles(manager, signal)
        report({
          text: t(updating ? 'update failed: {message}' : 'install failed: {message}', {
            message: shorten(`${entry.install.rows.length > 1 ? `${item.name}: ` : ''}${failureText(result)}`),
          }),
          tone: 'danger',
        })
        return false
      }
      if (result.application === 'cancelled') {
        await refreshBundles(manager, signal)
        report({ text: 'installation cancelled', tone: 'warning' })
        return false
      }
      if (result.application === 'overridden') {
        await refreshBundles(manager, signal)
        report({ text: 'change saved but overridden by the composition', tone: 'warning' })
        return false
      }
      if (result.application === 'restart-required') restart = true
    }
    await refreshBundles(manager, signal)
    if (!isCurrent(signal)) return false
    if (restart) {
      pendingChanges += 1
      syncChip()
    }
    report({
      text: restart
        ? t(updating ? 'updated; restart Mayfly and start a new session to apply' : 'installed; restart Mayfly and start a new session to apply')
        : updating ? 'updated' : t('installed'),
      tone: 'success',
    })
    return true
  }

  /** Remove every installed row of one entry (or the one unlisted bundle) through the native manager. */
  async function removeEntry(
    manager: ClientPluginManager,
    row: MarketRow,
    report: OperationReporter,
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = await remoteValue(manager.listBundles())
    if (!isCurrent(signal)) return false
    const entry = row.entry
    const names = entry === undefined
      ? [row.bundle!.name]
      : entry.install.rows.map(item => item.name).filter(name => current.some(bundle => bundle.name === name && bundle.installed))
    if (names.length === 0) {
      report({ text: t('"{name}" is not installed in this profile', { name: rowName(row) }), tone: 'danger' })
      return false
    }
    const blocked = current.filter(bundle => names.includes(bundle.name) && !bundle.removable)
    if (blocked.length > 0) {
      report({
        text: blocked.map(bundle => `${bundle.name}: ${bundle.readOnlyReason === 'management-required' ? 'the plugin manager protects this bundle' : 'this bundle is not removable'}`).join('; '),
        tone: 'danger',
      })
      return false
    }
    report({ text: t('removing "{name}"...', { name: rowName(row) }), tone: 'muted' })
    let restart = false
    for (const name of names) {
      const result = await remoteValue(manager.removeBundle(name))
      if (!isCurrent(signal)) return false
      if (result.application === 'failed') {
        await refreshBundles(manager, signal)
        report({ text: t('uninstall failed: {message}', { message: shorten(failureText(result)) }), tone: 'danger' })
        return false
      }
      if (result.application === 'cancelled') {
        await refreshBundles(manager, signal)
        report({ text: 'removal cancelled', tone: 'warning' })
        return false
      }
      if (result.application === 'restart-required') restart = true
    }
    await refreshBundles(manager, signal)
    if (!isCurrent(signal)) return false
    if (restart) {
      pendingChanges += 1
      syncChip()
    }
    report({ text: restart ? t('removed; restart Mayfly and start a new session to apply') : 'removed', tone: 'success' })
    return true
  }

  /** Run one install, update, removal, or enable through the native service, once at a time. */
  async function operate(row: MarketRow, action: RowAction, source: InstallSource | undefined, report: OperationReporter, signal: AbortSignal): Promise<boolean> {
    if (operationInFlight) {
      report({ text: t('a plugin operation is already running'), tone: 'warning' })
      return false
    }
    const manager = client.remote.pluginManager
    if (manager === undefined) {
      report({ text: 'plugin manager is unavailable: the native plugin service is not mounted', tone: 'danger' })
      return false
    }
    // Claim before the first await so overlapping keypresses cannot both run.
    operationInFlight = true
    try {
      if (action === 'remove') return await removeEntry(manager, row, report, signal)
      // `update` and `enable` use the same native installation path; the manager reports the observed application.
      return await installEntry(manager, row, source!, report, signal)
    } catch (error) {
      if (!isCurrent(signal)) return false
      // ChangeResult folds expected failures; a rejected service call is unexpected and still must not escape a key.
      await refreshBundles(manager, signal)
      if (!isCurrent(signal)) return false
      const message = shorten(error instanceof Error ? error.message : String(error))
      report({
        text: t(action === 'remove' ? 'uninstall failed: {message}' : action === 'update' ? 'update failed: {message}' : 'install failed: {message}', { message }),
        tone: 'danger',
      })
      return false
    } finally {
      operationInFlight = false
    }
  }

  /**
   * Install, update, remove, or enable one row after the guards every entry point shares: installed state, install
   * blocks, the up-to-date short-circuit, web-only warnings, native removal availability, and the source.
   */
  async function runOperation(row: MarketRow, action: RowAction, reporter: OperationReporter, signal: AbortSignal, requestedSource?: InstallSource): Promise<boolean> {
    if (action === 'remove') {
      if (!row.installed) {
        reporter({ text: t('"{name}" is not installed in this profile', { name: rowName(row) }), tone: 'danger' })
        return false
      }
      if (row.removable === false) {
        reporter({ text: 'the plugin manager does not allow removing this bundle', tone: 'danger' })
        return false
      }
      return operate(row, 'remove', undefined, reporter, signal)
    }
    const entry = row.entry
    if (entry === undefined) {
      reporter({ text: 'this bundle is not listed in the marketplace index', tone: 'danger' })
      return false
    }
    const installBlock = marketEntryInstallBlock(entry)
    if (installBlock !== undefined) {
      reporter({ text: t(installBlock), tone: 'danger' })
      return false
    }
    if (row.state === 'installed') {
      reporter({ text: t('"{name}" is already installed and up to date', { name: entry.displayName }), tone: 'success' })
      return true
    }
    if (usefulInTui(entry) === false) {
      reporter({ text: t('web-only plugin: it contributes nothing in this terminal frontend'), tone: 'warning' })
    }
    const source = requestedSource ?? sources.get(entry.id) ?? defaultInstallSource(entry)
    if (source === undefined) {
      reporter({ text: t('"{name}" has no common install source for every package', { name: entry.displayName }), tone: 'danger' })
      return false
    }
    if (!entrySupportsSource(entry, source)) {
      reporter({ text: t('"{name}" has no {source} install source', { name: entry.displayName, source }), tone: 'danger' })
      return false
    }
    return operate(row, action, source, reporter, signal)
  }

  /** Report an operation into an open surface. */
  const reportInto = (context: MayflyUiEventContext, remember: (text: string) => void): OperationReporter => status => {
    if (!isCurrent(context.signal)) return
    remember(status.text)
    context.report({
      message: status.text,
      severity: status.tone === 'danger' ? 'error' : status.tone === 'warning' ? 'warning' : status.tone === 'success' ? 'success' : 'info',
      purpose: status.tone === 'muted' ? 'progress' : 'feedback',
    })
  }

  /** The age of the index, in the coarsest whole unit. */
  const ageText = (ms: number): string => {
    const hours = Math.max(0, Math.floor(ms / HOUR_MS))
    if (hours < 1) return t('under an hour')
    if (hours < 48) return t('{count}h', { count: hours })
    return t('{count}d', { count: Math.floor(hours / 24) })
  }

  /** One keyed operation of a row, with the reply that shows the result. */
  async function rowAction(rowId: string, action: RowAction, context: MayflyUiEventContext): Promise<{ readonly ok: boolean, readonly message: string }> {
    const row = rows().find(item => item.id === rowId)!
    let message = t('plugin operation failed')
    const ok = await runOperation(row, action, reportInto(context, text => { message = text }), context.signal)
    return { ok, message }
  }

  /** Open the marketplace panel on a tab, optionally on one row's detail page. */
  function openBrowse(initialTab: MarketTab, signal: AbortSignal, options: { readonly focusId?: string, readonly detail?: boolean } = {}): CommandOutcome {
    if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly UI registry is not mounted') }
    const manager = client.remote.pluginManager
    for (const panel of panels) panel.close()
    panels.clear()
    const lifetime = new AbortController()
    const panelSignal = AbortSignal.any([signal, owner.signal, lifetime.signal])
    let activeTab: MarketTab = initialTab
    let groupMode: GroupMode = 'category'
    const focused: Partial<Record<MarketTab, string>> = {}
    if (options.focusId !== undefined) focused[initialTab] = options.focusId
    let narrow: 'list' | 'detail' = options.detail === true ? 'detail' : 'list'
    let focusRequest: { readonly tab: MarketTab, readonly id: string, readonly rev: number } | undefined
    let focusRev = 0
    /** The visible columns: the compose browser splits at {@link MARKET_BREAKPOINT} and pages below it. */
    const columns = (): number => ctx.get('mayflyScreen')?.columns ?? MARKET_BREAKPOINT
    /** The plugin body's room under the transcript and above the panel hint; keeps the browser's column rule full. */
    const detailRows = (): number => Math.max(6, (ctx.get('mayflyScreen')?.rows ?? 40) - 18)

    const subtitle = (current: Extract<CatalogResult, { index: unknown }>): string => {
      const generated = current.index.generatedAt === undefined ? Number.NaN : Date.parse(current.index.generatedAt)
      const age = Number.isNaN(generated) ? undefined : ageText(Date.now() - generated)
      if (current.status === 'stale') {
        return age === undefined ? t('⚠ offline · showing cached data') : t('⚠ offline · showing cached data from {age} ago', { age })
      }
      const count = current.index.entries.length
      return age === undefined ? t('{count} entries', { count }) : t('index updated {age} ago · {count} entries', { age, count })
    }

    const node = (): MayflyUiNode => {
      const title = t('Plugin marketplace')
      if (manager === undefined) return PluginMarketplaceUnavailable(title, 'plugin manager is unavailable: the native plugin service is not mounted')
      if (bundleError !== undefined) return PluginMarketplaceUnavailable(title, `could not read installed plugins: ${bundleError}`)
      if (catalog === undefined || bundles === undefined) return PluginMarketplaceLoading(title, t('loading catalog...'))
      if (catalog.status === 'offline') return PluginMarketplaceOffline(title, t('marketplace is offline: {message}', { message: catalog.message }), t('refresh'))
      const all = rows()
      const e = env()
      const tabs = MARKET_TABS.map(tab => tabFacts(e, all, tab, groupMode, focusRequest?.tab === tab ? focusRequest : undefined))
      const ordered = groupRows(tabRows(all, activeTab), groupMode)
      const row = ordered.find(item => item.id === focused[activeTab]) ?? ordered[0]
      // A named row may live outside the active tab's visible rows; show it when the caller names one.
      const named = options.focusId === undefined ? undefined : findRow(options.focusId)
      const shown = named ?? row
      return PluginMarketplace({
        title, subtitle: subtitle(catalog), tabs, activeTab,
        detail: shown === undefined ? undefined : detailFacts(e, shown, shown.entry === undefined ? undefined : sources.get(shown.entry.id)),
        noDetail: t('No plugin selected'),
        detailHeight: detailRows(),
        focusedRowId: row?.id,
        narrow,
        escapeLabel: narrow === 'detail' && columns() < MARKET_BREAKPOINT ? 'back' : 'close',
        keys: {
          install: t('install'), update: t('update'), remove: t('remove'), source: t('source'),
          group: t('group: {mode}', { mode: groupModeLabel(t, groupMode) }), refresh: t('refresh'), updateAll: t('update all'),
          removeConfirm: { title: t('Remove the selected plugin?'), detail: t('Removal applies after restarting Mayfly and starting a new session.'), confirmLabel: t('Remove'), tone: 'danger' },
          updateAllConfirm: { title: t('Update every plugin with a newer version?'), detail: t('Updates apply after restarting Mayfly and starting a new session.'), confirmLabel: t('Update') },
        },
        restartBanner: pendingChanges === 0 ? undefined : t(pendingChanges === 1
          ? '↻ {count} change applies after you restart Mayfly and start a new session'
          : '↻ {count} changes apply after you restart Mayfly and start a new session', { count: pendingChanges }),
      })
    }

    let handle: RemoteBrowserPanel | undefined
    const publish = (): void => { if (!unloaded && handle?.closed === false) handle.refresh() }

    const refreshMarket = async (reporter: OperationReporter, signal: AbortSignal): Promise<boolean> => {
      if (manager === undefined) {
        reporter({ text: 'plugin manager is unavailable: the native plugin service is not mounted', tone: 'danger' })
        return false
      }
      reporter({ text: t('refreshing plugin catalog...'), tone: 'muted' })
      const [result] = await Promise.all([reload(true, signal), refreshBundles(manager, signal)])
      /* a fiber unload landing inside the refresh await is a shutdown race */
      if (!isCurrent(signal)) return false
      if (result.status === 'offline' || bundleError !== undefined) {
        reporter({ text: t('refresh failed: {message}', { message: result.status === 'offline' ? result.message : bundleError! }), tone: 'danger' })
      } else {
        reporter({ text: t('refreshed {count} entries', { count: String(result.index.entries.length) }), tone: 'success' })
      }
      return result.status !== 'offline' && bundleError === undefined
    }

    /** Every installed row that has a newer version or needs switch-on, one after the other. */
    const updateAll = async (context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
      const targets = rows().filter(row => row.entry !== undefined && (row.state === 'update' || row.state === 'repair') && marketEntryInstallBlock(row.entry) === undefined)
      if (targets.length === 0) return { kind: 'accepted', node: node(), source: [], feedback: { severity: 'info', message: t('no plugin updates to apply') } }
      for (const [index, row] of targets.entries()) {
        const prefix = t('{index} of {count}', { index: index + 1, count: targets.length })
        let message = t('plugin operation failed')
        const report = reportInto(context, text => { message = text })
        const ok = await runOperation(row, 'install', status => report({ ...status, text: status.tone === 'muted' ? `${prefix} · ${status.text}` : status.text }), context.signal)
        if (!isCurrent(context.signal)) return { kind: 'cancelled' }
        if (!ok) return { kind: 'failed', node: node(), source: [], message: t('update all stopped at "{name}": {message}', { name: rowName(row), message }) }
      }
      return { kind: 'accepted', node: node(), source: [], feedback: { severity: 'success', message: t('updated {count} plugins; restart Mayfly and start a new session to apply', { count: targets.length }) } }
    }

    const activeRowId = (): string | undefined => {
      const ordered = groupRows(tabRows(rows(), activeTab), groupMode)
      return ordered.find(item => item.id === focused[activeTab])?.id ?? ordered[0]?.id
    }

    handle = openRemoteBrowser(context.base, {
      id: 'mayfly.plugin-market',
      scope: { kind: 'app', targetId: 'plugin-market' },
      signal: panelSignal,
      isCurrent: () => isCurrent(panelSignal),
      view: node,
      back: () => {
        if (narrow !== 'detail' || columns() >= MARKET_BREAKPOINT) return false
        narrow = 'list'
        publish()
        return true
      },
      observe: (event: MayflyUiObservationEvent) => {
          if (event.kind === 'tab-change') {
            const tab = MARKET_TABS.find(id => id === event.tabId)
            if (tab !== undefined && tab !== activeTab) { activeTab = tab; narrow = 'list'; publish() }
          } else if (event.kind === 'focus-change' && event.itemId !== undefined) {
            const tab = MARKET_TABS.find(id => listId(id) === event.controlId)
            if (tab !== undefined && focused[tab] !== event.itemId) {
              focused[tab] = event.itemId
              if (tab === activeTab) publish()
            }
          }
        },
      action: async (event: MayflyUiActionEvent, eventContext): Promise<MayflyUiActionReply> => {
          const context = { ...eventContext, signal: AbortSignal.any([eventContext.signal, panelSignal]) }
          if (!isCurrent(context.signal)) return { kind: 'cancelled' }
          if (event.kind === 'dismiss') {
            if (narrow === 'detail' && columns() < MARKET_BREAKPOINT) {
              narrow = 'list'
              publish()
              return { kind: 'completed', dismiss: false }
            }
            return { kind: 'completed' }
          }
          if (event.kind === 'selection-accept') {
            const selected = event.selectedIds[0] === undefined ? undefined : findRow(event.selectedIds[0])
            if (selected !== undefined) {
              focused[activeTab] = selected.id
              narrow = 'detail'
              publish()
            }
            return { kind: 'completed' }
          }
          if (event.kind !== 'activate') return { kind: 'completed' }
          switch (event.actionId) {
            case 'install':
            case 'update':
            case 'remove': {
              const id = activeRowId()
              if (id === undefined) return { kind: 'completed' }
              const result = await rowAction(id, event.actionId, context)
              if (!isCurrent(context.signal)) return { kind: 'cancelled' }
              if (!rows().some(item => item.id === id)) narrow = 'list'
              return result.ok
                ? { kind: 'accepted', node: node(), source: [], feedback: { severity: 'success', message: result.message } }
                : { kind: 'failed', node: node(), source: [], message: result.message }
            }
            case 'source': {
              const rowId = activeRowId()
              const row = rowId === undefined ? undefined : rows().find(item => item.id === rowId)
              if (row?.entry === undefined) return { kind: 'completed' }
              const current = sources.get(row.entry.id) ?? defaultInstallSource(row.entry)
              const next: InstallSource = current === 'npm' ? 'github' : 'npm'
              sources.set(row.entry.id, next)
              return { kind: 'accepted', node: node(), source: [], feedback: { severity: 'info', message: t('install source: {source}', { source: next }) } }
            }
            case 'group': {
              groupMode = GROUP_MODES[(GROUP_MODES.indexOf(groupMode) + 1) % GROUP_MODES.length]!
              const keep = focused[activeTab]
              if (keep !== undefined) focusRequest = { tab: activeTab, id: keep, rev: ++focusRev }
              return { kind: 'accepted', node: node(), source: [] }
            }
            case 'update-all':
              return updateAll(context)
            case 'refresh': {
              let message = t('refresh failed')
              const ok = await refreshMarket(reportInto(context, text => { message = text }), context.signal)
              if (!isCurrent(context.signal)) return { kind: 'cancelled' }
              return ok
                ? { kind: 'accepted', node: node(), source: [], feedback: { severity: 'success', message } }
                : { kind: 'failed', node: node(), source: [], message }
            }
            default:
              return { kind: 'completed' }
          }
        },
      onClosed: () => { lifetime.abort(); if (handle !== undefined) panels.delete(handle) },
    })
    if (handle.closed) return { kind: 'success' }
    panels.add(handle)
    // The panel mounts immediately with the loading document when the caller
    // opened before the first load settled; swap in the data when it arrives.
    if (manager !== undefined) {
      if (bundles === undefined) void refreshBundles(manager, panelSignal).then(() => { publish() })
    }
    if (catalog === undefined) {
      void reload(false, panelSignal).then(() => { publish() })
    }
    return { kind: 'success' }
  }

  const command = {
    name: 'plugin', scope: 'sessionless',
    description: 'Browse, install, and remove plugins',
    input: { hint: '[install <id> [--source npm|github>] | uninstall <id> | info <id> | list | updates | refresh]' },
    handler: async (rawInput: string, signal: AbortSignal): Promise<CommandOutcome> => {
      const raw = rawInput.trim()
      if (raw === '') {
        return openBrowse('browse', signal)
      }
      const tokens = raw.split(/\s+/)
      const verb = tokens[0]!
      const id = tokens[1]
      if (verb === 'refresh') {
        const manager = client.remote.pluginManager
        if (manager === undefined) return { kind: 'error', text: 'plugin manager is unavailable: the native plugin service is not mounted' }
        const [result] = await Promise.all([reload(true, signal), refreshBundles(manager, signal)])
        if (!isCurrent(signal)) return { kind: 'success' }
        if (result.status === 'offline' || bundleError !== undefined) {
          return { kind: 'error', text: t('refresh failed: {message}', { message: result.status === 'offline' ? result.message : bundleError! }) }
        }
        return { kind: 'success', text: t('refreshed {count} entries', { count: String(result.index.entries.length) }) }
      }
      if (verb === 'list') {
        return openBrowse('installed', signal)
      }
      if (verb === 'updates') {
        return openBrowse('updates', signal)
      }
      if (verb === 'info') {
        if (id === undefined) return { kind: 'error', text: t('usage: /plugin info <id>') }
        if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly UI registry is not mounted') }
        const manager = client.remote.pluginManager
        if (manager === undefined) return { kind: 'error', text: 'plugin manager is unavailable: the native plugin service is not mounted' }
        if (catalog === undefined) await reload(false, signal)
        if (!isCurrent(signal)) return { kind: 'success' }
        if (bundles === undefined) await refreshBundles(manager, signal)
        if (!isCurrent(signal)) return { kind: 'success' }
        const productEntry = entries().find(candidate => candidate.id === id || candidate.install.rows.some(item => item.name === id))
        if (productEntry?.install.rows.some(item => isMayflyProductPackage(item.name)) === true) {
          return { kind: 'error', text: t('Manage Mayfly packages with /update') }
        }
        const row = findRow(id)
        if (row === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        const tab = MARKET_TABS.find(candidate => tabRows(rows(), candidate).some(item => item.id === row.id)) ?? 'browse'
        return openBrowse(tab, signal, { focusId: row.id, detail: true })
      }
      if (verb === 'install' || verb === 'uninstall') {
        if (id === undefined) {
          return { kind: 'error', text: t('usage: /plugin {verb} <id> [--source npm|github]', { verb }) }
        }
        if (isMayflyProductPackage(id)) return { kind: 'error', text: t('Manage Mayfly packages with /update') }
        const sourceIndex = tokens.indexOf('--source')
        const requestedSource = sourceIndex === -1 ? undefined : tokens[sourceIndex + 1]
        if (sourceIndex !== -1 && requestedSource !== 'npm' && requestedSource !== 'github') {
          return { kind: 'error', text: t('usage: /plugin {verb} <id> [--source npm|github]', { verb }) }
        }
        const manager = client.remote.pluginManager
        if (manager === undefined) return { kind: 'error', text: 'plugin manager is unavailable: the native plugin service is not mounted' }
        if (catalog === undefined) await reload(false, signal)
        if (!isCurrent(signal)) return { kind: 'success' }
        if (bundles === undefined) await refreshBundles(manager, signal)
        if (!isCurrent(signal)) return { kind: 'success' }
        const productEntry = entries().find(candidate => candidate.id === id || candidate.install.rows.some(item => item.name === id))
        if (productEntry?.install.rows.some(item => isMayflyProductPackage(item.name)) === true) {
          return { kind: 'error', text: t('Manage Mayfly packages with /update') }
        }
        const row = findRow(id)
        if (row === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        if (verb === 'uninstall' && !row.installed) {
          return { kind: 'error', text: t('"{name}" is not installed in this profile', { name: rowName(row) }) }
        }
        if (verb === 'install') {
          if (row.entry === undefined) return { kind: 'error', text: 'this bundle is not listed in the marketplace index' }
          const installBlock = marketEntryInstallBlock(row.entry)
          if (installBlock !== undefined) return { kind: 'error', text: t(installBlock) }
          if (usefulInTui(row.entry) === false) {
            notifications?.report(`plugin/${row.id}/compatibility`, { kind: 'app', targetId: 'plugin-market' }, { message: t('web-only plugin: it contributes nothing in this terminal frontend'), severity: 'warning' })
          }
        }
        const action = verb === 'uninstall' ? 'remove' : 'install'
        await runOperation(row, action, notifyInto(`plugin/${row.id}/${action}`, signal), signal, requestedSource === 'npm' || requestedSource === 'github' ? requestedSource : undefined)
        return { kind: 'success' }
      }
      return { kind: 'error', text: t('usage: /plugin [install <id> | uninstall <id> | info <id> | list | updates | refresh]') }
    },
  }

  return { execute: command.handler, dispose }
}


/** Mount the reference marketplace with one exact Host client per feature generation. */
export function mountRemoteMarketplace(context: RemoteOperationsContext): () => void {
  mountInteractionLocale(context.base.ctx)
  let disposed = false
  let current: { readonly client: HostClient, readonly controller: MarketplaceController } | undefined
  const lifecycle = new RemoteFeatureLifecycle(context.base, () => {
    current?.controller.dispose()
    current = undefined
  })
  lifecycle.start()
  const unregister = context.base.commands.register({
    name: 'plugin', scope: 'sessionless',
    description: 'Browse, install, and remove plugins',
    input: { hint: '[install <id> [--source npm|github] | uninstall <id> | info <id> | list | updates | refresh]' },
    async execute(rawInput, signal) {
      if (signal.aborted) return
      const client = context.base.hosts.current()?.client ?? context.base.hosts.active?.() ?? context.base.hosts.list()[0]
      if (client === undefined) { context.base.notice.set('Attach a Host before managing plugins', 'error'); return }
      if (current?.client !== client) {
        current?.controller.dispose()
        current = { client, controller: createMarketplace(context, client) }
      }
      const controller = current.controller
      const generation = lifecycle.currentGeneration()
      const outcome = await controller.execute(rawInput, signal)
      if (!signal.aborted && lifecycle.owns(generation) && outcome.text !== undefined) context.base.notice.set(outcome.text, outcome.kind === 'error' ? 'error' : 'info')
    },
  })
  return () => {
    if (disposed) return
    disposed = true
    unregister()
    lifecycle.dispose()
    current?.controller.dispose()
    current = undefined
  }
}
