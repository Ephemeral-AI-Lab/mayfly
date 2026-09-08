/** Memory persistence underneath the native settings service for external-consumer tests.
 * @module @mayfly-example/overlay/tests/settings
 */
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'

export class MemorySettings extends SettingsProvider {
  readonly writable = true
  readonly document: Record<string, unknown> = {}
  writes = 0
  protected async load(): Promise<Record<string, unknown>> { return this.document }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.writes += 1
    this.document[String(ns)] = section
  }
}
