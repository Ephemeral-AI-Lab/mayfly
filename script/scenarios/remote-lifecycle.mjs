/**
 * Supervise the independent remote Frontend against an owner-supplied dsh Host.
 * The startup token travels only in the child environment and is redacted from output.
 * @module script/scenarios/remote-lifecycle
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REMOTE_BIN = fileURLToPath(new URL('../../packages/remote/lib/remote-bin.js', import.meta.url))

function endpoint(startupUrl) {
  let url
  try {
    url = new URL(startupUrl)
  } catch {
    throw new Error('MAYFLY_DSH_STARTUP_URL must be a valid HTTP(S) URL with exactly one token')
  }
  const tokens = url.searchParams.getAll('token')
  const token = tokens[0]
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || tokens.length !== 1 || token === undefined || token === '') {
    throw new Error('MAYFLY_DSH_STARTUP_URL must be a valid HTTP(S) URL with exactly one token')
  }
  return {
    value: {
      id: `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`,
      url: url.href,
      token,
    },
    secrets: [startupUrl, url.href, token, encodeURIComponent(token), new URLSearchParams({ token }).toString().slice('token='.length)],
  }
}

/**
 * Run the built independent remote in a PTY attached to the reviewer.
 * @param {object} options
 * @param {string} options.cwd - working directory for the automatically created Session.
 * @param {Record<string, string | undefined>} options.env - presentation and credential-carrying environment.
 * @param {number} options.cols - initial PTY columns.
 * @param {number} options.rows - initial PTY rows.
 * @returns {{ done: Promise<number>, stop(): void }} child completion and cleanup.
 */
export function superviseRemote({ cwd, env, cols, rows }) {
  const startupUrl = env.MAYFLY_DSH_STARTUP_URL
  if (startupUrl === undefined || startupUrl === '') {
    throw new Error('Set MAYFLY_DSH_STARTUP_URL to the dsh Host startup URL; do not put its token on the command line')
  }
  const { value, secrets } = endpoint(startupUrl)
  const redactions = [...new Set(secrets.filter(secret => secret !== ''))].sort((left, right) => right.length - left.length)
  const redact = data => redactions.reduce((text, secret) => text.replaceAll(secret, '<redacted>'), data)
  const pty = require('node-pty')
  const out = process.stdout
  const child = pty.spawn(process.execPath, [REMOTE_BIN], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      ...env,
      MAYFLY_ENDPOINT: JSON.stringify(value),
      MAYFLY_CWD: cwd,
      COLUMNS: undefined,
      LINES: undefined,
    },
  })
  let stopped = false
  let finish
  const done = new Promise(resolve => { finish = resolve })
  child.onData(data => { out.write(redact(data)) })
  child.onExit(({ exitCode }) => {
    stopped = true
    finish(exitCode)
  })
  const onInput = data => { child.write(data.toString('binary')) }
  const onResize = () => { child.resize(cols, rows) }
  const stop = () => {
    process.stdin.off('data', onInput)
    out.off('resize', onResize)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    if (!stopped) {
      stopped = true
      child.kill()
    }
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', onInput)
  process.stdin.resume()
  out.on('resize', onResize)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return {
    done: done.then(code => { stop(); return code }),
    stop,
  }
}
