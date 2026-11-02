/** Renderer-neutral session browser models consumed by the independent Remote frontend. @module */
export { SessionBrowser, type SessionBrowserFacts } from './interaction/session-browser-model.ts'
export { sessionListItem, sessionDetailNode, sessionLabel, type SessionListFacts } from './interaction/session-list-model.ts'
export { sessionWorkspaceTab, type SessionWorkspaceLabelFacts } from './interaction/session-workspaces-model.ts'
export { interactionTranslator, mountInteractionLocale } from './interaction/locale.ts'
