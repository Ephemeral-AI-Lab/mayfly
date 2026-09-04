/**
 * The `/plugin` command family: the marketplace browser over the index
 * published by Ephemeral-AI-Lab/dsh-plugins (`dist/index.json`). `/plugin`
 * opens a grouped, type-to-filter catalog — Enter opens the read-only
 * detail panel, `i` installs, `u` removes, `r` refreshes; `/plugin list`
 * shows what the profile carries, what has updates, and what left the
 * market; `install <id> [--source npm|github]`, `uninstall <id>`,
 * `info <id>`, and `refresh` run the argument paths directly. Installs and
 * removals shell out to `dsh plugin --profile <name> add|remove` — the same
 * seam the updater's swap uses — then remind that bundle membership is a
 * startup boundary: restart and start a new session. The catalog loads
 * cache-first and still serves stale data offline.
 *
 * @module @ephemeral-ai/mayfly/interaction/plugin-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Action } from '../frontend/index.ts'
import { displayServices } from './display-services.ts'
import { getSharedEditor } from './editor-instance.ts'
import { mountEditorReplacement } from './editor-panel-controller.ts'
import { CanonicalDocumentController, type FrontendPanelDocument, type FrontendPanelItem } from './frontend-panel.ts'
import { InfoPanel, type InfoSection, type InfoSegment } from './info-panel.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { currentMayflySettings } from './settings.ts'
import { DEFAULT_MARKET_INDEX_URL, loadMarketCatalog, type CatalogResult } from './plugin-market/catalog.ts'
import {
  defaultInstallSource,
  entryInstallStates,
  entrySupportsSource,
  installEntry,
  readInstalledPlugins,
  rowSpec,
  uninstallEntry,
  type EntryInstallState,
  type InstallSource,
  type InstalledPlugin,
} from './plugin-market/installer.ts'
import type { MarketEntry } from './plugin-market/types.ts'
import { findDshBin, profileNameFromArgv, profileRoot } from './updater/profile.ts'

/** Command outcome reused by every early-exit branch. */
type CommandOutcome = { readonly kind: 'success', readonly text?: string } | { readonly kind: 'error', readonly text: string }

/**
 * Register `/plugin`.
 * @param ctx - the interaction context.
 * @returns the disposer removing the command.
 */
export function registerPluginCommand(ctx: Context): () => void {
  const t = interactionTranslator(ctx)
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
    if (state?.installed === true) pieces.push(state.updateAvailable === true ? `up ${state.version ?? ''}`.trim() : 'installed')
    if (entry.status === 'beta' || entry.status === 'unstable' || entry.status === 'deprecated') pieces.push(entry.status)
    return pieces.join(' · ')
  }

  /** Whether the entry contributes anything to this terminal frontend. */
  const usefulInTui = (entry: MarketEntry): boolean =>
    entry.surfaces.server !== undefined || entry.surfaces.tui !== undefined

  /** Find an entry by marketplace id or by one of its row package names. */
  const findEntry = (id: string): MarketEntry | undefined =>
    entries().find(entry => entry.id === id || entry.install.rows.some(row => row.name === id))

  /** Reread the profile dependencies after an operation. */
  const refreshInstalled = (): void => {
    installed = readInstalledPlugins(profileRoot(profileNameFromArgv(process.argv)))
  }

  /**
   * Run one install or removal through the dsh CLI seam. Shared by the key
   * handlers and the argument paths so warnings, notices, and the in-flight
   * guard stay identical.
   */
  async function operate(entry: MarketEntry, action: 'install' | 'uninstall', source: InstallSource): Promise<void> {
    if (operationInFlight) {
      getSharedEditor(ctx)?.notice?.('a plugin operation is already running')
      return
    }
    // Claim before the first await so overlapping keypresses cannot both run.
    operationInFlight = true
    try {
      const dshBin = await findDshBin()
      /* v8 ignore next -- a fiber unload landing inside these awaits is a shutdown race */
      if (unloaded) return
      if (dshBin === undefined) {
        getSharedEditor(ctx)?.notice?.('plugin operations need the dsh CLI on PATH (or $DSH_BIN)')
        return
      }
      if (action === 'install' && entrySupportsSource(entry, source) === false) {
        getSharedEditor(ctx)?.notice?.(`"${entry.displayName}" has no ${source} install source`)
        return
      }
      getSharedEditor(ctx)?.notice?.(t(action === 'install' ? 'installing "{name}"...' : 'removing "{name}"...', { name: entry.displayName }))
      const input = { dshBin, profile: profileNameFromArgv(process.argv), root: profileRoot(profileNameFromArgv(process.argv)), entry, source }
      const outcome = action === 'install' ? await installEntry(input) : await uninstallEntry(input)
      /* v8 ignore next -- a fiber unload landing inside these awaits is a shutdown race */
      if (unloaded) return
      if (outcome.kind === 'error') {
        getSharedEditor(ctx)?.notice?.(t(action === 'install' ? 'install failed: {message}' : 'uninstall failed: {message}', { message: outcome.text }))
        return
      }
      refreshInstalled()
      getSharedEditor(ctx)?.notice?.(t(action === 'install'
        ? 'installed; restart Mayfly and start a new session to apply'
        : 'removed; restart Mayfly and start a new session to apply'))
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
    return `dsh plugin --profile <name> add ${entry.install.rows.map(row => rowSpec(row, source)).join(' ')}`
  }

  /** The read-only detail panel for one entry. */
  function detailPanel(entry: MarketEntry, state: EntryInstallState | undefined, onClose: () => void): InfoPanel {
    const display = displayServices(ctx)
    const segments = (text: string, style?: InfoSegment['style']): InfoSegment[] => [{ text, ...(style === undefined ? {} : { style }) }]
    const tuiFull = usefulInTui(entry)
    const webFull = entry.surfaces.web !== undefined || entry.surfaces.server !== undefined
    const sections: InfoSection[] = [
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
            ? [{ label: '', segments: segments(t('update available: {version}', { version: state.version }), 'warning') }]
            : []),
          { label: '', segments: segments(describe(entry), 'textMuted') },
        ],
      },
      {
        heading: t('Surfaces'),
        rows: [
          { label: 'TUI', segments: segments(tuiFull ? t('works here') : t('no contribution in this terminal'), tuiFull ? 'success' : 'warning') },
          { label: 'Web', segments: segments(webFull ? t('works on dsh Web') : t('no contribution on dsh Web'), webFull ? 'success' : 'warning') },
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
          { label: t('Install command'), segments: segments(installCommand(entry), 'accent') },
          ...(entry.links?.repo === undefined ? [] : [{ label: t('Links'), segments: segments(entry.links.repo, 'accent') }]),
        ],
      },
    ]
    return new InfoPanel({
      theme: display!.theme,
      components: display!.components,
      keymap: display!.keymap,
      title: entry.displayName,
      sections,
      onClose,
      t,
    })
  }

  /**
   * Open the browse panel. `mode` selects the catalog (grouped by source
   * tier) or the installed view (grouped by installed / updates / removed).
   */
  function openBrowse(mode: 'catalog' | 'installed'): CommandOutcome {
    const display = displayServices(ctx)
    if (display === undefined) {
      return { kind: 'error', text: 'plugin browser is unavailable: the Mayfly screen is not mounted' }
    }

    /** Rows for the catalog mode: live entries except tombstones. */
    const catalogItems = (): readonly FrontendPanelItem[] =>
      entries().filter(entry => entry.status !== 'removed').map(entry => {
        return {
          id: entry.id,
          label: entry.displayName,
          detail: describe(entry),
          badge: badgeOf(entry, states()[entry.id]),
          group: entry.source,
          action: { kind: 'plugin-market/details', id: entry.id },
          actionLabel: t('Details'),
        }
      })

    /** Rows for the installed mode: profile deps joined against the index. */
    const installedItems = (): readonly FrontendPanelItem[] => {
      const installedByName = new Map(installed.map(plugin => [plugin.name, plugin]))
      const indexedNames = new Set(entries().flatMap(entry => entry.install.rows.map(row => row.name)))
      const state = states()
      const rank = { installed: 0, updates: 1, removed: 2 } as const
      const marketRows = entries().flatMap((entry): readonly FrontendPanelItem[] => {
        const present = entry.install.rows.filter(row => installedByName.has(row.name))
        if (present.length === 0) return []
        const entryState = state[entry.id]
        const removed = entry.status === 'removed'
        const update = entryState?.updateAvailable === true
        const latest = entry.install.rows.map(row => entry.npm?.[row.name]?.latestVersion).find(version => version != null)
        const pieces = [
          entryState?.installed === true ? entryState.version : 'partial',
          update && latest !== null && latest !== undefined ? `up ${latest}` : undefined,
          removed ? 'removed' : undefined,
        ].filter((piece): piece is string => piece !== undefined)
        return [{
          id: entry.id,
          label: entry.displayName,
          detail: removed ? (entry.statusNote ?? t('removed from the market')) : describe(entry),
          badge: pieces.join(' · '),
          group: removed ? 'removed' : update ? 'updates' : 'installed',
          action: { kind: 'plugin-market/details', id: entry.id },
          actionLabel: t('Details'),
        }]
      })
      const removedRows = installed.filter(plugin => !indexedNames.has(plugin.name)).map(plugin => ({
        id: plugin.name,
        label: plugin.name,
        detail: plugin.spec,
        badge: 'removed',
        group: 'removed',
      }))
      const rows = [...marketRows, ...removedRows]
      /* v8 ignore next -- every row above sets one of the three groups */
      return [...rows].sort((a, b) => (rank[a.group as keyof typeof rank] ?? 0) - (rank[b.group as keyof typeof rank] ?? 0))
    }

    const model = (): FrontendPanelDocument => {
      if (catalog === undefined) {
        return { mode: 'loading', title: t('Plugin marketplace'), view: { kind: 'text', content: t('loading catalog...') } }
      }
      if (catalog.status === 'offline') {
        return { mode: 'error', title: t('Plugin marketplace'), view: { kind: 'text', content: t('marketplace is offline: {message}', { message: catalog.message }) } }
      }
      // One flat list: the tier rides in the badge and the index order sorts
      // official → dsh → community, so no tab row comes between focus and
      // the rows (Enter on a row opens its detail, the trace-panel pattern).
      const items = mode === 'catalog' ? catalogItems() : installedItems()
      return {
        mode: 'select',
        title: t('Plugin marketplace'),
        items,
        filterable: true,
        empty: mode === 'catalog'
          ? { title: t('No plugins indexed') }
          : { title: t('no plugins installed') },
      }
    }

    /** Install or remove the entry an `i`/`u` keypress selected. */
    const runOperation = (id: string, action: 'install' | 'uninstall'): void => {
      const entry = findEntry(id)
      if (entry === undefined) return
      if (action === 'uninstall' && states()[entry.id]?.installed !== true) {
        getSharedEditor(ctx)?.notice?.(`"${entry.displayName}" is not installed in this profile`)
        return
      }
      if (action === 'install' && usefulInTui(entry) === false) {
        getSharedEditor(ctx)?.notice?.(t('web-only plugin: it contributes nothing in this terminal frontend'))
      }
      const source = defaultInstallSource(entry)
      if (action === 'install' && source === undefined) {
        getSharedEditor(ctx)?.notice?.(`"${entry.displayName}" has no common install source for every package`)
        return
      }
      void operate(entry, action, source ?? 'npm').then(() => {
        if (unloaded) return
        panel.invalidate()
        display.screen.requestRender()
      })
    }

    /** Mount the detail panel for one entry above the browse panel. */
    const openDetail = (id: string): void => {
      const entry = findEntry(id)
      /* v8 ignore next -- detail actions only ever carry entry ids from rows */
      if (entry === undefined) return
      let restoreDetail: () => void
      let offDetail: () => void
      const detail = detailPanel(entry, states()[entry.id], () => {
        offDetail()
        restoreDetail()
      })
      restoreDetail = mountEditorReplacement(ctx, detail)
      offDetail = observeInteractionLocale(ctx, () => {
        detail.invalidate()
        display.screen.requestRender()
      })
    }

    const handleAction = (action: Action): void => {
      const id = String(action.id ?? '')
      if (action.kind === 'plugin-market/install') runOperation(id, 'install')
      else if (action.kind === 'plugin-market/uninstall') runOperation(id, 'uninstall')
      else if (action.kind === 'plugin-market/refresh') {
        void reload(true).then(result => {
          /* v8 ignore next -- a fiber unload landing inside the refresh await is a shutdown race */
          if (unloaded) return
          if (result.status === 'offline') {
            getSharedEditor(ctx)?.notice?.(t('refresh failed: {message}', { message: result.message }))
          }
          panel.invalidate()
          display.screen.requestRender()
        })
      }
      else openDetail(id)
    }

    let restore: () => void
    const panel = new CanonicalDocumentController({
      keymap: display.keymap,
      theme: display.theme,
      components: display.components,
      model,
      t,
      onAction: action => handleAction(action),
      onClose: () => {
        offLocale()
        restore()
      },
      onUnhandledInput: (data, selectedId): Action | undefined => {
        // Refresh works without a selection; install and remove need a row.
        if (data === 'r' || data === 'R') return { kind: 'plugin-market/refresh' }
        if (selectedId === undefined) return undefined
        if (data === 'i' || data === 'I') return { kind: 'plugin-market/install', id: selectedId }
        if (data === 'u' || data === 'U') return { kind: 'plugin-market/uninstall', id: selectedId }
        return undefined
      },
    })
    restore = mountEditorReplacement(ctx, panel)
    const offLocale = observeInteractionLocale(ctx, () => {
      panel.invalidate()
      display.screen.requestRender()
    })
    // The panel mounts immediately with the loading document when the caller
    // opened before the first load settled; swap in the data when it arrives.
    if (catalog === undefined) {
      void reload(false).then(() => {
        if (unloaded) return
        panel.invalidate()
        display.screen.requestRender()
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
        return openBrowse('catalog')
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
        if (catalog === undefined) await reload(false)
        if (unloaded) return { kind: 'success' }
        const entry = findEntry(id)
        if (entry === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        const display = displayServices(ctx)
        if (display === undefined) return { kind: 'error', text: 'plugin browser is unavailable: the Mayfly screen is not mounted' }
        let restore: () => void
        let offLocale: () => void
        const panel = detailPanel(entry, states()[entry.id], () => {
          offLocale()
          restore()
        })
        restore = mountEditorReplacement(ctx, panel)
        offLocale = observeInteractionLocale(ctx, () => {
          panel.invalidate()
          display.screen.requestRender()
        })
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
        const source: InstallSource | undefined = requestedSource === 'npm' || requestedSource === 'github'
          ? requestedSource
          : defaultInstallSource(entry)
        if (verb === 'install' && source === undefined) {
          return { kind: 'error', text: `"${entry.displayName}" has no common install source for every package` }
        }
        if (verb === 'uninstall' && states()[entry.id]?.installed !== true) {
          return { kind: 'error', text: `"${entry.displayName}" is not installed in this profile` }
        }
        if (verb === 'install' && usefulInTui(entry) === false) {
          getSharedEditor(ctx)?.notice?.(t('web-only plugin: it contributes nothing in this terminal frontend'))
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
