/**
 * The `/plugin` command family: the marketplace browser over the index
 * published by Ephemeral-AI-Lab/dsh-plugins (`dist/index.json`). `/plugin`
 * opens installed/not-installed tabs over a type-to-filter catalog — Enter
 * opens the read-only detail panel, while declared actions install, remove,
 * and refresh; every operation reports progress and its result in its surface.
 * `install <id> [--source npm|github]`, `uninstall <id>`,
 * `info <id>`, and `refresh` run the argument paths directly. Installs and
 * removals shell out to `dsh plugin --profile <name> add|remove` — the same
 * seam the updater's swap uses — then remind that bundle membership is a
 * startup boundary: restart and start a new session. The catalog loads
 * cache-first and still serves stale data offline.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-commands
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { openUiOverlay } from './ui-overlay.ts'
import { ui, type MayflyInlineSpan, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { currentMayflySettings } from './settings.ts'
import { DEFAULT_MARKET_INDEX_URL, loadMarketCatalog, type CatalogResult } from './plugin-market/catalog.ts'
import {
  currentProfileInstallBlock,
  defaultInstallSource,
  entryInstallStates,
  entrySupportsSource,
  installEntry,
  marketEntryInstallBlock,
  readInstalledPlugins,
  rowSpec,
  uninstallEntry,
  type EntryInstallState,
  type InstallSource,
  type InstalledPlugin,
} from './plugin-market/installer.ts'
import type { MarketEntry } from './plugin-market/types.ts'
import { findDshCommand, profileRoot } from './updater/profile.ts'
import { profileNameFromArgv } from '../internal/profile.ts'
import { createInteractionNotificationOwner } from './notifications.ts'

/** Command outcome reused by every early-exit branch. */
type CommandOutcome = { readonly kind: 'success', readonly text?: string } | { readonly kind: 'error', readonly text: string }

/** One operation message shown either in the browser or the prompt editor. */
interface OperationStatus {
  readonly text: string
  readonly tone: 'muted' | 'warning' | 'success' | 'danger'
}
interface DetailSegment { readonly text: string, readonly style?: 'text' | 'textMuted' | 'accent' | 'success' | 'warning' }
interface DetailSection { readonly heading: string, readonly rows: readonly { readonly label: string, readonly segments: readonly DetailSegment[] }[] }

type OperationReporter = (status: OperationStatus) => void

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
  ctx.effect(() => () => {
    unloaded = true
  })
  /** The loaded catalog; `undefined` until the first load settles. */
  let catalog: CatalogResult | undefined
  /** Latest load claim; slower earlier requests cannot replace newer data. */
  let reloadGeneration = 0
  /** Plugins the profile carries; reread after every install or removal. */
  let installed: readonly InstalledPlugin[] = []
  /** One install or removal at a time, like the updater's in-flight guard. */
  let operationInFlight = false

  /** The active UI locale, for entry descriptions that ship both languages. */
  const locale = (): 'zh' | 'en' => {
    const service = ctx.get('mayflyLocale')
    /* v8 ignore next -- panels render only where the frontend ships the locale service */
    if (service === undefined) return 'en'
    return service.snapshot.locale
  }

  /** The configured index URL; the empty default means the official chain. */
  const indexUrl = (): string => currentMayflySettings(ctx).marketIndexUrl || DEFAULT_MARKET_INDEX_URL

  /** Load (or force-reload) the catalog and refresh derived profile state. */
  const reload = (force: boolean): Promise<CatalogResult> => {
    const generation = ++reloadGeneration
    return loadMarketCatalog(indexUrl(), force).then(result => {
      if (unloaded || generation !== reloadGeneration) return result
      catalog = result
      installed = readInstalledPlugins(profileRoot(profileNameFromArgv(process.argv)))
      return result
    })
  }

  /** Entries currently on hand (empty while offline or unloaded). */
  const entries = (): readonly MarketEntry[] => {
    /* v8 ignore next -- row paths run only after a load settled */
    if (catalog === undefined || catalog.status === 'offline') return []
    return catalog.index.entries
  }

  /** Install state per entry id. */
  const states = (): Readonly<Record<string, EntryInstallState>> => entryInstallStates(entries(), installed)

  /** One-line description in the active locale. */
  const describe = (entry: MarketEntry): string =>
    locale() === 'zh' && entry.descriptionZh !== undefined ? entry.descriptionZh : entry.description

  /** Which frontends the entry contributes its own UI to. */
  const surfaceBadge = (entry: MarketEntry): string => {
    if (currentProfileInstallBlock(entry) !== undefined) return 'Automation'
    const parts: string[] = []
    if (entry.surfaces.tui !== undefined) parts.push('TUI')
    if (entry.surfaces.web !== undefined) parts.push('Web')
    if (entry.surfaces.server !== undefined) parts.push('Server')
    /* v8 ignore next -- the manifest schema requires at least one surface */
    return parts.length === 0 ? '—' : parts.join('+')
  }

  /** Composite row badge: tier, surfaces, install state, status. */
  const badgeOf = (entry: MarketEntry, state: EntryInstallState | undefined): string => {
    const pieces = [entry.source, surfaceBadge(entry)]
    /* v8 ignore next -- states() carries every indexed entry id */
    if (state?.installed === true) {
      pieces.push(state.updateAvailable === true ? `up ${state.updateVersion!}` : 'installed')
    } else if (entry.install.rows.some(row => installed.some(plugin => plugin.name === row.name))) {
      pieces.push('partial')
    }
    if (entry.status !== 'stable') pieces.push(entry.status)
    return pieces.join(' · ')
  }

  /** Whether the entry contributes anything to this terminal frontend. */
  const usefulInTui = (entry: MarketEntry): boolean =>
    currentProfileInstallBlock(entry) === undefined
      && (entry.surfaces.server !== undefined || entry.surfaces.tui !== undefined)

  /** Find an entry by marketplace id or by one of its row package names. */
  const findEntry = (id: string): MarketEntry | undefined =>
    entries().find(entry => entry.id === id || entry.install.rows.some(row => row.name === id))

  /** Reread the profile dependencies after an operation. */
  const refreshInstalled = (): void => {
    installed = readInstalledPlugins(profileRoot(profileNameFromArgv(process.argv)))
  }

  /** Whether at least one package row from the entry is present. */
  const hasInstalledRows = (entry: MarketEntry): boolean =>
    entry.install.rows.some(row => installed.some(plugin => plugin.name === row.name))

  /**
   * Run one install or removal through the dsh CLI seam. Shared by the key
   * handlers and the argument paths so warnings, notices, and the in-flight
   * guard stay identical.
   */
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
      /* v8 ignore next -- a fiber unload landing inside these awaits is a shutdown race */
      if (unloaded) return false
      if (dshCommand === undefined) {
        report({ text: t('plugin operations need the dsh CLI on PATH (or $DSH_BIN)'), tone: 'danger' })
        return false
      }
      if (action === 'install' && entrySupportsSource(entry, source) === false) {
        report({ text: t('"{name}" has no {source} install source', { name: entry.displayName, source }), tone: 'danger' })
        return false
      }
      report({
        text: t(action === 'install' ? 'installing "{name}"...' : 'removing "{name}"...', { name: entry.displayName }),
        tone: 'muted',
      })
      const input = {
        dshCommand,
        profile: profileNameFromArgv(process.argv),
        root: profileRoot(profileNameFromArgv(process.argv)),
        entry,
        source,
        ...(reporter === undefined ? {} : { onProgress: (phase: 'verify' | 'rollback') => {
          report({
            text: t(phase === 'verify' ? 'checking "{name}" compatibility...' : 'rolling back "{name}"...', { name: entry.displayName }),
            tone: phase === 'verify' ? 'muted' : 'warning',
          })
        } }),
      }
      const outcome = action === 'install' ? await installEntry(input) : await uninstallEntry(input)
      /* v8 ignore next -- a fiber unload landing inside these awaits is a shutdown race */
      if (unloaded) return false
      if (outcome.kind === 'error') {
        report({
          text: t(action === 'install' ? 'install failed: {message}' : 'uninstall failed: {message}', { message: outcome.text }),
          tone: 'danger',
        })
        return false
      }
      refreshInstalled()
      report({
        text: t(action === 'install'
          ? 'installed; restart Mayfly and start a new session to apply'
          : 'removed; restart Mayfly and start a new session to apply'),
        tone: 'success',
      })
      return true
    } finally {
      operationInFlight = false
    }
  }

  /** The copyable manual install command for an entry's default source. */
  const installCommand = (entry: MarketEntry): string => {
    const source = defaultInstallSource(entry)
    if (source === undefined) {
      return `dsh plugin --profile <name> add <${entry.id}>`
    }
    const specs = entry.install.rows.map(row => rowSpec(row, source)!)
    const shellArgs = specs.map(spec => /^[A-Za-z0-9@._/+~-]+$/u.test(spec)
      ? spec
      : `'${spec.replaceAll("'", `'\\''`)}'`)
    const profile = currentProfileInstallBlock(entry) === undefined ? '<name>' : '<automation-name>'
    return `dsh plugin --profile ${profile} add ${shellArgs.join(' ')}`
  }

  /** The read-only detail panel for one entry. */
  function detailNode(entry: MarketEntry, state: EntryInstallState | undefined): MayflyUiNode {
    const segments = (text: string, style?: DetailSegment['style']): DetailSegment[] => [{ text, ...(style === undefined ? {} : { style }) }]
    const installBlock = currentProfileInstallBlock(entry)
    const tuiFull = installBlock === undefined && usefulInTui(entry)
    const webFull = installBlock === undefined && (entry.surfaces.web !== undefined || entry.surfaces.server !== undefined)
    const sections: DetailSection[] = [
      {
        heading: t('Overview'),
        rows: [
          {
            label: t('Status'),
            segments: [
              { text: entry.status, style: entry.status === 'stable' ? 'success' : 'warning' },
              ...(entry.statusNote === undefined ? [] : [{ text: ` — ${entry.statusNote}`, style: 'textMuted' as const }]),
            ],
          },
          { label: t('Source'), segments: segments(entry.source) },
          { label: t('Version'), segments: segments(state?.installed === true ? (state.version ?? 'installed') : (entry.verified?.packages[0]?.version ?? 'unknown')) },
          ...(state?.updateAvailable === true && state.version !== undefined
            ? [{ label: '', segments: segments(t('update available: {version}', { version: state.updateVersion! }), 'warning') }]
            : []),
          { label: '', segments: segments(describe(entry), 'textMuted') },
        ],
      },
      {
        heading: t('Surfaces'),
        rows: [
          { label: 'TUI', segments: segments(installBlock === undefined ? (tuiFull ? t('works here') : t('no contribution in this terminal')) : t(installBlock), tuiFull ? 'success' : 'warning') },
          { label: 'Web', segments: segments(installBlock === undefined ? (webFull ? t('works on dsh Web') : t('no contribution on dsh Web')) : t(installBlock), webFull ? 'success' : 'warning') },
        ],
      },
      {
        heading: t('Provides'),
        rows: (entry.provides?.tools ?? []).length + (entry.provides?.commands ?? []).length === 0
          ? [{ label: '', segments: segments(t('none declared'), 'textMuted') }]
          : [
              ...(entry.provides?.tools ?? []).map(tool => ({ label: t('Tools'), segments: segments(tool) })),
              ...(entry.provides?.commands ?? []).map(command => ({ label: t('Commands'), segments: segments(command) })),
            ],
      },
      {
        heading: t('Details'),
        rows: [
          ...(entry.engines === undefined ? [] : [{
            label: t('Engines'),
            segments: [entry.engines.dsh, entry.engines.mayfly, entry.engines.node]
              .filter((value): value is string => value !== undefined)
              .map(value => ({ text: value })),
          }]),
          ...(entry.capabilities === undefined || entry.capabilities.length === 0 ? [] : [{
            label: t('Capabilities'),
            segments: segments(entry.capabilities.join(', ')),
          }]),
          ...(entry.verified === undefined ? [] : [{
            label: t('Verified'),
            segments: segments(`${entry.verified.at} · ${entry.verified.packages.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}`),
          }]),
          ...(entry.status === 'removed' ? [] : [{ label: t('Install command'), segments: segments(installCommand(entry), 'accent') }]),
          ...(entry.links?.repo === undefined ? [] : [{ label: t('Links'), segments: segments(entry.links.repo, 'accent') }]),
        ],
      },
    ]
    const tone = (style: DetailSegment['style']): NonNullable<MayflyInlineSpan['tone']> => style === 'textMuted' ? 'muted' : style === 'accent' ? 'accent' : style === 'success' ? 'success' : style === 'warning' ? 'warning' : 'default'
    return ui.surface({ title: entry.displayName, chrome: 'overlay', padding: 1, child: ui.stack.column([
      ui.child(ui.scroll(ui.sections(sections.map(section => ({
        title: section.heading,
        body: ui.fields(section.rows.map(row => ({ label: row.label, value: row.segments.map(segment => {
          const semanticTone = tone(segment.style)
          return { text: segment.text, tone: semanticTone }
        }) }))),
      }))), { id: `plugin-detail-document/${entry.id}`, scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
      ui.actions({ id: 'plugin-detail-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
    ]) })
  }

  /** Open the marketplace as installed and not-installed tabs. */
  function openBrowse(initialGroup: 'installed' | 'not-installed'): CommandOutcome {
    if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly UI registry is not mounted') }
    const browseLifetime = new AbortController()
    const detailOwners = new Set<Fiber>()

    /** Indexed rows grouped by their current all-rows-installed state. */
    const marketItems = (): readonly MarketEntry[] => {
      return entries().filter(entry => entry.status !== 'removed' || hasInstalledRows(entry)).map(entry => entry)
    }
    const marketNode = (): MayflyUiNode => {
      if (catalog === undefined) {
        return ui.surface({ title: t('Plugin marketplace'), chrome: 'overlay', child: ui.loader({ message: t('loading catalog...') }) })
      }
      if (catalog.status === 'offline') {
        return ui.surface({ title: t('Plugin marketplace'), chrome: 'overlay', child: ui.stack.column([
          ui.text(t('marketplace is offline: {message}', { message: catalog.message }), { tone: 'danger' }),
          ui.actions({ id: 'plugin-market-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
        ]) })
      }
      const items = marketItems()
      const groupIds = ['installed', 'not-installed'] as const
      const groups = groupIds.map(group => {
        const groupItems = items.filter(entry => (hasInstalledRows(entry) ? 'installed' : 'not-installed') === group)
        return ui.child(ui.stack.column([
          ui.list({
            id: `plugins-${group}`,
            role: 'browse',
            filterable: true,
            selectedIds: [],
            items: groupItems.map(entry => ({ id: entry.id, label: entry.displayName, detail: entry.status === 'removed' ? (entry.statusNote ?? t('removed from the market')) : describe(entry), badge: badgeOf(entry, states()[entry.id]), searchText: `${entry.displayName} ${describe(entry)}` })),
            empty: ui.empty({ title: t(group === 'installed' ? 'no plugins installed' : 'no plugins available') }),
          }),
          ui.actions({ id: `plugin-market-${group}-actions`, items: [
            { id: 'details', label: t('Details'), selections: [{ pagePath: [{ controlId: 'plugin-market-tabs', itemId: group }], controlId: `plugins-${group}` }] },
            { id: 'install', label: t('Install'), ...(group === 'installed' ? { disabled: true, disabledReason: t('Already installed in this profile') } : {}), selections: [{ pagePath: [{ controlId: 'plugin-market-tabs', itemId: group }], controlId: `plugins-${group}` }] },
            { id: 'remove', label: t('Remove'), ...(group === 'not-installed' ? { disabled: true, disabledReason: t('Not installed in this profile') } : {}), selections: [{ pagePath: [{ controlId: 'plugin-market-tabs', itemId: group }], controlId: `plugins-${group}` }] },
          ] }),
        ]), { tab: { controlId: 'plugin-market-tabs', itemId: group } })
      })
      return ui.surface({ title: t('Plugin marketplace'), chrome: 'overlay', child: ui.stack.column([
        ui.tabs({ id: 'plugin-market-tabs', activeId: initialGroup, items: groupIds.map(group => ({ id: group, label: t(group === 'installed' ? 'Installed' : 'Not installed'), count: items.filter(entry => (hasInstalledRows(entry) ? 'installed' : 'not-installed') === group).length })) }),
        ...groups,
        ui.actions({ id: 'plugin-market-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
      ]) })
    }

    let handle!: ReturnType<typeof openUiOverlay>
    /** Install or remove the entry selected by an explicit surface action. */
    const runOperation = async (id: string, action: 'install' | 'uninstall', reporter: OperationReporter): Promise<boolean> => {
      const entry = findEntry(id)
      /* v8 ignore next -- browser actions only carry ids from indexed rows */
      if (entry === undefined) return false
      if (action === 'uninstall' && !hasInstalledRows(entry)) {
        reporter({ text: t('"{name}" is not installed in this profile', { name: entry.displayName }), tone: 'danger' })
        return false
      }
      const installBlock = action === 'install' ? marketEntryInstallBlock(entry) : undefined
      if (installBlock !== undefined) {
        reporter({ text: t(installBlock), tone: 'danger' })
        return false
      }
      if (action === 'install' && usefulInTui(entry) === false) {
        reporter({ text: t('web-only plugin: it contributes nothing in this terminal frontend'), tone: 'warning' })
      }
      const source = defaultInstallSource(entry)
      if (action === 'install' && source === undefined) {
        reporter({ text: t('"{name}" has no common install source for every package', { name: entry.displayName }), tone: 'danger' })
        return false
      }
      const completed = await operate(entry, action, source ?? 'npm', reporter)
      return completed
    }

    /** Mount the detail panel for one entry above the browse panel. */
    const openDetail = async (id: string): Promise<void> => {
      const entry = findEntry(id)
      /* v8 ignore next -- detail actions only ever carry entry ids from rows */
      if (entry === undefined) return
      const detailId = `mayfly.plugin-detail.${entry.id}`
      if (ctx.mayflyOverlays.focus(detailId)) return
      let owner: Fiber | undefined
      let closed = false
      owner = await ctx.plugin({
        name: 'mayfly-plugin-market-detail',
        inject: ['mayflyOverlays'],
        apply(scope: Context) {
          if (browseLifetime.signal.aborted) { closed = true; return }
          const view = () => detailNode(entry, states()[entry.id])
          const detail = openUiOverlay(scope, {
            id: detailId,
            presentation: 'editor',
            capturing: true,
            dismissal: 'discard',
            title: entry.displayName,
            scope: { kind: 'panel', parent: { kind: 'overlay', id: 'mayfly.plugin-market' } },
          }, view(), browseLifetime.signal)
          const offLocale = observeInteractionLocale(scope, () => { detail.set(view()) })
          const offRegistry = scope.mayflyOverlays.subscribe(delta => {
            if (delta.kind === 'remove' && delta.id === detailId && detail.closed) { closed = true; void owner?.dispose() }
          })
          scope.effect(() => () => { offLocale(); offRegistry(); detail.close(); detailOwners.delete(owner!) })
          if (detail.closed) closed = true
        },
      })
      if (closed || browseLifetime.signal.aborted) await owner.dispose()
      else detailOwners.add(owner)
    }

    const refreshMarket = async (reporter: OperationReporter): Promise<boolean> => {
        reporter({ text: t('refreshing plugin catalog...'), tone: 'muted' })
        const result = await reload(true)
          /* v8 ignore next -- a fiber unload landing inside the refresh await is a shutdown race */
          if (unloaded) return false
          if (result.status === 'offline') {
            reporter({ text: t('refresh failed: {message}', { message: result.message }), tone: 'danger' })
          } else {
            reporter({ text: t('refreshed {count} entries', { count: String(result.index.entries.length) }), tone: 'success' })
          }
          return result.status !== 'offline'
    }

    handle = openUiOverlay(ctx, { id: 'mayfly.plugin-market', presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Plugin marketplace'), scope: { kind: 'app', targetId: 'plugin-market' }, onEvent: {
      action: async (event, context) => {
        if (event.kind === 'selection-accept' && event.selectedIds[0] !== undefined) await openDetail(event.selectedIds[0])
        if (event.kind === 'activate' && event.actionId === 'details') {
          const id = event.inputs?.selections?.[0]?.selectedIds[0]
          if (id !== undefined) await openDetail(id)
        }
        if (event.kind === 'activate' && (event.actionId === 'install' || event.actionId === 'remove')) {
          const id = event.inputs?.selections?.[0]?.selectedIds[0]
          if (id !== undefined) {
            let message = t('plugin operation failed')
            const report: OperationReporter = status => {
              message = status.text
              context.report({ message: status.text, severity: status.tone === 'danger' ? 'error' : status.tone === 'warning' ? 'warning' : status.tone === 'success' ? 'success' : 'info', purpose: status.tone === 'muted' ? 'progress' : 'feedback' })
            }
            const completed = await runOperation(id, event.actionId === 'install' ? 'install' : 'uninstall', report)
            return completed ? { kind: 'accepted', node: marketNode(), source: [], feedback: { severity: 'success', message } } : { kind: 'failed', node: marketNode(), source: [], message }
          }
        }
        if (event.kind === 'activate' && event.actionId === 'refresh') {
          let message = t('refresh failed')
          const report: OperationReporter = status => {
            message = status.text
            context.report({ message, severity: status.tone === 'danger' ? 'error' : status.tone === 'success' ? 'success' : 'info', purpose: status.tone === 'muted' ? 'progress' : 'feedback' })
          }
          return await refreshMarket(report)
            ? { kind: 'accepted', node: marketNode(), source: [], feedback: { severity: 'success', message } }
            : { kind: 'failed', node: marketNode(), source: [], message }
        }
        return { kind: 'completed' as const }
      },
    } }, marketNode())
    const offLocale = observeInteractionLocale(ctx, () => { handle.set(marketNode()) })
    let cleanupBrowse!: () => void
    const offBrowse = ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'remove' && delta.id === 'mayfly.plugin-market' && handle.closed) cleanupBrowse()
    })
    cleanupBrowse = ctx.effect(() => () => {
      offLocale()
      offBrowse()
      browseLifetime.abort()
      for (const owner of detailOwners) void owner.dispose()
      detailOwners.clear()
    })
    // The panel mounts immediately with the loading document when the caller
    // opened before the first load settled; swap in the data when it arrives.
    if (catalog === undefined) {
      void reload(false).then(() => {
        if (unloaded) return
        handle.set(marketNode())
      })
    }
    return { kind: 'success' }
  }

  const command = ctx.commands.register({
    name: 'plugin',
    description: 'Browse, install, and remove plugins',
    input: { hint: '[install <id> [--source npm|github>] | uninstall <id> | info <id> | list | refresh]' },
    handler: async (invocation): Promise<CommandOutcome> => {
      const raw = invocation.rawInput.trim()
      if (raw === '') {
        return openBrowse('not-installed')
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
      if (verb === 'info') {
        if (id === undefined) return { kind: 'error', text: 'usage: /plugin info <id>' }
        if (ctx.get('mayflyOverlays') === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly UI registry is not mounted') }
        if (catalog === undefined) await reload(false)
        if (unloaded) return { kind: 'success' }
        const entry = findEntry(id)
        if (entry === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        let offLocale: () => void
        const view = () => detailNode(entry, states()[entry.id])
        const handle = openUiOverlay(ctx, { id: `mayfly.plugin-detail.${entry.id}`, presentation: 'editor', capturing: true, dismissal: 'discard', title: entry.displayName, scope: { kind: 'app', targetId: `plugin/${entry.id}` } }, view())
        offLocale = observeInteractionLocale(ctx, () => { handle.set(view()) })
        ctx.effect(() => () => offLocale())
        return { kind: 'success' }
      }
      if (verb === 'install' || verb === 'uninstall') {
        if (id === undefined) {
          return { kind: 'error', text: `usage: /plugin ${verb} <id> [--source npm|github]` }
        }
        const sourceIndex = tokens.indexOf('--source')
        const requestedSource = sourceIndex === -1 ? undefined : tokens[sourceIndex + 1]
        if (sourceIndex !== -1 && requestedSource !== 'npm' && requestedSource !== 'github') {
          return { kind: 'error', text: `usage: /plugin ${verb} <id> [--source npm|github]` }
        }
        if (catalog === undefined) await reload(false)
        if (unloaded) return { kind: 'success' }
        const entry = findEntry(id)
        if (entry === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        const installBlock = verb === 'install' ? marketEntryInstallBlock(entry) : undefined
        if (installBlock !== undefined) return { kind: 'error', text: t(installBlock) }
        const source: InstallSource | undefined = requestedSource === 'npm' || requestedSource === 'github'
          ? requestedSource
          : defaultInstallSource(entry)
        if (verb === 'install' && source === undefined) {
          return { kind: 'error', text: t('"{name}" has no common install source for every package', { name: entry.displayName }) }
        }
        if (verb === 'uninstall' && !hasInstalledRows(entry)) {
          return { kind: 'error', text: t('"{name}" is not installed in this profile', { name: entry.displayName }) }
        }
        if (verb === 'install' && usefulInTui(entry) === false) {
          notifications.report(`plugin/${entry.id}/compatibility`, { message: t('web-only plugin: it contributes nothing in this terminal frontend'), severity: 'warning' })
        }
        await operate(entry, verb, source ?? 'npm')
        return { kind: 'success' }
      }
      return { kind: 'error', text: 'usage: /plugin [install <id> | uninstall <id> | info <id> | list | refresh]' }
    },
  })

  return () => {
    command()
  }
}
