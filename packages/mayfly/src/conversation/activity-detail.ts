/**
 * Bounded one-line details for live process activity: the salient argument
 * of a tool call and the latest reasoning paragraph. Pure helpers shared by
 * the facts projection (which records the running action's detail for the
 * activity row) and the transcript model (which keeps a detail per tool
 * call). Details never carry control characters, so width math over them is
 * exact.
 *
 * @module @ephemeral-ai/mayfly/conversation/activity-detail
 */

/** Upper bound, in graphemes, of one detail. */
export const LIVE_DETAIL_MAX_CHARS = 160

/** Trailing code units of a reasoning text scanned for its latest paragraph. */
export const REASONING_DETAIL_SCAN_CHARS = 4096

/** Argument keys consulted for a detail, in priority order (upstream list). */
const LIVE_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt',
  'message', 'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path',
  'target', 'action', 'status',
]

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** C0 and C1 controls (tab and newline included); they read as whitespace. */
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/gu

/**
 * Replace controls, collapse whitespace, and bound a detail value to
 * {@link LIVE_DETAIL_MAX_CHARS} graphemes; string arrays join with commas and
 * anything else is empty.
 * @param value - a raw argument value.
 * @returns the one-line detail, or `''`.
 */
export function normalizeDetail(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : ''
  const normalized = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
  const parts = Array.from(graphemes.segment(normalized), part => part.segment)
  return parts.length <= LIVE_DETAIL_MAX_CHARS ? normalized : `${parts.slice(0, LIVE_DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`
}

function questionDetail(value: unknown): string {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeDetail((item as Record<string, unknown>)['question'])
    if (detail !== '') return detail
  }
  return ''
}

/**
 * The salient argument of one call, without a name fallback.
 * @param args - parsed arguments, `undefined` when unparseable.
 * @returns the bounded detail, or `''` when no known key carries one.
 */
export function argumentDetail(args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of LIVE_DETAIL_KEYS) {
    if (!(key in record)) continue
    const detail = key === 'questions' ? questionDetail(record[key]) : normalizeDetail(record[key])
    if (detail !== '') return detail
  }
  return ''
}

/**
 * The salient argument a card shows for one call, falling back to its name.
 * @param name - tool name, the fallback detail.
 * @param args - parsed arguments, `undefined` when unparseable.
 * @returns the bounded detail.
 */
export function toolDetail(name: string, args: unknown): string {
  return argumentDetail(args) || normalizeDetail(name)
}

/**
 * The salient argument of one committed call's raw JSON arguments.
 * @param raw - the call's argument string as the model produced it.
 * @returns the bounded detail, or `''` for malformed or detail-free arguments.
 */
export function callDetail(raw: string): string {
  let args: unknown
  try {
    args = JSON.parse(raw)
  } catch {
    return ''
  }
  return argumentDetail(args)
}

/**
 * The latest non-empty reasoning paragraph, bold markers stripped. Only the
 * trailing {@link REASONING_DETAIL_SCAN_CHARS} code units are scanned, so a
 * per-delta call stays bounded; a paragraph cut by that window leads with `…`.
 * @param text - one step's reasoning text.
 * @returns the bounded detail, or `''`.
 */
export function reasoningDetail(text: string): string {
  let start = Math.max(0, text.length - REASONING_DETAIL_SCAN_CHARS)
  // Never start inside a surrogate pair.
  const code = text.charCodeAt(start)
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start += 1
  const paragraphs = text.slice(start).split(/\r?\n[\t ]*\r?\n/)
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const detail = normalizeDetail(paragraphs[index]!.replaceAll('**', ''))
    if (detail === '') continue
    return start > 0 && index === 0 ? normalizeDetail(`…${detail}`) : detail
  }
  return ''
}
