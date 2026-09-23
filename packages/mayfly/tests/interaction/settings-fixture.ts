/** Native settings persistence and shared UI fixtures for namespace editing.
 * @module @ephemeral-ai/mayfly/tests/interaction/settings-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { providerFixture } from './provider-fixture.ts'
import { openSettingsNamespace } from '../../src/interaction/settings-command.ts'
import { MemorySettings } from '../../../../examples/overlay/tests/settings.ts'

export const settingsField = (...path: string[]) => ({ pagePath: [], formId: 'settings-form', fieldId: JSON.stringify(path) })
export async function settingsFixture(ctx: Context, schema = Schema.object({
  name: Schema.string().default('base'), count: Schema.number().min(1).max(10).step(1).default(2), enabled: Schema.boolean().default(true),
  mode: Schema.union(['fast', 'slow']).default('fast'), levels: Schema.array(Schema.union(['low', 'high'])).default([]),
  secret: Schema.string().role('secret').default('private-default'), nested: Schema.object({ value: Schema.string().default('nested') }),
}).volatile(), base: Record<string, unknown> = {}) {
  const bench = await providerFixture(ctx)
  // A real patch row declares its editable fields `.volatile()`; the fixture
  // marks the supplied schema the same way so every registered field is live.
  const configurable = schema.meta.volatile === true ? schema : schema.volatile()
  const owner = await ctx.plugin({ name: 'settings-schema-owner', inject: ['settings'], apply(scope: Context) { (scope.settings as unknown as MemorySettings).register('test-settings', configurable, { base, owner: scope }) } })
  const open = async () => {
    await openSettingsNamespace(ctx, 'test-settings')
    const entry = ctx.mayflyOverlays.list().find(entry => entry.id === `mayfly.settings.${Buffer.from('test-settings').toString('hex')}`)!
    return ctx.mayflyUiInteraction.get('overlay', entry.id)!
  }
  return { ...bench, owner, open }
}
