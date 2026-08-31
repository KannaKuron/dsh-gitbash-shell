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
 4a. **inspect-registry shim 的安装时机(v0.7.2,对齐 ptc 0.6.3)**:shim 曾在 apply() 里
    一次性 ctx.get('cordisInspect') 采样——宿主 runner 行激活晚于本插件行,服务尚未
    provide,shim 静默未安装,之后第二个 cordis 模式 preset(如内置 cordis + cordis-gitbash)
    挂载即撞 "already registered" 直到重启。修复:ctx.inject(['cordisInspect'], ...) 服务
    就绪那一刻安装,与行激活顺序无关;上游形状不符时仍防御式退化为裸挂。动到 shim 需重跑
    「cordis 先挂 + 选 cordis-gitbash 成功」方向验证。
 4b. **统一 POSIX 路径方言 + MSYS 根翻译层(v0.8.0)**:指令(order 126)升级为
    「所有工具一律 MSYS 盘根 /c/ 形式」(含改写规则:反斜杠/盘符事实与工具输出
    的 Windows 路径一律转写回 /c/);host 侧全局 tools/execute wrapper 把路径参数
    字段(file_path/path/workdir,按字段名白名单——动态工具同名字段自动覆盖)
    的 /x/ 前缀改写为 X:/(Node 文件工具把 /c/ 解析到当前盘符下的错误路径;bash
    的 command 字段不动——那是 Git Bash 母语)。覆盖模型直调、PTC run_code 子
    分发(sub-calls go through its execute)、动态 Cordis 工具。契约注记:
    tools/execute 官方契约写「只能改 signal」,实现层 mutableExec 同对象透传
    给工具体;wrapper 防御式写入(冻结即吞异常降级),上游收紧时自动退化为
    纯指令模式。指令文本改动需同步复核 smoke 的翻译断言。
    **设置化(v0.9.0)**:方言默认关闭,由 settings 命名空间 gitbash-shell 的
    posixPaths(布尔,默认 false)门控——设置卡与默认关闭:client 半(手写
    ModuleLoader bundle,src/client.js)注册 settings.plugin.item 卡片(key=
    gitbash-shell,宿主不注册命名空间卡片永不出现),经 settingsScope.bind 写入;
    host 侧指令 text 闭包读设置(关→空文本,组装期丢弃,零提示噪声),wrapper
    每次分发读同一值(关→原样放行)。设置 schema 必须 schemastery(动态 import,
    冒烟零依赖);readPosixPaths 走 ctx.get('settings')(SERVICE READ RULE)。
    **源头替换(v0.10.0,默认开启)**:开关语义升级为「模型看到的官方提示词的路径方言版本」——
    开启时 system-prompt/assemble waterfall 把 assembly 的 sections[].text、
    contexts[].text(跳过自身指令防套娃)与 variables 值里的 Windows 绝对路径
    **原位替换**为 /c/ 盘根(windowsToMsys 纯函数:引号内含空格路径整体翻译、
    裸路径到空白/闭标点截止,lookbehind 排除 URL scheme 与 file://);不删减任何
    官方内容、不动工具 schema(官方工具描述无盘符示例,盲改有 pattern/default
    误伤风险)。指令缩为一句纯事实(源头已统一,无校准规则)。默认 posixPaths=true。
    **ModuleLoader 契约(v0.10.1 事故修复)**:client 半的 factory(require) **必须
    return module.exports**——漏掉 return 时模块物化为 undefined,浏览器插件行报 invalid plugin
    received undefined(0.9.0 埋雷、0.10.0 首启才炸;agent-lang client.js L587 同款 return,smoke 已加防回归断言)。
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
   `2026-08-25-rename-code-mode-to-ptc` 的 Deferred 一节)。落地时复查双 era 划分(2026-08-29 复核:
   dsh 0.1.2-alpha.1 仍为 SESSION_FORMAT_VERSION=0,迁移未落地);dsh-better-sidebar
   的命名空间(`terminalShell`/`shell`)演化同样需在其升级后复核。

## 验证清单(改动后)

1. `npm test` 全绿;
2. 真机验证:重启 DSH → 物化日志(含 era 字样)→ 模式选择器出现 `* · Git Bash` → 新会话 bash 工具存在、
   `command -v bash` 指向 Git 安装目录;
3. 组合文本改动后:用 cordis 会话跑 `agentPresets.standingKeyFor('<variant>')` 挂载校验;
4. era 相关改动另需双向验证,两个方向均已真机通过:`code` era(<= 0.1.1,2026-08 前)与 `ptc` era
   (2026-08-29,dsh 0.1.2-alpha.1 真机:三个物化变体 marker 全为 `base:"ptc"`、`standingKeyFor` 挂载
   全 OK、roster 无重复/无 broken/无 orphan;此前本机为 <= 0.1.1)。
   仍待覆盖:「旧 marker(无 base)首启刷新一次」路径(可手造无 `base` 的 marker 再启动验证)。

## 发布 checklist(GitHub + npm)

1. `npm test` 全绿;
2. `npm version minor|patch`(能力变化 minor,修复 patch);
3. `git push --tags`;
4. `gh release create <tag>`(notes 带安装命令与变更摘要)——published 事件自动触发 npm publish;
5. **触发 npmmirror 同步**(机器默认 registry 是 npmmirror,不触发要等它自行同步,
   期间 `dshmarket`/pnpm 对新版本号解析会报 ERR_PNPM_NO_MATCHING_VERSION):
   `curl -X PUT https://registry.npmmirror.com/dsh-gitbash-shell/sync`;
6. 用户侧更新 = `dsh plugin --profile <name> add dsh-gitbash-shell`(npm 包名);host 半变更需重启 DSH。