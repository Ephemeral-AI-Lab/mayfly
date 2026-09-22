/** Plan-review documents mount into the local content flow for the request's lifetime.
 * @module @ephemeral-ai/mayfly/interaction/plan-document
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { ui, type MayflyUiEvent, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyUiNode, GutterComponent } from '../core/index.ts'
import type { MayflyTranslate } from '../frontend/index.ts'
import type { TranscriptLocalsService } from '../transcript/transcript-model.ts'

/* The document is passive content: it admits no controls, so its event sink
   can never fire. */
const PASSIVE_EVENT_SINK = Function.prototype as (event: MayflyUiEvent) => void

/** The plan body renders as plain full-width rows inside the scrollable
 *  document, so screen-space selection copies clean markdown without the
 *  side borders a floating overlay would paint. */
export function planDocumentNode(question: AskUserQuestionItem, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.divider({ label: question.header ?? t('Plan') }),
    ui.markdown(question.detail ?? ''),
    ui.spacer(),
  ])
}

/** Compile the node through the canonical admission path and append it into
 *  the conversation flow; the caller disposes the entry when its request
 *  settles. The 'main' screen mode keeps the document passive: the compiler
 *  emits all rows linearly instead of windowing to the viewport, so the
 *  outer content ScrollView owns the only scroll state.
 *  The transcript locals service anchors the document at the durable tail
 *  and insets it by the same gutter every conversation row uses; without it
 *  the document leases a local content slot wrapped in that gutter itself. */
export function mountPlanDocument(ctx: Context, id: string, view: () => MayflyUiNode): { readonly dispose: () => void } {
  const screen = ctx.mayflyScreen
  const compiled = compileMayflyUiNode(view(), {
    components: ctx.mayflyComponents,
    colors: ctx.mayflyTheme.colors,
    getViewport: () => ({ columns: screen.columns, rows: screen.rows }),
    screenMode: 'main',
    emit: PASSIVE_EVENT_SINK,
  })
  const component = compiled.ok ? compiled.value.component : compiled.errorComponent
  const locals = ctx.get('mayflyTranscriptLocals') as TranscriptLocalsService | undefined
  if (locals !== undefined) {
    const dispose = locals.append(component)
    screen.followContent()
    return { dispose }
  }
  const slot = screen.mountContentSlot(`local.${id}`, new GutterComponent(component))
  screen.followContent()
  return slot
}
