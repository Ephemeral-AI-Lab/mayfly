# Mayfly 架构

Mayfly 是 `dsh-base` 上的一组普通 Cordis sibling 插件。它不建立第二个插件
模型，不拦截或复制 dsh service graph，也不为外部插件建立私有 runtime realm。

<!-- BEGIN diagram:mayfly-layers -->
<!-- single source 单一来源: docs/diagrams/mayfly-layers.zh.mmd — edit the .mmd, then `pnpm run diagrams:sync` -->
```mermaid
flowchart TB
    ROOT["一个 dsh 进程 · 一张 Cordis service graph"]
    DSH["dsh 原生服务<br/>commands · sessionProjections · tools · agents"]
    PLUGIN["普通 Cordis 插件<br/>Mayfly 官方行与外部 sibling"]
    AGENT["mayflyCurrentAgent<br/>主会话 + 单辅助槽<br/>当前展示的精确 Agent"]
    UI["Mayfly 直接 UI 服务<br/>mayflyPanes · mayflyStatus<br/>mayflyOverlays · mayflyEditorExtensions"]
    CORE["@ephemeral-ai/mayfly core 区域<br/>唯一 pi-tui 与原始终端 owner"]
    TERM["终端"]

    ROOT --> DSH
    ROOT --> PLUGIN
    DSH --> PLUGIN
    AGENT --> PLUGIN
    PLUGIN --> UI
    UI --> CORE
    CORE --> TERM
```
<!-- END diagram:mayfly-layers -->

## 运行时原则

1. 插件直接 inject 并使用 dsh 原生服务，例如 `commands`、
   `sessionProjections`、`tools` 和 `settings`。与 `planMode` 同 realm 的插件
   可以直接 inject 它；根级 UI 插件通过原生 `plan` projection 读取状态、通过
   原生 `/plan` 命令写入，不增加 Mayfly adapter。
2. Mayfly 只增加终端 UI 所需的四个 service：
   `mayflyPanes`、`mayflyStatus`、`mayflyOverlays`、
   `mayflyEditorExtensions`。
3. `mayflyCurrentAgent` 持有一个主 Agent 与一个辅助会话槽；`current()` 始终返回
   当前展示的精确 live Agent。插件拿到 Agent 后仍调用原生 dsh service；该对象
   不是 renderer model。BTW 与 continuable subagent 因而复用同一套 transcript、
   status、pane、command 与 editor，不建立第二份会话 renderer。
4. 注册、listener、timer 与异步 continuation 都属于创建它们的 Cordis Fiber。
   Fiber unload 是唯一的插件贡献清理机制。
5. 只有 `packages/mayfly/src/core/` import pi-tui、处理 ANSI/raw mode、焦点、
   布局和 visible width。
6. UI contribution 始终是普通 readonly node；core 私有地窗口化大列表，并在
   响应式分支首次可见时才校验和编译，不向插件暴露 renderer 调度状态。
7. core 启动时按固定顺序预建 prelude、conversation、local activity、EditorDock
   与 Footer host。Feature 只领取 named slot lease；临时 notice/echo 进入 local
   activity region，不改变 terminal root 顺序。
8. 普通 surface 按 provider revision 缓存；transcript 按
   `(session generation, entry id, updatedSeq, width, presentation revision)` 缓存。

## 包边界

| 包 | 当前职责 |
| --- | --- |
| `@ephemeral-ai/mayfly-ui` | renderer-neutral contract、纯 node builder、`defineMayflyComponent` 与四个直接 UI registry/provider |
| `@ephemeral-ai/mayfly` | frontend、conversation、app、core、transcript、interaction、theme，以及 `dsh-base` 上的 flat composition 与 presets |
| `@ephemeral-ai/mayfly-cli` | dependency-free `mayfly` launcher；首次运行展开内置 dsh runtime 并校准 profile |

`frontend`、`conversation`、`app`、`core`、`transcript` 与 `interaction` 仍是
清晰的源码所有权区域和 Cordis row，但不再分别发布 npm 包。

不存在第二套插件作者工具、Harness service adapter 包、validation-only adapter
包、可替换 provider owner、插件 bridge 或 app session facade。

## 状态所有权

- Harness 的 Agent、Session、command、tool 与 projection 状态仍由 Harness
  package 持有。
- app 持有主 Agent selection、单辅助槽与当前显示侧；它不重做 Harness
  command/tool/projection API。live 辅助会话成为精确 current Agent；one-shot 或
  cold child 由 core-owned 通用只读 transcript panel 展示。
- BTW Agent 仍携带完整 seed 作为模型上下文，但 `mayflyCurrentAgent` 的 BTW
  metadata 记录 seed cutoff，transcript source 只呈现 cutoff 之后的新问题、工具
  与回答。
- `mayfly-ui` provider 持有当前 UI contribution snapshots，且每项
  registration 随 consumer Fiber 清理。
- transcript 与 interaction 持有它们自己的 renderer-neutral/TUI product state。
- interaction 内部把当前 editor/autocomplete、可跨 host replay 的 panel stack 与
  submit transform 分成 `mayflyPromptEditor`、`mayflyEditorPanels`、
  `mayflyPromptSubmissions` 三个 Fiber service。选择器、信息面板与表单只通过共享
  controller 和 action-id keymap 进入 core compiler。
- transcript 只有一个 selected-session conversation controller；session generation
  改变时会销毁旧 entry cache。
- core 持有 named Screen Shell、terminal、focus、layout、form draft、control/scroll、
  list cursor/admission cache 与编译后的 renderer
  object；这些状态随 surface generation 失效，不进入公开 node。

Renderer 可以根据当前 Agent 调用 projection snapshot，但不能折叠第二份
Harness session event truth。

## Composition

<!-- BEGIN diagram:mayfly-composition -->
<!-- single source 单一来源: docs/diagrams/mayfly-composition.mmd — edit the .mmd, then `pnpm run diagrams:sync` -->
```mermaid
flowchart TB
    BASE["dsh-base"]
    subgraph GRAPH["flat Cordis sibling graph · 34 inserted rows"]
        SUPPORT["dsh support · 6 rows<br/>subagent settings · presets · host runner<br/>workspace · session controller · title"]
        UI["@ephemeral-ai/mayfly-ui provider<br/>four direct UI registries"]
        RUNTIME["@ephemeral-ai/mayfly runtime rows<br/>frontend · conversation · app · core<br/>transcript · status · panes · interaction"]
        PLUGINS["external Cordis plugins"]
    end
    NATIVE["native dsh services"]

    BASE --> NATIVE
    NATIVE --> SUPPORT
    NATIVE --> RUNTIME
    NATIVE --> PLUGINS
    UI --> RUNTIME
    UI --> PLUGINS
```
<!-- END diagram:mayfly-composition -->

`cordis.patch.yml` 插入 34 个普通 sibling：6 个 dsh 支撑行和 28 个 Mayfly
product 行。YAML 顺序不代表启动顺序；所有顺序要求必须由 `inject` 表达。
动态 Cordis plugin 与官方 Mayfly 行处在同一 service graph。

## 验证

whole-tree bundle 测试必须证明原生 command/projection/tool service 可达、
current Agent identity 精确、四个 UI service 可注册、Fiber unload 会清理、
core reload 后 registry 仍可重挂 renderer。宽度敏感组件继续接受
`packages/mayfly/tests/{core,transcript,interaction}/width-scan.spec.ts` 检查。
