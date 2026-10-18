/** The editor marker a pasted image leaves and the byte-size words it contains.
 * @module @ephemeral-ai/mayfly/tests/interaction/image-marker
 */
import { describe, expect, it } from 'vitest'
import { IMAGE_MARKER, formatImageSize, imageMarker } from '../../src/interaction/image-marker.ts'

describe('formatImageSize', () => {
  it('writes bytes below one KiB', () => {
    expect(formatImageSize(0)).toBe('0 B')
    expect(formatImageSize(512)).toBe('512 B')
    expect(formatImageSize(1023)).toBe('1023 B')
  })

  it('rounds to whole KiB below one MiB', () => {
    expect(formatImageSize(1024)).toBe('1 KB')
    expect(formatImageSize(1536)).toBe('2 KB')
    expect(formatImageSize(84 * 1024 + 511)).toBe('84 KB')
    expect(formatImageSize(1024 * 1024 - 1)).toBe('1024 KB')
  })

  it('writes MiB with one decimal at and above one MiB', () => {
    expect(formatImageSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatImageSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatImageSize(1.55 * 1024 * 1024)).toBe('1.6 MB')
  })
})

describe('imageMarker', () => {
  it('names the serial and the formatted size', () => {
    expect(imageMarker(1, 512)).toBe('[image #1 512 B]')
    expect(imageMarker(12, 1.5 * 1024 * 1024)).toBe('[image #12 1.5 MB]')
  })

  it('matches every marker in a line, including spaces and unicode in the size', () => {
    const text = 'see [image #1 84 KB] and [image #2 1.0 MB]'
    expect(text.match(IMAGE_MARKER)).toEqual(['[image #1 84 KB]', '[image #2 1.0 MB]'])
    expect('[image #3 2 KB]'.match(IMAGE_MARKER)).toEqual(['[image #3 2 KB]'])
    expect('no marker here'.match(IMAGE_MARKER)).toBeNull()
    expect('[image #4]'.match(IMAGE_MARKER)).toBeNull()
  })

  it('exposes a global regex whose lastIndex callers reset per use', () => {
    expect(IMAGE_MARKER.global).toBe(true)
    IMAGE_MARKER.lastIndex = 0
    expect(IMAGE_MARKER.exec('[image #5 9 B]')?.[0]).toBe('[image #5 9 B]')
    IMAGE_MARKER.lastIndex = 0
  })
})
