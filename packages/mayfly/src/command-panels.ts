/** Shared command documents for the standalone terminal frontend. @module @ephemeral-ai/mayfly/command-panels */
export { helpNode, type HelpSection } from './interaction/help.ts'
export { INTERACTION_KEY_ACTIONS } from './interaction/keys.ts'
export { displayKey } from './core/key-actions.ts'
export { SHARED_KEY_REFERENCE } from './core/ui-key-grammar.ts'
export { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './interaction/locale.ts'
