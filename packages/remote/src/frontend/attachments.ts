/**
 * Node-safe attachment reads and uploads through official dsh Client APIs.
 * @module @ephemeral-ai/mayfly/frontend/attachments
 */
import type { FileUploadService } from '@deepseek-ai/dsh-client-file-upload/client'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostClient, SessionRef } from '../client/types.ts'
import type { HostActions } from './host-actions.ts'

/** Resolve the official upload service owned by the same Host Client as the Session. */
export interface RemoteAttachmentUploads {
  /** Return the exact Host's Client upload service. */
  forSession(ref: SessionRef): FileUploadService
}

/** Adapt the official fileUpload service exposed by the current Client Runtime. */
export function createRemoteAttachmentUploads(client: HostClient): RemoteAttachmentUploads {
  const upload = (client as HostClient & { readonly fileUpload: FileUploadService }).fileUpload
  return {
    forSession(ref) {
      if (client.key !== ref.host) throw new Error('Attachment Host Client and SessionRef must identify the same Host')
      return upload
    },
  }
}

/** Attachment bytes and media type supplied by a Node editor or image consumer. */
export interface RemoteImageBytes {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name?: string
}

/** Convert Node image bytes to the standard Blob accepted by Client fileUpload. */
export function remoteImageBlob(image: RemoteImageBytes): Blob {
  const bytes = new ArrayBuffer(image.data.byteLength)
  new Uint8Array(bytes).set(image.data)
  return new Blob([bytes], { type: image.mediaType })
}

/** Host-authenticated attachment reads and Session-addressed upload commands. */
export class RemoteAttachmentService {
  /**
   * @param actions - exact Host/Session action router.
   * @param uploads - official Client upload services supplied by the Client runtime.
   */
  constructor(
    private readonly actions: HostActions,
    private readonly uploads: RemoteAttachmentUploads,
  ) {}

  /** Read verified Host-issued image bytes; no Host filesystem path is consulted. */
  read(
    ref: SessionRef,
    attachment: Parameters<SessionFace['readAttachment']>[0],
  ): ReturnType<SessionFace['readAttachment']> {
    return this.actions.readAttachment(ref, attachment)
  }

  /** Upload bytes, a Blob, or a one-shot stream through the official Client service. */
  upload(
    ref: SessionRef,
    data: Parameters<FileUploadService['upload']>[1],
    name?: string,
    signal?: AbortSignal,
    onProgress?: Parameters<FileUploadService['upload']>[4],
  ): ReturnType<FileUploadService['upload']> {
    return this.uploads.forSession(ref).upload(ref.sessionId, data, name, signal, onProgress)
  }

  /** Upload and normalize one prompt image through the official Client service. */
  uploadImage(
    ref: SessionRef,
    image: RemoteImageBytes,
    signal?: AbortSignal,
    onProgress?: Parameters<FileUploadService['uploadImage']>[5],
  ): ReturnType<FileUploadService['uploadImage']> {
    return this.uploads.forSession(ref).uploadImage(
      ref.sessionId,
      remoteImageBlob(image),
      image.mediaType,
      image.name,
      signal,
      onProgress,
    )
  }
}
