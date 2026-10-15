/**
 * What a scenario can put around the product that a PTY run does not have: a clipboard that holds an image, a workspace
 * with files to mention, and an external editor that edits a draft. Each lives in files of the run's own directory and
 * reaches the product through its environment, so the product runs its real code and nothing is added to it.
 * @module script/scenarios/fixtures
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'

/** The CRC-32 table PNG chunks use. */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

/**
 * A PNG of about `kilobytes` KB: random-looking pixels (pseudo-random from a fixed seed) stored uncompressed, so its size
 * and bytes are the same on every run.
 * @param {number} kilobytes - the wanted size.
 * @returns {Buffer} the encoded image.
 */
export function pngOfSize(kilobytes) {
  const width = 128
  const rowBytes = 1 + width * 4
  const height = Math.max(1, Math.round((kilobytes * 1024) / rowBytes))
  const raw = Buffer.alloc(rowBytes * height)
  let seed = 0x2545f491
  for (let at = 0; at < raw.length; at += 1) {
    if (at % rowBytes === 0) continue
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    raw[at] = seed >>> 24
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A `wl-paste` that offers one PNG, ahead of the real tools on `PATH`, so Ctrl+V runs the product's own clipboard flow.
 * @param {string} dir - the run's directory.
 * @param {number} kilobytes - the image's size.
 * @param {number} [delayMs] - how long the clipboard takes to answer a read, for a scenario that shows the wait.
 * @returns {Record<string, string>} the environment the product needs.
 */
export function clipboardImage(dir, kilobytes, delayMs = 0) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const png = join(dir, 'clipboard.png')
  writeFileSync(png, pngOfSize(kilobytes))
  const shim = join(bin, 'wl-paste')
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "-l" ]; then echo image/png; exit 0; fi\nif [ "$1" = "-t" ] && [ "$2" = "image/png" ]; then ${delayMs > 0 ? `sleep ${String(delayMs / 1000)}; ` : ''}cat '${png}'; exit 0; fi\nexit 1\n`)
  chmodSync(shim, 0o755)
  return { PATH: `${bin}:${process.env.PATH ?? ''}`, WAYLAND_DISPLAY: 'scenario-0' }
}

/**
 * Files in a workspace, for `@` mentions.
 * @param {string} cwd - the workspace.
 * @param {Record<string, string>} files - content by relative path.
 */
export function workspaceFiles(cwd, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
}

/**
 * An external editor that appends `suffix` to the first line of the file it is given and exits, for the Ctrl+G round trip.
 * @param {string} dir - the run's directory.
 * @param {string} suffix - what the "user" adds.
 * @returns {Record<string, string>} the environment the product needs.
 */
export function externalEditor(dir, suffix) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const editor = join(bin, 'scenario-editor')
  writeFileSync(editor, `#!/bin/sh\nsed -i '1s/$/ ${suffix.replaceAll('/', '\\/')}/' "$1"\n`)
  chmodSync(editor, 0o755)
  return { VISUAL: editor, EDITOR: editor }
}
