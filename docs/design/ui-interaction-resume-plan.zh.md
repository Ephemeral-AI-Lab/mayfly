# 交互重构续做方案与当前核查

状态日期：2026-09-08。候选实现位于 `refactor/ui-interaction`，基线为 `b82acd2`。
Codex session `01a07aa1-3760-7791-92dd-dc5f797f2874` 已用于恢复此前决策；后续不依赖
该 session 可恢复性，所有事实以工作树为准。

## 已完成

- 公开交互协议、provider endpoint、frontend 稳定 owner 与 core compiler 已切换到
  单一模型。
- Provider、Settings、请求型交互、Tools/MCP/Skills、Help/Trace/Session/Agents、
  Jobs/Market/Update、通知、Queue 与 editor extension 均已迁移。
- 旧通用 panel/controller 与兼容字段已退出生产树。
- 外部 overlay 示例已证明普通插件可用相同 Form/Tabs/action/reply 语义读写原生
  settings。
- 全仓 typecheck、lint 和逐文件 100% coverage 已通过；确切数字见
  [实施进度](./ui-interaction-progress.zh.md)。
- 架构、seams、AGENTS、中英 README 与 Website 插件参考已同步到最终协议。

## 当前边界

技术实现、发布候选自动门禁、Step 19 人工接受和 Step 20 合并清理均已完成：

1. 候选四笔提交已通过 `5fbbdc8` 合并到 main。
2. 主 checkout 已重建并通过 `check:lib`。
3. Website preview、专用 profile 和 worktree 已清理。

`mayfly` 共享 profile 未用于候选验收。Website preview、专用 profile 和 worktree
均只保留到用户明确接受，随后按仓库流程清理。

## 人工验收顺序

运行时入口：

```sh
dsh --profile mayfly-ui-interaction
```

Website 入口：

- `http://192.168.8.188:4183/plugins/ui-reference`
- `http://192.168.8.188:4183/plugins/component-model`
- `http://192.168.8.188:4183/en/plugins/ui-reference`

| 组 | 主流程与预期结果 | 失败、窄屏或生命周期检查 | 相邻行为不得回归 | 状态 |
| --- | --- | --- | --- | --- |
| A | `/provider` 与 `/settings` 中编辑 Form、single/multi Choice，Save 只提交变化路径，Cancel 不写入 | 必填错误留在字段；凭据部分成功只重试未完成部分；有未保存内容时关闭默认选 No；40 列或窄高窗口不溢出 | 文本输入、Tab 分组、Escape 逐层返回及原有配置文件入口正常 | 已接受 |
| B | 在 `/agents`、`/trace`、`/help`、`/tools` 等页面操作 Tabs、Tree、Search 和长 Document，焦点、展开和滚动锚点符合当前内容 | 搜索清空后恢复展开；prepend/append 或宽度变化后仍定位同一语义内容；返回或 renderer reload 不复活已关闭子页 | PageUp/PageDown/Home/End、父子返回和大列表窗口稳定 | 已接受 |
| C | 从 Provider 发起 OAuth，并实际处理审批、问题和计划评审；每个原生请求只结算一次 | URL/code 持续可见；Escape 默认拒绝；用户拒绝、signal 撤回与整个授权取消可区分；晚结果不重开 UI；Other 与空答案按原语义处理 | 请求 FIFO/allowance、敏感值不回填或泄漏、编辑器焦点恢复正常 | 已接受 |
| D | `/plugin` 浏览详情与安装状态，`/jobs` 查看分页输出和停止任务，`/update` 展示 preflight、执行状态与最终结果 | 离线/安装失败有明确反馈；Jobs 长行和跨页内容完整且翻页不重复消费；stop 默认不确认；更新失败执行 rollback | 市场 tabs、profile/source 标识、Job 原生终态和更新重入保护正常 | 已接受 |
| E | 在 Prompt 中编辑/提交/转向，浏览 Session/Agents，并触发 editor extension 的 action、completion 与 transform | F7/F8 切换及关闭辅助会话；附件失败回滚；取消、timeout、replacement 或 unload 后晚结果不生效 | 精确 Agent、草稿、附件、补全及主会话 transcript 不串线 | 已接受 |
| W | 阅读上述三条 Website 路由，核对中英文协议说明、组件截图、侧栏和窄屏排版 | 页面刷新与直接打开子路由正常，截图无裁切、重叠或过期交互 | 语言切换、前后页和其他开发手册导航正常 | 已接受 |

2026-09-08 的首次人工验收发现：命令 overlay 双外框、permission 选择缺少
`mayflyOverlays` inject、Settings 字段导航/Tab 会造成意外调整，以及 editor 命令面板
未执行高度上限。候选已统一合并 registration/root frame、补齐 inject、改为导航态
聚焦和 Enter-only select 应用，并让 editor presentation 遵守默认三分之一
`maxHeight`，短内容保持自然高度；A 至 D 等待使用重建后的专用 profile 复验。

第二轮反馈要求默认高度调整为屏幕三分之一、短 Version 型面板按内容收缩，并指出
`/context` 会因 fractional token estimate 产生非法 progress。候选现已将 context
window/occupancy 归一化为安全整数，长面板限制为 8/24 行，`/version` 实机为 6 行；
`/context`、`/plugin` 与 `/version` 均已在专用 profile 复核，并纳入最终接受。


用户于 2026-09-08 明确回复“验收通过”，接受 A 至 E 的运行时场景与 W 的 Website
场景；Step 19 完成，候选进入验收后合并和清理。

每项验收记录 primary workflow、期望结果、失败或生命周期分支，以及相邻行为是否
回归。任何验收后源码调整都重跑对应自动门禁。

## 合并条件

最终源码门禁、Website/profile 复核、用户接受、分支合并、主 checkout 重建和资源
清理均已完成。main 原有 artifacts/audit 文件得到保留；重叠的早期 PR #15 文档原文
另存为 stash commit `dfcdfe3`，最终文档保留并更新了其中有效内容。
