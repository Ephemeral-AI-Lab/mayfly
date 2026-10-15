/**
 * The model endpoint of a replay session: replays play session events directly, so nothing needs a model. This stub
 * answers the requests the product makes anyway (title generation) and any prompt you type, so no real provider is
 * reached and nothing is billed. A prompt that holds `hold:<ms>` is answered after that long: a real turn that stays
 * running for a person to work on (the runner does not wait for it). @module script/scenarios/stub-model
 */

import { createServer } from 'node:http'

const TITLE = 'Replay session'
const REPLY = 'This is a replay session: the model is a stub. Type nothing; the conversation above is scripted.'

/** The delay a prompt asks for with `hold:<ms>` (a real turn that stays running for that long), else none. */
const holdOf = body => {
  const text = JSON.stringify(body.messages ?? [])
  const match = /hold:(\d+)/u.exec(text)
  return match === null ? 0 : Number(match[1])
}

/** A prompt that holds `spawn:<description>` makes the model call the subagent tool once, so the product creates a real child. */
const spawnOf = body => {
  const messages = body.messages ?? []
  const at = messages.findLastIndex(message => /spawn:[\w -]+/u.test(JSON.stringify(message)))
  if (at < 0) return undefined
  // The call is made once: after it the conversation holds the tool's use or result.
  if (messages.slice(at + 1).some(message => /tool_(use|result)/u.test(JSON.stringify(message)))) return undefined
  return /spawn:([\w -]+)/u.exec(JSON.stringify(messages[at]))?.[1]
}

const toolSse = (name, input) => [
  { type: 'message_start', message: { id: 'stub', type: 'message', role: 'assistant', model: 'stub', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_stub1', name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

const sse = text => [
  { type: 'message_start', message: { id: 'stub', type: 'message', role: 'assistant', model: 'stub', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

/** DeepSeek's `GET /user/balance` answers a scenario can ask for (`account.balance`); `rejected` and `down` are statuses. */
const BALANCES = {
  ok: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] },
  low: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '6.20', granted_balance: '6.20', topped_up_balance: '0.00' }] },
  multi: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }, { currency: 'USD', total_balance: '4.20', granted_balance: '0.00', topped_up_balance: '4.20' }] },
  insufficient: { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }] },
}
const BALANCE_STATUS = { rejected: 401, down: 503 }

/**
 * Start the stub. Requests without tools (title generation) get the title; the rest get the notice.
 * @param options - `balance`: the `/user/balance` answer (`ok`, `low`, `multi`, `insufficient`, or the statuses `rejected` and `down`).
 * @returns `{ baseURL, inFlight(), close() }`: `inFlight()` counts the requests not answered yet, so a scenario settles
 *   only after the title the product asks for has arrived.
 */
export async function startStubModel({ balance = 'ok' } = {}) {
  const open = new Set()
  /** Responses held by `hold:<ms>`: a person-sized wait is not a request the runner settles on. */
  const held = new Set()
  const server = createServer((request, response) => {
    open.add(response)
    response.on('close', () => { open.delete(response); held.delete(response) })
    if (request.method === 'GET' && (request.url ?? '').split('?')[0] === '/user/balance') {
      const status = BALANCE_STATUS[balance]
      if (status !== undefined) response.writeHead(status).end()
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(BALANCES[balance]))
      return
    }
    if (request.method !== 'POST' || !(request.url ?? '').split('?')[0].endsWith('/v1/messages')) { response.writeHead(404).end(); return }
    let raw = ''
    request.on('data', (data) => { raw += data })
    request.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* answered as a prompt */ }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const spawn = Array.isArray(body.tools) && body.tools.some(tool => tool.name === 'subagent') ? spawnOf(body) : undefined
      if (spawn !== undefined) { response.end(toolSse('subagent', { description: spawn, prompt: 'Write one short line about the README.' })); return }
      const answer = sse(Array.isArray(body.tools) && body.tools.length > 0 ? REPLY : TITLE)
      const hold = Array.isArray(body.tools) && body.tools.length > 0 ? holdOf(body) : 0
      if (hold === 0) { response.end(answer); return }
      open.delete(response)
      held.add(response)
      setTimeout(() => { if (!response.destroyed) response.end(answer) }, hold).unref()
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    inFlight: () => open.size,
    close: async () => {
      for (const response of [...open, ...held]) response.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
