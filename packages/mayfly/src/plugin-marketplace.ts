/**
 * Shared marketplace presentation and read-only discovery for the standalone TUI.
 * @module @ephemeral-ai/mayfly/plugin-marketplace
 */
export * from './components/marketplace.ts'
export * from './interaction/plugin-market/catalog.ts'
export * from './interaction/plugin-market/model.ts'
export * from './interaction/plugin-market/facts.ts'
export * from './interaction/plugin-market/types.ts'
export { interactionTranslator, observeInteractionLocale, mountInteractionLocale } from './interaction/locale.ts'
