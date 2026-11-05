/**
 * Remote-local clipboard image probes for Linux, Windows, and macOS.
 * @module @ephemeral-ai/mayfly/app/local/image-paste
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ImageAttachmentLimits, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { sniffImageMediaType } from '../editor/attachments.ts'
import { readCopiedPaths } from './clipboard.ts'
import { failureDetail, runLocalTool, type LocalToolRun } from './process.ts'

export type ClipboardFailure =
  | { readonly kind: 'no-image' }
  | { readonly kind: 'unsupported', readonly mediaType: string }
  | { readonly kind: 'file-failed', readonly detail: string }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'missing-tool' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed', readonly detail: string }

type ClipboardImageResult =
  | { readonly kind: 'image', readonly data: Uint8Array, readonly mediaType: ImageMediaType, readonly backend?: string, readonly fallback?: boolean }
  | { readonly kind: 'images', readonly images: readonly SaveImageAttachment[], readonly backend?: string, readonly fallback?: boolean }
  | ClipboardFailure

const IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const FILE_TYPES = ['text/uri-list', 'x-special/gnome-copied-files'] as const
const COOLDOWN_MS = 60_000

interface LinuxTool {
  readonly backend: 'wayland' | 'x11'
  readonly command: string
  readonly unreachable: RegExp
  readonly listArgs: readonly string[]
  readArgs(mediaType: string): string[]
}

const LINUX_TOOLS: Readonly<Record<'wayland' | 'x11', LinuxTool>> = {
  wayland: {
    backend: 'wayland', command: 'wl-paste', unreachable: /failed to connect to a wayland server/iu,
    listArgs: ['-l'], readArgs: mediaType => ['-t', mediaType],
  },
  x11: {
    backend: 'x11', command: 'xclip', unreachable: /can(?:not|'t) open display/iu,
    listArgs: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
    readArgs: mediaType => ['-selection', 'clipboard', '-t', mediaType, '-o'],
  },
}

function classify(command: string, run: LocalToolRun, unreachable?: RegExp): ClipboardFailure {
  if (run.code === 'ENOENT') return { kind: 'missing-tool' }
  if (run.killed || run.code === 'ETIMEDOUT') return { kind: 'timeout' }
  if (unreachable?.test(run.stderr) === true) return { kind: 'unreachable' }
  return { kind: 'failed', detail: failureDetail(command, run) }
}

function rank(failure: ClipboardFailure): number {
  switch (failure.kind) {
    case 'unsupported': return 0
    case 'file-failed': return 1
    case 'no-image': return 2
    case 'unreachable': return 3
    case 'failed': return 4
    case 'timeout': return 5
    case 'missing-tool': return 6
  }
}

function aggregate(outcomes: readonly ClipboardFailure[]): ClipboardFailure {
  // Every configured policy probes at least one backend or records its cooldown.
  let best = outcomes[0]!
  for (const outcome of outcomes) if (rank(outcome) < rank(best)) best = outcome
  const kinds = new Set(outcomes.map(outcome => outcome.kind))
  if (!kinds.has('unreachable') || !kinds.has('missing-tool')) return best
  return (process.env.DISPLAY ?? '') !== '' || (process.env.WAYLAND_DISPLAY ?? '') !== ''
    ? { kind: 'missing-tool' }
    : { kind: 'unreachable' }
}

function parseFileUris(data: Buffer, mediaType: typeof FILE_TYPES[number]): { readonly ok: true, readonly paths: string[] } | { readonly ok: false, readonly detail: string } {
  const lines = data.toString('utf8').split(/\r?\n/u).map(line => line.trim())
  if (mediaType === 'x-special/gnome-copied-files') {
    const operation = lines.shift()
    if (operation !== 'copy' && operation !== 'cut') return { ok: false, detail: 'GNOME copied-files data has no copy/cut operation' }
  }
  const paths: string[] = []
  for (const line of lines) {
    if (line === '' || line.startsWith('#')) continue
    try {
      const url = new URL(line)
      if (url.protocol !== 'file:') return { ok: false, detail: `clipboard URI scheme ${url.protocol.slice(0, -1)} is not local` }
      paths.push(fileURLToPath(url))
    } catch {
      return { ok: false, detail: 'clipboard file list contains an invalid local URI' }
    }
  }
  return { ok: true, paths: [...new Set(paths)] }
}

async function probeLinux(tool: LinuxTool, limits: ImageAttachmentLimits, signal: AbortSignal): Promise<ClipboardImageResult> {
  const listing = await runLocalTool(tool.command, tool.listArgs, { signal })
  if (!listing.ok) {
    const failure = classify(tool.command, listing, tool.unreachable)
    if (tool.backend === 'x11' && failure.kind === 'failed' && listing.stderr.trim() === '') return { kind: 'no-image' }
    return failure
  }
  const offered = listing.stdout.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean)
  let soft: ClipboardFailure | undefined
  for (const mediaType of IMAGE_TYPES.filter(type => limits.mediaTypes.includes(type) && offered.includes(type))) {
    const read = await runLocalTool(tool.command, tool.readArgs(mediaType), { signal })
    if (read.ok && read.stdout.length > 0) {
      const sniffed = sniffImageMediaType(read.stdout)
      if (sniffed === mediaType) return { kind: 'image', data: new Uint8Array(read.stdout), mediaType, backend: tool.backend }
      soft ??= { kind: 'failed', detail: `${tool.command} returned invalid bytes for ${mediaType}` }
      continue
    }
    if (!read.ok) {
      const failure = classify(tool.command, read, tool.unreachable)
      if (failure.kind !== 'failed') return failure
      soft ??= failure
    }
  }
  for (const fileType of FILE_TYPES) {
    if (!offered.includes(fileType)) continue
    const read = await runLocalTool(tool.command, tool.readArgs(fileType), { signal })
    if (!read.ok) return classify(tool.command, read, tool.unreachable)
    const parsed = parseFileUris(read.stdout, fileType)
    if (!parsed.ok) return { kind: 'file-failed', detail: parsed.detail }
    const files = await readCopiedPaths(parsed.paths, limits, signal)
    if (files.kind === 'images') return { ...files, backend: tool.backend }
    if (files.kind !== 'no-image') return files
  }
  const imageType = offered.find(type => type.startsWith('image/'))
  if (imageType !== undefined && !offered.some(type => IMAGE_TYPES.includes(type as ImageMediaType))) return { kind: 'unsupported', mediaType: imageType }
  return soft ?? { kind: 'no-image' }
}

async function withStage<T>(fn: (stage: string) => Promise<T>): Promise<T> {
  const stage = await mkdtemp(join(tmpdir(), 'mayfly-paste-'))
  try {
    return await fn(stage)
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

const POWERSHELL_STAGE_ENV = 'MAYFLY_PASTE_STAGE'
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $stage = $env:${POWERSHELL_STAGE_ENV}
  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    try { $img.Save((Join-Path $stage 'clipboard.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $img.Dispose() }
    [System.IO.File]::WriteAllText((Join-Path $stage 'kind'), 'image', $utf8)
    exit 0
  }
  $drop = [System.Windows.Forms.Clipboard]::GetFileDropList()
  $names = New-Object System.Collections.Generic.List[string]
  if ($drop.Count -gt 0) {
    $filesDir = Join-Path $stage 'files'
    [System.IO.Directory]::CreateDirectory($filesDir) | Out-Null
    foreach ($item in $drop) {
      if (-not [System.IO.File]::Exists($item)) { continue }
      $name = [System.IO.Path]::GetFileName($item)
      $dest = Join-Path $filesDir $name
      $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
      $ext = [System.IO.Path]::GetExtension($name)
      $i = 1
      while ([System.IO.File]::Exists($dest)) {
        $dest = Join-Path $filesDir ($base + ' (' + $i + ')' + $ext)
        $i++
      }
      [System.IO.File]::Copy($item, $dest)
      $names.Add([System.IO.Path]::GetFileName($dest))
    }
  }
  if ($names.Count -eq 0) { exit 2 }
  [System.IO.File]::WriteAllText((Join-Path $stage 'kind'), 'files', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $stage 'order'), ($names -join "\`n"), $utf8)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

async function probeWindows(limits: ImageAttachmentLimits, signal: AbortSignal): Promise<ClipboardImageResult> {
  return withStage(async stage => {
    const run = await runLocalTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', POWERSHELL_SCRIPT], {
      signal, timeoutMs: 10_000, env: { ...process.env, [POWERSHELL_STAGE_ENV]: stage },
    })
    if (!run.ok) return run.code === 2 ? { kind: 'no-image' } : classify('powershell.exe', run)
    try {
      const kind = (await readFile(join(stage, 'kind'), 'utf8')).trim()
      if (kind === 'image') {
        const data = await readFile(join(stage, 'clipboard.png'))
        if (sniffImageMediaType(data) !== 'image/png') return { kind: 'failed', detail: 'powershell.exe returned invalid PNG bytes' }
        return { kind: 'image', data: new Uint8Array(data), mediaType: 'image/png', backend: 'win32' }
      }
      if (kind === 'files') {
        const names = (await readFile(join(stage, 'order'), 'utf8')).split(/\r?\n/u).filter(Boolean)
        const files = await readCopiedPaths(names.map(name => join(stage, 'files', name)), limits, signal)
        return files.kind === 'images' ? { ...files, backend: 'win32' } : files
      }
      return { kind: 'failed', detail: 'powershell.exe did not write a clipboard staging marker' }
    } catch (error) {
      return { kind: 'failed', detail: `powershell.exe staging read failed (${String((error as NodeJS.ErrnoException).code)})` }
    }
  })
}

const DARWIN_TYPES: ReadonlyArray<readonly [string, string, ImageMediaType, string]> = [
  ['PNGf', '«class PNGf»', 'image/png', 'png'],
  ['JPEG', 'JPEG picture', 'image/jpeg', 'jpg'],
  ['GIF', 'GIF picture', 'image/gif', 'gif'],
]

function appleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function darwinWrite(coercion: string, destination: string): string[] {
  return [
    '-e', `set imageData to (the clipboard as ${coercion})`,
    '-e', `set fileRef to open for access POSIX file "${appleScriptString(destination)}" with write permission`,
    '-e', 'set eof of fileRef to 0',
    '-e', 'write imageData to fileRef',
    '-e', 'close access fileRef',
  ]
}

function clipboardClasses(info: string): Set<string> {
  const classes = new Set<string>()
  for (const match of info.matchAll(/«class\s*([^»]+?)\s*»|\b([A-Za-z]+)\s+picture\b/gu)) classes.add((match[1] ?? match[2])!.trim())
  return classes
}

async function probeDarwin(limits: ImageAttachmentLimits, signal: AbortSignal): Promise<ClipboardImageResult> {
  return withStage(async stage => {
    const info = await runLocalTool('osascript', ['-e', 'clipboard info'], { signal, timeoutMs: 5_000 })
    if (!info.ok) return classify('osascript', info)
    const classes = clipboardClasses(info.stdout.toString('utf8'))
    let soft: ClipboardFailure | undefined
    for (const [token, coercion, mediaType, extension] of DARWIN_TYPES) {
      if (!classes.has(token)) continue
      const path = join(stage, `clipboard.${extension}`)
      const run = await runLocalTool('osascript', darwinWrite(coercion, path), { signal, timeoutMs: 5_000 })
      if (!run.ok) {
        const failure = classify('osascript', run)
        if (failure.kind !== 'failed') return failure
        soft ??= failure
        continue
      }
      const data = await readFile(path)
      if (sniffImageMediaType(data) !== mediaType) return { kind: 'failed', detail: `osascript returned invalid bytes for ${mediaType}` }
      return { kind: 'image', data: new Uint8Array(data), mediaType, backend: 'darwin' }
    }
    if (classes.has('TIFF')) {
      const tiff = join(stage, 'clipboard.tiff')
      const png = join(stage, 'clipboard.png')
      for (const coercion of ['«class TIFF»', 'TIFF picture']) {
        const write = await runLocalTool('osascript', darwinWrite(coercion, tiff), { signal, timeoutMs: 5_000 })
        if (!write.ok) continue
        const convert = await runLocalTool('sips', ['-s', 'format', 'png', tiff, '--out', png], { signal, timeoutMs: 5_000 })
        if (!convert.ok) return classify('sips', convert)
        const data = await readFile(png)
        if (sniffImageMediaType(data) === 'image/png') return { kind: 'image', data: new Uint8Array(data), mediaType: 'image/png', backend: 'darwin' }
      }
      soft ??= { kind: 'failed', detail: 'macOS TIFF clipboard conversion failed' }
    }
    if (classes.has('furl')) {
      const list = await runLocalTool('osascript', [
        '-e', 'set filePaths to (the clipboard as «class furl») as list',
        '-e', 'set pathLines to ""',
        '-e', 'repeat with filePath in filePaths',
        '-e', 'set pathLines to pathLines & (POSIX path of filePath) & linefeed',
        '-e', 'end repeat',
        '-e', 'return pathLines',
      ], { signal, timeoutMs: 5_000 })
      if (list.ok) {
        const paths = list.stdout.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean)
        const files = await readCopiedPaths(paths, limits, signal)
        if (files.kind === 'images') return { ...files, backend: 'darwin' }
        if (files.kind !== 'no-image') return files
      } else soft ??= classify('osascript', list)
    }
    if (soft !== undefined) return soft
    return { kind: 'no-image' }
  })
}

/** One Remote-local probe owner with backend cooldown state and no module singletons. */
export class LocalImagePaste {
  private readonly cooldowns = new Map<string, number>()

  constructor(private readonly backend: () => 'auto' | 'wayland' | 'x11') {}

  async read(limits: ImageAttachmentLimits, signal: AbortSignal): Promise<ClipboardImageResult> {
    const policy = this.backend()
    if (policy === 'auto' && process.platform === 'win32') return probeWindows(limits, signal)
    if (policy === 'auto' && process.platform === 'darwin') return probeDarwin(limits, signal)
    const tools = policy === 'wayland'
      ? [LINUX_TOOLS.wayland]
      : policy === 'x11'
        ? [LINUX_TOOLS.x11]
        : (process.env.WAYLAND_DISPLAY ?? '') !== ''
          ? [LINUX_TOOLS.wayland, LINUX_TOOLS.x11]
          : (process.env.DISPLAY ?? '') !== ''
            ? [LINUX_TOOLS.x11, LINUX_TOOLS.wayland]
            : [LINUX_TOOLS.wayland, LINUX_TOOLS.x11]
    const outcomes: ClipboardFailure[] = []
    for (const [index, tool] of tools.entries()) {
      const key = [tool.backend, process.env.DISPLAY ?? '', process.env.WAYLAND_DISPLAY ?? '', process.env.XDG_RUNTIME_DIR ?? ''].join('\0')
      const retry = this.cooldowns.get(key) ?? 0
      if (Date.now() < retry) {
        outcomes.push({ kind: 'timeout' })
        continue
      }
      const result = await probeLinux(tool, limits, signal)
      if (result.kind === 'image' || result.kind === 'images') return { ...result, fallback: policy === 'auto' && index > 0 }
      if (result.kind === 'timeout') this.cooldowns.set(key, Date.now() + COOLDOWN_MS)
      outcomes.push(result)
      if (signal.aborted) break
    }
    return aggregate(outcomes)
  }
}

/** Actionable local clipboard failure copy, preserving the current Mayfly wording. */
export function clipboardFailureNotice(result: ClipboardFailure, platform: NodeJS.Platform = process.platform): string {
  switch (result.kind) {
    case 'missing-tool':
      if (platform === 'win32') return 'clipboard image tool missing: powershell.exe is unavailable'
      if (platform === 'darwin') return 'clipboard image tool missing: osascript or sips is unavailable'
      return 'clipboard image tool missing: install wl-clipboard (wl-paste) or xclip'
    case 'unreachable': return 'clipboard unreachable: DISPLAY/WAYLAND_DISPLAY is not set in this session'
    case 'no-image': return 'no image available from the clipboard'
    case 'unsupported': return `clipboard image type ${result.mediaType} is not supported`
    case 'file-failed': return `clipboard image file failed: ${result.detail}`
    case 'timeout': return 'clipboard read timed out'
    case 'failed': return `clipboard read failed: ${result.detail}`
  }
}
