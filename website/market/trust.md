---
title: 信任与安全
---

# 信任与安全

## 三档来源

| 来源 | 含义 |
| --- | --- |
| **official** | Ephemeral AI Lab 官方插件，源码在[市场仓库](https://github.com/Ephemeral-AI-Lab/dsh-plugins) |
| **dsh** | DeepSeek 官方发布的 dsh 可选插件 |
| **community** | 社区提交、通过机器门禁与人工审查的第三方插件 |

## verified 是什么

每个条目记录**审查时**的包版本与日期（详情页"审核信息"）。收录采用轻量档：审查后跟随最新版本，市场每周自动重新验证并在新版本出现时标记。`verified` 表示"这个版本被审过"，不是持续保证。

## 诚实声明

**收录是披露与审查，不是沙箱。** 插件以你的用户权限运行：安装一个第三方插件，等同于安装一个任意 npm 包。安装前请看详情页的：

- **能力披露**（capabilities）：shell 执行、网络、凭据读取等；
- **前端支持**：`server`（任何前端可用）、`web`（dsh Web 面板）、`tui`（Mayfly 原生 UI）；
- **allowBuilds**：该插件声明了哪些包允许运行安装脚本（原生编译等）。

## 下架与举报

下架的插件不删条目而是标记 `removed` 并注明原因——已安装的用户会在 `/plugin list` 看到"已从市场移除"。发现恶意行为请到[市场仓库](https://github.com/Ephemeral-AI-Lab/dsh-plugins/issues)举报。
