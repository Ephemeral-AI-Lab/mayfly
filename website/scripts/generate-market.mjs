/**
 * Generate the marketplace plugin pages from the published index before
 * VitePress builds. Runs in both the PR check and the deploy job (the
 * website package's build script) — VitePress only picks up files that
 * exist before `vitepress build` starts.
 *
 * Sources `catalog.json` from MARKET_INDEX_URL (default: the marketplace
 * repository's main branch). Unknown schema versions fail the build rather
 * than rendering half-understood entries; an unreachable index falls back to
 * the bundled snapshot with a loud warning (pre-merge CI, air-gapped runs).
 *
 * Output (git-ignored):
 *   market/p/<id>/index.md        one detail page per entry (zh)
 *   en/market/p/<id>/index.md     the same page (en)
 *   market/catalog.json           the pruned index for <PluginCatalog>
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/Ephemeral-AI-Lab/dsh-plugins/main/dist/catalog.json'
const INDEX_URL = process.env.MARKET_INDEX_URL || DEFAULT_INDEX_URL
const SUPPORTED_SCHEMA = 1
const README_CAP = 32 * 1024

async function fetchIndex() {
  let response
  try {
    response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`${INDEX_URL} -> HTTP ${response.status}`)
  } catch (error) {
    // The bundled fallback keeps builds green when the index URL is
    // unreachable (CI before the marketplace repository ships dist/, air-gapped
    // environments). It is a snapshot, not a live document — warn loudly.
    console.warn(`market index fetch failed (${error instanceof Error ? error.message : String(error)}); falling back to scripts/market-fallback.json`)
    return JSON.parse(readFileSync(join(websiteRoot, 'scripts', 'market-fallback.json'), 'utf8'))
  }
  return await response.json()
}

const TIER_LABEL = { official: '官方 official', dsh: 'dsh', community: '社区 community' }
const TIER_LABEL_EN = { official: 'official', dsh: 'dsh', community: 'community' }

function surfaces(entry) {
  const parts = []
  if (entry.surfaces?.tui !== undefined) parts.push('TUI')
  if (entry.surfaces?.web !== undefined) parts.push('Web')
  if (entry.surfaces?.server !== undefined) parts.push('Server')
  return parts.join('+') || '—'
}

function verdict(entry, locale) {
  const tui = entry.surfaces?.server !== undefined || entry.surfaces?.tui !== undefined
  const web = entry.surfaces?.web !== undefined || entry.surfaces?.server !== undefined
  if (locale === 'zh') {
    return [
      `| ${tui ? '✅ 工具' : '⚠️ 工具' } | ${tui ? 'Mayfly 终端：' + (entry.surfaces?.server !== undefined ? '工具/命令完整可用' : '原生 UI 贡献') : '无贡献（纯 dsh Web 面板）'} |`,
      `| ${web ? '✅' : '⚠️'} | dsh Web：${web ? (entry.surfaces?.web !== undefined ? '工具 + 专属面板' : '工具可用（无专属面板）') : '无贡献'} |`,
    ].join('\n')
  }
  return [
    `| ${tui ? '✅' : '⚠️'} | Mayfly terminal: ${tui ? (entry.surfaces?.server !== undefined ? 'full tools & commands' : 'native UI contribution') : 'no contribution (dsh Web panel only)'} |`,
    `| ${web ? '✅' : '⚠️'} | dsh Web: ${web ? (entry.surfaces?.web !== undefined ? 'tools + dedicated panel' : 'tools (no dedicated panel)') : 'no contribution'} |`,
  ].join('\n')
}

function rowSpec(row, source) {
  if (source === 'npm') return row.npm?.spec
  return row.github === undefined
    ? undefined
    : `github:${row.github.repo}#${row.github.ref}${row.github.subdir ? `&path:${row.github.subdir}` : ''}`
}

function shellArg(value) {
  return /^[A-Za-z0-9@._/+~-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

export function installCommand(entry) {
  const rows = entry.install.rows
  const source = rows.every(row => row.npm !== undefined)
    ? 'npm'
    : rows.every(row => row.github !== undefined) ? 'github' : undefined
  if (source === undefined) return `dsh plugin --profile <name> add <${entry.id}>`
  return `dsh plugin --profile <name> add ${rows.map(row => shellArg(rowSpec(row, source))).join(' ')}`
}

function escapeInertHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
}

export function readmeBlock(entry) {
  const text = typeof entry.readme === 'string' ? entry.readme : ''
  if (text === '') return '_（该插件未提供 README 摘录 / No README excerpt shipped.）_'
  let excerpt = text.slice(0, README_CAP)
  if (excerpt.length < text.length) {
    // Prefer a paragraph boundary so the inert excerpt remains readable.
    const cut = excerpt.lastIndexOf('\n\n')
    if (cut > 0) excerpt = excerpt.slice(0, cut)
    excerpt += '\n\n…'
  }
  return `<pre v-pre class="market-readme">${escapeInertHtml(excerpt)}</pre>`
}

function inlineText(value) {
  return String(value).replace(/\s+/gu, ' ').trim().replace(/([\\`*_[\]<>])/gu, '\\$1')
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function detailPage(entry, locale) {
  const zh = locale === 'zh'
  const displayName = inlineText(entry.displayName)
  const description = inlineText(zh && entry.descriptionZh ? entry.descriptionZh : entry.description)
  const tools = entry.provides?.tools ?? []
  const commands = entry.provides?.commands ?? []
  const verified = entry.verified?.packages?.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')
  const links = [
    safeHttpUrl(entry.links?.repo) ? `[${zh ? '仓库' : 'Repository'}](<${safeHttpUrl(entry.links.repo)}>)` : '',
    safeHttpUrl(entry.links?.docs) ? `[${zh ? '文档' : 'Docs'}](<${safeHttpUrl(entry.links.docs)}>)` : '',
    safeHttpUrl(entry.links?.npm) ? `[npm](<${safeHttpUrl(entry.links.npm)}>)` : '',
  ].filter(Boolean).join(' · ')
  return `---
title: ${JSON.stringify(displayName)}
---

# ${displayName}

${description}

${zh ? `来源：**${TIER_LABEL[entry.source] ?? entry.source}** · 状态：\`${entry.status}\`` : `Source: **${TIER_LABEL_EN[entry.source] ?? entry.source}** · Status: \`${entry.status}\``}
${entry.statusNote ? `> ${inlineText(entry.statusNote)}` : ''}

## ${zh ? '安装' : 'Install'}

\`\`\`sh
${installCommand(entry)}
\`\`\`

${zh ? '在 Mayfly 中：`/plugin install ' + entry.id + '`（或 `/plugin` 浏览）。安装后**重启并新建会话**生效。' : 'Inside Mayfly: `/plugin install ' + entry.id + '` (or browse with `/plugin`). **Restart and start a new session** to apply.'}

## ${zh ? '前端支持' : 'Frontend support'}

| | |
|---|---|
${verdict(entry, locale)}

## ${zh ? '提供' : 'Provides'}

- ${zh ? '工具' : 'Tools'}: ${tools.length > 0 ? tools.map(tool => `\`${tool}\``).join(' · ') : zh ? '无' : 'none'}
- ${zh ? '命令' : 'Commands'}: ${commands.length > 0 ? commands.join(' · ') : zh ? '无' : 'none'}
${entry.capabilities?.length ? `- ${zh ? '能力披露' : 'Capabilities'}: ${entry.capabilities.join(', ')}` : ''}

## ${zh ? '审核信息' : 'Verification'}

${verified ? `${zh ? '审核版本' : 'Reviewed versions'}: ${verified}（${entry.verified.at}）` : zh ? '未记录' : 'Not recorded.'} ${zh ? '收录是披露与审查，不是沙箱——安装第三方插件等同于安装任意 npm 包。' : 'Listing is disclosure and review, not a sandbox — installing a third-party plugin equals installing an arbitrary npm package.'}

${links ? `## ${zh ? '链接' : 'Links'}\n\n${links}` : ''}

## README

${readmeBlock(entry)}
`
}

/** Validate the path- and renderer-critical catalog boundary. */
export function validateMarketIndex(index) {
  if (typeof index !== 'object' || index === null || Array.isArray(index)) throw new Error('market catalog is not an object')
  if (index.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`market catalog schema version ${index.schemaVersion} is not supported (expected ${SUPPORTED_SCHEMA})`)
  }
  if (!Array.isArray(index.entries)) throw new Error('market catalog has no entries array')
  const ids = new Set()
  for (const [position, entry] of index.entries.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`market entry ${position} is not an object`)
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(entry.id) || entry.id.length > 64) {
      throw new Error(`market entry ${position} has an unsafe id`)
    }
    if (ids.has(entry.id)) throw new Error(`market catalog repeats id ${entry.id}`)
    ids.add(entry.id)
    for (const key of ['displayName', 'description', 'source', 'status', 'category']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) throw new Error(`${entry.id}: ${key} must be a non-empty string`)
    }
    if (!['official', 'dsh', 'community'].includes(entry.source)) throw new Error(`${entry.id}: unknown source tier`)
    if (!['stable', 'beta', 'unstable', 'deprecated', 'removed'].includes(entry.status)) throw new Error(`${entry.id}: unknown status`)
    if (typeof entry.surfaces !== 'object' || entry.surfaces === null || Array.isArray(entry.surfaces)) {
      throw new Error(`${entry.id}: surfaces must be an object`)
    }
    if (typeof entry.install !== 'object' || entry.install === null || !Array.isArray(entry.install.rows) || entry.install.rows.length === 0) {
      throw new Error(`${entry.id}: install.rows must be a non-empty array`)
    }
    for (const row of entry.install.rows) {
      if (typeof row !== 'object' || row === null || typeof row.name !== 'string' || (row.npm === undefined && row.github === undefined)) {
        throw new Error(`${entry.id}: every install row needs a package name and source`)
      }
      if (row.npm !== undefined && (typeof row.npm !== 'object' || row.npm === null || typeof row.npm.spec !== 'string')) {
        throw new Error(`${entry.id}: npm sources need a string spec`)
      }
      if (row.github !== undefined && (typeof row.github !== 'object' || row.github === null || typeof row.github.repo !== 'string' || typeof row.github.ref !== 'string')) {
        throw new Error(`${entry.id}: GitHub sources need repo and ref strings`)
      }
    }
  }
  return index.entries
}

async function main() {
  const index = await fetchIndex()
  const entries = validateMarketIndex(index)
  const generated = join(websiteRoot, 'market', 'p')
  const generatedEn = join(websiteRoot, 'en', 'market', 'p')
  for (const dir of [generated, generatedEn]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  let zhCount = 0
  let enCount = 0
  for (const entry of entries) {
    if (!entry?.id || entry.status === 'removed') continue
    mkdirSync(join(generated, entry.id), { recursive: true })
    writeFileSync(join(generated, entry.id, 'index.md'), detailPage(entry, 'zh'))
    mkdirSync(join(generatedEn, entry.id), { recursive: true })
    writeFileSync(join(generatedEn, entry.id, 'index.md'), detailPage(entry, 'en'))
    zhCount += 1
    enCount += 1
  }
  // The pruned catalog for the <PluginCatalog> component.
  const catalog = entries
    .filter(entry => entry?.id && entry.status !== 'removed')
    .map(entry => ({
      id: entry.id,
      displayName: entry.displayName,
      description: entry.description,
      descriptionZh: entry.descriptionZh,
      source: entry.source,
      status: entry.status,
      category: entry.category,
      surfaces: {
        tui: entry.surfaces?.tui !== undefined,
        web: entry.surfaces?.web !== undefined,
        server: entry.surfaces?.server !== undefined,
      },
      provides: entry.provides ?? {},
      author: entry.author?.name,
    }))
  const catalogPath = join(websiteRoot, 'market', 'catalog.json')
  mkdirSync(dirname(catalogPath), { recursive: true })
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`market pages: ${zhCount} zh + ${enCount} en; catalog: ${catalog.length} entries (${INDEX_URL})`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
