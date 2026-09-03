/**
 * The launcher's main flow (S37, D50 decision 4): answer `-V` from the
 * shell's own manifests (shell · Mayfly pin · harness line, one line),
 * materialize the prepacked host, calibrate the `mayfly` profile on the boot
 * surface, then exec the host with inherited stdio and propagate the
 * child's exit code. Every failure is one verdict line, an optional
 * bounded output tail, and a manual pointer — the bootstrap contract's
 * failure form (D56 extends D50④) — and a non-zero exit.
 *
 * @module @ephemeral-ai/mayfly-cli/main
 */

import { fileURLToPath } from 'node:url'
import { calibrate } from './calibrate.ts'
import type { CalibrationOutcome } from './calibrate.ts'
import { cliInternals } from './internals.ts'
import { translateArgv } from './translate.ts'
import { bundledDsh, HARNESS_LINE } from './runtime.ts'

/**
 * The marker the shell's children carry: the app's help text and exit
 * epitaph rebrand from `dsh --profile mayfly` to `mayfly` when it is `mayfly`
 * (the S37 seam in mayfly-app).
 */
const LAUNCHER_ENV: Record<string, string> = { MAYFLY_LAUNCHER: 'mayfly' }

/** The failed half of `CalibrationOutcome` — the `manualLine` input shape. */
type FailedOutcome = Extract<CalibrationOutcome, { action: 'failed' }>

/**
 * The manual pointer per failure class (D56): every line must be runnable by
 * the failing audience — a fresh npm-shell user has no global `dsh` on PATH,
 * so the bare plugin command retired from the failure output; the global-dsh
 * form stays as the parenthesized escape hatch on the generic classes.
 * @param outcome - the failed calibration.
 * @param version - the shell's own version (the Mayfly pin).
 * @returns the one manual line.
 */
function manualLine(outcome: FailedOutcome, version: string): string {
  if (outcome.kind === 'pnpm-missing' || outcome.kind === 'pnpm-version') return 'npm i -g pnpm@11 (or: corepack enable pnpm@11), then re-run mayfly'
  if (outcome.kind === 'timeout') return 're-run mayfly — downloaded packages are cached and the install resumes'
  return `fix the cause and re-run mayfly (with a global dsh: dsh plugin --profile mayfly add @ephemeral-ai/mayfly@${version})`
}

/**
 * Run one invocation to process exit.
 * @param argv - the shell's arguments (`process.argv.slice(2)` shape).
 */
export async function main(argv: readonly string[]): Promise<void> {
  const translation = translateArgv(argv)
  const version = shellVersion()
  if (translation.kind === 'version') {
    cliInternals.stdout(`mayfly ${version} (Mayfly @ephemeral-ai/mayfly@${version} · harness @deepseek-ai/dsh@${HARNESS_LINE})\n`)
    return
  }
  let host
  try {
    host = await bundledDsh(version)
  } catch (error) {
    cliInternals.stderr(`mayfly: bundled dsh runtime is unavailable — ${String(error).replace(/^Error:\s*/, '')}; reinstall @ephemeral-ai/mayfly-cli\n`)
    cliInternals.exit(1)
    return
  }
  if (translation.kind === 'boot') {
    const outcome = await calibrate({ version, dshBinJs: host.binJs })
    if (outcome.action === 'failed') {
      cliInternals.stderr([
        `mayfly: bootstrap failed — ${outcome.reason}`,
        ...(outcome.detail ?? []).map(line => `  ${line}`),
        `  manual: ${manualLine(outcome, version)}`,
      ].join('\n') + '\n')
      cliInternals.exit(1)
      return
    }
    if (outcome.action === 'installed') {
      cliInternals.stderr(`mayfly: installed @ephemeral-ai/mayfly@${version} into profile 'mayfly'\n`)
    } else if (outcome.action === 'ahead') {
      // /update (or a manual add) advanced the profile past this shell —
      // boot it as-is; reinstalling the shell is how the pair advances.
      cliInternals.stderr(`mayfly: profile 'mayfly' is at @ephemeral-ai/mayfly@${outcome.installed}, ahead of this shell (${version}) — reinstall to advance: npm -g install @ephemeral-ai/mayfly-cli\n`)
    } else if (outcome.action === 'link-lane') {
      cliInternals.stderr(`mayfly: profile 'mayfly' is a dev ${outcome.spec.split(':', 1)[0]} lane — calibration skipped\n`)
    }
  }
  const child = await cliInternals.spawnInherit(cliInternals.execPath, [host.binJs, ...translation.dshArgs], {
    env: { ...LAUNCHER_ENV, MAYFLY_DSH_BIN: host.binJs },
  })
  cliInternals.exit(child.code ?? 1)
}

/**
 * The shell's own manifest version — the Mayfly pin, equal by the
 * version.spec lockstep. `'unknown'` only when the manifest is broken
 * (the install's own failure then names it precisely).
 */
export function shellVersion(): string {
  const text = cliInternals.readTextFile(fileURLToPath(new URL('../package.json', import.meta.url)))
  if (text === undefined) return 'unknown'
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version
    return typeof version === 'string' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}
