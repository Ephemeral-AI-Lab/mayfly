# 发布插件

Mayfly 插件按普通 npm Cordis package 发布。发布前：

- `package.json` 的 `exports` 指向实际存在的 JS/type；
- `files` 包含 build output；可安装的 Host bundle 另发布其原生 `cordis.patch.yml`；
- dsh 与 Mayfly 包放在合理的 peer dependency；
- tarball 在空目录独立安装并通过测试；
- README 写清安装命令、`inject` service、unload 行为和 profile 验收流程；
- npm 包名、版本、tag、access、provenance 与 2FA 已明确。

```sh
npm pack
npm publish --access public
```

只有用户明确授权 exact package/version/tag 后才执行 publish。GitHub repository
创建与 npm 发布是两个独立动作。

Host bundle 可[提交到插件市场](/market/submit)，供用户通过 `/plugin` 发现。前端 UI
package 需加入 TUI 源码组合（`run(argv, { plugins })`），再构建并重启；发布本身不会建立 TUI 安装或热加载路径。
