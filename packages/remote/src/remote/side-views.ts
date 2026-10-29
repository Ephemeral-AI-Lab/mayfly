/**
 * Display-only side views for independently retained Host Sessions (BTW forks
 * and cold continuable children). One borrowed binding renders through a
 * dedicated model source into a retained transcript view; the main selected
 * conversation keeps its own authoritative source, attachment reads, and queue
 * actions. Closing a side view releases only its local source and display.
 * @module @ephemeral-ai/mayfly/remote/side-views
 */

import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MayflyScreenService } from '@ephemeral-ai/mayfly/core'
import type { ToolPresentationSource } from '@ephemeral-ai/mayfly/transcript'
import { TranscriptController } from '@ephemeral-ai/mayfly/transcript'
import type { SessionRef } from '../client/types.ts'
import type { RemoteNotice } from './notice.ts'
import { RemoteConversationModelSource, type RemotePresentationSelection } from '../transcript/remote-model.ts'

/** The single retained side-view key beside the main 'remote' view. */
export const REMOTE_SIDE_VIEW_KEY = 'remote-side'

/** Independent presentation of one borrowed Host Session binding. */
export class RemoteSideViews {
  private source: RemoteConversationModelSource | undefined
  private displayed: { readonly ref: SessionRef } | undefined

  constructor(
    private readonly transcript: TranscriptController,
    private readonly tools: ToolPresentationSource,
    private readonly screen: MayflyScreenService,
    private readonly notice: RemoteNotice,
  ) {}

  /** The currently displayed side-view Session identity, if one is open. */
  current(): SessionRef | undefined {
    return this.displayed?.ref
  }

  /**
   * Present one exact borrowed binding as the side view; the previous side
   * source is replaced without touching the Host Session's lifetime.
   */
  present(binding: SessionBinding, selection: RemotePresentationSelection): void {
    this.releaseSource()
    this.source = new RemoteConversationModelSource(this.tools, () => { this.transcript.refresh() }, {
      onPresentation: () => { this.screen.requestRender() },
      onCommandResult: result => {
        if (result.text !== undefined) this.notice.set(result.text)
      },
    })
    this.source.attach(binding, selection)
    this.displayed = { ref: selection.ref }
    this.transcript.setView(REMOTE_SIDE_VIEW_KEY, () => this.source!.snapshot())
    this.transcript.show(REMOTE_SIDE_VIEW_KEY)
  }

  /** Stop displaying the side view and return to the main conversation. */
  close(): void {
    if (this.displayed === undefined) return
    this.displayed = undefined
    this.releaseSource()
    this.transcript.dropView(REMOTE_SIDE_VIEW_KEY)
    this.transcript.show('remote')
  }

  /** Close the view and release its local model source. */
  dispose(): void {
    this.close()
  }

  private releaseSource(): void {
    this.source?.dispose()
    this.source = undefined
  }
}
