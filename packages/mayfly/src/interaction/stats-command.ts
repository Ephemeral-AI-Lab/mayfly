/** `/stats`: the live session, the stored sessions' history, and the per-model usage in one tabbed panel.
 * @module @ephemeral-ai/mayfly/interaction/stats-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { MayflyOverlayHandle, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { StatsPanel } from '../components/stats-panel.ts'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { copyTextToClipboard } from './clipboard-write.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'
import { loadModelsDevIndex, type ModelsDevIndex } from './models-dev.ts'
import type { ModelTokens, PriceSources, UserPrice } from './pricing.ts'
import { HARNESS_LINE, SESSION_INFO_KEYS, sessionInfoFacts } from './session-commands.ts'
import { currentMayflySettings } from './settings.ts'
import { buildStatsFacts, statsSummary, STATS_TABS, type IndexState, type StatsTab } from './stats-facts.ts'
import { foldDigest, type SessionDigest } from './stats-index/digest.ts'
import { createStatsIndex, readDigests, refreshStatsIndex } from './stats-index/index.ts'
import { readAccountSnapshot, type AccountSnapshot } from './stats-account.ts'
import { aggregate, RANGES, type StatsRange } from './stats-index/stats.ts'
import { openUiOverlay } from './ui-overlay.ts'

export const name = 'mayfly-stats'
export const inject = ['commands', 'mayflyOverlays']
export interface Config { readonly displayVersion?: string }

const OVERLAY_ID = 'mayfly.stats'
/** The index repaints at most this often while sessions are read. */
const REPAINT_MS = 100
/** A provider read is reused this long; a failed one is read again when the tab is shown. */
const ACCOUNT_FRESH_MS = 5 * 60 * 1000

export function apply(ctx: Context, config: Config = {}): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const t = interactionTranslator(ctx)
  const index = createStatsIndex(ctx)
  /** The last provider read, kept across panel opens for its route. */
  let accountCache: AccountSnapshot | undefined
  ctx.effect(() => () => { accountCache = undefined })
  const version = { mayfly: config.displayVersion ?? MAYFLY_VERSION, harness: HARNESS_LINE }
  ctx.inject(['mayflyCurrentAgent', 'sessionProjections', 'mayflyInteractionState'], owner => {
    owner.commands.register({
      name: 'stats', description: t('Show this session, the history of your sessions, and the usage per model'),
      handler: invocation => {
        const agent = invocation.agent
        if (lifetime.signal.aborted || invocation.signal.aborted) return { kind: 'success' }
        if (owner.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: t('no session is live yet') }
        const overlay = new AbortController()
        const signal = AbortSignal.any([lifetime.signal, invocation.signal, overlay.signal])
        let tab: StatsTab = 'session'
        let range: StatsRange = 'all'
        let allWorkspaces = true
        let closed = false
        let progress: IndexState | undefined
        let generation: AbortController | undefined
        let started: boolean | undefined
        let modelsDev: ModelsDevIndex | undefined
        let accountGeneration: AbortController | undefined
        let accountLoading = false
        let memo: { readonly events: number, readonly digest: SessionDigest | undefined, readonly tokens: readonly ModelTokens[] } | undefined
        let handle: MayflyOverlayHandle | undefined
        let timer: ReturnType<typeof setTimeout> | undefined

        const readSession = (): ReturnType<typeof sessionInfoFacts> | undefined => {
          try { return sessionInfoFacts(owner, agent) } catch { return undefined }
        }
        /** The current session folded from its own events, again only when its log grew: it counts before it is stored. */
        const liveDigest = (): { readonly digest: SessionDigest | undefined, readonly tokens: readonly ModelTokens[] } => {
          const events = agent.session.snapshotEvents()
          if (memo?.events === events.length) return memo
          const digest = foldDigest(String(agent.id), agent.session.header.cwd, events)
          const tokens = digest === undefined ? [] : aggregate([digest], 'all', Date.now()).models
          memo = { events: events.length, digest, tokens }
          return memo
        }
        const sessionTokens = (): readonly ModelTokens[] => liveDigest().tokens
        /** The stored sessions the index has read, with the current one (from its live events) in place of its stored copy. */
        const digests = (): readonly SessionDigest[] => {
          const stored = readDigests(index, cwd())
          const live = liveDigest().digest
          if (live === undefined || (cwd() !== undefined && live.cwd !== cwd())) return stored
          return [live, ...stored.filter(digest => digest.id !== live.id)]
        }
        const sources = (): PriceSources => {
          const settings = currentMayflySettings(owner)
          return { user: settings.prices as Readonly<Record<string, UserPrice>>, modelsDev, usdCnyRate: settings.usdCnyRate }
        }
        /** The provider route of the current model. */
        const routeOf = (): string | undefined => readSession()?.model?.provider
        /**
         * Read the provider of the current model once per five minutes (and again after a failed read). The last result
         * stays on show while a newer one loads.
         */
        const loadAccount = (): void => {
          const route = routeOf()
          if (route === undefined || accountLoading) return
          const cached = accountCache?.route === route ? accountCache : undefined
          const failed = cached?.balance?.status === 'unavailable' && cached.balance.reason !== 'signed-out' && cached.balance.reason !== 'no-key'
          if (cached !== undefined && !failed && Date.now() - cached.at < ACCOUNT_FRESH_MS) return
          accountGeneration?.abort()
          const mine = new AbortController()
          accountGeneration = mine
          accountLoading = true
          const retire = AbortSignal.any([signal, mine.signal])
          schedule()
          void readAccountSnapshot(owner, route, retire).then(snapshot => {
            if (!retire.aborted) accountCache = snapshot
          }).catch((error: unknown) => {
            if (!retire.aborted) owner.logger.warn(`stats: account read failed: ${error instanceof Error ? error.message : String(error)}`)
          }).finally(() => {
            if (accountGeneration !== mine || closed) return
            accountLoading = false
            publish()
          })
        }
        const cwd = (): string | undefined => allWorkspaces ? undefined : agent.session.header.cwd
        const facts = () => buildStatsFacts({
          t, locale: owner.get('mayflyLocale')?.locale === 'zh' ? 'zh' : 'en', now: Date.now(), tab, range, allWorkspaces,
          session: readSession(), sessionTokens: sessionTokens(), digests: digests(), index: progress, sources: sources(), version,
          account: { snapshot: accountCache?.route === routeOf() ? accountCache : undefined, loading: accountLoading },
          lowBalance: { CNY: currentMayflySettings(owner).lowBalanceCny, USD: currentMayflySettings(owner).lowBalanceUsd },
        })
        const node = () => StatsPanel(facts())
        const publish = (): void => {
          if (closed || handle?.closed !== false) return
          if (timer !== undefined) { clearTimeout(timer); timer = undefined }
          handle.set(node())
        }
        /** A burst of progress or projection changes repaints once. */
        const schedule = (): void => {
          if (closed || timer !== undefined) return
          timer = setTimeout(() => { timer = undefined; publish() }, REPAINT_MS)
        }

        /** Read the stored sessions for the scope on show; a newer read retires the one before it. */
        const startIndex = (): void => {
          generation?.abort()
          const mine = new AbortController()
          generation = mine
          started = true
          const retire = AbortSignal.any([signal, mine.signal])
          progress = { running: true, done: 0, total: 0, skipped: 0, failed: 0 }
          schedule()
          void refreshStatsIndex(owner, index, cwd(), retire, state => {
            if (generation === mine) { progress = { running: true, ...state }; schedule() }
          }).catch((error: unknown) => {
            if (retire.aborted) return
            const message = error instanceof Error ? error.message : String(error)
            owner.logger.warn(`stats: index failed: ${message}`)
            if (generation === mine) progress = { running: false, done: 0, total: 0, skipped: 0, failed: 0, error: message }
          }).finally(() => {
            if (generation !== mine || closed) return
            progress = progress === undefined ? undefined : { ...progress, running: false }
            publish()
          })
        }
        const showTab = (next: StatsTab): void => {
          if (next === tab) return
          tab = next
          if ((tab === 'history' || tab === 'models') && started !== true) startIndex()
          if (tab === 'account') loadAccount()
          publish()
        }

        const copy = async (): Promise<MayflyUiActionReply> => {
          try {
            const method = await copyTextToClipboard(statsSummary(facts(), tab))
            return { kind: 'completed', feedback: { severity: 'success', message: `${t('copied the stats summary')}${method === 'osc52' ? t(' via terminal escape sequence (unverified)') : ''}` } }
          } catch (error) {
            return { kind: 'failed', message: t('could not copy: {error}', { error: error instanceof Error ? error.message : String(error) }) }
          }
        }

        const offs: (() => void)[] = []
        handle = openUiOverlay(owner, {
          id: OVERLAY_ID, presentation: 'editor', capturing: true, dismissal: 'discard', title: t('Stats'),
          scope: { kind: 'session', sessionId: agent.id },
          onEvent: {
            observe: (event: MayflyUiObservationEvent) => {
              if (event.kind !== 'tab-change') return
              const next = STATS_TABS.find(id => id === event.tabId)
              if (next !== undefined) showTab(next)
            },
            action: async (event: MayflyUiActionEvent): Promise<MayflyUiActionReply> => {
              if (event.kind !== 'activate') return { kind: 'completed' }
              switch (event.actionId) {
                case 'refresh':
                  return { kind: 'accepted', node: node(), source: [] }
                case 'range':
                  range = RANGES[(RANGES.indexOf(range) + 1) % RANGES.length]!
                  return { kind: 'accepted', node: node(), source: [] }
                case 'workspace':
                  allWorkspaces = !allWorkspaces
                  startIndex()
                  return { kind: 'accepted', node: node(), source: [] }
                case 'copy':
                  return copy()
                default:
                  return { kind: 'completed' }
              }
            },
          },
        }, node(), { signal, reopen: 'focus', onClosed: () => {
          closed = true
          if (timer !== undefined) clearTimeout(timer)
          generation?.abort()
          accountGeneration?.abort()
          overlay.abort()
          for (const off of offs.splice(0)) off()
        } })
        if (handle === undefined) return { kind: 'success' }
        const live = handle
        offs.push(
          owner.sessionProjections.onChanged((session, key) => { if (session === agent.session && SESSION_INFO_KEYS.some(item => item === key)) schedule() }),
          owner.on('agent/status', ({ agent: changed }) => { if (changed === agent) schedule() }),
          observeInteractionLocale(owner, schedule),
          owner.mayflyCurrentAgent.subscribe(current => { if (current !== agent) live.close() }),
        )
        // The best-effort price catalog arrives later; the panel is complete without it.
        loadAccount()
        void loadModelsDevIndex(owner, signal).then(loaded => { modelsDev = loaded; schedule() }).catch(() => {})
        return { kind: 'success' }
      },
    })
  })
}
