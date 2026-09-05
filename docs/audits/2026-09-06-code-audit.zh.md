# Mayfly 代码审计报告

审计基线：`f9e41c4428ce3c1a49e2712ba19bf5935cef7ab1`。报告日期：2026-09-06。
本报告是该提交的审计记录，不定义当前 API，也不表示已实施修复。

## 结论

Mayfly 的主要问题不是缺少架构约束，而是部分约束没有贯穿完整工作流。core 已统一终端宽度、主题和 UI 编译；贡献服务、会话 generation、固定 screen slot 也有较好的测试基础。但启动器与应用内命令、快照与注册生命周期、文本编辑与实体操作之间仍有可复现的不一致。

优先处理两项 P1：应用内插件操作/更新没有使用启动器提供的内置 Harness；注册表的发布和清理仍引用调用者可变的 definition.id。随后处理搜索输入、Delete 语义、窄屏表单、Windows 路径和剪贴板超时。性能优化应覆盖生产者到终端的整条路径，仅优化可见行绘制不足以解决大列表和长会话的事件循环开销。

本次记录 13 项代码问题/技术债和 2 项可靠性、验证风险。严重度表示处理顺序，不是安全漏洞评级：P1 为重要工作流或生命周期正确性问题；P2 为条件触发的功能缺陷或规模瓶颈；P3 为较低优先级的成本与一致性问题。没有认定 P0，也没有据此宣称不存在其他严重问题。

## 范围与证据

- 阅读根及 ui、mayfly、cli 包的维护边界和当前架构文档；对三个包、测试、构建/发布脚本与 CI 做目录级扫描，对本报告涉及的调用链做深入阅读。没有把所有源码逐行阅读一遍，也未将历史文档当作行为依据。
- 重点路径：CLI 启动及内置 runtime、应用内插件/更新、四个 UI registry、UI builder/validator/compiler、surface、终端布局、transcript projection/cache、表单/选择器/面板、文件补全、剪贴板、外部编辑器、locale。
- 在 Linux、Node v24.15.0、pnpm 11.7.0 上运行 `pnpm exec vitest run`：**174 个测试文件通过，1 个跳过；2888 项测试通过，6 项跳过；耗时 21.85 秒**。
- 单独运行源码级最小复现，使用 Node 的 `--experimental-transform-types`；表单与选择器使用仓库已有 headless test doubles。性能数据是本机合成输入的微基准，不是用户真实会话的 FPS、P95 或跨机器指标。
- 本次没有重建整个 workspace，没有运行 coverage/full gate、发布包验收、真实模型请求或 Windows/macOS 实机 TUI。现有 workspace `lib/` 参与包名依赖解析；测试通过不能代替新构建和三平台验收。
- 未修改运行时代码、安装 profile、更新依赖或发布任何内容。

## 发现清单

| 编号 | 优先级 | 发现 | 证据类型 |
| --- | --- | --- | --- |
| A01 | P1 | 应用内插件/更新忽略内置 dsh 路径，且发现流程依赖 POSIX shell | 调用链确认 |
| A02 | P1 | 修改注册时的 definition.id 会造成残留贡献和错误 registry key | 源码最小复现 |
| A03 | P2 | 文本复制超时不能保证结束，和图片粘贴的超时策略不一致 | 源码及子进程机制复现 |
| A04 | P2 | 文件补全与 cwd 展示存在 Windows 路径假设错误 | 源码及 win32 路径计算复现 |
| A05 | P2 | 两套列表搜索均拒绝多字符输入 | headless 复现 |
| A06 | P2 | 表单编辑时 Delete 被实体删除动作截获 | headless 复现及真实调用方确认 |
| A07 | P2 | 窄屏/长标签表单可把字段值全部裁掉 | headless 复现 |
| A08 | P2 | provider 等工作流没有完整接入已有 locale 机制 | 调用链确认 |
| A09 | P2 | 大列表在 provider 前仍同步全量克隆、冻结 | 源码及微基准 |
| A10 | P2 | 流式 transcript 更新仍随历史规模执行全量扫描/校验 | 源码及微基准 |
| A11 | P3 | Markdown 缓存命中之前仍重复全文分段 | 调用顺序确认 |
| A12 | P3 | freezeWire 保留 getter，冻结结果不一定是稳定数据快照 | 源码最小复现 |
| A13 | P3 | 多处重复的输入、路径、进程与 profile 逻辑已有行为漂移 | 实现对照 |
| A14 | P2 | 三平台发布矩阵没有覆盖三平台真实 TUI 工作流 | CI 验证缺口 |
| A15 | P3 | runtime 缓存命中只验证 manifest，不检查入口/平台完整性 | 条件性可靠性风险 |

## P1：优先修复

### A01 应用内命令没有使用启动器交付的 Harness

位置：[CLI main.ts](../../packages/cli/src/main.ts#L86)、[updater/profile.ts](../../packages/mayfly/src/interaction/updater/profile.ts#L74)、[plugin-commands.ts](../../packages/mayfly/src/interaction/plugin-commands.ts#L168)、[update-command.ts](../../packages/mayfly/src/interaction/update-command.ts#L359)。

启动器通过 `MAYFLY_DSH_BIN: host.binJs` 把内置入口传入子进程。应用内 `findDshBin()` 只检查 `DSH_BIN`，否则执行 `sh -c 'command -v dsh'`；源码搜索未找到应用内对 `MAYFLY_DSH_BIN` 的消费。

触发与影响：

- 只安装 `@ephemeral-ai/mayfly-cli`、没有全局 dsh：能够启动 Mayfly，但插件安装/卸载或更新路径会报告找不到 dsh。
- 同时存在另一版本全局 dsh：应用内操作会选择全局版本，丢失启动器固定 Harness 的保证。
- 原生 Windows 没有 `sh`：发现流程直接失败。安装 Git Bash 不是该工作流应隐含要求的前提。

还存在下一层 Windows 问题：[updater/io.ts](../../packages/mayfly/src/interaction/updater/io.ts#L73) 使用无 shell 的 `spawn`；[registry.ts](../../packages/mayfly/src/interaction/updater/registry.ts#L122) 直接启动 `npm`。对常见 npm.cmd 安装，这条执行路径没有启动器已有的 ComSpec/PATHEXT 处理，可能退回公共 registry，失去 npmrc 镜像配置。

建议：在 runtime 内集中解析“可执行程序 + 固定前置参数”。内置 JS 入口应使用 `process.execPath` 启动；不要仅把 env 名补进查找函数后继续把 `.js` 当平台可执行文件。为无全局 dsh、全局版本不同、Windows npm.cmd、带空格入口分别增加端到端测试。

### A02 注册表没有真正隔离调用者的 definition

位置：[services.ts](../../packages/ui/src/services.ts#L192)。同样的闭包模式存在于 pane、status、overlay、editor-extension。

虽然保存了 `admittedDefinition = freezeWire(definition)`，后续 publish/remove 仍读取原对象的 `definition.id`。TypeScript 的 readonly 接口不阻止调用者保留原始可变对象，JS 消费者更不受类型限制。

实际复现：注册 `audit.a`，把原 definition.id 改为 `audit.b`，然后 set、dispose：

```text
after set     [ [ 'audit.a', 'audit.a' ], [ 'audit.b', 'audit.a' ] ]
after dispose [ 'audit.a' ]
```

数组内两列分别是 entry.id 和 entry.definition.id。结果既产生身份不一致，又在 dispose 后留下旧贡献。如果改成另一现有 id，还可能写入不属于本 handle 的 registry 项。

建议：所有后续 map 操作、事件和清理都捕获已准入的稳定 id；四个服务同时修复。增加“修改原对象后 set/dispose”和“改为已存在 id”的回归用例，验证 Fiber unload 后没有残留。

## UI/UX 与功能一致性

### A05 列表搜索不能处理多字符输入

位置：[select-list.ts](../../packages/mayfly/src/interaction/select-list.ts#L170)、[frontend-panel.ts](../../packages/mayfly/src/interaction/frontend-panel.ts#L158)。

两者都以 `data.length === 1 && data >= ' '` 判断可输入文本。结果是一次传入 `ab`、`中文` 或一个 UTF-16 长度为 2 的 emoji 时，不会更新搜索词。单字中文不必然失败；问题在输入事件的长度假设，而不是中文本身。

headless 结果：`ab -> null`、`中文 -> null`、`😀 -> null`、`a -> a`，其中 null 表示没有 filter。IME 连续提交、粘贴和终端合并输入是否形成这样的事件，需要真实终端补测；控制器本身拒绝这些输入已经确认。

建议：复用 core 的文本输入/粘贴语义，在 core 内区分可打印文本、控制序列和 bracketed paste；两个列表控制器共用同一搜索输入逻辑。不要改成直接接受所有多字符字符串，否则会把转义序列当搜索词。

### A06 Delete 在字段编辑状态仍触发实体删除

位置：[form-panel.ts](../../packages/mayfly/src/interaction/form-panel.ts#L123)、[keys.ts](../../packages/mayfly/src/interaction/keys.ts#L133)、[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts#L486)。

`ACTION_DELETE` 同时绑定 Delete 和 Ctrl-D。表单在向文本编辑器转发之前直接调用 `onDelete`，没有检查当前是否编辑字段。provider 编辑表单恰好注册了这个回调。

headless 复现：进入字段编辑状态，再发送 Delete，实体删除回调被调用。真实 provider 路径随后会进入二次确认，所以这不是“按 Delete 立即删除凭据”；实际问题是正常字符编辑被打断，并提前结束当前编辑步骤。

建议：文本编辑状态把 Delete/Ctrl-D 交给 editor；实体删除使用明确的独立动作或只在浏览状态生效。提示也必须随当前状态改变。回归测试需断言光标处字符变化，以及实体删除回调没有执行。

### A07 不超宽不等于窄屏可用

位置：[ui-compiler.ts](../../packages/mayfly/src/core/ui-compiler.ts#L435)。

字段绘制先计算完整标签宽度，把 value 的可用宽度下限设为 1，然后把“完整标签 + value”整体截断。当标签已经占满 available，value 的那一列仍在裁剪区域之外，后续行缩进也占满宽度。

20 列表单中，标签 `A very long field name` 会使初始值 `VISIBLE_VALUE` 完全不可见。带长 hint 的真实字段也会触发，不限于极端标签。现有 width scan 能保证不会撑破终端，却不能发现这个可用性缺陷。

建议：不足宽度时切换为 label/value 两行布局，或为编辑区域保留最低宽度并截断 label；聚焦时必须保证 value 和光标可见。测试应检查内容存在、光标可见、可编辑，覆盖 20/40/80 列及中英文标签。

### A08 Locale 接入存在工作流断层

位置：[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts#L155)、[provider-add.ts](../../packages/mayfly/src/interaction/provider-add.ts#L486)、[form-panel.ts](../../packages/mayfly/src/interaction/form-panel.ts#L135)。

共享 form/select controller 已有 `t` 参数，但 provider 的 fillForm 和编辑表单构造没有传入 translator；动态 `Configure ${route}`、字段提示、错误与删除确认也保留了直接英文字符串。另一方面，settings/plugin 等页面已使用 locale。

影响：选择中文后，相邻配置工作流的标题、说明和错误反馈语言不同。只增加词典条目不能修复没有接入 translator 的调用路径，动态拼接消息也应改为占位符。

建议：以完整工作流检查 locale，而不是仅测试词典注册。优先 provider onboarding/edit/delete、插件操作失败、更新失败；继续允许路径、模型名、第三方原始诊断保留原文。

## 跨平台与进程行为

### A03 文本复制没有硬超时保证

位置：[clipboard-write.ts](../../packages/mayfly/src/interaction/clipboard-write.ts#L50)、[clipboard-probe.ts](../../packages/mayfly/src/interaction/clipboard-probe.ts#L76)。

文本复制使用 `spawn(..., { timeout: 3000 })`，没有指定 killSignal，也没有单独超时 settle，等待 close 后才结束。Node 默认发送 SIGTERM；忽略或阻塞在 SIGTERM 处理中的 helper 可以一直不 close。

图片粘贴的共享 runner 已明确使用 SIGKILL，注释还记录了 wl-clipboard 在异常 compositor 下的 TERM 问题。因此这不是理论上的风格差异，而是已有经验没有覆盖同类路径。

用相同 spawn 选项启动忽略 SIGTERM 的受控 Node helper：超过 3 秒仍存活，3.5 秒时由审计程序显式 SIGKILL 后结束。本次没有在真实 Wayland compositor 上制造故障。

影响：`/copy` 可以一直等待原生工具，后续工具与 OSC52 的结果回退不能按时完成。建议统一有硬期限、输出上限、关闭 stdin 错误处理的进程原语；真实 helper 的正常退出行为仍应保留。

### A04 Windows 文件路径语义没有贯通

位置：[file-mention.ts](../../packages/mayfly/src/interaction/file-mention.ts#L140)、[file-mention.ts](../../packages/mayfly/src/interaction/file-mention.ts#L258)、[file-mention.ts](../../packages/mayfly/src/interaction/file-mention.ts#L287)、[status-cwd.ts](../../packages/mayfly/src/transcript/status-cwd.ts#L34)。

确认的具体问题：

- 目录 listing 只以 `startsWith('/')` 判断绝对路径。`C:/Users/demo/` 被当相对路径，按当前分支执行 `path.win32.join('C:/repo', base)` 得到 `C:\repo\C:\Users\demo\`。
- 扫描使用平台 `join` 得到反斜杠路径，评分深度却使用 `split('/')`；`src\core\index.ts` 的深度被算为 0，`src/core` 也不匹配该候选。
- mention tail 只查 `/`，不能一致处理 Windows 用户输入的反斜杠目录。
- footer cwd 的 home 缩写与分段同样只认 `/`，原生 Windows 深路径不能按设计缩写，窄屏会更早丢失关键信息。

建议：区分文件系统绝对路径与 UI 展示路径，在内部边界统一规范；使用平台路径 API 判断 drive/UNC/absolute。补充盘符、UNC、反斜杠、正斜杠、空格、中文及 fd 缺失下的测试。Linux 上的 path.win32 复现证明算法错误，不等于已经完成 Windows 实机验收。

## TUI 性能

### A09 列表窗口化没有覆盖快照生产与发布

位置：[builders.ts](../../packages/ui/src/builders.ts#L55)、[services.ts](../../packages/ui/src/services.ts#L172)、[ui-compiler.spec.ts](../../packages/mayfly/tests/core/ui-compiler.spec.ts#L1874)。

`freezeWire` 每次递归 clone 再 deepFreeze；builder 构造列表时执行一次，registry.set 又执行一次，即使对象已是 builder 创建的冻结值。core 的可见项 admission 可以受 viewport 限制，但上述工作始终按全量数据执行。

本机简单列表的单次 freezeWire 测量：

| 项数 | 同步耗时 |
| --- | --- |
| 1,000 | 约 4 ms |
| 10,000 | 约 15 ms |
| 100,000 | 约 166 ms |

这些是单次微基准，有 JIT/GC 和机器噪声；没有包含 builder + provider + compiler 的完整耗时。现有 10 万项测试直接把原始列表交给 compiler，并未度量公开 builder/provider 链路。

建议：在不削弱 caller isolation 的前提下，对库自己生产、已验证不可变的数据使用内部可信身份/结构共享，避免重复复制；不要把任意 `Object.isFrozen` 对象都当安全快照。建立从 register/set 到输入可响应的端到端大列表基准，分别测首次发布、小更新和滚动。

### A10 流式更新仍有随历史长度增长的成本

位置：[projection.ts](../../packages/mayfly/src/conversation/projection.ts#L145)、[official-model.ts](../../packages/mayfly/src/transcript/official-model.ts#L288)、[official-model.ts](../../packages/mayfly/src/transcript/official-model.ts#L370)。

更新活跃 entry 时使用 findIndex 和数组复制；source 的 onChanged 对完整 projection 执行 Zod safeParse；incrementalStreamingModel 随后 flatMap 全部 entries 才确定变化项。200-entry 渲染窗口在这些步骤之后，无法限制前面的成本。Zod 校验的 parsed.data 还未作为模型输入复用。

对简单 assistant entries 做预热后 7 次测量，safeParse 中位数约为：1,000 项 0.48 ms、10,000 项 4.04 ms、100,000 项 31.58 ms。工具 result 的递归 JSON 数据更复杂；这里没有量化其影响，也没有测真实 token 频率。

建议：保持 Harness projection 为唯一状态来源，利用稳定 entry identity、updatedSeq 或已有增量事实限制重新校验范围；不要通过 renderer 再折叠会话事件来换取性能。增加历史规模 × delta 频率的基准，观察事件循环延迟、分配量和最终内容一致性。

### A11 Markdown 缓存命中仍先做全文扫描

位置：[components.ts](../../packages/mayfly/src/core/components.ts#L582)。

Markdown adapter 的 render 首先执行 splitRichDocument，再判断是否包含 Mermaid，随后才判断 Mermaid 渲染缓存。没有 Mermaid 的文档也会每次扫描源文；包含 Mermaid 的相同文本重绘也先付出分段成本。

建议：在 setText 时失效分段缓存，render 直接复用分段结果；把文本 revision/宽度缓存判断前移。transcript 外层 entry cache 已能跳过部分调用，所以本项不等于“所有终端帧都完整解析 Markdown”，优先级低于 A09/A10。

## 架构与复用

### A12 冻结对象不一定形成不可变数据快照

位置：[builders.ts](../../packages/ui/src/builders.ts#L69)、[ui-validator.ts](../../packages/mayfly/src/core/ui-validator.ts#L109)。

cloneWire 对 accessor descriptor 原样复制。最小复现中，冻结一个 content getter 引用外部变量的 text node，再改变该变量，`Object.isFrozen(node)` 仍为 true，但 node.content 已变化。

core 的 validator 会拒绝 accessor 字段，这一点有效降低了渲染风险；本报告不把它描述为 renderer admission 绕过。问题在 builder/provider 的“已冻结快照”语义与 renderer 的“只能是数据”语义不一致，也可能让其他 registry subscriber 观察到没有 revision 的变化。

建议：在公开 wire 边界明确拒绝 accessor，并验证不执行 getter；保留 schema admission 属于 core 的分工。不要为获得快照而主动执行任意 getter。

### A13 重复逻辑的收益与代价需要重新划界

| 功能 | 实现位置 | 当前问题与建议 |
| --- | --- | --- |
| 列表查询/输入/取消 | interaction/select-list.ts、frontend-panel.ts | 分别维护 query/filterEditing 和输入判定，同样漏多字符输入；共享纯输入状态转换，保留各自业务布局 |
| mention token 提取 | interaction/file-mention.ts:43、core/components.ts:171 | 两处重复 delimiter/扫描，且都记录引号空格局限；把纯解析集中到中立的内部模块 |
| profile argv 解析 | app/exit-epitaph.ts:78、interaction/updater/profile.ts:45 | 算法重复，后者还以“跨 app package 需要新 export”为理由；现已在同一 runtime package，可共享内部纯 helper，无须新 public export |
| 剪贴板 subprocess | interaction/clipboard-probe.ts、paste-image.ts、clipboard-write.ts | 超时策略已有 A03 所示分歧；共享有界执行与错误分类原语，保留平台协议差异 |
| CLI 与 updater 的进程执行 | cli/internals.ts、interaction/updater/io.ts | Windows、stdin、失败诊断不一致；CLI 独立分发边界确有理由，不能简单令 CLI 依赖完整 runtime，至少共享契约测试/用例 |
| 四个 UI registry | ui/services.ts | A02 的闭包缺陷重复四次；提取稳定身份/生命周期小原语即可，不必增加新服务 facade |

另一个维护热点是 `core/ui-compiler.ts` 约 2218 行、`ui-validator.ts` 约 928 行、`core/terminal.ts` 约 984 行、`settings-command.ts` 约 1059 行。文件长度本身不是缺陷；风险是职责修改容易跨验证、焦点和绘制联动。建议围绕已有 control state、admission、layout 边界增量拆分，避免一次性重写 compiler。

不应误判为冗余的部分：公开 root/subpath re-export、四个不同的 UI registry 语义、live 辅助 Agent 复用主 transcript、只读 transcript panel，以及不同 OS 剪贴板协议。它们分别服务于分发、生命周期或产品语义。

## 验证与可靠性风险

### A14 发布矩阵并未证明三平台 TUI 可用

位置：[ci.yml](../../.github/workflows/ci.yml#L27)、[release.yml](../../.github/workflows/release.yml#L96)。

日常完整代码门禁只运行 Ubuntu。发布矩阵确实包含 Linux/Windows/macOS 和 Node 22/24，但跨平台主要验证 CLI 安装、版本和 `plugin --help`；profile 组合、安装结果和真实 PTY boot/exit 都受 Linux + Node 24 条件限制。

因此当前证据支持“有跨平台发行与 host materialization 验证”，不支持“Windows/macOS 交互工作流已经与 Linux 等价”。代码行覆盖率 100% 的配置也不能覆盖真实 shell、输入法、控制台编码、剪贴板和焦点行为。

建议：PR 上增加平台相关定向测试；发布候选上运行原生 ConPTY/macOS PTY 的 boot、输入、resize、退出恢复，并加入应用内 plugin 操作。不要只把现有 Linux shell smoke 原样塞入 Windows runner。

### A15 runtime 缓存有效性验证偏弱

位置：[runtime.ts](../../packages/cli/src/runtime.ts#L37)、[runtime.ts](../../packages/cli/src/runtime.ts#L61)。

readRuntime 只检查 dsh package.json 的版本和 bin 字段，未验证 bin 文件存在，也不验证当前平台 native 层；缓存目录 key 仅包含 Mayfly/Harness 版本。manifest 尚存但入口被清理的缓存会继续命中，跨 OS/architecture 共享 DSH_HOME 也没有平台隔离。

这是损坏缓存/共享 home 场景的可靠性风险，本次没有模拟删除用户缓存，也没有认定正常首次解压会生成半成品。同步解压、临时目录和 rename 的并发发布设计仍是合理的。

建议：缓存 key 包含目标 OS/arch；命中时检查入口和少量平台 sentinel，失败则走可恢复的重建。结合无需每次扫描全部 node_modules 的启动成本约束设计。

## 按维度的整体评价

| 维度 | 已有优势 | 主要不足 |
| --- | --- | --- |
| UI/UX 一致性 | canonical surface、语义颜色、共享 hint/keymap、公共 form/list 基础 | 编辑/删除语义冲突；搜索输入分叉；窄屏字段不可见；翻译工作流不完整 |
| Linux | CI、whole-tree、宽度、进程测试证据较多 | Wayland 复制硬超时；仅安装 launcher 时的应用内命令定位 |
| Windows | CLI 有 ComSpec 预检和 native payload 分层 | 应用内 POSIX shell/npm spawn、盘符/分隔符；缺真实 TUI 验收 |
| macOS | 原生 clipboard probe、darwin payload；共享 Node 路径行为较接近 Linux | TUI/IME/外部编辑器的实机证据不足；launcher 定位问题同样适用 |
| 架构 | core 为 terminal owner；native service graph；generation 与 Fiber 清理机制 | registry 身份没有隔离；部分迁移后的重复代码仍以旧包边界解释 |
| 性能 | transcript entry cache/200-entry 窗口；list admission 窗口；Mermaid 和 diff 有计算规模限制 | provider 全量复制、projection 全量校验/扫描、Markdown 缓存前重复工作 |
| 测试 | 大量源码测试、宽度检查、生命周期/replay 测试 | 结构覆盖强于场景覆盖；微基准/真实交互预算缺失；跨平台矩阵范围偏窄 |

## 尚需实机验证的事项

以下不作为已经确认的缺陷：

- Windows `clip.exe` 对 UTF-8 中文/emoji 的输入编码、PowerShell 剪贴板与 ConPTY 的组合行为。
- Windows 外部编辑器 shell quoting 对带空格、百分号目录，以及 `code --wait` 的行为；现有 quote helper 只做双引号包裹和反斜杠转义，没有完整覆盖 cmd.exe 展开规则。
- macOS Option/Meta、IME 提交、终端主题通知，以及不同 terminal emulator 的 OSC52/图片 fallback。
- SSH/tmux 的本地/远端剪贴板目标与输出恢复；本报告不把 native 成功自动等同于用户桌面已复制。
- 异步外部编辑器仍运行时 theme/reload/quit 的子进程回收；input-plugin 已有 unloaded 写回拦截，但 launcher 本身没有 AbortSignal 参数。
- 真实长会话的流式 FPS、按键到绘制延迟、RSS 和 GC。微基准只能证明工作量位置，不能直接推导实际卡顿比例。

## 整改顺序与验收建议

### 第一阶段：正确性和主工作流

修复 A01/A02/A03/A05/A06/A07/A04。每项先增加能证明用户结果的回归用例，再改实现。Windows 优先覆盖不安装 Git Bash、仅安装 mayfly-cli 的环境；表单测试必须包含正在输入时的 Delete 和长标签窄屏，而不仅是截图宽度。

### 第二阶段：整条更新链路的性能

先测 builder -> provider -> compiler -> render，再测 projection delta -> transcript -> render；用 1k/10k/100k 规模观察增长曲线。区分首次打开、稳定重绘、小范围更新、尺寸变化。按测量结果处理 A09/A10，再优化 A11。

建议记录输入响应和帧耗时 P50/P95、最大 event-loop delay、一次更新分配量和峰值 RSS。预算应在目标硬件上建立，不能把本报告的合成数据当验收阈值。

### 第三阶段：复用与语言一致性

处理 A08/A12/A13，优先合并已经导致功能漂移的纯逻辑，维持现有包/服务边界。不要为了 DRY 增加 Mayfly manifest、插件 host facade 或新 public subpath。为两种 locale 跑完整 provider/settings/plugin 流程。

### 第四阶段：平台验收与缓存恢复

补 A14/A15。最小矩阵包含 Linux Wayland/X11、Windows Terminal/ConPTY、macOS Terminal 或 iTerm2；每个平台都验证 boot、输入法/粘贴、resize、表单编辑、文件补全、应用内插件操作、退出后终端恢复。SSH/tmux、图片协议和主题自动切换可作为扩展矩阵。

后续修复涉及用户行为时，应遵守仓库规则使用独立 worktree/profile，运行 change-aware gate；公共 UI、架构、composition 等变更运行 full gate，并交付针对具体场景的人工验收清单。
