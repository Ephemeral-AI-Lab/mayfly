/**
 * The `/plugin` command family: the marketplace browser over the index
 * published by Ephemeral-AI-Lab/dsh-plugins (`dist/index.json`). `/plugin`
 * opens installed/not-installed tabs over a type-to-filter catalog — Enter
 * opens the read-only detail panel, `i` installs, `u` removes, `r` refreshes;
 * every operation reports progress and its result inside the panel.
 * `install <id> [--source npm|github]`, `uninstall <id>`,
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

/** Command outcome reused by every early-exit branch. */
type CommandOutcome = { readonly kind: 'success', readonly text?: string } | { readonly kind: 'error', readonly text: string }

/** One operation message shown either in the browser or the prompt editor. */
interface OperationStatus {
  readonly text: string
  readonly tone: 'muted' | 'warning' | 'success' | 'danger'
}

type OperationReporter = (status: OperationStatus) => void

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
    const report: OperationReporter = reporter ?? (status => getSharedEditor(ctx)?.notice?.(status.text))
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
  function detailPanel(entry: MarketEntry, state: EntryInstallState | undefined, onClose: () => void): InfoPanel {
    const display = displayServices(ctx)
    const segments = (text: string, style?: InfoSegment['style']): InfoSegment[] => [{ text, ...(style === undefined ? {} : { style }) }]
    const installBlock = currentProfileInstallBlock(entry)
    const tuiFull = installBlock === undefined && usefulInTui(entry)
    const webFull = installBlock === undefined && (entry.surfaces.web !== undefined || entry.surfaces.server !== undefined)
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

  /** Open the marketplace as installed and not-installed tabs. */
  function openBrowse(initialGroup: 'installed' | 'not-installed'): CommandOutcome {
    const display = displayServices(ctx)
    if (display === undefined) {
      return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly screen is not mounted') }
    }

    let panelStatus: OperationStatus | undefined

    /** Indexed rows grouped by their current all-rows-installed state. */
    const marketItems = (): readonly FrontendPanelItem[] => {
      const state = states()
      return entries().filter(entry => entry.status !== 'removed' || hasInstalledRows(entry)).map(entry => {
        const presentNow = hasInstalledRows(entry)
        const installBlocked = currentProfileInstallBlock(entry) !== undefined
        return {
          id: entry.id,
          label: entry.displayName,
          detail: entry.status === 'removed' ? (entry.statusNote ?? t('removed from the market')) : describe(entry),
          badge: badgeOf(entry, state[entry.id]),
          group: presentNow ? 'installed' : 'not-installed',
          action: { kind: 'plugin-market/details', id: entry.id },
          actionLabel: t('Details'),
          ...(!presentNow && installBlocked ? {} : {
            secondaryAction: { kind: presentNow ? 'plugin-market/uninstall' : 'plugin-market/install', id: entry.id },
            secondaryActionLabel: t(presentNow ? 'Uninstall' : 'Install'),
          }),
        }
      })
    }

    const model = (): FrontendPanelDocument => {
      if (catalog === undefined) {
        return { mode: 'loading', title: t('Plugin marketplace'), view: { kind: 'text', content: t('loading catalog...') } }
      }
      if (catalog.status === 'offline') {
        return {
          mode: 'error',
          title: t('Plugin marketplace'),
          view: { kind: 'text', content: panelStatus?.text ?? t('marketplace is offline: {message}', { message: catalog.message }) },
        }
      }
      const items = marketItems()
      const installedCount = items.filter(item => item.group === 'installed').length
      const notInstalledCount = items.length - installedCount
      return {
        mode: 'select',
        title: t('Plugin marketplace'),
        ...(panelStatus === undefined ? {} : { header: { kind: 'text', content: panelStatus.text, tone: panelStatus.tone } as const }),
        items,
        filterable: true,
        grouped: true,
        includeAllGroup: false,
        groups: ['installed', 'not-installed'],
        groupLabels: { installed: t('Installed'), 'not-installed': t('Not installed') },
        groupCounts: { installed: installedCount, 'not-installed': notInstalledCount },
        emptyByGroup: {
          installed: { title: t('no plugins installed') },
          'not-installed': { title: t('all marketplace plugins are installed') },
        },
      }
    }

    let panel: CanonicalDocumentController
    const reportInPanel: OperationReporter = (status) => {
      panelStatus = status
      panel.invalidate()
      display.screen.requestRender()
    }

    /** Install or remove the entry an `i`/`u` keypress selected. */
    const runOperation = (id: string, action: 'install' | 'uninstall'): void => {
      const entry = findEntry(id)
      /* v8 ignore next -- browser actions only carry ids from indexed rows */
      if (entry === undefined) return
      if (action === 'uninstall' && !hasInstalledRows(entry)) {
        reportInPanel({ text: t('"{name}" is not installed in this profile', { name: entry.displayName }), tone: 'danger' })
        return
      }
      const installBlock = action === 'install' ? marketEntryInstallBlock(entry) : undefined
      if (installBlock !== undefined) {
        reportInPanel({ text: t(installBlock), tone: 'danger' })
        return
      }
      if (action === 'install' && usefulInTui(entry) === false) {
        reportInPanel({ text: t('web-only plugin: it contributes nothing in this terminal frontend'), tone: 'warning' })
      }
      const source = defaultInstallSource(entry)
      if (action === 'install' && source === undefined) {
        reportInPanel({ text: t('"{name}" has no common install source for every package', { name: entry.displayName }), tone: 'danger' })
        return
      }
      void operate(entry, action, source ?? 'npm', reportInPanel).then(() => {
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
        reportInPanel({ text: t('refreshing plugin catalog...'), tone: 'muted' })
        void reload(true).then(result => {
          /* v8 ignore next -- a fiber unload landing inside the refresh await is a shutdown race */
          if (unloaded) return
          if (result.status === 'offline') {
            reportInPanel({ text: t('refresh failed: {message}', { message: result.message }), tone: 'danger' })
          } else {
            reportInPanel({ text: t('refreshed {count} entries', { count: String(result.index.entries.length) }), tone: 'success' })
          }
          panel.invalidate()
          display.screen.requestRender()
        })
      }
      else openDetail(id)
    }

    let restore: () => void
    panel = new CanonicalDocumentController({
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
      contextHints: () => [{
        id: 'navigate',
        keys: t('←→ tabs · ↑↓ select'),
        compact: '←→/↑↓',
        priority: 98,
      }, {
        id: 'plugin-operations',
        keys: t('i install · u remove · r refresh'),
        compact: 'i/u/r',
        priority: 95,
      }],
      initialGroup,
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
        if (catalog === undefined) await reload(false)
        if (unloaded) return { kind: 'success' }
        const entry = findEntry(id)
        if (entry === undefined) return { kind: 'error', text: t('unknown plugin: {id}', { id }) }
        const display = displayServices(ctx)
        if (display === undefined) return { kind: 'error', text: t('plugin browser is unavailable: the Mayfly screen is not mounted') }
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
