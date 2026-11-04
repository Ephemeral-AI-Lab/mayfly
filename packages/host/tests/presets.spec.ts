/** Verify the published native Host preset against its pinned upstream composition. @module */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const upstream = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
const upstreamRequire = createRequire(join(upstream, 'package.json'))
const skillRequire = createRequire(upstreamRequire.resolve('@deepseek-ai/dsh-skill-filesystem/package.json'))
const { parse } = skillRequire('yaml') as { parse(source: string, options?: unknown): unknown }
const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }] }

interface Row {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly insert?: readonly Row[]
  readonly group?: boolean
  readonly config?: {
    readonly id?: string
    readonly name?: string
    readonly description?: string
    readonly order?: number
    readonly plugins?: readonly Row[]
    readonly prefix?: string
    readonly customSkillDirs?: readonly string[]
    readonly surfaceContext?: boolean
  }
}

function readRows(file: string): readonly Row[] {
  return parse(readFileSync(file, 'utf8'), options) as readonly Row[]
}

describe('Host creative preset composition', () => {
  const declaration = readRows(join(root, 'presets/mayfly-cordis.patch.yml'))[0]!.insert![0]!
  const native = readRows(join(upstream, 'presets/cordis.patch.yml'))[0]!.insert![0]!

  it('registers one native Mayfly preset and preserves upstream tools and isolate groups', () => {
    expect(declaration).toMatchObject({
      id: 'preset-mayfly-cordis', name: '@deepseek-ai/dsh-agent-preset',
      config: { id: 'mayfly-cordis', name: 'Mayfly Cordis', order: 5 },
    })
    const ordinary = (rows: readonly Row[]): readonly Row[] => rows.filter(row => row.id !== 'persona' && row.id !== 'skill-filesystem')
    expect(ordinary(declaration.config!.plugins!)).toEqual(ordinary(native.config!.plugins!))
    expect(declaration.config!.plugins!.map(row => row.id)).toEqual(native.config!.plugins!.map(row => row.id))
    const persona = declaration.config!.plugins!.find(row => row.id === 'persona')!.config!.prefix!
    // The roster truncates long descriptions: expose the current API gap first.
    expect(declaration.config!.description).toMatch(/^TUI 热挂载 API 暂缺；/u)
    expect(declaration.config!.description).toContain('前端扩展需源码集成并重启')
    expect(persona).toContain('independent @ephemeral-ai/mayfly-remote')
    expect(persona).toContain('no public Remote UI hot-load or external frontend plugin installation entry')
    expect(persona).toContain('Current Harness model tools cannot create or run dynamic definitions')
    expect(persona).toContain('Do not load either plugin-development skill')
  })

  it('publishes all Host-owned skills and directs the native filesystem provider to that payload', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      files: string[], dsh: { bundle: { patch: string[] } }, dependencies: Record<string, string>
    }
    expect(manifest.dsh.bundle.patch).toEqual(['./cordis.patch.yml', './presets/mayfly-cordis.patch.yml'])
    expect(manifest.files).toContain('presets/**/*')
    const filesystem = declaration.config!.plugins!.find(row => row.id === 'skill-filesystem')!
    expect(filesystem.config!.customSkillDirs).toHaveLength(1)
    expect(filesystem.config!.customSkillDirs![0]).toContain("resolve('@ephemeral-ai/mayfly-host/package.json')")
    const skillRoot = join(root, 'presets/mayfly-cordis/skills')
    const names = readdirSync(skillRoot).sort()
    expect(names).toEqual(['cordis-plugin-development', 'editing-cordis-compositions', 'mayfly-plugin-development'])
    for (const name of names) {
      const content = readFileSync(join(skillRoot, name, 'SKILL.md'), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(content)!
      expect(parse(frontmatter[1]!)).toMatchObject({ name, description: expect.any(String) })
      expect(content.length).toBeLessThan(8192)
      expect(content).toContain('Host')
      expect(content).toContain('Remote')
    }
    expect(manifest.dependencies['@deepseek-ai/dsh-skill-filesystem']).toBe('0.2.2-alpha.3')
    for (const match of readFileSync(join(root, 'presets/mayfly-cordis.patch.yml'), 'utf8').matchAll(/name: '(@deepseek-ai\/[^']+)'/gu)) {
      const packageName = match[1]!.split('/').slice(0, 2).join('/')
      expect(manifest.dependencies[packageName], packageName).toBe('0.2.2-alpha.3')
    }
  })

  it('keeps the Web Host composition while disabling browser-only model and shell context', () => {
    const rows = readRows(join(root, 'cordis.patch.yml'))
    expect(rows.find(row => row.id === 'web-runtime')!.config).toMatchObject({
      openBrowser: false, printUrl: false, surfaceContext: false,
    })
    expect(rows.find(row => row.id === 'harness-dev-context')).toEqual({ id: 'harness-dev-context', disabled: true })
    expect(rows.flatMap(row => row.insert ?? []).map(row => row.id)).toEqual(['mayfly-host', 'mayfly-host-startup', 'mayfly'])
  })
})
