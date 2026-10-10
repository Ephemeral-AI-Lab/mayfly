import assert from 'node:assert/strict'
import test from 'node:test'
import { browserKey, findChrome, openBrowserTerminal } from '../scenarios/browser.mjs'
import { keyBytes } from '../scenarios/input.mjs'

/** The key names the scenario steps use, sent by both backends. */
const KEYS = ['enter', 'esc', 'tab', 'shift+tab', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'ctrl+o', 'ctrl+c', 'alt+x', 'a', '/']

test('a key name becomes a browser key event with its modifiers, and anything else is typed', () => {
  assert.deepEqual(browserKey('enter'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })
  assert.deepEqual(browserKey('ctrl+o'), { key: 'o', code: 'KeyO', keyCode: 79, modifiers: 2 })
  assert.deepEqual(browserKey('shift+tab'), { key: 'Tab', code: 'Tab', keyCode: 9, text: undefined, modifiers: 8 })
  assert.deepEqual(browserKey('alt+x'), { key: 'x', code: 'KeyX', keyCode: 88, modifiers: 1 })
  assert.deepEqual(browserKey('hello'), { insert: 'hello' })
  assert.deepEqual(browserKey('+'), { insert: '+' })
})

test('xterm.js in Chrome answers the product\'s queries and sends each key as the headless backend does', { skip: findChrome() === undefined && 'no Chrome on this machine' }, async () => {
  const writes = []
  const terminal = await openBrowserTerminal({ cols: 40, rows: 6, write: data => writes.push(data) })
  try {
    terminal.feed('\u001b[c\u001b]11;?\u0007\u001b[?1004h')
    await terminal.flush()
    for (let tries = 0; tries < 50 && writes.length < 3; tries += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(writes.splice(0), ['\u001b[?1;2c', '\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\', '\u001b[I'])
    for (const name of KEYS) {
      await terminal.key(name)
      for (let tries = 0; tries < 50 && writes.length === 0; tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(writes.splice(0).join(''), keyBytes(name), name)
    }
    terminal.feed('\u001b[?1000h\u001b[?1006h')
    await terminal.flush()
    await terminal.wheel(2, 3, 'up')
    await terminal.click(1, 0)
    for (let tries = 0; tries < 50 && writes.length < 3; tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(writes.splice(0), ['\u001b[<64;4;3M', '\u001b[<0;1;2M', '\u001b[<0;1;2m'])
    assert.equal((await terminal.screenshot()).subarray(1, 4).toString(), 'PNG')
  } finally {
    await terminal.close()
  }
})
