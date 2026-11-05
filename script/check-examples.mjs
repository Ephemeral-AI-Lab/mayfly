#!/usr/bin/env node
/** Run the supported-line packed direct-service ecosystem gate.
 * @module script/check-examples
 */
import { execFileSync } from 'node:child_process'
import { ROOT } from './package-contract.mjs'
import { harnessLine } from './smoke-lib.mjs'

const scenarios = [
  'composition.five-plugins',
  'user-kit.public-component',
  'header.pane-lifecycle',
  'right-inspector.pane-lifecycle',
  'bottom-log.pane-lifecycle',
  'ui-gallery.pane-lifecycle',
  'overlay.editor-action-and-lifecycle',
  'direct.status-and-editor-lifecycle',
]
const directServices = ['mayflyPanes', 'mayflyStatus', 'mayflyOverlays', 'mayflyEditorExtensions']

if (harnessLine === undefined) throw new Error('supported Harness line is unavailable')
const output = execFileSync(
  process.execPath,
  ['script/mayfly-examples-fixture.mjs', '--install', '--harness-line', harnessLine],
  { cwd: ROOT, encoding: 'utf8' },
)
const report = JSON.parse(output)
if (report.harnessLine !== harnessLine) throw new Error(`fixture reported Harness ${String(report.harnessLine)}, expected ${harnessLine}`)
if (JSON.stringify(report.declared) !== JSON.stringify(scenarios)) throw new Error('fixture declared scenarios differ')
if (JSON.stringify(report.executed) !== JSON.stringify(scenarios)) throw new Error('fixture executed scenarios differ')
if (JSON.stringify(report.directServices) !== JSON.stringify(directServices)) throw new Error('fixture direct-service evidence differs')
if (report.skipped.length !== 0 || report.failures.length !== 0) throw new Error('fixture skipped or failed scenarios')
if (!report.fixtureCleaned || !report.cleaned || !report.valid) throw new Error('fixture did not complete cleanly')
if (Object.keys(report.harnessPackages).length === 0) throw new Error('fixture resolved no dsh packages')
for (const [name, version] of Object.entries(report.harnessPackages)) if (version !== harnessLine) throw new Error(`fixture resolved ${name} ${String(version)}, expected ${harnessLine}`)
process.stdout.write(output)
