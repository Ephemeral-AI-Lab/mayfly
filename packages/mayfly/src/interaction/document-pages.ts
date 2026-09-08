/** Bounded document payloads that retain complete text and Unicode pairs.
 * @module @ephemeral-ai/mayfly/interaction/document-pages
 */
const PAGE_CHARS = 12_000

export function documentPages(text: string): readonly string[] {
  const pages: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + PAGE_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= start) end = newline + 1
      else if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1
    }
    pages.push(text.slice(start, end))
    start = end
  }
  return Object.freeze(pages.length === 0 ? [''] : pages)
}
