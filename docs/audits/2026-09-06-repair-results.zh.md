# Mayfly 审计修复结果

对应 [原始审计](./2026-09-06-code-audit.zh.md)，基线为 `f9e41c4`。
实现位于 `fix/audit-20260906`，由三个并行任务分批集成并交叉复查。
代码和 Linux 自动化验证已完成；尚未合并 main，等待人工验收。

## 修复情况

| 编号 | 结果 |
| --- | --- |
| A01 | 插件、更新、探测与回滚统一使用 command/args；内置 Harness 优先，以 Node 执行 JS；Windows npm/pnpm 使用 cross-spawn；内置宿主过旧时提示更新 launcher |
| A02 | 四类 registry 捕获稳定 id；准入失败不注册、不发布、不递增 revision；修改原 definition 不再残留或覆盖贡献 |
| A03 | 文本复制、Linux/Windows/macOS 图片探测共用有界 runner；覆盖硬超时、取消、输出上限、同步异常及 EPIPE |
| A04 | 文件补全和 cwd 采用平台路径语义，支持盘符、UNC、home 和大小写；已知 pi-tui 不兼容输入明确路由到 fs fallback，普通 fd 无结果仍保持原语义 |
| A05 | 两套列表共用 core 搜索输入，支持多字符、Unicode、grapheme 删除、分片粘贴；清空会取消未完成粘贴状态 |
| A06 | 编辑字段时 Delete/Ctrl-D 交给 editor；实体删除限浏览状态，保留二次确认 |
| A07 | 窄屏长标签改为标签/值分行；交叉复查补修重复 cursor marker，验证唯一光标位于编辑值行 |
| A08 | provider 新建/编辑/删除使用结构化结果与动态 locale；插件/更新的状态、预检、回滚及修复提示接入翻译，技术诊断保留原文 |
| A09 | 模块私有 WeakSet 识别自身不可变快照，可复用可信子树；普通冻结对象、其他模块实例仍安全克隆 |
| A10 | source 只准入、转换末尾最多 200 个合格 entry，移除完整 projection 副本及引用扫描；未修改 Harness 或 checkpoint schema |
| A11 | Markdown 分段按文本 revision 缓存；改变宽度或绘制失效不重复分段，相同 setText 不失效 |
| A12 | Wire accessor 在准入时被拒绝，getter 不执行；使用安全数据属性复制；renderer 对伪造非法 delta 仍有独立防御 |
| A13 | 共用搜索输入、mention 解析、平台路径、profile argv 与剪贴板 runner；保留 CLI 独立分发边界，没有引入 public facade 或新 subpath |
| A14 | 配置三平台 Node 24 定向 CI 与发布 PTY/ConPTY；Linux 集成实测通过，Windows/macOS 原生执行及桌面验收待完成 |
| A15 | 缓存按 OS/arch 区分，检查入口和打包生成的 native sentinel；所有发布/修复使用目录 lease，覆盖并发与崩溃遗留锁恢复 |

## 验证证据

环境：Linux x64、Node v24.15.0、workspace pnpm 11.7.0。

| 检查 | 结果 |
| --- | --- |
| `pnpm run verify:full` | 通过：工作流测试、类型、lint、架构图、完整 build、lib、agent docs、独立 examples、全量 coverage、happy smoke |
| 全量 Vitest | 179 个文件通过、2 个跳过；2982 项通过、7 项跳过；Windows 专项在 Linux 跳过，不计作 Windows 验证 |
| 覆盖率 | statements 16589/16589、branches 11308/11308、functions 3599/3599、lines 13864/13864，均 100% |
| 独立 examples | 八个声明场景均执行，无失败；临时 consumer 清理通过 |
| `check:pack` | 三个 tarball 均通过，外部 UI kit 安装/runtime/types 通过 |
| CLI 分发 | 七层 runtime 共 119863019 压缩字节；26 个平台 sentinel 包；CLI JS 约 177 KB，保持发布包无运行时依赖 |
| 打包 CLI 冷启动 | 使用独立 DSH_HOME 从打包产物解压当前平台 runtime，并执行 `plugin --help`，退出 0 |
| Linux portable PTY | boot、Unicode paste、edit、resize、file completion、form edit/cancel、plugin install/uninstall、exit restore 全部通过，退出 0 |
| Happy smoke | 40 列真实进程连接 mock LLM，`HAPPY_SMOKE_PASS exit=0` |
| 截图 | 重新生成后无改动；没有 Website 源码或资产变更 |

首次整仓运行发现两项旧测试假设与新契约不符，已修正后重跑完整门禁。
访问器测试现在分别验证 provider 拒绝与伪造 registry delta 下的 renderer 防御，
没有通过删除 renderer 防御分支或降低覆盖阈值来通过检查。

## 性能对比

数据来自相同脚本、每组七次采样的中位数，单位 ms。输入规模为 100,000。
这是共享开发机上的 headless 合成基准，非真实终端 FPS 或硬件承诺；P95、
heap 增长和 RSS 原始记录见 [修复前](./2026-09-06-performance-before.json)
与 [修复后](./2026-09-06-performance-after.json)。heap 增长不等于累计分配量。

| 场景 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 原始列表构建、发布、绘制 | 280.215 | 238.981 |
| 可信列表重复发布、绘制 | 132.684 | 1.192 |
| 复用可信 items，仅更新选择并绘制 | 276.142 | 1.626 |
| 列表翻页、绘制 | 0.462 | 0.503 |
| 原生克隆后，仅 Mayfly source | 38.207 | 0.175 |
| 包含原生完整 parse 与 source | 70.640 | 36.795 |

首次处理原始可变数据仍需完整复制；复用性能依赖保留库生成的可信 items。
列表翻页没有表现出可归因的收益。Harness 全量校验/克隆、完整数组更新和
稀疏 cutoff 扫描仍可能 O(N)，本轮没有把这些成本描述为已消除。

复现命令（先执行 build）：

```sh
node --experimental-transform-types --expose-gc script/audit-performance.mjs
```

## 人工验收

保留的工作目录：`/home/x/dev/deepseek-harness-plugin/mayfly-audit-20260906`。
保留的人工验收入口：

```sh
dsh --profile mayfly-audit-20260906
```

- 主流程：打开 provider 配置，确认中文标题、字段、错误和取消提示一致；进入字段编辑后 Delete 只删除字符，不触发提供商删除。
- 输入：在列表搜索中提交多字符中文、emoji 和粘贴文本，确认过滤正确；取消或清空后不遗留粘贴内容。
- 窄屏：缩到 40 列，长字段标签和值应分行，编辑值和唯一光标仍可见；恢复宽度后焦点和草稿保持。
- 邻近行为：普通 `@` 补全、目录继续补全、会话切换、BTW、已有表单提交/取消和退出后的终端恢复不回归。
- 平台：Windows 原生终端验证无 Git Bash 的 npm/pnpm、盘符/UNC；macOS 验证输入法及 clipboard；Linux 桌面验证 Wayland/X11 的系统剪贴板。具体清单见 [平台验收](../platform-acceptance.md)。

应用内插件安装/卸载已在临时独立 DSH_HOME 中用本地 tarball fixture 自动验证；
人工 profile 无需为确认这一点安装任意第三方插件。更新流程用模拟 registry、
进程和失败回滚测试验证，没有执行真实版本升级。

## 产物与剩余边界

- PTY 结果与日志：工作目录下 `.artifacts/platform-pty/`（已忽略，不提交终端日志）。
- 发布包：`/tmp/mayfly-audit-pack-xaX70M/artifacts/`。
- 集成 PTY 的独立 home：`/tmp/mayfly-audit-pty-KfYF4w`；打包 CLI 冷启动 home：`/tmp/mayfly-audit-launcher-pMtaZB`。
- 尚未在远程 CI 执行 Windows/macOS job，也没有完成三平台桌面人工验收，不宣称三平台认证完成。
- 缓存 lease 为 120 秒 stale、5 秒 heartbeat、约 12 秒获取重试；进程暂停或同步文件系统阻塞超过 stale 的极端场景不提供强 fencing。native 检查为存在性与大小，不是完整内容校验。
- main 仍在原始基线；生产 profile 未修改，未推送、发布、合并或清理人工验收 profile。人工验收通过后再执行合并、主 checkout 重建及临时产物清理。
