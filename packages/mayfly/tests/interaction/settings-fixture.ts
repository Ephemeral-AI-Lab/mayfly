/** Native settings persistence and shared UI fixtures for namespace editing.
 * @module @ephemeral-ai/mayfly/tests/interaction/settings-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { providerFixture } from './provider-fixture.ts'
import { openSettingsNamespace } from '../../src/interaction/settings-command.ts'

export const settingsField = (...path: string[]) => ({ pagePath: [], formId: 'settings-form', fieldId: JSON.stringify(path) })
export async function settingsFixture(ctx: Context, schema = Schema.object({
  name: Schema.string().default('base'), count: Schema.number().min(1).max(10).step(1).default(2), enabled: Schema.boolean().default(true),
  mode: Schema.union(['fast', 'slow']).default('fast'), levels: Schema.array(Schema.union(['low', 'high'])).default([]),
  secret: Schema.string().role('secret').default('private-default'), nested: Schema.object({ value: Schema.string().default('nested') }),
}), base: Record<string, unknown> = {}) {
  const bench = await providerFixture(ctx)
  const owner = await ctx.plugin({ name: 'settings-schema-owner', inject: ['settings'], apply(scope: Context) { scope.settings.register('test-settings', schema, { base }) } })
  const open = async () => {
    await openSettingsNamespace(ctx, 'test-settings')
    const entry = ctx.mayflyOverlays.list().find(entry => entry.id === `mayfly.settings.${Buffer.from('test-settings').toString('hex')}`)!
    return ctx.mayflyUiInteraction.get('overlay', entry.id)!
  }
  return { ...bench, owner, open }
}
