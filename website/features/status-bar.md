# 状态栏

状态栏分为两行：第一行显示当前状态，第二行显示可用按键和会话范围。
所有条目都使用同一个 renderer-neutral `mayflyStatus` service。

打开 `/settings`，选择 `mayfly`，修改**状态栏按键提示**（`keyHints`）：

原生 Save 操作写入当前配置档并立即更新提示。Harness 0.1.7 使用配置档中的
`cordis.patch.yml`；旧 `settings.yaml` 仅作为启动时的迁移输入。

| 值 | 效果 |
| --- | --- |
| `full`（默认） | 显示 `Ctrl+O 展开`、`Shift+Tab 退出计划`、`Alt+M 模型`、`/help 按键` 等上下文提示 |
| `minimal` | 仅保留中断/撤回、内容展开及会话切换提示 |
| `off` | 隐藏内置第二行及空编辑器中的教学文字 |

修改立即生效。捕获输入的面板仍显示自己的按键提示。编辑器边框显示会话标题；
计划、权限与 Shell 模式在第一行以独立的加粗状态标签显示。

| Entry | Priority | 内容 |
| --- | --- | --- |
| scope / switch | 0 / 1（第二行） | 左侧显示会话身份；右侧显示 `F7` 切换、`F8` 关闭旁支提问或离开子代理视图 |
| basic | 0 | 当前 model；显式选择 thinking effort 时追加 ` Effort`(如 `step-5-preview Max`),provider default 不加后缀 |
| mode | 1 | 独立的计划、权限和 Shell 状态标签 |
| goal | 2 | 当前 goal 的 `Goal <phase> · <rounds>/<max> · <activation>`（按 phase 着色；无 goal 时隐藏） |
| schedule | 2 | 提醒数（无提醒时隐藏） |
| jobs | 3 | `⏵ N jobs`——live（running/stopping）后台任务数；没有时隐藏 |
| context | 4（right） | 最近一步的 cache 命中率与 context 占用，如 `cache 82%  context: 45% (57.6k/128k)`；provider 未报告 cache 时省略 `cache` 段 |
| cwd | 5 | 当前工作目录 |
| git | 10 | branch 与变更摘要 |

宽度不足时，core 为最高优先级的模式与切换条目预留空间，再按 priority/id 顺序容纳 entry：放得下的 entry 保留完整
宽度，声明 `overflow: 'hide'` 的 entry 直接隐藏而不是截断，行满后低优先级
entry 被丢弃。已容纳的 entry 再按声明的 left/center/right band 布局。

第三方贡献：

```ts
export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  ctx.mayflyStatus.register({
    id: 'acme.health',
    priority: 15,
    band: 'right',
  }, { kind: 'text', content: 'healthy', tone: 'success' })
}
```

Registration 随 Fiber 清理。详情见[插件状态栏](/plugins/status)。

![状态栏提示设置](/shots/app-settings.svg)
