/** The mock LLM shared by the PTY bench and the workbench: a long answer shaped like a real one. @module script/workbench/mock-llm */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** A reply shaped like a real answer: prose, lists, a table, and fenced code in two languages. */
export function reply() {
  const parts = []
  for (let section = 1; section <= 8; section += 1) {
    parts.push(`## Section ${section}: rendering pipeline notes`)
    parts.push(`The **renderer** walks the tree once per frame and only repaints rows whose content changed since the last frame. This paragraph is long enough to wrap at ordinary widths, with \`inline code\`, *emphasis*, and a [link](https://example.com/${section}) to exercise the inline painter.`)
    parts.push(['- first point about caches and identity', '- second point about `width` ladders', '- third point, with a nested list:', '  - nested one', '  - nested two'].join('\n'))
    parts.push(['```ts', `export function section${section}(input: readonly string[], width: number): string[] {`, '  const rows: string[] = []', '  for (const line of input) {', "    if (line.length === 0) { rows.push(''); continue }", '    for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width))', '  }', "  return rows.map(row => row.padEnd(width, ' '))", '}', '```'].join('\n'))
    if (section % 2 === 0) {
      parts.push(['| workload | validated | compiled | rows |', '| --- | ---: | ---: | ---: |', '| W1 | 2 | 2 | 2 |', '| W2 | 0 | 0 | 1 |', '| W3 | 0 | 0 | 2 |'].join('\n'))
      parts.push(['```python', 'def wrap(lines, width):', '    rows = []', '    for line in lines:', '        if not line:', "            rows.append('')", '            continue', '        rows.extend(line[i:i + width] for i in range(0, len(line), width))', '    return rows', '```'].join('\n'))
    }
  }
  parts.push('BENCH-END-MARKER')
  return parts.join('\n\n')
}

/**
 * Start the local mock LLM server answering every request with {@link reply}.
 * @param options - `chunkSize` characters per streamed chunk and `chunkDelayMs` between chunks.
 * @returns the server (`baseURL`, `close`).
 */
export async function startReplyServer({ chunkSize = 16, chunkDelayMs = 10 } = {}) {
  const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')
  return await startMockLlmServer({ port: 0, sequence: ['slow_success'], repeatLast: true, successText: reply(), chunkSize, chunkDelayMs })
}

/**
 * The environment that points a booted `dsh` at a mock server.
 * @param server - a server from {@link startReplyServer}.
 */
export function mockEnv(server) {
  return { DEEPSEEK_BASE_URL: `${server.baseURL}/v1`, DEEPSEEK_API_KEY: 'bench-key' }
}
