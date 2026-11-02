/** Official upload-global carriers restore exact active owners across overlapping construction.
 * @module @ephemeral-ai/mayfly-remote/tests/client/upload
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientFileUploadHooks, FileUploadFetch } from '@deepseek-ai/dsh-client-file-upload/types'
import { withNodeFileUpload } from '../../src/client/upload.ts'

const target = globalThis as typeof globalThis & { __DSH_FILE_UPLOAD__?: ClientFileUploadHooks }
const original = target.__DSH_FILE_UPLOAD__
afterEach(() => {
  if (original === undefined) delete target.__DSH_FILE_UPLOAD__
  else target.__DSH_FILE_UPLOAD__ = original
})
const carrier = (): FileUploadFetch => async () => new Response('native upload carrier')

describe('instance-owned native upload construction', () => {
  it('installs a carrier only while construction is active and removes it after an unowned baseline', async () => {
    delete target.__DSH_FILE_UPLOAD__
    const fetch = carrier()
    await withNodeFileUpload(fetch, async () => {
      expect(target.__DSH_FILE_UPLOAD__?.fetch).toBe(fetch)
    })
    expect(Object.hasOwn(target, '__DSH_FILE_UPLOAD__')).toBe(false)
  })

  it('restores an active enclosing carrier when nested construction finishes first', async () => {
    delete target.__DSH_FILE_UPLOAD__
    const first = carrier()
    const second = carrier()
    await withNodeFileUpload(first, async () => {
      await withNodeFileUpload(second, async () => { expect(target.__DSH_FILE_UPLOAD__?.fetch).toBe(second) })
      expect(target.__DSH_FILE_UPLOAD__?.fetch).toBe(first)
    })
    expect(target.__DSH_FILE_UPLOAD__).toBeUndefined()
  })

  it('skips a retired enclosing scope when overlapping construction finishes out of order', async () => {
    const baseline = { fetch: carrier() }
    target.__DSH_FILE_UPLOAD__ = baseline
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const pendingFirst = withNodeFileUpload(carrier(), () => first.promise)
    const inner = carrier()
    const pendingSecond = withNodeFileUpload(inner, () => second.promise)
    first.resolve()
    await pendingFirst
    expect(target.__DSH_FILE_UPLOAD__?.fetch).toBe(inner)
    second.resolve()
    await pendingSecond
    expect(target.__DSH_FILE_UPLOAD__).toBe(baseline)
  })

  it('preserves a newer external owner and restores an earlier external owner after construction failure', async () => {
    const baseline = { fetch: carrier() }
    const replacement = { fetch: carrier() }
    target.__DSH_FILE_UPLOAD__ = baseline
    await withNodeFileUpload(carrier(), async () => { target.__DSH_FILE_UPLOAD__ = replacement })
    expect(target.__DSH_FILE_UPLOAD__).toBe(replacement)
    const failure = new Error('native upload plugin refused to mount')
    await expect(withNodeFileUpload(carrier(), async () => { throw failure })).rejects.toBe(failure)
    expect(target.__DSH_FILE_UPLOAD__).toBe(replacement)
  })
})
