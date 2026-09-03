import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const base = process.env.DOCS_BASE ?? '/'

/**
 * 站点版本：当前预览线，与三个发布包一致。
 * 升级时只改这一处（首页 hero 文案与 footer 同步引用语义，见各 index.md）。
 */
const SITE_VERSION = '0.1.0-alpha.1'

/**
 * Optional deployment origin. Local and fork builds deliberately have no
 * canonical hostname; deployers opt in with DOCS_SITE_URL.
 */
const siteUrl = process.env.DOCS_SITE_URL?.replace(/\/+$/u, '') || undefined

// ── 入口语言路由（烤进 <head> 内联脚本，整页加载执行；SPA 导航不重跑）──────
// 原则：localStorage 偏好（theme 钩子在 SPA 导航时写入）> navigator.languages。
// 中文挂根路径：中文浏览器不跳；英文/其他浏览器落任意中文页（含深链）跳 /en/
// 等价页。自动跳转不写偏好；手动切换后双向粘性。函数必须自包含（不得引用
// 任何 import 或外层变量）——它会被 toString() 后内联。
const langRedirect = (base: string) => {
  try {
    const KEY = 'mayfly-docs-lang'
    let pref: string | null = null
    try { pref = localStorage.getItem(KEY) } catch {}
    const langs = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || '']
    const isZh = langs.some((l) => /^zh/i.test(l || ''))
    const wantEn = pref ? pref === 'en' : !isZh
    const path = location.pathname
    if (path.indexOf(base) !== 0) return // 非本站基座（保险）
    const rest = path.slice(base.length)
      .replace(/^\/+/, '')
      .replace(/\.html$/i, '') // cleanUrls 直链兼容
      .replace(/\/+$/, '')
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|json|xml|txt|woff2?|ttf)$/i.test(rest)) return
    if (/^(assets|images|icons|files)\//.test(rest)) return
    const onEn = rest === 'en' || rest.startsWith('en/')
    if (onEn === wantEn) return
    const target = onEn
      ? rest.slice(3).replace(/^\/+/, '') // en/guide → guide；en → ''
      : rest ? 'en/' + rest : 'en' // guide → en/guide；''（zh 首页）→ en
    location.replace(target === 'en' ? base + 'en/' : base + target)
  } catch {}
}

// ── 双语共享主题配置 ──────────────────────────────────────────────────────
// 本地搜索：中文文案挂在 locales.root（根路径即中文 locale）；en 用内置英文。
const sharedTheme = {
  search: {
    provider: 'local' as const,
    options: {
      locales: {
        root: {
          translations: {
            button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
            modal: {
              noResultsText: '未找到相关结果',
              resetButtonTitle: '清除查询条件',
              displayDetails: '显示详细列表',
              footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
            },
          },
        },
      },
    },
  },
  socialLinks: [{ icon: 'github', link: 'https://github.com/Ephemeral-AI-Lab/mayfly' }],
  // 导航栏品牌标：暗色界面用白标、明色界面用墨标（资源由品牌素材包提供）。
  logo: { light: '/brand/logo-dark.svg', dark: '/brand/logo-light.svg', alt: 'Mayfly' },
}

// ── 导航：顶栏入口——用户手册 / 开发手册 ────────────────────────────────────
// 按受众分册（对齐 Claude Code 的使用文档/插件开发文档分家）：用户手册覆盖
// 使用与定制，开发手册收口 /plugins/ 路径下的插件开发内容。
const navZh = [
  { text: '用户手册', link: '/guide/', activeMatch: '/(guide|dsh|features|reference)' },
  { text: '开发手册', link: '/plugins/', activeMatch: '^/plugins' },
]

const navEn = [
  { text: 'User manual', link: '/en/guide/', activeMatch: '/en/(guide|dsh|features|reference)' },
  { text: 'Developer manual', link: '/en/plugins/', activeMatch: '^/en/plugins' },
]

// ── 侧边栏：按路径分册 ─────────────────────────────────────────────────────
// '/' = 用户手册（指南 / dsh 手册 / 功能 / 参考）；'/plugins/' = 开发手册。
const sidebarZh = {
  '/': [
    {
      text: '指南',
      items: [
        { text: '快速上手', link: '/guide/' },
        { text: '配置', link: '/guide/config' },
        { text: '主题', link: '/guide/theme' },
        { text: '常见问题', link: '/guide/faq' },
      ],
    },
    {
      text: 'dsh 手册',
      items: [
        { text: '认识 dsh', link: '/dsh/' },
        { text: 'Profile 与目录', link: '/dsh/profiles' },
        { text: '权限与模式', link: '/dsh/modes' },
        { text: '内置工具', link: '/dsh/tools' },
        { text: '官方可选插件', link: '/dsh/plugins' },
        { text: 'Skills', link: '/dsh/skills' },
        { text: 'MCP 配置', link: '/dsh/mcp' },
        { text: '系统提示词', link: '/dsh/system-prompt' },
      ],
    },
    {
      text: '功能',
      items: [
        { text: '功能总览', link: '/features/' },
        { text: '会话模式', link: '/features/modes' },
        { text: '流式会话与工具卡片', link: '/features/streaming' },
        { text: '输入编辑器', link: '/features/editor' },
        { text: '审批与问卷浮层', link: '/features/approval' },
        { text: '状态栏', link: '/features/status-bar' },
        { text: '底部面板', link: '/features/panes' },
      ],
    },
    {
      text: '参考',
      items: [
        { text: '键位参考', link: '/reference/keys' },
        { text: '斜杠命令参考', link: '/reference/commands' },
      ],
    },
  ],
  '/plugins/': [
    {
      text: '开始',
      items: [
        { text: '概览', link: '/plugins/' },
        { text: '快速开始', link: '/plugins/quickstart' },
        { text: '核心概念', link: '/plugins/concepts' },
        { text: '公共 UI Kit', link: '/plugins/ui-kit' },
        { text: '组件模型', link: '/plugins/component-model' },
        { text: '示例目录', link: '/plugins/examples' },
        { text: '创造模式实战', link: '/plugins/creative-mode' },
      ],
    },
    {
      text: '直接服务',
      items: [
        { text: 'dsh 原生命令', link: '/plugins/commands' },
        { text: 'Pane 与 Overlay', link: '/plugins/dock' },
        { text: '状态栏', link: '/plugins/status' },
        { text: '编辑器扩展', link: '/plugins/editor-extensions' },
      ],
    },
    {
      text: '验证与发布',
      items: [
        { text: '调试与验证', link: '/plugins/testing' },
        { text: '发布插件', link: '/plugins/publishing' },
      ],
    },
    {
      text: '参考',
      items: [
        { text: 'UI 节点参考', link: '/plugins/ui-reference' },
        { text: 'Seam 参考', link: '/plugins/seams' },
        { text: '内置插件', link: '/plugins/builtins' },
        { text: '贡献本仓库', link: '/plugins/contributing' },
        { text: '仓库设计文档（GitHub）', link: 'https://github.com/Ephemeral-AI-Lab/mayfly/blob/main/docs/README.md' },
      ],
    },
  ],
}

const sidebarEn = {
  '/en/': [
    {
      text: 'Guide',
      items: [
        { text: 'Quickstart', link: '/en/guide/' },
        { text: 'Configuration', link: '/en/guide/config' },
        { text: 'Theming', link: '/en/guide/theme' },
        { text: 'FAQ', link: '/en/guide/faq' },
      ],
    },
    {
      text: 'dsh handbook',
      items: [
        { text: 'What is dsh', link: '/en/dsh/' },
        { text: 'Profiles & directories', link: '/en/dsh/profiles' },
        { text: 'Modes & permissions', link: '/en/dsh/modes' },
        { text: 'Built-in tools', link: '/en/dsh/tools' },
        { text: 'Official optional plugins', link: '/en/dsh/plugins' },
        { text: 'Skills', link: '/en/dsh/skills' },
        { text: 'MCP setup', link: '/en/dsh/mcp' },
        { text: 'System prompt', link: '/en/dsh/system-prompt' },
      ],
    },
    {
      text: 'Features',
      items: [
        { text: 'Overview', link: '/en/features/' },
        { text: 'Session modes', link: '/en/features/modes' },
        { text: 'Streaming transcript & tool cards', link: '/en/features/streaming' },
        { text: 'Input editor', link: '/en/features/editor' },
        { text: 'Approvals & questionnaires', link: '/en/features/approval' },
        { text: 'Status bar', link: '/en/features/status-bar' },
        { text: 'Bottom panes', link: '/en/features/panes' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'Key bindings', link: '/en/reference/keys' },
        { text: 'Slash commands', link: '/en/reference/commands' },
      ],
    },
  ],
  '/en/plugins/': [
    {
      text: 'Getting started',
      items: [
        { text: 'Overview', link: '/en/plugins/' },
        { text: 'Quickstart', link: '/en/plugins/quickstart' },
        { text: 'Core concepts', link: '/en/plugins/concepts' },
        { text: 'Public UI kit', link: '/en/plugins/ui-kit' },
        { text: 'Component model', link: '/en/plugins/component-model' },
        { text: 'Example catalog', link: '/en/plugins/examples' },
        { text: 'Creative mode walkthrough', link: '/en/plugins/creative-mode' },
      ],
    },
    {
      text: 'Direct services',
      items: [
        { text: 'Native dsh commands', link: '/en/plugins/commands' },
        { text: 'Panes and overlays', link: '/en/plugins/dock' },
        { text: 'Status bar', link: '/en/plugins/status' },
        { text: 'Editor extensions', link: '/en/plugins/editor-extensions' },
      ],
    },
    {
      text: 'Verify & publish',
      items: [
        { text: 'Debugging & validation', link: '/en/plugins/testing' },
        { text: 'Publishing', link: '/en/plugins/publishing' },
      ],
    },
    {
      text: 'Reference',
      items: [
        { text: 'UI node reference', link: '/en/plugins/ui-reference' },
        { text: 'Seam reference', link: '/en/plugins/seams' },
        { text: 'Built-in plugins', link: '/en/plugins/builtins' },
        { text: 'Contributing to Mayfly', link: '/en/plugins/contributing' },
        { text: 'Design docs (GitHub, 中文)', link: 'https://github.com/Ephemeral-AI-Lab/mayfly/blob/main/docs/README.md' },
      ],
    },
  ],
}

const config = defineConfig({
  base,
  cleanUrls: true,
  ...(siteUrl === undefined ? {} : { sitemap: { hostname: `${siteUrl}/` } }),
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    // 品牌字体（首页 hero 正典 final/hero.html）：Cinzel / Cormorant Garamond /
    // Inter / JetBrains Mono，字重与素材保持一致。
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
      },
    ],
    // 基础 OG/Twitter 卡片；og:image 需要绝对 URL，仅在部署方通过
    // DOCS_SITE_URL 提供站点源时生成。
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Mayfly' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ...(siteUrl
      ? [
          ['meta', { property: 'og:image', content: `${siteUrl}${base}brand/hero-poster.png` }] as [string, Record<string, string>],
          ['meta', { name: 'twitter:image', content: `${siteUrl}${base}brand/hero-poster.png` }] as [string, Record<string, string>],
        ]
      : []),
    ['script', {}, `(${langRedirect.toString()})(${JSON.stringify(base)})`],
    [
      'script',
      {
        type: 'module',
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        'data-cf-beacon': '{"token": "78f084a06ca54e528103657960a14b43"}',
      },
    ],
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Mayfly',
      description: `Mayfly-dsh：DeepSeek Harness (dsh) 的插件式终端界面。预览阶段（v${SITE_VERSION}）。`,
      themeConfig: {
        nav: navZh,
        sidebar: sidebarZh,
        docFooter: { prev: '上一页', next: '下一页' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitleLabel: '切换到浅色',
        darkModeSwitchTitleLabel: '切换到深色',
        footer: {
          message: `预览版 · v${SITE_VERSION}`,
          copyright: 'MIT License',
        },
      },
    },
    en: {
      label: 'English',
      link: '/en/',
      lang: 'en-US',
      title: 'Mayfly',
      description: `Mayfly-dsh: a plugin-based terminal UI for DeepSeek Harness (dsh). Preview (v${SITE_VERSION}).`,
      themeConfig: {
        nav: navEn,
        sidebar: sidebarEn,
        footer: {
          message: `Preview · v${SITE_VERSION}`,
          copyright: 'MIT License',
        },
      },
    },
  },
  themeConfig: { ...sharedTheme },
})

// ── Mermaid 图表支持 ────────────────────────────────────────────────────────
// vitepress-plugin-mermaid v2：`mermaid` 键承载 mermaidConfig，仅在明色主题生效
// ——插件检测 VitePress 挂在 <body> 上的 dark class，切暗色时自动换主题重渲染。
// 仓库图源约定：docs/diagrams/*.mmd 是唯一正典，各文档（含本站页面）的嵌入块
// 由 script/sync-diagrams.mjs 生成，CI 用 pnpm run diagrams:check 把关。
// optimizeDeps：dev 下 mermaid 的 ESM chunk 引 dayjs 等 CJS 依赖，不预打包会
// 以 /@fs 原始路径伺服并因缺 default 导出抛 SyntaxError（整页白屏），必须整体
// 预打包交由 esbuild 做 interop（配合 pnpm-workspace.yaml 的 publicHoistPattern）。
export default withMermaid({
  ...config,
  mermaid: { theme: 'neutral' },
  vite: { optimizeDeps: { include: ['mermaid'] } },
})
