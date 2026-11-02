/** Native input bindings for the shared editor extension owner. @module interaction/editor-extension-runtime */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MayflyEditorAttachment, MayflyFeedback, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyEditor } from '../core/types.ts'
import { EditorExtensionRuntime as SharedEditorExtensionRuntime, type EditorExtensionSubmitCapture } from '../frontend/editor-extension-runtime.ts'
import { IMAGE_MARKER } from './image-marker.ts'
import { beginPromptWait } from './prompt-wait.ts'
import type { SubmitTransformation } from './prompt-submit-pipeline.ts'

interface NativePreparedSubmit {
  readonly text: string
  readonly transformation?: SubmitTransformation
}

interface AttachmentBinding {
  readonly marker: string
  readonly ref: ImageAttachmentRef
  readonly public: MayflyEditorAttachment
}

interface NativeEditorExtensionRuntimeOptions {
  readonly ctx: Context
  readonly editor: MayflyEditor
  readonly report: (id: string, feedback: MayflyFeedback) => void
  readonly footer?: () => MayflyUiNode | undefined
  readonly frame: (state: { readonly parked: boolean }) => MayflyUiNode
  readonly shouldTransformSubmit: (text: string) => boolean
}

function captureAttachments(ctx: Context, source: string): EditorExtensionSubmitCapture<NativePreparedSubmit> {
  const bindings: AttachmentBinding[] = []
  const text = source.replace(IMAGE_MARKER, marker => {
    const ref = ctx.mayflyInteractionState.pasteImage.pastedImages.get(marker)
    if (ref === undefined) return marker
    bindings.push(Object.freeze({
      marker,
      ref,
      public: Object.freeze({
        id: String(ref.attachmentId),
        label: ref.name ?? marker,
        mediaType: ref.mediaType,
        size: ref.bytes,
      }),
    }))
    return ''
  }).trim()
  return {
    text,
    attachments: Object.freeze(bindings.map(binding => binding.public)),
    prepare: transformed => {
      if (bindings.length === 0) return { text: transformed }
      const images = ctx.mayflyInteractionState.pasteImage.pastedImages
      const consumed: AttachmentBinding[] = []
      for (const binding of bindings) {
        if (images.get(binding.marker) !== binding.ref) continue
        images.delete(binding.marker)
        consumed.push(binding)
      }
      const blocks: ContentBlock[] = []
      if (transformed.length > 0) blocks.push({ type: 'text', text: transformed })
      for (const binding of consumed) blocks.push({ type: 'image', attachment: binding.ref })
      let rolledBack = false
      return {
        text: transformed,
        transformation: {
          blocks,
          rollback: () => {
            if (rolledBack) return
            rolledBack = true
            for (const binding of consumed) if (!images.has(binding.marker)) images.set(binding.marker, binding.ref)
          },
        },
      }
    },
  }
}

/** Keep private native submission semantics while sharing the complete renderer and extension lifecycle. */
export class EditorExtensionRuntime extends SharedEditorExtensionRuntime<NativePreparedSubmit> {
  constructor(options: NativeEditorExtensionRuntimeOptions) {
    super({
      ...options,
      bindings: {
        autocomplete: {
          sources: () => options.ctx.mayflyPromptEditor.listAutocompleteSources(),
          subscribe: listener => options.ctx.mayflyPromptEditor.subscribeEditorState(listener),
        },
        beginWait: message => beginPromptWait(options.ctx, message),
        captureSubmit: source => captureAttachments(options.ctx, source),
        shouldTransformSubmit: options.shouldTransformSubmit,
      },
    })
  }

  override takePrepared(source: string): NativePreparedSubmit | undefined { return super.takePrepared(source) }
}
