/** Fiber-scoped prompt submit transformations and rollback composition.
 * @module @ephemeral-ai/mayfly/interaction/prompt-submit-pipeline
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context { mayflyPromptSubmissions: PromptSubmitPipeline }
}

export interface SubmitTransformation {
  readonly blocks: ContentBlock[]
  readonly rollback?: () => void
}

export type SubmitTransformer = (text: string) => ContentBlock[] | SubmitTransformation

/** Ordered reversible transformations applied immediately before Agent followup. */
export class PromptSubmitPipeline extends Service {
  private readonly transformers: SubmitTransformer[] = []

  constructor(ctx: Context) { super(ctx, 'mayflyPromptSubmissions') }

  register(transformer: SubmitTransformer): () => void {
    this.transformers.push(transformer)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const index = this.transformers.indexOf(transformer)
      if (index >= 0) this.transformers.splice(index, 1)
    }
  }

  apply(text: string): ContentBlock[] { return this.applyReversible(text).blocks }

  applyReversible(text: string): SubmitTransformation {
    if (this.transformers.length === 0) return { blocks: [{ type: 'text', text }] }
    const blocks: ContentBlock[] = []
    const rollbacks: Array<() => void> = []
    for (const transformer of this.transformers) {
      const result = transformer(text)
      if (Array.isArray(result)) blocks.push(...result)
      else {
        blocks.push(...result.blocks)
        if (result.rollback !== undefined) rollbacks.push(result.rollback)
      }
    }
    let rolledBack = false
    return {
      blocks: blocks.length === 0 ? [{ type: 'text', text }] : blocks,
      ...(rollbacks.length === 0 ? {} : {
        rollback: () => {
          if (rolledBack) return
          rolledBack = true
          for (const rollback of rollbacks.reverse()) rollback()
        },
      }),
    }
  }

  dispose(): void { this.transformers.splice(0) }
}

export const registerSubmitTransformer = (ctx: Context, transformer: SubmitTransformer): (() => void) => ctx.mayflyPromptSubmissions.register(transformer)
export const applySubmitTransformers = (ctx: Context, text: string): ContentBlock[] => ctx.mayflyPromptSubmissions.apply(text)
export const applyReversibleSubmitTransformers = (ctx: Context, text: string): SubmitTransformation => ctx.mayflyPromptSubmissions.applyReversible(text)
