# 内置插件

Mayfly bundle 在 `dsh-base` 上插入普通 Cordis sibling：一组 dsh 支撑行
与全部 Mayfly product 行（行清单以 `cordis.patch.yml` 为准）。不存在
group/isolate 或私有 service realm。

<!-- BEGIN diagram:mayfly-composition -->
<!-- single source 单一来源: docs/diagrams/mayfly-composition.mmd — edit the .mmd, then `pnpm run diagrams:sync` -->
```mermaid
flowchart TB
    BASE["dsh-base"]
    subgraph GRAPH["flat Cordis sibling graph"]
        SUPPORT["dsh support rows<br/>subagent settings · presets · host runner · workspace<br/>connection · file upload · session controller · title"]
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

## 支撑行

- subagent model settings、agent presets；
- dynamic Cordis host runner；
- workspace、connection、file-upload；
- session controller；
- all-prompts title provider。

## Mayfly 行

- `mayfly-ui-provider`：由 `@ephemeral-ai/mayfly-ui/provider` 挂载四个直接 UI registry；
- `mayfly-frontend`、`mayfly-core`、dark theme；
- `mayfly-conversation`、startup、app/current Agent；
- banner、transcript、official model；
- basic/cwd/git/title/context/mode/jobs/goal status；
- activity/queue/todo/agents/workflow pane；
- BTW、jobs 与 agents command、attachments、paste image、editor-plus、interaction。

外部 plugin row 与这些行处于同一 service graph。启动依赖全部由 `inject`
决定，而不是 YAML 行序。任何内置 status/pane 都使用与外部插件相同的
`mayflyStatus`/`mayflyPanes` registry。
