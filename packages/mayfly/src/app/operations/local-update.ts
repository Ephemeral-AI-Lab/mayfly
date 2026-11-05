/** Frontend-local npm launcher staging, verification, installation and exact-version recovery.
 * @module @ephemeral-ai/mayfly/app/operations/local-update
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const CLI = '@ephemeral-ai/mayfly-cli'
const TUI = '@ephemeral-ai/mayfly'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const OWNED_NPM = `
import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const temporary = process.argv[1] + '.' + randomUUID()
try {
  await writeFile(temporary, JSON.stringify({ state: 'running', pid: process.pid }), { mode: 0o600, flag: 'wx' })
  await rename(temporary, process.argv[1])
} finally { await rm(temporary, { force: true }) }
process.argv = [process.execPath, ...process.argv.slice(2)]
await import(pathToFileURL(process.argv[1]).href)
`

/** The local process/file boundary; tests exercise the transaction without changing global packages. */
export interface LocalUpdateIo {
  readonly entry: string | undefined
  readonly node: string
  readonly npm: string
  readonly pid: number
  running(pid: number): boolean
  claim(path: string, text: string): Promise<void>
  read(path: string): Promise<string>
  real(path: string): Promise<string>
  temporary(): Promise<string>
  write(path: string, text: string): Promise<void>
  append(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
  replace(path: string, text: string): Promise<void>
  lock<T>(path: string, operation: () => Promise<T>, signal: AbortSignal): Promise<T>
  run(command: string, args: readonly string[], signal?: AbortSignal, ownerPath?: string): Promise<string>
}

/** Construct a bounded subprocess boundary with no shell and no credential-bearing environment. */
export function systemLocalUpdateIo(): LocalUpdateIo {
  return {
    entry: process.argv[1], node: process.execPath, pid: process.pid,
    running: pid => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } },
    claim: (path, text) => writeFile(path, text, { flag: 'wx', mode: 0o600 }),
    npm: join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js'),
    read: path => readFile(path, 'utf8'), real: realpath,
    temporary: () => mkdtemp(join(tmpdir(), 'mayfly-update-')),
    write: (path, text) => writeFile(path, text, { mode: 0o600 }),
    append: (path, text) => appendFile(path, text, { mode: 0o600 }),
    remove: path => rm(path, { recursive: true, force: true }),
    replace: (path, text) => writeFileAtomic(path, text, { mode: 0o600 }),
    lock: (path, operation, signal) => withFileLock(path, operation, { signal, waitMs: 0 }),
    run: async (command, args, signal, ownerPath) => {
      if (ownerPath !== undefined) await writeFileAtomic(ownerPath, JSON.stringify({ state: 'starting' }), { mode: 0o600 })
      try { return await new Promise<string>((resolveRun, reject) => {
        const env = { ...process.env }
        delete env.MAYFLY_DSH_STARTUP_URL
        delete env.MAYFLY_TASK
        delete env.MAYFLY_SESSION_ID
        const owned = ownerPath === undefined ? [...args] : ['--input-type=module', '--eval', OWNED_NPM, ownerPath, ...args]
        execFile(command, owned, { env, timeout: 1_200_000, maxBuffer: 4 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
          if (error !== null) reject(new Error(`Local update process failed: ${error.code ?? 'unknown'}`))
          else resolveRun(`${stdout}${stderr}`)
        })
      }) } finally { if (ownerPath !== undefined) await rm(ownerPath, { force: true }) }
    },
  }
}

/** One verified, local launcher installation and its recovery location. */
export interface LocalUpdateSnapshot {
  readonly root: string
  readonly current: string
  readonly target: string
  readonly directory: string
  readonly logPath: string
  readonly lockPath: string
}

/** An interrupted installation retains its original exact Host identity and enablement. */
export interface PendingLocalUpdate { readonly snapshot: LocalUpdateSnapshot, readonly host: string, readonly enabled: boolean }

/** Canonical frontend release metadata; the Host still verifies an exact install. */
export interface LocalUpdateReleases {
  readonly tags: Readonly<Record<string, string>>
  readonly versions: readonly string[]
  readonly time: Readonly<Record<string, string>>
}

/** Reject foreign npm output rather than guessing a channel target. */
function releaseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The frontend registry returned invalid Mayfly release metadata')
  return value as Readonly<Record<string, unknown>>
}

/** Keep only the string-valued metadata native npm publishes. */
function releaseStrings(value: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(releaseRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** Version-gated frontend-local upgrade owner, independent from Host profile management. */
export class LocalFrontendUpdater {
  private active: LocalUpdateSnapshot | undefined

  constructor(private readonly io: LocalUpdateIo = systemLocalUpdateIo()) {}

  /** Resolve the frontend's complete channel table through its own npm configuration. */
  async releases(signal: AbortSignal): Promise<LocalUpdateReleases> {
    const output = await this.io.run(this.io.node, [this.io.npm, 'view', CLI, '--json'], signal)
    const parsed: unknown = JSON.parse(output)
    const record = releaseRecord(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed)
    const versions = record.versions
    if (!Array.isArray(versions) || !versions.every((version): version is string => typeof version === 'string')) throw new Error('The frontend registry returned invalid Mayfly release metadata')
    return { tags: releaseStrings(record['dist-tags']), versions, time: releaseStrings(record.time) }
  }

  /** Refuse linked/workspace/non-npm installs before any mutation, as the reference updater does. */
  async preflight(current: string, target: string, signal: AbortSignal): Promise<LocalUpdateSnapshot> {
    if (!VERSION.test(current) || !VERSION.test(target)) throw new Error('The update requires exact released versions')
    const root = await this.installationRoot(signal, current)
    const directory = await this.io.temporary()
    const logPath = join(directory, 'update.log')
    await this.io.write(logPath, `Mayfly ${current} -> ${target}\n`)
    await this.io.write(join(directory, 'recovery.json'), `${JSON.stringify({ package: CLI, current, target, root })}\n`)
    return Object.freeze({ root, current, target, directory, logPath, lockPath: join(dirname(root), '.mayfly-update.json') })
  }

  /** Read a durable interrupted-update marker without changing either installation. */
  async pending(signal: AbortSignal): Promise<PendingLocalUpdate | undefined> {
    if (this.io.entry === undefined) return undefined
    const captured = this.active
    const root = captured?.root ?? dirname(dirname(await this.io.real(this.io.entry)))
    const lockPath = join(dirname(root), '.mayfly-update.json')
    let raw: string
    try { raw = await this.io.read(lockPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (signal.aborted) return undefined
    const record = JSON.parse(raw) as { snapshot: LocalUpdateSnapshot, host: string, enabled: boolean, pid: number }
    const snapshot = record.snapshot
    if (typeof record.host !== 'string' || typeof record.enabled !== 'boolean' || !Number.isSafeInteger(record.pid)
      || snapshot?.root !== root || snapshot.lockPath !== lockPath || !VERSION.test(snapshot.current) || !VERSION.test(snapshot.target)
      || typeof snapshot.directory !== 'string' || snapshot.logPath !== join(snapshot.directory, 'update.log')) throw new Error('The interrupted-update marker is invalid; inspect it before repairing the installation')
    if (record.pid !== this.io.pid && this.io.running(record.pid)) throw new Error('Another Mayfly update process is still running')
    await this.checkWorker(lockPath)
    if (captured !== undefined && JSON.stringify(snapshot) === JSON.stringify(captured)) await this.checkGlobalRoot(root, signal)
    else await this.installationRoot(signal)
    this.active = snapshot
    return { snapshot, host: record.host, enabled: record.enabled }
  }

  /** Claim the shared local installation before mutation; concurrent TUI processes cannot overwrite it. */
  async begin(snapshot: LocalUpdateSnapshot, host: string, enabled: boolean): Promise<void> {
    await this.io.claim(snapshot.lockPath, `${JSON.stringify({ snapshot, host, enabled, pid: this.io.pid })}\n`)
    this.active = snapshot
  }

  /** Keep the local installation exclusively owned until the callback has finished or compensated. */
  async transaction<T>(snapshot: LocalUpdateSnapshot, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.io.lock(snapshot.lockPath, async () => {
      await this.checkWorker(snapshot.lockPath, true)
      await this.installationRoot(signal, snapshot.current)
      return operation()
    }, signal)
  }

  /** Recheck and transfer an interrupted marker while holding the same process lock as normal updates. */
  async recovery<T>(pending: PendingLocalUpdate, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const { snapshot } = pending
    return this.io.lock(snapshot.lockPath, async () => {
      const current = await this.pending(signal)
      if (current === undefined || current.host !== pending.host || current.enabled !== pending.enabled || JSON.stringify(current.snapshot) !== JSON.stringify(snapshot)) {
        throw new Error('The interrupted update changed before recovery; inspect its marker and retry explicitly')
      }
      signal.throwIfAborted()
      await this.checkWorker(snapshot.lockPath, true)
      await this.io.replace(snapshot.lockPath, `${JSON.stringify({ snapshot, host: pending.host, enabled: pending.enabled, pid: this.io.pid })}\n`)
      this.active = snapshot
      return operation()
    }, signal)
  }

  /** A worker writes its own durable PID before loading npm; an unknown startup cannot prove safe recovery. */
  private async checkWorker(lockPath: string, clear = false): Promise<void> {
    const path = `${lockPath}.worker`
    let text: string
    try { text = await this.io.read(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const unconfirmed = new Error(`The npm worker startup is unconfirmed; inspect ${path} and stop any earlier npm writer before manual repair`)
    let record: { state?: unknown, pid?: unknown } | undefined
    try { record = JSON.parse(text) as typeof record } catch { throw unconfirmed }
    if (record?.state !== 'running' || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw unconfirmed
    if (this.io.running(record.pid)) throw new Error(`An earlier npm worker (${record.pid}) is still writing this installation; wait for it before recovery`)
    if (clear) await this.io.remove(path)
  }

  /** Clear recovery ownership only after both installations have verified or restored. */
  async finish(snapshot: LocalUpdateSnapshot): Promise<void> {
    await this.io.remove(snapshot.lockPath)
    this.active = undefined
  }

  /** Download both exact release graphs before mutations, then smoke the candidate's real entry. */
  async stage(snapshot: LocalUpdateSnapshot, signal: AbortSignal): Promise<void> {
    for (const [label, version] of [['previous', snapshot.current], ['candidate', snapshot.target]] as const) {
      const prefix = join(snapshot.directory, label)
      await this.npm(snapshot, ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `${CLI}@${version}`], signal)
      const cliRoot = join(prefix, 'node_modules', CLI)
      await this.verify(cliRoot, version)
      const entry = join(cliRoot, 'lib/bin.js')
      await this.io.run(this.io.node, ['--input-type=module', '--eval', `import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; const require = createRequire(process.argv[1]); await import(pathToFileURL(require.resolve('@ephemeral-ai/mayfly')).href)`, entry], signal)
      const output = await this.io.run(this.io.node, [entry, '--version'], signal)
      if (output.trim() !== `mayfly ${version}`) throw new Error('The staged launcher failed its version startup check')
    }
  }

  /** Install only the already validated exact launcher; its exact dependency owns the TUI and its presentation. */
  async install(snapshot: LocalUpdateSnapshot, signal?: AbortSignal): Promise<void> {
    await this.npm(snapshot, ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${CLI}@${snapshot.target}`], signal, true)
    await this.verify(snapshot.root, snapshot.target)
  }

  /** Recovery is explicit exact-version installation using the graph cached before the transaction. */
  async restore(snapshot: LocalUpdateSnapshot): Promise<void> {
    await this.npm(snapshot, ['install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', `${CLI}@${snapshot.current}`], undefined, true)
    await this.verify(snapshot.root, snapshot.current)
  }

  /** Retain the log/recovery recipe while dropping staged dependency trees. */
  async cleanup(snapshot: LocalUpdateSnapshot): Promise<void> {
    if (this.active === snapshot) return
    await this.io.remove(join(snapshot.directory, 'previous'))
    await this.io.remove(join(snapshot.directory, 'candidate'))
  }

  private async installationRoot(signal: AbortSignal, current?: string): Promise<string> {
    if (this.io.entry === undefined) throw new Error('Start the installed mayfly launcher before updating')
    const entry = await this.io.real(this.io.entry)
    const root = dirname(dirname(entry))
    const manifest = JSON.parse(await this.io.read(join(root, 'package.json'))) as { name?: unknown, version?: unknown }
    if (manifest.name !== CLI || typeof manifest.version !== 'string' || !VERSION.test(manifest.version) || (current !== undefined && manifest.version !== current)) throw new Error('Linked or standalone TUI installs cannot self-update; use the installed npm mayfly launcher')
    await this.checkGlobalRoot(root, signal)
    return root
  }

  /** A captured installation survives missing package files, but never a prefix change or npm link. */
  private async checkGlobalRoot(root: string, signal: AbortSignal): Promise<void> {
    const globalRoot = (await this.io.run(this.io.node, [this.io.npm, 'root', '--global'], signal)).trim()
    if (join(await this.io.real(globalRoot), CLI) !== root) throw new Error('This launcher is not owned by the selected npm global prefix; update it with its original installer')
  }

  private async npm(snapshot: LocalUpdateSnapshot, args: readonly string[], signal?: AbortSignal, owned = false): Promise<void> {
    const output = await this.io.run(this.io.node, [this.io.npm, ...args], signal, owned ? `${snapshot.lockPath}.worker` : undefined)
    await this.io.append(snapshot.logPath, output)
  }

  private async verify(root: string, version: string): Promise<void> {
    const cli = JSON.parse(await this.io.read(join(root, 'package.json'))) as { version?: unknown, dependencies?: Record<string, unknown> }
    if (cli.version !== version || cli.dependencies?.[TUI] !== version) throw new Error('Launcher and TUI versions are inconsistent')
    // npm may hoist the TUI to the same global node_modules directory.
    const hoisted = resolve(root, '../mayfly/package.json')
    const nested = join(root, 'node_modules', TUI, 'package.json')
    let text: string
    let tuiRoot: string
    try { text = await this.io.read(nested); tuiRoot = dirname(nested) } catch { text = await this.io.read(hoisted); tuiRoot = dirname(hoisted) }
    const manifest = JSON.parse(text) as { version?: unknown, dependencies?: Record<string, unknown> }
    if (manifest.version !== version || manifest.dependencies?.['@ephemeral-ai/mayfly-ui'] !== version || manifest.dependencies?.['@ephemeral-ai/mayfly-host'] !== version) throw new Error('The staged TUI dependency versions are inconsistent')
    for (const name of ['@ephemeral-ai/mayfly-ui', '@ephemeral-ai/mayfly-host']) {
      let shared: string
      try { shared = await this.io.read(join(tuiRoot, 'node_modules', name, 'package.json')) }
      catch { shared = await this.io.read(resolve(tuiRoot, '..', name.slice(name.indexOf('/') + 1), 'package.json')) }
      if ((JSON.parse(shared) as { version?: unknown }).version !== version) throw new Error('An installed TUI dependency version is inconsistent')
    }
  }
}
