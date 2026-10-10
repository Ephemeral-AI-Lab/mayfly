/**
 * The real look of a scenario: the product's bytes rendered by xterm.js (the WebGL renderer, the pinned JetBrains Mono)
 * in headless Chrome, driven over the DevTools protocol with Node's own WebSocket. Keys and the mouse are dispatched as
 * browser input events, so xterm.js's own encoder produces what the product receives, and the page answers the
 * terminal's queries. A screenshot is a PNG of the terminal element. Chrome comes from `CHROME_BIN`, else the first of
 * google-chrome, chromium, or chromium-browser on the PATH. @module script/scenarios/browser
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ASSETS = fileURLToPath(new URL('../shots/assets/', import.meta.url))

/** The Chrome executable, or undefined when none is installed. */
export function findChrome() {
  if (process.env.CHROME_BIN !== undefined && process.env.CHROME_BIN !== '') return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || undefined } catch { /* try the next */ }
  }
  return undefined
}

const NAMED = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}
const MODIFIER = { alt: 1, ctrl: 2, shift: 8 }

/**
 * The browser key event for a key name of the scenario steps (`enter`, `ctrl+o`, `shift+tab`, `alt+x`), or the text
 * to insert for anything else.
 * @returns {{ key: string, code: string, keyCode: number, text?: string, modifiers: number } | { insert: string }}
 */
export function browserKey(name) {
  const parts = name.toLowerCase().split('+')
  const base = parts.at(-1)
  const modifiers = parts.slice(0, -1).reduce((sum, part) => sum + (MODIFIER[part] ?? Number.NaN), 0)
  if (Number.isNaN(modifiers) || name.length === 1) return { insert: name }
  if (NAMED[base] !== undefined) return { ...NAMED[base], ...(modifiers === 0 ? {} : { text: undefined }), modifiers }
  if (/^[a-z]$/u.test(base) && modifiers !== 0) return { key: base, code: `Key${base.toUpperCase()}`, keyCode: base.toUpperCase().charCodeAt(0), modifiers }
  return { insert: name }
}

const page = ({ cols, rows }) => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<style>
@font-face { font-family: 'JBM'; src: url(/JetBrainsMono-Regular.woff2) format('woff2'); font-weight: 400; }
@font-face { font-family: 'JBM'; src: url(/JetBrainsMono-Bold.woff2) format('woff2'); font-weight: 700; }
html, body { margin: 0; background: #1e1e1e; } #t { display: inline-block; padding: 8px; }
</style><div id="t"></div>
<script src="/xterm.js"></script><script src="/addon-webgl.js"></script>
<script>
(async () => {
  await document.fonts.load('14px JBM'); await document.fonts.load('bold 14px JBM')
  const term = new Terminal({ cols: ${String(cols)}, rows: ${String(rows)}, fontFamily: 'JBM, monospace', fontSize: 14, allowProposedApi: true, theme: { background: '#1e1e1e', foreground: '#d4d4d4' } })
  term.open(document.getElementById('t'))
  window.renderer = 'dom'
  try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => { window.renderer = 'lost' }); term.loadAddon(gl); window.renderer = 'webgl' } catch { /* the DOM renderer stays */ }
  term.onData(data => ptyWrite(data))
  term.onBinary(data => ptyWrite(data))
  window.term = term
  window.feed = b64 => new Promise(done => term.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), done))
  window.cell = (row, col) => { const r = document.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.x + (col + 0.5) * r.width / term.cols, y: r.y + (row + 0.5) * r.height / term.rows } }
  window.ready = true
})()
</script>`

/**
 * Open a terminal page in headless Chrome.
 * @param {{ cols: number, rows: number, write: (data: string) => void }} options - `write` sends to the product.
 */
export async function openBrowserTerminal({ cols, rows, write }) {
  const chromeBin = findChrome()
  if (chromeBin === undefined) throw new Error('no Chrome to render the real look: install google-chrome or chromium, or set CHROME_BIN')
  const xterm = dirname(require.resolve('@xterm/xterm/package.json'))
  const webgl = dirname(require.resolve('@xterm/addon-webgl/package.json'))
  const files = {
    '/xterm.js': [join(xterm, 'lib/xterm.js'), 'text/javascript'],
    '/xterm.css': [join(xterm, 'css/xterm.css'), 'text/css'],
    '/addon-webgl.js': [join(webgl, 'lib/addon-webgl.js'), 'text/javascript'],
    '/JetBrainsMono-Regular.woff2': [join(ASSETS, 'JetBrainsMono-Regular.woff2'), 'font/woff2'],
    '/JetBrainsMono-Bold.woff2': [join(ASSETS, 'JetBrainsMono-Bold.woff2'), 'font/woff2'],
  }
  const html = page({ cols, rows })
  const server = createServer((request, response) => {
    if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }).end(html); return }
    const file = files[request.url ?? '']
    if (file === undefined) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': file[1] }).end(readFileSync(file[0]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const profile = mkdtempSync(join(tmpdir(), 'mayfly-chrome-'))
  const chrome = spawn(chromeBin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--window-size=2000,1400', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const close = async () => {
    socket?.close()
    // Chrome writes its profile until it has exited; only then is the profile removed.
    const exited = chrome.exitCode !== null ? Promise.resolve() : new Promise(resolve => chrome.once('exit', resolve))
    chrome.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
    await new Promise(resolve => server.close(resolve))
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* a leftover temp profile is harmless */ }
  }
  let socket
  try {
    const url = await new Promise((resolve, reject) => {
      let err = ''
      chrome.stderr.on('data', (data) => { err += data; const match = /DevTools listening on (ws:\/\/\S+)/u.exec(err); if (match) resolve(match[1]) })
      chrome.once('exit', code => reject(new Error(`Chrome exited (${String(code)}): ${err.slice(-500)}`)))
      setTimeout(() => reject(new Error(`Chrome gave no DevTools address: ${err.slice(-500)}`)), 20_000)
    })
    socket = new WebSocket(url)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  } catch (error) { await close(); throw error }
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry?.reject(new Error(JSON.stringify(message.error)))
      else entry?.resolve(message.result)
    } else if (message.method === 'Runtime.bindingCalled' && message.params.name === 'ptyWrite') write(message.params.payload)
  })
  let session
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(session === undefined ? {} : { sessionId: session }) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Runtime.addBinding', { name: 'ptyWrite' })
  await send('Page.navigate', { url: `http://127.0.0.1:${String(server.address().port)}/` })
  for (let tries = 0; tries < 200 && await evaluate('window.ready === true') !== true; tries += 1) await new Promise(resolve => setTimeout(resolve, 25))
  await evaluate('term.focus()')
  const renderer = await evaluate('window.renderer')
  let chain = Promise.resolve()

  return {
    renderer,
    /** Bytes from the product, written in order. */
    feed(data) { const b64 = Buffer.from(data, 'utf8').toString('base64'); chain = chain.then(() => evaluate(`feed(${JSON.stringify(b64)})`)) },
    /** Resolve once every byte fed so far is drawn. */
    flush: async () => { await chain; await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))') },
    /** A key as the browser sends it, or text as it is typed. */
    async key(name) {
      const event = browserKey(name)
      if ('insert' in event) { await send('Input.insertText', { text: event.insert }); return }
      const common = { key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: event.modifiers }
      await send('Input.dispatchKeyEvent', { type: event.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, ...(event.text === undefined ? {} : { text: event.text, unmodifiedText: event.text }) })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    },
    async click(row, col) {
      const { x, y } = await evaluate(`cell(${String(row)}, ${String(col)})`)
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    },
    async wheel(row, col, direction) {
      const { x, y } = await evaluate(`cell(${String(row)}, ${String(col)})`)
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: direction === 'up' ? -120 : 120 })
    },
    resize: (nextCols, nextRows) => evaluate(`term.resize(${String(nextCols)}, ${String(nextRows)})`),
    /** A PNG of the terminal. */
    async screenshot() {
      await this.flush()
      const rect = await evaluate(`(() => { const r = document.getElementById('t').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } })
      return Buffer.from(data, 'base64')
    },
    close,
  }
}
