/**
 * Scoped installation of the official dsh file-upload global. Independent
 * restorations skip inactive records, so concurrent Host Clients cannot leave
 * another Client's carrier installed.
 * @module @ephemeral-ai/mayfly/client/upload
 */

import type {
  ClientFileUploadHooks,
  FileUploadFetch,
} from '@deepseek-ai/dsh-client-file-upload/types'

interface FileUploadGlobal {
  __DSH_FILE_UPLOAD__?: ClientFileUploadHooks
}

interface HookScope {
  active: boolean
  readonly previous: ClientFileUploadHooks | undefined
}

const hookScope = Symbol('mayfly.file-upload.scope')

interface ScopedFileUploadHooks extends ClientFileUploadHooks {
  readonly [hookScope]: HookScope
}

/** Run one official upload-plugin construction with an instance-owned Node carrier. */
export async function withNodeFileUpload(
  fetch: FileUploadFetch,
  construct: () => Promise<void>,
): Promise<void> {
  const target = globalThis as FileUploadGlobal
  const hook: ScopedFileUploadHooks = {
    fetch,
    [hookScope]: { active: true, previous: target.__DSH_FILE_UPLOAD__ },
  }
  target.__DSH_FILE_UPLOAD__ = hook
  try {
    await construct()
  } finally {
    hook[hookScope].active = false
    if (target.__DSH_FILE_UPLOAD__ === hook) {
      const previous = activePrevious(hook[hookScope].previous)
      if (previous === undefined) delete target.__DSH_FILE_UPLOAD__
      else target.__DSH_FILE_UPLOAD__ = previous
    }
  }
}

function activePrevious(previous: ClientFileUploadHooks | undefined): ClientFileUploadHooks | undefined {
  let current = previous
  while (current !== undefined && isScoped(current) && !current[hookScope].active) {
    current = current[hookScope].previous
  }
  return current
}

function isScoped(hook: ClientFileUploadHooks): hook is ScopedFileUploadHooks {
  return hookScope in hook
}
