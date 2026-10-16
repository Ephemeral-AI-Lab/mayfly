/**
 * The `/plugin` command family: the marketplace over the index published by Ephemeral-AI-Lab/dsh-plugins
 * (`dist/index.json`). `/plugin` opens the marketplace panel (`components/marketplace.ts`): Installed, Updates, and
 * Browse tabs over grouped, slash-filtered lists, with the detail of the focused plugin beside the list from 100
 * columns (below it `Enter` opens the detail panel). Its keys install, update, remove, switch the install source,
 * regroup, update everything, and refresh; every operation reports its progress and result in the panel.
 * `install <id> [--source npm|github]`, `uninstall <id>`, `info <id>`, `list`, `updates`, and `refresh` run the argument
 * paths directly. Installs and removals shell out to `dsh plugin --profile <name> add|remove` — the same seam the
 * updater's swap uses — and every completed change stays a pending restart (a banner in the panel, a chip in the
 * status footer) because bundle membership is a startup boundary. The catalog loads cache-first and still serves
 * stale data offline.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { openUiOverlay } from './ui-overlay.ts'
import { ui, type MayflyOverlayHandle, type MayflyStatusRegistration, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiNode, type MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { registerOwnedCommand } from './sessionless-commands.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { currentMayflySettings } from './settings.ts'
import { DEFAULT_MARKET_INDEX_URL, loadMarketCatalog, type CatalogResult } from './plugin-market/catalog.ts'
import {
  defaultInstallSource,
  entrySupportsSource,
  installEntry,
  marketEntryInstallBlock,
  readInstalledPlugins,
  uninstallEntry,
  type InstallSource,
  type InstalledPlugin,
} from './plugin-market/installer.ts'
import {
  buildRows, GROUP_MODES, groupRows, incompatible, MARKET_TABS, tabRows, unlistedEntry, usefulInTui,
  type GroupMode, type MarketRow, type MarketTab, type RuntimeVersions,
} from './plugin-market/model.ts'
import { detailFacts, groupModeLabel, tabFacts, unavailableKeys, type FactsEnv } from './plugin-market/facts.ts'
import type { MarketEntry } from './plugin-market/types.ts'
import { findDshCommand, profileRoot } from './updater/profile.ts'
import { profileNameFromArgv } from '../internal/profile.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { listId, PluginDetailPanel, PluginMarketplace, PluginMarketplaceLoading, PluginMarketplaceOffline } from '../components/marketplace.ts'

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

/** A failure kept to one short line: the head says what failed, the tail how the profile was left (`changes rolled back`). */
function shorten(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > 150 ? `${flat.slice(0, 110)}… ${flat.slice(-30)}` : flat
}

/**
 * Register `/plugin`.
 * @param ctx - the interaction context.
 * @returns the disposer removing the command.
 */
export function registerPluginCommand(ctx: Context): () => void {
  const t = interactionTranslator(ctx)
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.market', 'plugin-market')
  /** Set when this fiber unloads: awaits must gate continuations on it. */
  let unloaded = false
  /** The status footer chip for changes that wait for a restart; made on the first change. */
  let chip: MayflyStatusRegistration | undefined
  ctx.effect(() => () => {
    unloaded = true
    chip?.dispose()
    chip = undefined
  })
  /** The loaded catalog; `undefined` until the first load settles. */
  let catalog: CatalogResult | undefined
  /** Latest load claim; slower earlier requests cannot replace newer data. */
  let reloadGeneration = 0
  /** Plugins the profile carries; reread after every install or removal. */
  let installed: readonly InstalledPlugin[] = []
  /** One install or removal at a time, like the updater's in-flight guard. */
  let operationInFlight = false
  /** Completed changes that apply after a restart and a new session. */
  let pendingChanges = 0
  /** The install source picked with `s`, per entry id. */
  const sources = new Map<string, InstallSource>()

  /** The active UI locale, for entry descriptions that ship both languages. */
  const locale = (): 'zh' | 'en' => {
    const service = ctx.get('mayflyLocale')
    /* panels render only where the frontend ships the locale service */
    if (service === undefined) return 'en'
    return service.snapshot.locale
  }
  const versions: RuntimeVersions = { mayfly: MAYFLY_VERSION, node: process.versions.node }
  const env = (): FactsEnv => ({ t, locale: locale(), versions })

  /** The configured index URL; the empty default means the official chain. */
  const indexUrl = (): string => currentMayflySettings(ctx).marketIndexUrl || DEFAULT_MARKET_INDEX_URL

  const profile = (): string => profileNameFromArgv(process.argv)

  /** Reread the profile dependencies. */
  const refreshInstalled = (): void => {
    installed = readInstalledPlugins(profileRoot(profile()))
  }

  /** Load (or force-reload) the catalog and refresh derived profile state. */
  const reload = (force: boolean): Promise<CatalogResult> => {
    const generation = ++reloadGeneration
    return loadMarketCatalog(indexUrl(), force).then(result => {
      if (unloaded || generation !== reloadGeneration) return result
      catalog = result
      refreshInstalled()
      return result
    })
  }

  /** Entries currently on hand (empty while offline or unloaded). */
  const entries = (): readonly MarketEntry[] => {
    /* row paths run only after a load settled */
    if (catalog === undefined || catalog.status === 'offline') return []
    return catalog.index.entries
  }

  const rows = (): readonly MarketRow[] => buildRows(entries(), installed)

  /** Find a row by marketplace id, by one of its row package names, or by an unlisted package name. */
  const findRow = (id: string): MarketRow | undefined =>
    rows().find(row => row.id === id || row.entry?.id === id || row.entry?.install.rows.some(item => item.name === id) === true || row.plugin?.name === id)

  /** The entry an operation acts on; an unlisted package acts through a stand-in. */
  const rowEntry = (row: MarketRow): MarketEntry => row.entry ?? unlistedEntry(row.plugin!)

  /** Show the pending restart in the status footer. */
  const syncChip = (): void => {
    if (unloaded || pendingChanges === 0) return
    const status = ctx.get('mayflyStatus')
    if (status === undefined) return
    chip ??= status.register({ id: 'mayfly.plugin-restart', priority: 3, overflow: 'hide' }, null)
    chip.set(ui.text(t(pendingChanges === 1 ? '↻ {count} plugin change' : '↻ {count} plugin changes', { count: pendingChanges }), { tone: 'warning' }))
  }
  ctx.effect(() => observeInteractionLocale(ctx, syncChip))

  /** Run one install, update, or removal through the dsh CLI seam, once at a time. */
  async function operate(entry: MarketEntry, action: 'install' | 'uninstall', source: InstallSource, reporter?: OperationReporter): Promise<boolean> {
    const operationId = `plugin/${entry.id}/${action}`
    const report: OperationReporter = reporter ?? (status => notifications.report(operationId, {
      message: status.text,
      severity: status.tone === 'danger' ? 'error' : status.tone === 'muted' ? 'info' : status.tone,
      ...(status.tone === 'muted' ? { purpose: 'progress' as const } : {}),
    }, undefined, operationId))
    if (operationInFlight) {
      report({ text: t('a plugin operation is already running'), tone: 'warning' })
      return false
    }
    // Claim before the first await so overlapping keypresses cannot both run.
    operationInFlight = true
    try {
      const dshCommand = await findDshCommand()
      /* a fiber unload landing inside these awaits is a shutdown race */
      if (unloaded) return false
      if (dshCommand === undefined) {
        report({ text: t('plugin operations need the dsh CLI on PATH (or $DSH_BIN)'), tone: 'danger' })
        return false
      }
      if (action === 'install' && entrySupportsSource(entry, source) === false) {
        report({ text: t('"{name}" has no {source} install source', { name: entry.displayName, source }), tone: 'danger' })
        return false
      }
      const updating = action === 'install' && entry.install.rows.some(row => installed.some(plugin => plugin.name === row.name))
      const name = entry.displayName
      report({
        text: action === 'install'
          ? t(updating ? 'updating "{name}" via {source}...' : 'installing "{name}" via {source}...', { name, source })
          : t('removing "{name}"...', { name }),
        tone: 'muted',
      })
      const input = {
        dshCommand,
        profile: profile(),
        root: profileRoot(profile()),
        entry,
        source,
        onProgress: (phase: 'verify' | 'rollback') => {
          report({
            text: t(phase === 'verify' ? 'checking "{name}" compatibility...' : 'rolling back "{name}"...', { name }),
            tone: phase === 'verify' ? 'muted' : 'warning',
          })
        },
      }
      const outcome = action === 'install' ? await installEntry(input) : await uninstallEntry(input)
      /* a fiber unload landing inside these awaits is a shutdown race */
      if (unloaded) return false
      if (outcome.kind === 'error') {
        report({
          text: t(action === 'install' ? (updating ? 'update failed: {message}' : 'install failed: {message}') : 'uninstall failed: {message}', { message: shorten(outcome.text) }),
          tone: 'danger',
        })
        return false
      }
      refreshInstalled()
      pendingChanges += 1
      syncChip()
      report({
        text: t(action === 'install'
          ? (updating ? 'updated; restart Mayfly and start a new session to apply' : 'installed; restart Mayfly and start a new session to apply')
          : 'removed; restart Mayfly and start a new session to apply'),
        tone: 'success',
      })
      return true
    } finally {
      operationInFlight = false
    }
  }

  /**
   * Install, update, or remove one entry after the guards every entry point shares: installed state, install blocks,
   * the up-to-date short-circuit, the web-only and engine warnings, and the source.
   */
  async function runOperation(entry: MarketEntry, action: 'install' | 'uninstall', reporter: OperationReporter, requestedSource?: InstallSource): Promise<boolean> {
    const present = entry.install.rows.some(item => installed.some(plugin => plugin.name === item.name))
    if (action === 'uninstall' && !present) {
      reporter({ text: t('"{name}" is not installed in this profile', { name: entry.displayName }), tone: 'danger' })
      return false
    }
    const installBlock = action === 'install' ? marketEntryInstallBlock(entry) : undefined
    if (installBlock !== undefined) {
      reporter({ text: t(installBlock), tone: 'danger' })
      return false
    }
    const row = rows().find(item => item.entry?.id === entry.id)
    if (action === 'install' && row !== undefined && row.state === 'installed') {
      reporter({ text: t('"{name}" is already installed and up to date', { name: entry.displayName }), tone: 'success' })
      return true
    }
    if (action === 'install' && usefulInTui(entry) === false) {
      reporter({ text: t('web-only plugin: it contributes nothing in this terminal frontend'), tone: 'warning' })
    }
    if (action === 'install' && incompatible(entry, versions)) {
      reporter({ text: t('"{name}" declares engines this Mayfly does not match; installing anyway', { name: entry.displayName }), tone: 'warning' })
    }
    const source = requestedSource ?? sources.get(entry.id) ?? defaultInstallSource(entry)
    if (action === 'install' && source === undefined) {
      reporter({ text: t('"{name}" has no common install source for every package', { name: entry.displayName }), tone: 'danger' })
      return false
    }
    return operate(entry, action, source ?? 'npm', reporter)
  }

  /** Report an operation into an open surface. */
  const reportInto = (context: MayflyUiEventContext, remember?: (text: string) => void): OperationReporter => status => {
    remember?.(status.text)
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
    const row = rows().find(item => item.id === rowId)
    /* keyed actions only carry ids from rows */
    if (row === undefined) return { ok: false, message: t('plugin operation failed') }
    let message = t('plugin operation failed')
    const ok = await runOperation(rowEntry(row), action === 'remove' ? 'uninstall' : 'install', reportInto(context, text => { message = text }))
    return { ok, message }
  }

  /** Open the detail panel of one row: above the marketplace, or alone for `/plugin info`. */
  function openDetail(rowId: string, parent: 'market' | 'app', signal: AbortSignal | undefined, changed: () => void): void {
    const first = rows().find(item => item.id === rowId)
    if (first === undefined) return
    let offLocale: (() => void) | undefined
    const view = (): MayflyUiNode => {
      const row = rows().find(item => item.id === rowId) ?? first
      const reasons = unavailableKeys(t, row)
      const can = { install: reasons.install === undefined, update: reasons.update === undefined, remove: reasons.remove === undefined }
      return PluginDetailPanel(detailFacts(env(), row, row.entry === undefined ? undefined : sources.get(row.entry.id)), rowTitle(row), {
        install: t('install'), update: t('update'), remove: t('remove'), can,
        removeConfirm: { title: t('Remove the selected plugin?'), detail: t('Removal applies after restarting Mayfly and starting a new session.'), confirmLabel: t('Remove'), tone: 'danger' },
      })
    }
    const handle = openUiOverlay(ctx, {
      id: 'mayfly.plugin-detail', presentation: 'editor', capturing: true, dismissal: 'discard', title: rowTitle(first),
      scope: parent === 'market' ? { kind: 'panel', parent: { kind: 'overlay', id: 'mayfly.plugin-market' } } : { kind: 'app', targetId: `plugin/${first.id}` },
      onEvent: {
        action: async (event, context): Promise<MayflyUiActionReply> => {
          if (event.kind !== 'activate' || (event.actionId !== 'install' && event.actionId !== 'update' && event.actionId !== 'remove')) return { kind: 'completed' }
          const result = await rowAction(rowId, event.actionId, context)
          changed()
          if (!result.ok) return { kind: 'failed', message: result.message, node: view(), source: [] }
          return rows().some(item => item.id === rowId)
            ? { kind: 'accepted', node: view(), source: [], feedback: { severity: 'success', message: result.message } }
            : { kind: 'completed', dismiss: true, feedback: { severity: 'success', message: result.message } }
        },
      },
    }, view(), { reopen: 'replace', ...signal === undefined ? {} : { signal }, onClosed: () => offLocale?.() })
    offLocale = observeInteractionLocale(ctx, () => { if (!handle.closed) handle.set(view()) })
  }

  const rowTitle = (row: MarketRow): string => row.entry?.displayName ?? row.plugin!.name

  /** Open the marketplace panel on a tab. */
  function openBrowse(initialTab: MarketTab): CommandOutcome {
    if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly UI registry is not mounted') }
    const lifetime = new AbortController()
    let activeTab: MarketTab = initialTab
    let groupMode: GroupMode = 'category'
    const focused: Partial<Record<MarketTab, string>> = {}
    let focusRequest: { readonly tab: MarketTab, readonly id: string, readonly rev: number } | undefined
    let focusRev = 0
    refreshInstalled()

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
      if (catalog === undefined) return PluginMarketplaceLoading(title, t('loading catalog...'))
      if (catalog.status === 'offline') return PluginMarketplaceOffline(title, t('marketplace is offline: {message}', { message: catalog.message }), t('refresh'))
      const all = rows()
      const e = env()
      const tabs = MARKET_TABS.map(tab => tabFacts(e, all, tab, groupMode, focusRequest?.tab === tab ? focusRequest : undefined))
      const ordered = groupRows(tabRows(all, activeTab), groupMode)
      const row = ordered.find(item => item.id === focused[activeTab]) ?? ordered[0]
      return PluginMarketplace({
        title, subtitle: subtitle(catalog), tabs, activeTab,
        detail: row === undefined ? undefined : detailFacts(e, row, row.entry === undefined ? undefined : sources.get(row.entry.id)),
        noDetail: t('No plugin selected'),
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

    const publish = (): void => { if (!unloaded && !handle.closed) handle.set(node()) }

    const refreshMarket = async (reporter: OperationReporter): Promise<boolean> => {
      reporter({ text: t('refreshing plugin catalog...'), tone: 'muted' })
      const result = await reload(true)
      /* a fiber unload landing inside the refresh await is a shutdown race */
      if (unloaded) return false
      if (result.status === 'offline') {
        reporter({ text: t('refresh failed: {message}', { message: result.message }), tone: 'danger' })
      } else {
        reporter({ text: t('refreshed {count} entries', { count: String(result.index.entries.length) }), tone: 'success' })
      }
      return result.status !== 'offline'
    }

    /** Every installed row that has a newer version or is partly installed, one after the other. */
    const updateAll = async (context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
      const targets = rows().filter(row => row.entry !== undefined && (row.state === 'update' || row.state === 'repair') && marketEntryInstallBlock(row.entry) === undefined)
      if (targets.length === 0) return { kind: 'accepted', node: node(), source: [], feedback: { severity: 'info', message: t('no plugin updates to apply') } }
      for (const [index, row] of targets.entries()) {
        const prefix = t('{index} of {count}', { index: index + 1, count: targets.length })
        let message = t('plugin operation failed')
        const report = reportInto(context, text => { message = text })
        const ok = await runOperation(rowEntry(row), 'install', status => report({ ...status, text: status.tone === 'muted' ? `${prefix} · ${status.text}` : status.text }))
        if (unloaded) return { kind: 'cancelled' }
        if (!ok) return { kind: 'failed', node: node(), source: [], message: t('update all stopped at "{name}": {message}', { name: rowTitle(row), message }) }
      }
      return { kind: 'accepted', node: node(), source: [], feedback: { severity: 'success', message: t('updated {count} plugins; restart Mayfly and start a new session to apply', { count: targets.length }) } }
    }

    const handle: MayflyOverlayHandle = openUiOverlay(ctx, {
      id: 'mayfly.plugin-market', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Plugin marketplace'),
      scope: { kind: 'app', targetId: 'plugin-market' },
      onEvent: {
        observe: (event: MayflyUiObservationEvent) => {
          if (event.kind === 'tab-change') {
            const tab = MARKET_TABS.find(id => id === event.tabId)
            if (tab !== undefined && tab !== activeTab) { activeTab = tab; publish() }
          } else if (event.kind === 'focus-change' && event.itemId !== undefined) {
            const tab = MARKET_TABS.find(id => listId(id) === event.controlId)
            if (tab !== undefined && focused[tab] !== event.itemId) {
              focused[tab] = event.itemId
              if (tab === activeTab) publish()
            }
          }
        },
        action: async (event: MayflyUiActionEvent, context): Promise<MayflyUiActionReply> => {
          if (event.kind === 'selection-accept') {
            if (event.selectedIds[0] !== undefined) openDetail(event.selectedIds[0], 'market', lifetime.signal, publish)
            return { kind: 'completed' }
          }
          if (event.kind !== 'activate') return { kind: 'completed' }
          const id = event.inputs?.selections?.[0]?.selectedIds[0]
          switch (event.actionId) {
            case 'install':
            case 'update':
            case 'remove': {
              if (id === undefined) return { kind: 'completed' }
              const result = await rowAction(id, event.actionId, context)
              return result.ok
                ? { kind: 'accepted', node: node(), source: [], feedback: { severity: 'success', message: result.message } }
                : { kind: 'failed', node: node(), source: [], message: result.message }
            }
            case 'source': {
              const row = id === undefined ? undefined : rows().find(item => item.id === id)
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
              const ok = await refreshMarket(reportInto(context, text => { message = text }))
              return ok
                ? { kind: 'accepted', node: node(), source: [], feedback: { severity: 'success', message } }
                : { kind: 'failed', node: node(), source: [], message }
            }
            default:
              return { kind: 'completed' }
          }
        },
      },
    }, node(), { reopen: 'replace', onClosed: () => {
      offLocale()
      lifetime.abort()
    } })
    const offLocale = observeInteractionLocale(ctx, publish)
    // The panel mounts immediately with the loading document when the caller
    // opened before the first load settled; swap in the data when it arrives.
    if (catalog === undefined) {
      void reload(false).then(() => { publish() })
    }
    return { kind: 'success' }
  }

  const command = registerOwnedCommand(ctx, {
    name: 'plugin',
    description: 'Browse, install, and remove plugins',
    input: { hint: '[install <id> [--source npm|github>] | uninstall <id> | info <id> | list | updates | refresh]' },
    handler: async (invocation): Promise<CommandOutcome> => {
      const raw = invocation.rawInput.trim()
      if (raw === '') {
        return openBrowse('browse')
      }
      const tokens = raw.split(/\s+/)
      const verb = tokens[0]!
      const id = tokens[1]
      if (verb === 'refresh') {
        const result = await reload(true)
        if (unloaded) return { kind: 'success' }
        if (result.status === 'offline') {
          return { kind: 'error', text: t('refresh failed: {message}', { message: result.message }) }
        }
        return { kind: 'success', text: t('refreshed {count} entries', { count: String(result.index.entries.length) }) }
      }
      if (verb === 'list') {
        return openBrowse('installed')
      }
      if (verb === 'updates') {
        return openBrowse('updates')
      }
      if (verb === 'info') {
        if (id === undefined) return { kind: 'error', text: t('usage: /plugin info <id>') }
        if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly UI registry is not mounted') }
        if (catalog === undefined) await reload(false)
        if (unloaded) return { kind: 'success' }
        refreshInstalled()
        const row = findRow(id)
        if (row === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        openDetail(row.id, 'app', undefined, () => {})
        return { kind: 'success' }
      }
      if (verb === 'install' || verb === 'uninstall') {
        if (id === undefined) {
          return { kind: 'error', text: t('usage: /plugin {verb} <id> [--source npm|github]', { verb }) }
        }
        const sourceIndex = tokens.indexOf('--source')
        const requestedSource = sourceIndex === -1 ? undefined : tokens[sourceIndex + 1]
        if (sourceIndex !== -1 && requestedSource !== 'npm' && requestedSource !== 'github') {
          return { kind: 'error', text: t('usage: /plugin {verb} <id> [--source npm|github]', { verb }) }
        }
        if (catalog === undefined) await reload(false)
        if (unloaded) return { kind: 'success' }
        refreshInstalled()
        const row = findRow(id)
        if (row === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        const entry = rowEntry(row)
        const installBlock = verb === 'install' ? marketEntryInstallBlock(entry) : undefined
        if (installBlock !== undefined) return { kind: 'error', text: t(installBlock) }
        const source: InstallSource | undefined = requestedSource === 'npm' || requestedSource === 'github'
          ? requestedSource
          : sources.get(entry.id) ?? defaultInstallSource(entry)
        if (verb === 'install' && source === undefined) {
          return { kind: 'error', text: t('"{name}" has no common install source for every package', { name: entry.displayName }) }
        }
        if (verb === 'uninstall' && !row.installed) {
          return { kind: 'error', text: t('"{name}" is not installed in this profile', { name: entry.displayName }) }
        }
        if (verb === 'install' && usefulInTui(entry) === false) {
          notifications.report(`plugin/${entry.id}/compatibility`, { message: t('web-only plugin: it contributes nothing in this terminal frontend'), severity: 'warning' })
        }
        await operate(entry, verb, source ?? 'npm')
        return { kind: 'success' }
      }
      return { kind: 'error', text: t('usage: /plugin [install <id> | uninstall <id> | info <id> | list | updates | refresh]') }
    },
  })

  return () => {
    command()
  }
}
