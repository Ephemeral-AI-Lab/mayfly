/** Native settings persistence and shared UI fixtures for namespace editing.
 * @module @ephemeral-ai/mayfly/tests/interaction/settings-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { providerFixture } from './provider-fixture.ts'
import { openSettingsNamespace } from '../../src/interaction/settings-command.ts'
import { MemorySettings } from '../../../../examples/overlay/tests/settings.ts'
import type { MayflyPagePath } from '../../../ui/src/interaction.ts'

/** The rail page that holds one namespace's form. */
export const settingsPage = (ns: string): MayflyPagePath => [{ controlId: 'namespaces', itemId: ns }]
export const settingsFieldIn = (ns: string, ...path: string[]) => ({ pagePath: settingsPage(ns), formId: 'settings-form', fieldId: JSON.stringify(path) })
export const settingsField = (...path: string[]) => settingsFieldIn('test-settings', ...path)
export async function settingsFixture(ctx: Context, schema: Schema = Schema.object({
  name: Schema.string().default('base'), count: Schema.number().min(1).max(10).step(1).default(2), enabled: Schema.boolean().default(true),
  mode: Schema.union(['fast', 'slow']).default('fast'), levels: Schema.array(Schema.union(['low', 'high'])).default([]),
  secret: Schema.string().role('secret').default('private-default'), nested: Schema.object({ value: Schema.string().default('nested') }),
}).volatile(), base: Record<string, unknown> = {}) {
  // The provider namespace belongs to provider specs; a settings rail over it
  // would add an unrelated page to every settings case.
  const bench = await providerFixture(ctx, {}, undefined, { registerNamespace: false })
  // A real patch row declares its editable fields `.volatile()`; the fixture
  // marks the supplied schema the same way so every registered field is live.
  const configurable = schema.meta.volatile === true ? schema : schema.volatile()
  const owner = await ctx.plugin({ name: 'settings-schema-owner', inject: ['settings'], apply(scope: Context) { (scope.settings as unknown as MemorySettings).register('test-settings', configurable, { base, owner: scope }) } })
  const open = async (ns = 'test-settings') => {
    if (!await openSettingsNamespace(ctx, ns)) throw new Error(`Settings namespace "${ns}" did not open`)
    ctx.mayflyOverlays.focus('mayfly.settings')
    const model = ctx.mayflyUiInteraction.get('overlay', 'mayfly.settings')!
    // A root panel left on another namespace switches its rail page to the
    // fixture's namespace, just as opening the namespace does.
    if (model.activeTab({ pagePath: [], controlId: 'namespaces' }) !== ns) model.emit({ kind: 'tab-change', pagePath: [], controlId: 'namespaces', tabId: ns })
    return model
  }
  return { ...bench, owner, open }
}
