/** Operating-system user-service registration, activation and login policy. @module */
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { execute, privateDirectory, type Paths } from './state.ts'

/** A stable service identity includes the data root as well as the profile. */
export function serviceId(p: Paths): string { return `dev.mayfly.${createHash('sha256').update(p.dir).digest('hex').slice(0, 20)}` }

/** Quote a systemd argument, disabling expansion of percent and dollar specifiers. */
export function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`
}

/** Escape a LaunchAgent property-list value. */
export function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

/** Quote Windows CreateProcess arguments, including trailing backslashes. */
export function windowsQuote(value: string): string {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

/** Build a native service definition containing only paths and instance identity. */
export function definition(p: Paths, profile: string, bin: string, platform = process.platform, enabled = false): string {
  if (platform === 'linux') return `[Unit]\nDescription=Mayfly Host (${profile})\nStartLimitIntervalSec=120\nStartLimitBurst=10\n\n[Service]\nType=simple\nExecStart=${[process.execPath, bin, '__service', profile, p.home].map(systemdQuote).join(' ')}\nRestart=on-failure\nRestartSec=3\nKillMode=mixed\nTimeoutStopSec=12\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${serviceId(p)}</string>\n<key>ProgramArguments</key><array>${[process.execPath, bin, '__service', profile, p.home].map(value => `<string>${xml(value)}</string>`).join('')}</array>\n<key>RunAtLoad</key><${enabled ? 'true' : 'false'}/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>3</integer>\n</dict></plist>\n`
}

function serviceFile(p: Paths): string {
  return process.platform === 'linux'
    ? join(homedir(), '.config', 'systemd', 'user', `${serviceId(p)}.service`)
    : join(homedir(), 'Library', 'LaunchAgents', `${serviceId(p)}.plist`)
}
function launchFile(p: Paths): string { return join(p.dir, 'service.plist') }
function domain(): string { return `gui/${process.getuid!()}` }
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** Register/update a service without enabling login startup or starting it. */
export async function register(p: Paths, profile: string, bin: string): Promise<void> {
  if (process.platform === 'win32') return
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Mayfly server supports Linux, macOS and Windows')
  const file = process.platform === 'darwin' ? launchFile(p) : serviceFile(p)
  await privateDirectory(dirname(file))
  const enabled = await isEnabled(p)
  const content = definition(p, profile, bin, process.platform, enabled)
  if (await readFile(file, 'utf8').catch(() => '') === content) return
  await writeFile(file, content, { mode: 0o600 })
  if (process.platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload'])
}

/** Start via the native user service manager, or detach the Windows supervisor. */
export async function startService(p: Paths, profile: string, bin: string): Promise<void> {
  await register(p, profile, bin)
  if (process.platform === 'linux') await execute('systemctl', ['--user', 'start', `${serviceId(p)}.service`])
  else if (process.platform === 'darwin') {
    const loaded = await execute('launchctl', ['print', `${domain()}/${serviceId(p)}`]).then(() => true, () => false)
    if (!loaded) await execute('launchctl', ['bootstrap', domain(), launchFile(p)])
    await execute('launchctl', ['kickstart', `${domain()}/${serviceId(p)}`])
  } else {
    const child = spawn(process.execPath, [bin, '__service', profile, p.home], { detached: true, windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject) })
    child.unref()
  }
}

/** Stop native supervision as well as the Host, preventing an explicit stop from restarting. */
export async function stopService(p: Paths): Promise<void> {
  if (process.platform === 'linux') {
    const exists = await readFile(serviceFile(p), 'utf8').then(() => true, () => false)
    if (exists) await execute('systemctl', ['--user', 'stop', `${serviceId(p)}.service`])
  } else if (process.platform === 'darwin') {
    const loaded = await execute('launchctl', ['print', `${domain()}/${serviceId(p)}`]).then(() => true, () => false)
    if (loaded) await execute('launchctl', ['bootout', `${domain()}/${serviceId(p)}`])
  }
}

/** Read login policy without confusing service registration with enablement. */
export async function isEnabled(p: Paths): Promise<boolean> {
  if (process.platform === 'linux') return execute('systemctl', ['--user', 'is-enabled', `${serviceId(p)}.service`]).then(result => result.stdout.trim() === 'enabled', () => false)
  if (process.platform === 'darwin') return readFile(serviceFile(p), 'utf8').then(() => true, () => false)
  return execute('reg.exe', ['query', runKey, '/v', serviceId(p)]).then(() => true, () => false)
}

/** Change login startup without changing the currently running service. */
export async function setEnabled(p: Paths, profile: string, bin: string, enabled: boolean): Promise<void> {
  await register(p, profile, bin)
  if (process.platform === 'linux') await execute('systemctl', ['--user', enabled ? 'enable' : 'disable', `${serviceId(p)}.service`])
  else if (process.platform === 'darwin') {
    if (enabled) {
      await privateDirectory(dirname(serviceFile(p)))
      await writeFile(serviceFile(p), definition(p, profile, bin, 'darwin', true), { mode: 0o600 })
    } else await rm(serviceFile(p), { force: true })
  }
  else if (enabled) await execute('reg.exe', ['add', runKey, '/v', serviceId(p), '/t', 'REG_SZ', '/d', [process.execPath, bin, '__service', profile, p.home].map(windowsQuote).join(' '), '/f'])
  else if (await isEnabled(p)) await execute('reg.exe', ['delete', runKey, '/v', serviceId(p), '/f'])
}

/** Remove stale socket files only after the previous supervisor is proved absent. */
export async function removeSocket(p: Paths): Promise<void> {
  if (process.platform !== 'win32') await rm(p.socket, { force: true })
}
