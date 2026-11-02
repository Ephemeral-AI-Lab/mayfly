/** rc.2 statistics tabs over whole Host digests and native Client projections. @module */
import {
  StatsPanel, buildStatsFacts, statsSummary, STATS_TABS, RANGES, aggregate,
  type AccountSnapshot, type IndexState, type SessionDigest, type StatsRange, type StatsTab,
} from '@ephemeral-ai/mayfly/stats-presentation'
import { currentMayflySettings } from '@ephemeral-ai/mayfly/settings'
import { loadModelsDevIndex, type ModelsDevIndex } from '@ephemeral-ai/mayfly/configuration-panels'
import { interactionTranslator, mountInteractionLocale } from '@ephemeral-ai/mayfly/editor-presentation'
import type { MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import type { MayflyStatsDigest, MayflyStatsSession } from '@ephemeral-ai/mayfly-host/types'
import { mayflyHostRemote } from '../../frontend/host-mount.ts'
import { remoteEffectiveReasoningEffort } from '../../transcript/remote-model.ts'
import type { RemoteFeatureSelection } from '../features.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import { remoteValue, remoteErrorMessage } from '../features/official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { remoteSessionInformation, REMOTE_SESSION_INFO_KEYS } from '../session-information.ts'
import { copyLocalText } from '../local/clipboard.ts'
import { remoteClientVersion } from '../features/version.ts'
import { remoteStatsAccount } from './stats-account.ts'
import { remoteReadNumber, type RemoteOperationsContext } from './support.ts'

/** Decode the Host's complete digest; this never reads or folds Session events. */
export function remoteStatsDigest(value: MayflyStatsDigest): SessionDigest {
  return { ...value, cwd: value.cwd, days: new Map(value.days.map(day => [day.key, { turns: day.turns, models: new Map(day.models.map(model => [`${model.provider}\0${model.model}`, { ...model, peak: { ...model.peak }, offPeak: { ...model.offPeak } }])) }])) }
}

const ACCOUNT_FRESH_MS = 5 * 60 * 1000
const REPAINT_MS = 100
const KEYS = [...REMOTE_SESSION_INFO_KEYS, 'sessionStats'] as const

class RemoteStatsController {
  private readonly t
  private readonly lifecycle: RemoteFeatureLifecycle
  private panel: RemoteBrowserPanel | undefined
  private retire: (() => void) | undefined
  private accountCache: AccountSnapshot | undefined

  constructor(private readonly context: RemoteOperationsContext) {
    mountInteractionLocale(context.base.ctx)
    this.t = interactionTranslator(context.base.ctx)
    this.lifecycle = new RemoteFeatureLifecycle(context.base, () => {
      this.retire?.()
      this.accountCache = undefined
    })
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    this.lifecycle.dispose()
    this.retire?.()
    this.accountCache = undefined
  }

  readonly execute = async (input: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    if (input.trim() !== '') throw new Error('Usage: /stats')
    const current = this.context.base.hosts.current()
    if (current === undefined) throw new Error(this.t('no session is live yet'))
    if (this.context.base.ctx.mayflyOverlays.focus('mayfly.stats')) return
    this.retire?.()
    this.open(current, this.lifecycle.currentGeneration(), signal)
  }

  private open(current: RemoteFeatureSelection, captured: number, parent: AbortSignal): void {
    const { base } = this.context
    const lifetime = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, parent])
    const valid = (): boolean => {
      const next = this.lifecycle.selection(captured)
      return !signal.aborted && next?.client === current.client && next.binding === current.binding
        && next.ref.host === current.ref.host && next.ref.sessionId === current.ref.sessionId
    }
    let tab: StatsTab = 'session'
    let range: StatsRange = 'all'
    let allWorkspaces = true
    let session: MayflyStatsSession | undefined
    let stored: readonly SessionDigest[] = []
    let progress: IndexState | undefined
    let modelsDev: ModelsDevIndex | undefined
    let accountLoading = false
    let accountRoute: string | undefined
    let accountGeneration: AbortController | undefined
    let historyGeneration: AbortController | undefined
    let sessionGeneration: AbortController | undefined
    let started = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let sessionDirty = false
    const offs: Array<() => void> = []
    const version = { mayfly: remoteClientVersion(), harness: '' }
    const usage = () => {
      const facts = remoteSessionInformation(current.binding, { model: undefined, provider: undefined })
      if (facts.model === undefined) return facts
      const reasoningEffort = remoteEffectiveReasoningEffort(current.binding, this.context.options.modelCatalog?.(current.ref.host))
      return { ...facts, model: { ...facts.model, ...reasoningEffort === undefined ? {} : { reasoningEffort } } }
    }
    const route = () => usage().model?.provider
    const locale = (): 'zh' | 'en' => base.ctx.mayflyLocale.locale === 'zh' ? 'zh' : 'en'
    const facts = () => {
      const digest = session?.digest === undefined ? undefined : remoteStatsDigest(session.digest)
      const digests = digest === undefined ? stored : [digest, ...stored.filter(item => item.id !== digest.id)]
      const stats = current.binding.session.projections.faceOf('sessionStats').getSnapshot()
      const number = (key: string): number => remoteReadNumber(stats, key) ?? 0
      const settings = currentMayflySettings(base.ctx)
      return buildStatsFacts({
        home: current.client.remote.$host.home ?? '', t: this.t, locale: locale(), now: Date.now(), tab, range, allWorkspaces,
        session: session === undefined ? undefined : {
          ...usage(), id: current.ref.sessionId, createdAt: session.createdAt, ...session.cwd === undefined ? {} : { cwd: session.cwd }, status: session.status,
          turns: number('turns'), steps: number('steps'),
          ...stats === undefined ? {} : { timing: { llmMs: number('llmMs'), toolMs: number('toolMs'), ttftMs: number('ttftMs'), ttftSteps: number('ttftSteps'), decodeMs: number('decodeMs'), decodeTokens: number('decodeTokens') } },
        },
        sessionTokens: digest === undefined ? [] : aggregate([digest], 'all', Date.now()).models,
        digests, index: progress, sources: { user: settings.prices, modelsDev, usdCnyRate: settings.usdCnyRate },
        account: { snapshot: this.accountCache?.route === route() ? this.accountCache : undefined, loading: accountLoading },
        lowBalance: { CNY: settings.lowBalanceCny, USD: settings.lowBalanceUsd }, version,
      })
    }
    const node = () => StatsPanel(facts())
    const publish = (): void => {
      if (!valid()) return
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      this.panel?.refresh()
    }
    const schedule = (): void => {
      if (!valid() || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        publish()
        if (sessionDirty) { sessionDirty = false; void readSession() }
      }, REPAINT_MS)
    }
    const readSession = async (): Promise<void> => {
      sessionGeneration?.abort()
      const mine = new AbortController()
      sessionGeneration = mine
      const retire = AbortSignal.any([signal, mine.signal])
      try {
        const value = await remoteValue(mayflyHostRemote(current.client).statsSession({ sessionId: current.ref.sessionId }, retire))
        if (!valid() || retire.aborted) return
        session = value
        version.harness = value.harnessVersion
        loadAccount()
        publish()
      } catch (error) {
        if (valid() && !retire.aborted) { base.notice.set(remoteErrorMessage(error)); publish() }
      }
    }
    const startIndex = (): void => {
      historyGeneration?.abort()
      const mine = new AbortController()
      historyGeneration = mine
      const retire = AbortSignal.any([signal, mine.signal])
      started = true
      stored = []
      progress = { running: true, done: 0, total: 0, skipped: 0, failed: 0 }
      schedule()
      void (async () => {
        const stream = mayflyHostRemote(current.client).statsHistory({ sessionId: current.ref.sessionId, allWorkspaces }, retire)
        try {
          for await (const frame of stream) {
            if (!valid() || retire.aborted) return
            stored = frame.digests.map(remoteStatsDigest)
            progress = { running: frame.running, done: frame.done, total: frame.total, skipped: frame.skipped, failed: frame.failed }
            schedule()
          }
        } catch (error) {
          if (valid() && !retire.aborted) progress = { running: false, done: 0, total: 0, skipped: 0, failed: 0, error: remoteErrorMessage(error) }
        } finally {
          stream.dispose()
          if (valid() && !retire.aborted) { progress = { ...progress!, running: false }; publish() }
        }
      })()
    }
    const loadAccount = (): void => {
      const provider = route()
      if (provider === undefined) return
      const cached = this.accountCache?.route === provider ? this.accountCache : undefined
      const failed = cached?.balance?.status === 'unavailable' && !['signed-out', 'no-key'].includes(cached.balance.reason)
      if (cached !== undefined && !failed && Date.now() - cached.at < ACCOUNT_FRESH_MS) return
      if (accountLoading && accountRoute === provider) return
      accountGeneration?.abort()
      const mine = new AbortController()
      accountGeneration = mine
      const retire = AbortSignal.any([signal, mine.signal])
      accountLoading = true
      accountRoute = provider
      schedule()
      void remoteStatsAccount(current.client, provider, locale(), version.mayfly, retire).then(value => {
        if (valid() && !retire.aborted && route() === provider) this.accountCache = value
      }).catch(() => {}).finally(() => {
        if (!valid() || retire.aborted) return
        accountLoading = false
        publish()
      })
    }
    const close = (): void => {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      if (timer !== undefined) clearTimeout(timer)
      historyGeneration?.abort(); accountGeneration?.abort(); sessionGeneration?.abort()
      for (const off of offs) off()
      this.panel?.close()
      this.panel = undefined
      this.retire = undefined
    }
    this.retire = close
    this.panel = openRemoteBrowser(base, {
      id: 'mayfly.stats', scope: { kind: 'session', sessionId: current.ref.sessionId }, isCurrent: valid, signal,
      view: node, onClosed: close,
      observe: event => {
        if (event.kind !== 'tab-change') return
        const next = STATS_TABS.find(item => item === event.tabId)
        if (next === undefined || next === tab) return
        tab = next
        if ((tab === 'history' || tab === 'models') && !started) startIndex()
        if (tab === 'account') loadAccount()
        publish()
      },
      action: async (event, context): Promise<MayflyUiActionReply> => {
        if (!valid() || context.signal.aborted) return { kind: 'cancelled' }
        if (event.kind !== 'activate') return { kind: 'completed' }
        if (event.actionId === 'copy') {
          try {
            const text = statsSummary(facts(), tab)
            const method = await (this.context.options.copy?.(text) ?? copyLocalText(text, signal))
            if (!valid() || context.signal.aborted) return { kind: 'cancelled' }
            return { kind: 'completed', feedback: { severity: 'success', message: `${this.t('copied the stats summary')}${method === 'osc52' ? this.t(' via terminal escape sequence (unverified)') : ''}` } }
          } catch (error) { return valid() ? { kind: 'failed', message: this.t('could not copy: {error}', { error: remoteErrorMessage(error) }) } : { kind: 'cancelled' } }
        }
        if (event.actionId === 'refresh') void readSession()
        else if (event.actionId === 'range') range = RANGES[(RANGES.indexOf(range) + 1) % RANGES.length]!
        else if (event.actionId === 'workspace') { allWorkspaces = !allWorkspaces; startIndex() }
        else return { kind: 'completed' }
        return { kind: 'accepted', node: node(), source: [] }
      },
    })
    if (signal.aborted) return
    for (const key of KEYS) offs.push(current.binding.session.projections.faceOf(key).subscribe(() => { sessionDirty = true; schedule() }))
    offs.push(current.binding.session.subscribe(() => { sessionDirty = true; schedule() }))
    void readSession()
    void loadModelsDevIndex(base.ctx, signal).then(value => { if (valid()) { modelsDev = value; schedule() } }).catch(() => {})
  }
}

/** Mount reference statistics over the exact selected native Host and Session. */
export function mountRemoteStatsOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteStatsController(context)
  const off = context.base.commands.register({ name: 'stats', description: 'Show this session, the history of your sessions, and the usage per model', execute: controller.execute })
  return () => { off(); controller.dispose() }
}
