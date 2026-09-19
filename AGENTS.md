# AGENTS.md

面向后续在本仓库继续开发的 Agent / 贡献者。读完再动手。

## 环境与工具

- 本机已安装 GitHub CLI(gh)与 npm 且均已认证;建仓、推送、tag、release **优先用 gh**;
- 分发**双通道**:GitHub(tag + Release,源码与发布说明)+ npm(公开包 `dsh-gitbash-shell`,用户安装入口);
  GitHub Release 的 published 事件自动触发 npm publish —— **Trusted Publishing (OIDC)**,
  workflow 用 `id-token: write` + 无令牌 `npm publish`(见 .github/workflows/npm-publish.yml,
  npm 包设置里须登记同名 workflow 为 trusted publisher)。

## 变更记录纪律(2026-09-13 起)

- **所有版本发布、修复、事故复盘、复现/验证记录一律写进本仓库 `CHANGELOG.md`**,不再追加进本文件;
  本文件只保留仍然有效的规则、不变量与当前事实,历史叙事由 CHANGELOG 承载(需引用时写
  「见 CHANGELOG vX.Y.Z」)。
- **发版 checklist 新增强制步骤**:更新 CHANGELOG(写好新版本条目)→ 随版本提交 → 再打 tag /
  发 Release;顺序不能反。
- CHANGELOG 条目格式:倒序排列;`## vX.Y.Z — YYYY-MM-DD` + 类型(feat / fix / docs / chore)+
  要点 bullet + 相关链接(issue / PR / discussion / Release)。

## 项目一句话

`dsh-gitbash-shell`:Windows 上把 dsh 的 `ctx.shell` 换成 Git for Windows bash 的插件。
1) host 执行器(`src/shell.js`,继承官方 `@deepseek-ai/dsh-bash-sandbox`);
2) preset 物化(`src/index.js`,把 standard/minimal/code/cordis 的 Git Bash 变体写进
用户 preset 根,哈希标记管理、卸载清理);
3) 发布 `gitBash` 宿主能力服务供 dsh-ptc-cordis-preset 联动。

## 核心不变量(改代码前必读)

1. **执行器只替换 argv,不替换行为——除 Windows 受限分支(v0.13.2,issue #1)**:沙箱策略、拒绝分类、
   后台任务、设置节全部沿用 `@deepseek-ai/dsh-bash-sandbox`;full-access 分支必须单独接 Git Bash
   (父类硬编码裸 `bash`,Windows 上会解析到 WSL 占位)。**Windows confined 分支同样必须单独接**:
   MSYS2 在 restricted-token(dsh-sandbox-windows-acl)下 DLL 初始化即死(msys-2.0.dll 的 cygheap
   映射与 signal pipe 的 DACL 只含用户 SID,WRITE_RESTRICTED 的 pass-2 写检查要求 restricting-SID
   ACE → Win32 error 5 / 0xC0000142;0.6.0 起所有版本;cmd/pwsh 走匿名管道不受影响)——OS 层冲突
   无插件内解,故 win32 的 read-only/workspace-write 调用改走 runArgv/startArgv(不受限执行),结果
   sandbox 标注 `enforcement: 'unconfined'` + 实例级一次性 console.log 提示;fs 工具沙箱不受影响
   (另一层)。**红线:绝不静默假成功**——要么真受限、要么明示 unconfined、失败如实带错误码。
   社区同类取舍:绕过(zimzaza4/dsh-bash-win、Jyleaves/dsh-win-bash-fix)vs 拒绝(liceses/
   dsh-gitbash-preset);本插件选绕过+如实标注。本机复现记录见 CHANGELOG v0.13.2。
2. **preset 组合文本可审查**:assets/*/agent.cordis.yml 是完整组合,物化只做逐字节拷贝,
   绝不经过 YAML parse→dump 往返(会丢 `!!js` 表达式)。**两个纯字符串手术例外,都不解析 YAML**:
   ① v0.13.0 的 present 行条件注入(`injectPresentRow`,按锚点拼接);② v0.14.0 的**行形态对齐**
   (`alignEngineRow` / `alignRalphRow`,把引擎行与 `tool-ralph` 重写成宿主内置 preset 的拼法 +
   disabled 状态,见第 9 条)。两者都必须幂等、探测失败即 no-op,`!!js` 字面量照旧安全。
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
    **翻译层冻结修复(v0.10.2)**:registry 在构造 exec 时即 deepFreeze(arguments)——
    原地写入严格模式下抛 TypeError 被防御吞掉、静默不翻译(0.10.0/0.10.1 真机 read /c/ 报 C:/c/...);
    改为纯函数返回新对象 + wrapper 替换 exec.arguments 属性(exec 本体到 tools/result 才
    freeze,signal 替换是 registry 自有先例)。smoke 加冻结输入用例锁定。
    **两段式槽注册(v0.10.3)**:settings.plugin.item 的正确形状是
    slots.inject(洞名, 回调),回调体内 return slots.register(options, card)——直接把
    (options, component) 作为 slots.inject 的第二三参会静默不注册、卡片永不出现
    (agent-lang/better-workspace 均两段式;smoke 已加形状断言)。
    **输出侧回流修复(v0.10.4)**:成功结果的路径元数据(read/write/edit 的 path、
    glob paths[]、grep matches[].path——后者为相对路径,仅分隔符归一)经 tools/post-execute
    waterfall(官方允许 replace value projection)改写回 MSYS 方言;文件内容行与错误结果
    绝不动。模型不再从成功调用中收到 Windows 形式路径回声。
    **官方 shell-env 事实(v0.11.0)**:方言声明进驻官方 `dsh-shell-env` 注册表(宿主层
    服务,web 组合注入、实测下发 DSH_WEB_URL/DSH_HOME/DSH_SESSION_ID/DSH_SHELL=1,bash 工具
    schema 官方措辞本就指向 $DSH_*「inspect them when needed」)——ctx.inject(['shellEnv'])
    服务就绪即注册贡献者 `gitbash-shell`,键 `DSH_PATH_DIALECT`(值 `msys`);resolver 每次
    执行读活设置(关→返回空对象,免重注册),unregister 经 envCtx.effect 挂插件 fiber 可逆;
    组合里没有该服务时静默无操作。DSH_HOME/DSH_SHELL/DSH_SESSION_ID 为注册表保留键,不可也
    不应覆盖。提示词源头替换(说一次)+ 运行时环境事实(按需核验)互为印证。
    **虚拟挂载表翻译(v0.17.0)**:入参翻译升级为「盘根 + Git Bash mount 表」两级——`/tmp`→用户 TEMP、`/dev/null`→`\\.\NUL`、`/usr` 系→Git 安装根(buildTranslateEnv 进程内一次探测,默认安装 + PATH 候选 bash.exe,以 `<root>/usr/bin` 存在性排除 WSL shim)、`~`→`$HOME`、裸盘根 `/c`→`C:/`;全部段边界 + 大小写敏感(忠实 msys 挂载表,`/Tmp` 不匹配),探测失败即 no-op。**铁律**:`/dev/null` 只能映射 `\\.\NUL` 设备路径——裸 `NUL` 字符串经 libuv 相对路径会在 cwd 创建真实文件(非即焚);glob 绝对 pattern 按「首个通配符前目录前缀」拆成 `{path, pattern}`(仅 glob 工具、绝对 pattern 覆盖已有 path);present 的嵌套 `files[].path` 入参 + 出参回流均覆盖;出参 TEMP 前缀回显为 `/tmp`。完整设计与实测矩阵见 CHANGELOG v0.17.0。
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
   字面量(`mode: ptc` / `mode: code`),smoke 测试有断言把关。**ptc era 组成随 alpha 演进继续漂移
   (v0.10.5,2026-09-02 同步 dsh 0.1.2-alpha.4)**:内置 `ptc` preset 给 `tool-workflow` 行加
   `disabled: true`(#3425:`run_code` 为唯一模型编排面,引擎保留给 `ralph`),内置 standard/cordis
   删 subagent-report 注释块、更新 fork 注释;`code-gitbash` 的 ptc-era(含头部文案与 preset.yml
   描述)与 `standard-gitbash`/`cordis-gitbash` 的 ptc-era 已同步;smoke 增加「code-gitbash ptc-era
   必须 disabled、其 code-era 及 standard/cordis 两 era 必须启用」断言。code-era 文本(↔0.1.1)不动。**persona 拆分第三维(v0.12.0,2026-09-04 同步 dsh 0.1.3-alpha.2)**:
    dsh 0.1.3-alpha.2(40792330c0)把 dsh-persona 的单一 `text` 键拆成 `prefix:`+`suffix:`
    (schema `prefix: required`,**无兼容别名**),shipped 四预设全部跟进——旧键组合在新宿主上
    persona 行校验失败。维度:`detectPersonaEra` 读 roster 内置条目(仅 ptc/standard/cordis/
    minimal,**绝不探测自家变体**——会回声旧形态)的 agent.cordis.yml,`personaEraForText` 判
    split/text;marker 记 `persona`(旧 marker 无此字段视为 text);`pickComposition(base, persona,
    available)` 候选链 `.ptc.ps.yml` → `.ptc.yml` → `.ps.yml`(minimal 专属)→ 基文件。资产:
    standard/code/cordis 各加 `agent.cordis.ptc.ps.yml`,minimal 加 `agent.cordis.ps.yml`(首次
    分叉);code-era(≤0.1.1)与 0.1.2~alpha.1 ptc-era 文件原样保留。**升级顺序无关**:新插件装在
    alpha.1 宿主上探测得 text、物化旧式(与 0.11.x 行为一致);宿主升 alpha.2+ 后首启探测翻转
    → 同版本自动刷新。smoke:ps 键形/旧文件保形/pickComposition 矩阵/syncDecision persona 翻转/
    探测忽略自家变体,共 20 项。**present 能力维度(v0.13.0,2026-09-10 同步 dsh 0.1.5-alpha.2→rc.1)**:
    官方给 ptc/standard/cordis 三模式组合追加 `- id: present / name: '@deepseek-ai/dsh-tool-present'`
    (不可变文件交付下载卡片;minimal 不加——单工具预设)。该包 **0.1.5-alpha.2 首发**,而组合里
    一行 import 失败会拒绝**整棵 preset 挂载**(agent-presets mount.ts),所以 present 行**绝不写进
    资产**,改由物化时探测宿主(`hostHasToolPresent`:createRequire.resolve,按 boot 缓存)注入:
    仅 `.ptc.` 文件、有 tool-presentation 块者锚点后相邻插入、无锚者( cordis/standard 孪生)尾部
    追加(与官方位置一致)、幂等。marker 记 `present`(旧 marker 无字段视为 false),宿主升级使探测
    翻转 → syncDecision 自动重物化补行。minimal 资产同步官方单工具化(v0.13.0):删 filesystem
    组(fs-local + str_replace_editor)、bash 描述的固定网络两行换为环境相关单行、banner 与 preset.yml
    描述改单工具——这些是纯内容变化,全 era 安全直接改。smoke:注入锚/尾追加/幂等/syncDecision 翻转/
    materialize 端到端(含 minimal 不注入)/资产不得写死 present,共 25 项。
8. **未来破坏点跟踪**:官方宣布会话持久词汇(`tool/code-dispatch*`、日志插件名 `tools-code-mode`、
   `:code:` 子调用段)将在 SESSION_FORMAT_VERSION v0→v1 迁移时改名(dsh 仓库 notes
   `2026-08-25-rename-code-mode-to-ptc` 的 Deferred 一节)。落地时复查双 era 划分(2026-08-29 复核:
   dsh 0.1.2-alpha.1 仍为 SESSION_FORMAT_VERSION=0,迁移未落地;2026-09-02 复核:dsh 0.1.2-alpha.4
   仍为 0,Session 重构只到 branded types,消费面无变化);dsh-better-sidebar
   的命名空间(`terminalShell`/`shell`)演化同样需在其升级后复核。

9. **适配新版 dsh 的核对纪律(2026-09-15 立,dsh 0.1.6-alpha.1 教训)**:物化类插件升级 dsh 时,
   **绝不只看本站 `assets/` 的自身 diff**——真正的漂移只存在于「本站资产 × 宿主内置 preset」之间。
   每次跟随升级必须完整做一遍:
   ① **结构化行序列对比**:取宿主 `packages/preset/agent-presets/presets/{standard,cordis,ptc,minimal}/
      agent.cordis.yml`,抽出 `- id:` / `name:` / `disabled:` 三行序列,与本插件对应变体逐条对齐;
      **提示词**(persona 的 `prefix:`/`suffix:` 文本)与**工具行**同样要 diff,不要只看 id 名字。
   ② **行改名是致命项**:dsh 0.1.6-alpha.1 把引擎行 `workflow-worker-thread` 改名 `workflow-ptc`
      并**删除**了旧包(`packages/workflow/workflow-worker-thread` 整包消失)。组合里一行 import
      失败会拒绝**整棵 preset 挂载**(agent-presets `mount.ts`),物化出的 preset 会直接不可用——
      不是「少个工具」那么轻。
   ③ **默认值变化同样要跟**:同一版把 `tool-ralph` 改成默认 `disabled: true`(内置预设全改);
      不跟就是「物化出来的 preset 替部署偷偷打开了一个已被关掉的工具」。
   ④ **对齐优先用运行时改写,而不是再加 era 资产**:能从宿主内置 preset 现场抄的行一律抄
      (`rowFormsOf` / `alignEngineRow` / `alignRalphRow` + `detectRowForms`,v0.14.0)。只有整段
      文本结构变化时才新增变体文件。改写必须是**纯字符串手术**(绝不 YAML parse→dump,`!!js` 必须
      活下来)、**幂等**、**探测失败即 no-op**(旧宿主保持逐字节原样)。
   ⑤ marker 用 `rows` 指纹记录对齐结果,宿主形态翻转时 `syncDecision` 自动重物化(与 `base` /
      `persona` / `present` 同一套维度模式)。
   ⑥ **工具面/翻译层覆盖核对(2026-09-19 立,v0.17.0 教训)**:翻译层按「顶层字段名白名单
      (`file_path`/`path`/`workdir`)+ present 嵌套形状」工作,dsh 新版本**新增或改动工具的
      路径参数**是独立于 preset 的另一个漂移源(0.1.5 新增 present 的 `files[].path` 嵌套,直到
      v0.17.0 才覆盖)。每次跟随升级必须盘点**所有带路径参数的工具**:对照宿主工具 schema
      (harness 源码 packages/ 或 `cordis_inspect_list`)检查新字段名、嵌套路径形状、出参路径
      元数据字段;有遗漏则补 `TRANSLATABLE_PATH_FIELDS` / 嵌套形状 / `rewriteResultPaths`,
      并在真机跑一遍「虚拟路径 × 工具」矩阵(~、/tmp、/dev/null、/usr、裸盘根、绝对 glob
      pattern、present 嵌套、bash workdir)。

## 验证清单(改动后)

1. `npm test` 全绿;
2. 真机验证:重启 DSH → 物化日志(含 era 字样)→ 模式选择器出现 `* · Git Bash` → 新会话 bash 工具存在、
   `command -v bash` 指向 Git 安装目录;
3. 组合文本改动后:用 cordis 会话跑 `agentPresets.standingKeyFor('<variant>')` 挂载校验;
4. era 相关改动另需双向验证,两个方向(`code` era ≤ 0.1.1 / `ptc` era)均已真机通过,记录见
   CHANGELOG v0.6.0;仍待覆盖:「旧 marker(无 base)首启刷新一次」路径(可手造无 `base` 的
   marker 再启动验证)。
5. **升级 dsh 后**(v0.14.0 起强制):按第 9 条把四个内置 preset 各核对一遍——行序列 + 提示词 +
   disabled 默认值;smoke 的 `assets keep the pre-rename engine spelling` 与 `materialize aligns
   the engine row to the host` 两项锁住对齐行为;真机确认物化日志出现四个变体且模式选择器里都能挂载。

## 发布 checklist(GitHub + npm)

1. `npm test` 全绿;
2. **更新 `CHANGELOG.md`**(新版本条目,随版本提交——见「变更记录纪律」);
3. `npm version minor|patch`(能力变化 minor,修复 patch);
4. `git push --tags`;
5. `gh release create <tag>`(notes 带安装命令与变更摘要)——published 事件自动触发 npm publish;
6. **触发 npmmirror 同步**(机器默认 registry 是 npmmirror,不触发要等它自行同步,
   期间 `dshmarket`/pnpm 对新版本号解析会报 ERR_PNPM_NO_MATCHING_VERSION):
   `curl -X PUT https://registry.npmmirror.com/dsh-gitbash-shell/sync`;
7. 用户侧更新 = `dsh plugin --profile <name> add dsh-gitbash-shell`(npm 包名);host 半变更需重启 DSH。
