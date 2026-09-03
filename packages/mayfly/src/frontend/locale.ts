/**
 * Renderer-neutral locale registry and active-locale service. Dictionary
 * owners register plain message tables; consumers resolve the current service
 * at call time so provider reload never leaves a translator bound to a dead
 * frontend tree.
 *
 * @module @ephemeral-ai/mayfly/frontend/locale
 */

import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyLocale: MayflyLocaleService
  }
}

/** Locale identifiers supported by Mayfly. */
export const MAYFLY_LOCALE_IDS = ['zh', 'en'] as const

/** A locale identifier supported by Mayfly. */
export type MayflyLocaleId = typeof MAYFLY_LOCALE_IDS[number]

/** Explicit preference; absence means follow the process locale. */
export type MayflyLocalePreference = MayflyLocaleId | undefined

/** One namespace's messages for both shipped locales. */
export interface MayflyLocaleCatalog {
  /** Simplified Chinese messages. */
  readonly zh: Readonly<Record<string, string>>
  /** English source and fallback messages. */
  readonly en: Readonly<Record<string, string>>
}

/** Immutable locale/catalog revision snapshot. */
export interface MayflyLocaleSnapshot {
  /** Effective locale used for lookup. */
  readonly locale: MayflyLocaleId
  /** Explicit persisted preference, absent while following the system. */
  readonly preference: MayflyLocalePreference
  /** Monotonic preference and catalog revision. */
  readonly revision: number
}

/** Values interpolated into `{name}` message placeholders. */
export type MayflyLocaleValues = Readonly<Record<string, string | number>>

/** Namespace-bound translation function. */
export type MayflyTranslate = (key: string, values?: MayflyLocaleValues) => string

/** Options for {@link MayflyLocaleService}. */
export interface MayflyLocaleServiceOptions {
  /** Locale resolved from the process environment. */
  readonly systemLocale?: MayflyLocaleId
  /** Initial explicit preference. */
  readonly preference?: MayflyLocaleId
}

/** Renderer-neutral locale registry scoped to one frontend tree. */
export class MayflyLocaleService extends Service {
  private readonly catalogs = new Map<string, MayflyLocaleCatalog>()
  private readonly listeners = new Set<(snapshot: MayflyLocaleSnapshot) => void>()
  private readonly systemLocale: MayflyLocaleId
  private explicitPreference: MayflyLocalePreference
  private currentRevision = 0
  private disposed = false

  /**
   * Create the tree-scoped locale service.
   * @param ctx - owning Cordis context.
   * @param options - resolved system locale and optional preference.
   */
  constructor(ctx: Context, options: MayflyLocaleServiceOptions = {}) {
    super(ctx, 'mayflyLocale')
    this.systemLocale = options.systemLocale ?? 'en'
    this.explicitPreference = options.preference
  }

  /** Effective locale after applying the explicit preference. */
  get locale(): MayflyLocaleId {
    return this.explicitPreference ?? this.systemLocale
  }

  /** Explicit persisted preference, absent while following the system. */
  get preference(): MayflyLocalePreference {
    return this.explicitPreference
  }

  /** Current immutable service snapshot. */
  get snapshot(): MayflyLocaleSnapshot {
    return Object.freeze({
      locale: this.locale,
      preference: this.preference,
      revision: this.currentRevision,
    })
  }

  /**
   * Apply a persisted preference and notify only when state moved.
   * @param preference - explicit locale, or undefined to follow the system.
   * @returns whether the locale snapshot changed.
   */
  setPreference(preference: MayflyLocalePreference): boolean {
    if (this.disposed || preference === this.explicitPreference) return false
    this.explicitPreference = preference
    this.touch()
    return true
  }

  /**
   * Register one package-owned dictionary namespace.
   * @param namespace - stable dictionary namespace.
   * @param catalog - English and Simplified Chinese messages.
   * @returns idempotent registration disposer.
   */
  register(namespace: string, catalog: MayflyLocaleCatalog): () => void {
    if (this.disposed) throw new Error('locale service is disposed')
    if (this.catalogs.has(namespace)) {
      throw new Error(`locale namespace "${namespace}" is already registered`)
    }
    const frozen = Object.freeze({
      zh: Object.freeze({ ...catalog.zh }),
      en: Object.freeze({ ...catalog.en }),
    })
    this.catalogs.set(namespace, frozen)
    this.touch()
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (!this.catalogs.delete(namespace) || this.disposed) return
      this.touch()
    }
  }

  /**
   * Bind a translator to this service instance.
   * @param namespace - package dictionary namespace.
   * @returns stable translation function.
   */
  bind(namespace: string): MayflyTranslate {
    return (key, values) => this.translate(namespace, key, values)
  }

  /**
   * Resolve one message through namespace/common and English fallbacks.
   * @param namespace - package dictionary namespace.
   * @param key - message key.
   * @param values - optional placeholder values.
   * @returns resolved and interpolated message, or the key when absent.
   */
  translate(namespace: string, key: string, values?: MayflyLocaleValues): string {
    const locale = this.locale
    const own = this.catalogs.get(namespace)
    const common = this.catalogs.get('common')
    const message = own?.[locale][key]
      ?? own?.en[key]
      ?? common?.[locale][key]
      ?? common?.en[key]
      ?? key
    if (values === undefined) return message
    return interpolate(message, values)
  }

  /**
   * Subscribe to preference and catalog changes.
   * @param listener - snapshot listener, called immediately.
   * @returns subscription disposer.
   */
  subscribe(listener: (snapshot: MayflyLocaleSnapshot) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  /** Release dictionaries and listeners owned by this frontend tree. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.catalogs.clear()
    this.listeners.clear()
  }

  /** Advance one revision and notify current listeners. */
  private touch(): void {
    this.currentRevision += 1
    const snapshot = this.snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}

/**
 * Interpolate catalog placeholders without exposing a locale service.
 * @param message - source message.
 * @param values - replacement values.
 * @returns interpolated message.
 */
export function interpolateLocaleMessage(message: string, values?: MayflyLocaleValues): string {
  return values === undefined ? message : interpolate(message, values)
}

function interpolate(message: string, values: MayflyLocaleValues): string {
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (placeholder, name: string) => {
    const value = values[name]
    return value === undefined ? placeholder : String(value)
  })
}
