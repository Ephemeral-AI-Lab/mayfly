import { defineConfig } from 'vitepress'

const base = process.env.DOCS_BASE ?? '/'

/**
 * 站点版本：当前预览线，与三个发布包一致。
 * 升级时只改这一处（首页 hero 文案与 footer 同步引用语义，见各 index.md）。
 */
const SITE_VERSION = '0.1.0-alpha.3'

/**
 * Optional deployment origin. Local and fork builds deliberately have no
 * canonical hostname; deployers opt in with DOCS_SITE_URL.
 */
const siteUrl = process.env.DOCS_SITE_URL?.replace(/\/+$/u, '') || undefined

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
  { text: '插件市场', link: '/market/', activeMatch: '^/market' },
  { text: '开发手册', link: '/plugins/', activeMatch: '^/plugins' },
]

const navEn = [
  { text: 'User manual', link: '/en/guide/', activeMatch: '/en/(guide|dsh|features|reference)' },
  { text: 'Marketplace', link: '/en/market/', activeMatch: '/en/market' },
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
  '/market/': [
    {
      text: '市场',
      items: [
        { text: '插件目录', link: '/market/' },
        { text: '安装与更新', link: '/market/installing' },
        { text: '信任与安全', link: '/market/trust' },
      ],
    },
    {
      text: '收录',
      items: [
        { text: '提交你的插件', link: '/market/submit' },
        { text: 'Manifest 规范', link: '/market/manifest' },
        { text: '审查清单', link: '/market/review' },
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
  '/en/market/': [
    {
      text: 'Market',
      items: [
        { text: 'Plugin catalog', link: '/en/market/' },
        { text: 'Installing & updating', link: '/en/market/installing' },
        { text: 'Trust & safety', link: '/en/market/trust' },
      ],
    },
    {
      text: 'Listings',
      items: [
        { text: 'Submit your plugin', link: '/en/market/submit' },
        { text: 'Manifest spec', link: '/en/market/manifest' },
        { text: 'Review checklist', link: '/en/market/review' },
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
  markdown: {
    config(md) {
      const renderFence = md.renderer.rules.fence!
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index]
        if (token.info.trim() === 'mermaid') {
          return `<MermaidDiagram code="${encodeURIComponent(token.content.trim())}" />\n`
        }
        return renderFence(tokens, index, options, env, self)
      }
    },
  },
})

export default config
