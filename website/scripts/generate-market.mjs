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
import { fileURLToPath } from 'node:url'

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/Ephemeral-AI-Lab/dsh-plugins/main/dist/catalog.json'
const INDEX_URL = process.env.MARKET_INDEX_URL || DEFAULT_INDEX_URL
const SUPPORTED_SCHEMA = 1
const README_CAP = 32 * 1024

async function fetchIndex() {
  try {
    const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`${INDEX_URL} -> HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    // The bundled fallback keeps builds green when the index URL is
    // unreachable (CI before the marketplace repository ships dist/, air-gapped
    // environments). It is a snapshot, not a live document — warn loudly.
    console.warn(`market index fetch failed (${error instanceof Error ? error.message : String(error)}); falling back to scripts/market-fallback.json`)
    return JSON.parse(readFileSync(join(websiteRoot, 'scripts', 'market-fallback.json'), 'utf8'))
  }
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

function installCommand(entry) {
  const row = entry.install?.rows?.[0]
  const spec = row?.npm?.spec ?? (row?.github ? `github:${row.github.repo}#${row.github.ref}${row.github.subdir ? `&path:${row.github.subdir}` : ''}` : undefined)
  return `dsh plugin --profile <name> add ${spec ?? `<${entry.id}>`}`
}

function readme(entry) {
  const text = typeof entry.readme === 'string' ? entry.readme : ''
  if (text === '') return '_（该插件未提供 README 摘录 / No README excerpt shipped.）_'
  let excerpt = text.slice(0, README_CAP)
  if (excerpt.length < text.length) {
    // Cut at a paragraph boundary so truncation never splits an HTML tag
    // (a split tag breaks the Vue template compiler).
    const cut = excerpt.lastIndexOf('\n\n')
    if (cut > 0) excerpt = excerpt.slice(0, cut)
    excerpt += '\n\n…'
  }
  // Raw README HTML (unclosed tags, truncated elements) breaks the Vue
  // template compiler even inside v-pre — strip tags, keep the markdown.
  // Relative repository links would be dead links here: keep only anchors
  // and absolute URLs, degrade everything else to its label.
  const plain = excerpt
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (match, label, target) =>
      /^(https?:|#)/.test(target) ? match : label)
    .replace(/\n{3,}/g, '\n\n')
  return plain
}

function detailPage(entry, locale) {
  const zh = locale === 'zh'
  const description = zh && entry.descriptionZh ? entry.descriptionZh : entry.description
  const tools = entry.provides?.tools ?? []
  const commands = entry.provides?.commands ?? []
  const verified = entry.verified?.packages?.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')
  const links = [
    entry.links?.repo ? `[${zh ? '仓库' : 'Repository'}](${entry.links.repo})` : '',
    entry.links?.docs ? `[${zh ? '文档' : 'Docs'}](${entry.links.docs})` : '',
    entry.links?.npm ? `[npm](${entry.links.npm})` : '',
  ].filter(Boolean).join(' · ')
  return `---
title: ${entry.displayName}
---

# ${entry.displayName}

${description}

${zh ? `来源：**${TIER_LABEL[entry.source] ?? entry.source}** · 状态：\`${entry.status}\`` : `Source: **${TIER_LABEL_EN[entry.source] ?? entry.source}** · Status: \`${entry.status}\``}
${entry.statusNote ? `> ${entry.statusNote}` : ''}

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

${readme(entry)}
`
}

async function main() {
  const index = await fetchIndex()
  if (index.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`market catalog schema version ${index.schemaVersion} is not supported (expected ${SUPPORTED_SCHEMA})`)
  }
  const entries = Array.isArray(index.entries) ? index.entries : []
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
      link: `/market/p/${entry.id}/`,
    }))
  const catalogPath = join(websiteRoot, 'market', 'catalog.json')
  mkdirSync(dirname(catalogPath), { recursive: true })
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  const catalogPathEn = join(websiteRoot, 'en', 'market', 'catalog.json')
  mkdirSync(dirname(catalogPathEn), { recursive: true })
  writeFileSync(catalogPathEn, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`market pages: ${zhCount} zh + ${enCount} en; catalog: ${catalog.length} entries (${INDEX_URL})`)
}

await main()
