---
layout: home
pageClass: brand-home

brandHero:
  eyebrow: A dsh-based multi-agent terminal
  name: mayfly
  tagline: ephemeral agents, enduring works
  versionNote: v0.1.0-alpha.3 · 预览版
  install: npm -g install @ephemeral-ai/mayfly-cli
  copyLabel: 复制
  copiedLabel: 已复制
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/Ephemeral-AI-Lab/mayfly

brandFeatures:
  kicker: Why mayfly
  title: 须臾即逝的代理，历久弥新的作品。
  items:
    - title: 行为透明
      details: "模型的思考、每次工具调用与子代理扇出都落在同一条 Harness 事件流里；/trace 随时展开完整轨迹。领域状态由 dsh 持有，Mayfly 只负责把它如实呈现在终端。"
      image: /shots/app-trace.svg
      alt: Mayfly 终端中的 /trace 会话轨迹回放
      caption: /trace — 一条可回放的事件流
      link: /reference/commands
      linkText: 斜杠命令参考 →
    - title: 多 Agent 协作
      details: "Harness 原生支持 subagent、后台代理与 workflow 编排，多个代理并行推进、共享同一份事实。Mayfly 在终端里呈现每个代理的进度与产出，协作者一目了然。"
      image: /shots/app-agents.svg
      alt: Mayfly 终端中多个代理并行协作
      caption: subagents — 并行推进，共享事实
      link: /dsh/tools
      linkText: 内置工具 →
    - title: 权限可控
      details: "sandbox、审批与 presets 由 dsh 的模式系统定义，每个越权动作都会停下来等你确认。Mayfly 贡献审批交互，但决定权与审计记录始终在 Harness 一侧。"
      image: /shots/app-permission.svg
      alt: Mayfly 终端中的权限审批确认
      caption: approval — 每个决定都经你之手
      link: /dsh/modes
      linkText: 权限与模式 →
    - title: 会话可回溯
      details: "/sessions 列出历史会话，/fork 从任意节点分叉，/rewind 回放到更早的状态。会话与事件由 Harness 持久化，Mayfly 只是你回到过去的入口。"
      image: /shots/app-sessions.svg
      alt: Mayfly 终端中的会话列表与回溯
      caption: /sessions · /fork · /rewind
      link: /reference/commands
      linkText: 斜杠命令参考 →
    - title: 界面易扩展
      details: "终端里看到的一切都来自插件：Mayfly 只暴露四个 UI 服务和一套公共 UI Kit，外部插件用同一套组件贡献自己的界面，与内置能力同台呈现。"
      image: /shots/uikit-builder.svg
      alt: Mayfly 公共 UI Kit 组件
      caption: ui-kit — 插件贡献的界面
      link: /plugins/
      linkText: 开发手册 →
---
