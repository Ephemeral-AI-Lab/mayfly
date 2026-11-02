/** Shared transcript presentation and terminal controller. @module @ephemeral-ai/mayfly/transcript */
export { conversationTranscriptModel } from './transcript/conversation-model.ts'
export { TranscriptController, createTranscriptModel } from './transcript/transcript-model.ts'
export type { TranscriptControllerOptions } from './transcript/transcript-model.ts'
export type { ToolPresentationSource } from './transcript/present.ts'
export type { ToolPresentationFacts } from './transcript/tool-model.ts'
export { mountStatusFooter } from './transcript/status-rows.ts'
