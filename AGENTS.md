# AGENTS.md

面向后续在本仓库继续开发的 Agent / 贡献者。读完再动手。

## 环境与工具

- 本机已安装 GitHub CLI(gh)与 npm 且均已认证;建仓、推送、tag、release **优先用 gh**;
- 分发**双通道**:GitHub(tag + Release,源码与发布说明)+ npm(公开包 `dsh-gitbash-shell`,用户安装入口);
  GitHub Release 的 published 事件自动触发 npm publish —— **Trusted Publishing (OIDC)**,
  workflow 用 `id-token: write` + 无令牌 `npm publish`(见 .github/workflows/npm-publish.yml,
  npm 包设置里须登记同名 workflow 为 trusted publisher)。

## 项目一句话

`dsh-gitbash-shell`:Windows 上把 dsh 的 `ctx.shell` 换成 Git for Windows bash 的插件。
1) host 执行器(`src/shell.js`,继承官方 `@deepseek-ai/dsh-bash-sandbox`);
2) preset 物化(`src/index.js`,把 standard/minimal/code/cordis 的 Git Bash 变体写进
用户 preset 根,哈希标记管理、卸载清理);
3) 发布 `gitBash` 宿主能力服务供 dsh-ptc-cordis-preset 联动。

## 核心不变量(改代码前必读)

1. **执行器只替换 argv,不替换行为**:沙箱策略、拒绝分类、后台任务、设置节全部沿用
   `@deepseek-ai/dsh-bash-sandbox`;full-access 分支必须单独接 Git Bash(父类硬编码裸
   `bash`,Windows 上会解析到 WSL 占位)。
2. **preset 组合文本可审查**:assets/*/agent.cordis.yml 是完整组合,物化只做逐字节拷贝,
   绝不经过 YAML parse→dump 往返(会丢 `!!js` 表达式)。
3. **用户改过的 preset 绝不覆盖、绝不删除**:.plugin-managed.json 哈希是唯一判据;
   孤儿清理只删 `managedBy === 'dsh-gitbash-shell'` 且 unmodified 的目录。
4. **`gitBash` 能力服务**是联动契约:`{ active, bashPath }`,仅 Windows 为 active;
   形状变更要同步 dsh-ptc-cordis-preset(v0.6.0+ 依赖)。
5. **无构建**:发布产物就是 src/* + assets/*;npm test 全绿即可;安装不触发 lifecycle
   脚本(保持零 allowBuilds 摩擦)。
6. **`presets` 配置**:物化清单由 `gitbash-presets` 行配置,默认 4 个;变更要同步
   本机 web profile 的 patch。
7. **双 era 组合文本与 marker.base(v0.6.0)**:dsh 0.1.2 把内置 `code` preset 改名
   `ptc`(`mode: code`→`ptc`,无别名,另新增 `command-goal` 行、`modelSelectionSettings: true`、
   `fetch: true`)。受影响变体(standard/code/cordis)各有双 era 已提交文本
   (`agent.cordis.yml` ↔ 0.1.1,`agent.cordis.ptc.yml` ↔ 0.1.2+;minimal 内置未变,单文本双 era),
   `detectBase` 每启动探测 roster 选文件,marker 记 `base`,探测翻转 → `syncDecision` 刷新。
   **preset id 永不随官方改名**(`code-gitbash` 保持历史 id——会话钉在 id 上,改名即 preset not found);
   内置 preset 变化时两个 era 文件都要对照各自版本的内置手工同步;组合文本里不得出现另一 era 的
   字面量(`mode: ptc` / `mode: code`),smoke 测试有断言把关。
8. **未来破坏点跟踪**:官方宣布会话持久词汇(`tool/code-dispatch*`、日志插件名 `tools-code-mode`、
   `:code:` 子调用段)将在 SESSION_FORMAT_VERSION v0→v1 迁移时改名(dsh 仓库 notes
   `2026-08-25-rename-code-mode-to-ptc` 的 Deferred 一节)。落地时复查双 era 划分;dsh-better-sidebar
   的命名空间(`terminalShell`/`shell`)演化同样需在其升级后复核。

## 验证清单(改动后)

1. `npm test` 全绿;
2. 真机验证:重启 DSH → 物化日志(含 era 字样)→ 模式选择器出现 `* · Git Bash` → 新会话 bash 工具存在、
   `command -v bash` 指向 Git 安装目录;
3. 组合文本改动后:用 cordis 会话跑 `agentPresets.standingKeyFor('<variant>')` 挂载校验;
4. era 相关改动另需双向验证:当前本机 dsh(<= 0.1.1)物化 `code` era;有条件时在新版 dsh(>= 0.1.2)上
   验证 `ptc` era 挂载 + `marker.base='ptc'`;以及「旧 marker(无 base)首启刷新一次」路径。

## 发布 checklist(GitHub + npm)

1. `npm test` 全绿;
2. `npm version minor|patch`(能力变化 minor,修复 patch);
3. `git push --tags`;
4. `gh release create <tag>`(notes 带安装命令与变更摘要)——published 事件自动触发 npm publish;
5. 用户侧更新 = `dsh plugin --profile <name> add dsh-gitbash-shell`(npm 包名);host 半变更需重启 DSH。