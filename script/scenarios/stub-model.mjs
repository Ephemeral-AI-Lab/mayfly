/**
 * The model endpoint of a replay session: replays play session events directly, so nothing needs a model. This stub
 * answers the requests the product makes anyway (title generation) and any prompt you type, so no real provider is
 * reached and nothing is billed. @module script/scenarios/stub-model
 */

import { createServer } from 'node:http'

const TITLE = 'Replay session'
const REPLY = 'This is a replay session: the model is a stub. Type nothing; the conversation above is scripted.'

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
  const server = createServer((request, response) => {
    open.add(response)
    response.on('close', () => open.delete(response))
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
      response.end(sse(Array.isArray(body.tools) && body.tools.length > 0 ? REPLY : TITLE))
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    inFlight: () => open.size,
    close: async () => {
      for (const response of open) response.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
