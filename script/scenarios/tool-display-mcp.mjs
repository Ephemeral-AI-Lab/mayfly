/**
 * A stdio MCP server for the tool-display demo: newline-delimited JSON-RPC with hand-written answers, so a demo reaches
 * the real MCP bridge with no account and no network. The first argument names the server. @module script/scenarios/tool-display-mcp
 */

import { createInterface } from 'node:readline'

const scalar = type => ({ type })
const tool = (name, description, properties) => ({ name, description, inputSchema: { type: 'object', properties } })
const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...isError ? { isError: true } : {} })
/** A one-pixel PNG: the image block is what the demo exercises, not its picture. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const ISSUES = [
  { number: 1423, title: 'List loses selection after reorder', state: 'open' },
  { number: 1419, title: 'Menu focus jumps on resize', state: 'open' },
  { number: 1402, title: 'Tabs flicker when a badge updates', state: 'open' },
]

const SERVERS = {
  github: {
    tools: [
      tool('search_issues', 'Search issues.', { query: scalar('string'), per_page: scalar('number') }),
      tool('get_issue', 'Read one issue.', { owner: scalar('string'), repo: scalar('string'), issue_number: scalar('number') }),
      tool('create_issue', 'Open an issue.', { title: scalar('string'), teamId: scalar('string'), description: scalar('string'), labels: { type: 'array', items: scalar('string') }, draft: scalar('boolean') }),
    ],
    call: {
      search_issues: () => text(ISSUES),
      get_issue: () => text(ISSUES[0]),
      create_issue: () => text('401 Bad credentials', true),
    },
  },
  linear: {
    tools: [tool('search_issues', 'Search issues.', { query: scalar('string') })],
    call: { search_issues: () => text('ENG-212 Selection reset on reorder\nENG-198 Stale selection in the picker\nENG-171 Reorder drops focus') },
  },
  browser: {
    tools: [tool('screenshot', 'Take a screenshot.', { url: scalar('string') })],
    call: { screenshot: () => ({ content: [{ type: 'image', data: PIXEL, mimeType: 'image/png' }] }) },
  },
}

const server = SERVERS[process.argv[2]]
if (server === undefined) throw new Error(`Unknown demo MCP server: ${String(process.argv[2])}`)

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })
const answer = (id, result) => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) }

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') answer(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: process.argv[2], version: '0.0.0' } })
  else if (method === 'tools/list') answer(id, { tools: server.tools })
  // A person watches the call run, so it takes a moment.
  else if (method === 'tools/call') void sleep(900).then(() => { answer(id, server.call[params.name]()) })
  else if (id !== undefined) answer(id, {})
})
