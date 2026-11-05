/**
 * Client-safe pure conversation primitives: the assistant stream fold and the
 * tool activity details the durable projections use, shared with the TUI's
 * transient current-attempt overlay so both fold the same way.
 *
 * @module @ephemeral-ai/mayfly-host/conversation
 */

export { argumentDetail, toolDetail } from './conversation/activity-detail.ts'
export { foldAssistantStreamRecords, initialAssistantStream } from './conversation/stream-accumulator.ts'
