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
0. **双时代总纲(v0.24.0 起,dsh 0.1.7 分界)**:dsh 0.1.7 **删除了目录预设机制**,预设改为声明式——本插件在 register() 可用的宿主上直接 `ctx.agentPresets.register(definition)` 注册四个变体(行数据 = `src/compositions.js`,镜像官方 0.1.7 standard/minimal/ptc/cordis + Git Bash 增量);旧宿主(≤0.1.6)仍走完整物化路径(本文件其余条目继续生效)。时代探测 = `typeof ctx.agentPresets.register === 'function'`。声明式路径要点:变体行集由 `pluginsFor({ kind, gitBash, skillsDir })` / `minimalPluginsFor()` 生成;cordis 变体的 skills 直接指向 `@deepseek-ai/dsh-agent-preset` 包旁目录(现场解析,不再拷贝);启动时清理旧物化目录树(仅 marker 判定 unmodified 的);预设清单沿用行配置 `presets`(Config 的普通字段,改动触发重挂载)。**设置面同 dsh-agent-lang v0.7.0 双时代**:host 半**顶层 await 惰性 import** schemastery 并导出 `Config`(8 个开关全 volatile 探测;拿不到 schemastery 时 `Config = undefined`,插件照常挂载),apply 内 `makeLiveReader(ctx, config)` 供所有翻译层消费点(shellEnv 解析器、prompt 组装、tools/execute、post-execute、posix 指示闭包、adoptSidebar)逐次读取;client 半可选注入 settingsScope/configForms;**挂载行 id `gitbash-presets` → `gitbash-shell`**(与设置命名空间同串)。**绝不用顶层静态 peer import(v0.24.3 加固)**:`@deepseek-ai/schemastery` 是 peer,普通 Node 从本包位置解析不到它;顶层静态 import 一旦失败,dsh Loader 把插件行的导入失败当**非致命跳过**(`vendor/loader/src/config/entry.ts` `_init()`:logger.error + return,永不建 fiber)⇒ 本插件连 preset 变体、执行器接线与 client 半全部消失,而宿主日志全绿(与 dsh-better-workspace issue #9 同一失败类;已用"除静态 peer import 外完全相同"的夹具插件实证)。冒烟有"不得出现静态导入行"断言。另:peerDependencies 必须声明 `"@deepseek-ai/dsh": ">=0.1.0"` 且标 `peerDependenciesMeta.optional`(rc.1 的兼容门禁只读这类 peer;不设上界;optional 避免 autoInstallPeers 场景下对只有 prerelease 的 `@deepseek-ai/dsh` 解析失败)。

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
   **0.1.7 执行器契约(v0.24.4 补齐,issue #6 复盘)**:① `Config` 的六个继承字段
   (`cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/`graceMs`)**必须经
   `live()` 探测加 `.volatile()`** —— 0.1.7-alpha.1 起基类把它们读成 `Volatile<T>` 并一律 `.get()`,
   裸值会让**每一次 shell 调用**抛 `config.timeoutMs.get is not a function`(整个 `ctx.shell` 失效);
   插件自己的 `bashPath` 保持裸值。② 方法面改了:`run`/`start` 被删除,抽象面是
   `resolve` + `execute(spec): Promise<ShellExecution>`,后台执行 = `onExpiry: 'none'` 的一次
   execution,前台/后台由调用方是否 await `result()` 决定 —— 所以**必须覆盖 `execute`** 才能让
   "全权访问走 Git Bash argv""win32 受限改走 unconfined"两条继续成立(`run`/`start` 只留给
   ≤0.1.6,`execute` 在无 `super.execute` 时委派给 `run`);父类的 `decorateResult` 是私有的,
   就地记忆化投影由本插件的 `decorateExecution` 复刻。③ `settings` 服务在 0.1.7 上**没有
   `get(ns)` 了**(只剩 `describe()`/`update()`):任何"读插件设置"的代码都要按 era 分流,
   否则静默降级 —— 本插件踩过两处(`withParityEnv` 的 Linux 行尾 env、better-sidebar 的
   `terminalShell` 接管),现都用 `describe()` 里本行(行 id `gitbash-shell`)的表单值。
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
    **输出侧回流(v0.10.4 起;v0.23.0 换挂点)**:成功结果的路径元数据(read/read_image/write/edit 的
    path、glob paths[]、grep matches[].path、present files[].path)改写回 MSYS 方言;文件内容行与
    错误结果绝不动。**挂点从 v0.23.0 起是 `tools/execute` 的返回包装(自作结果),不再是 post-execute
    的 `value` 决策**——原因见 §4d 的铁律;整值路径统一走 `driveToMsys`/`pathEcho`(带空格目录不再
    混合方言,散文面另有正则规则)。
    **官方 shell-env 事实(v0.11.0)**:方言声明进驻官方 `dsh-shell-env` 注册表(宿主层
    服务,web 组合注入、实测下发 DSH_WEB_URL/DSH_HOME/DSH_SESSION_ID/DSH_SHELL=1,bash 工具
    schema 官方措辞本就指向 $DSH_*「inspect them when needed」)——ctx.inject(['shellEnv'])
    服务就绪即注册贡献者 `gitbash-shell`,键 `DSH_PATH_DIALECT`(值 `msys`);resolver 每次
    执行读活设置(关→返回空对象,免重注册),unregister 经 envCtx.effect 挂插件 fiber 可逆;
    组合里没有该服务时静默无操作。DSH_HOME/DSH_SHELL/DSH_SESSION_ID 为注册表保留键,不可也
    不应覆盖。提示词源头替换(说一次)+ 运行时环境事实(按需核验)互为印证。
    **虚拟挂载表翻译(v0.17.0)**:入参翻译升级为「盘根 + Git Bash mount 表」两级——`/tmp`→用户 TEMP、`/dev/null`→`\\.\NUL`、`/usr` 系→Git 安装根(buildTranslateEnv 进程内一次探测,默认安装 + PATH 候选 bash.exe,以 `<root>/usr/bin` 存在性排除 WSL shim)、`~`→`$HOME`、裸盘根 `/c`→`C:/`;全部段边界 + 大小写敏感(忠实 msys 挂载表,`/Tmp` 不匹配),探测失败即 no-op。**铁律**:`/dev/null` 只能映射 `\\.\NUL` 设备路径——裸 `NUL` 字符串经 libuv 相对路径会在 cwd 创建真实文件(非即焚);harness 文件工具的 realpath 步骤不支持设备路径——文件工具直接 read/write `/dev/null` 报 EINVAL(如实、无副作用),设备语义经 bash 使用;glob 绝对 pattern 按「首个通配符前目录前缀」拆成 `{path, pattern}`(仅 glob 工具、绝对 pattern 覆盖已有 path);present 的嵌套 `files[].path` 入参 + 出参回流均覆盖;出参 TEMP 前缀回显为 `/tmp`。完整设计与实测矩阵见 CHANGELOG v0.17.0。
 4c. **run_code 程序内的路径字面量(`rewriteCodePaths`,v0.20.0 起已翻译;2026-09-19 立)**:翻译层的第三张
    面孔。前两张是「工具入参 / 出参」,而 run_code 交给原生 Node 执行的**程序源码里的路径字符串是程序
    数据**,由 Node 自己解析——`/c/Users/...` 会落到 `<当前盘符>:\c\Users\...`(实测真写出过
    `C:\c\Users\kanna\sandbox\...`)。现在 run_code 的 `code` 在 tools/execute 里过一遍
    `rewriteCodePaths`:逐字节扫描源码(注释 / 单双引号 / 模板字面量 / 正则 / 插值 / 转义),把**整体
    就是一条绝对 MSYS 路径**的字面量按**同一张挂载表**翻译(盘根、`/tmp`、`/dev/null`→NUL 设备并
    转义、`/usr` 等 Git 根、`~/...`)。**铁律**:
    ① **任何不确定 = 整份 no-op**(未闭合字面量、走不到头的模板/正则、翻译结果里出现该字面量的引号、
       反引号语境下出现插值起点),绝不半改——半改的程序比不改更糟;
    ② **只翻「整体是路径」的字面量**:注释里的路径、带 scheme 的串、`$VAR`(JS 字面量是数据,不做
       shell 展开)、已是 Windows 形式、相对路径一律不动;
    ③ **开关独立**:设置卡 `codePaths`(默认开,21 语言词典同齐),关掉只影响程序字面量,不动工具参数
       方言;`posixPaths` 仍是总开关。
    仍**不在覆盖内**:动态拼出来的路径(`'/c/' + name`)与插值模板——只有「整条路径是一个字面量」才
    可判定,其余靠指令表述说清(模型侧纪律:程序里的路径写成实路径)。同源官方事实:run_code 的
    `process.env` 为空是**设计**(「empty model environment」,runtime.spec 断言 `env === []`),
    `os.tmpdir()` 在 Windows 上得到 `undefined\temp`。
    改动这一层必须跑 `tests/smoke.mjs` 的「run_code program literals」矩阵(翻译 / 不动 / 整体 no-op
    三类,含 `/dev/null` 经 `eval` 求值、正则引号与除法不串味)。
 4d. **失败有「两个面」,必须同方言;以及行尾值为什么是 `input`(v0.22.0)**。
     「翻译层」的第四张面孔是**失败文本**:一次失败同时产出 `content`(模型在失败调用上读到的文本、UI
     卡片)与 `error.message`(PTC 桥交给程序的那条 `ToolCallError` 消息)。只翻 content 时,程序里
     `catch (e) { console.log(e.message) }` 会打出 `C:\Users\...`,而同一失败在未捕获面是 `/c/...`
     ——同一错误两种方言。修法:`tools/post-execute` 对同一 result 的 `error.message` **原地改写**
     (注册表在 `normalizeDispatchResult` 按**引用**透传 error,直到 `materializeFinalResult` 才快照,
     故这次写入同时到达 PTC 桥与最终记录)。**铁律**:① 绝不用官方 `block` 决策去改 message——它会重建
     `{ message }` 并**丢掉 `error.info`**(`FS_NOT_FOUND` 等结构化身份,记录/UI 在用),冒烟断言锁死正文
     不得出现 `kind: 'block'`;② 改写函数对冻结/缺字段/非字符串一律 no-op(内容面仍独立生效),
     半改不算改;③ `/tmp` 回显必须覆盖**句子中间内嵌**的路径(`msysEcho` + `mountTempRoot`),
     成功面(`rewriteResultPaths`)与失败面共用同一个 helper,三面同源。
     **行尾值**:执行器注入的是 `core.autocrlf=input` + `core.eol=lf`(**不是 `false`**)。实测:在已经是
     CRLF 工作区的仓库里(Windows 默认 autocrlf=true 检出的仓库),`false` 会让 `git diff` 把工作区 CRLF 与
     索引 LF 逐行比对 → 整文件飘红、`git add` 连行尾差异一起暂存(同仓库实测 4387/4233 行,而 `input`/`true`
     只有真实改动的 198/44 行);input 提交侧归一 CRLF→LF、检出侧永不写 CRLF。**精确措辞(重启后实测)**:
     它让 git diff 在 CRLF 工作区里**没有幻影改动**、真实改动只算自己(scratch 仓库:纯 CRLF 差异 →
     diff --shortstat 为空;再加一行 → 1 file changed, 1 insertion(+)),但被 touch 过的文件**仍会被
     git status --porcelain 列为 modified**(stat 层报告,Linux 遇到 CRLF 工作区同样如此);代价是
     git diff 对将被归一化的文件打一行 stderr 提示(如实告知即可)。
     改这一层必须跑冒烟里的「one dialect on BOTH faces」与「post-execute branch」两例。
     **成功面为什么不能挂 post-execute(v0.23.0,issue #2 的结论)**:注册表禁止同一条决策同时带
     `content` 与 `value`(`postExecute` 抛 `cannot replace both value and content`,且抛在整条瀑布
     收束之后、任何监听者 try/catch 之外 → 调用直接 isError)。所以:①**成功面一律在 `tools/execute`
     里自作结果**(`{ ...result, value }`;宿主 `normalizeDispatchResult` 会用新 value 重渲染 content),
     **任何决策上都不得再出现 `value` 键**;②失败面留在 post-execute,且**只产 `content`**(`value` 对
     失败结果本就非法),两边都不可能撞车;③结果未变时必须返回**原对象**,否则白白触发一次重渲染。
     ④整值路径走 `pathEcho`(盘符前缀 + 分隔符归一 + `/tmp` 挂载),**绝不把整值丢给散文改写器**
     `windowsToMsys`——它遇空格即断(issue #3:带空格目录回流成 `/c/my dir\f.txt`);散文面则只允许
     「空格后那个词自带分隔符」时跨空格,免得把英文吞进路径。
     改这一层必须跑冒烟里的「one dialect on BOTH faces」「post-execute branch」「whole-value path」
     「success echo rides tools/execute」四例。
 4e. **与 dsh-ptc-cordis-preset 的去重(v0.25.0,issue #7)**:联动生效后对方的 `PTC 创造模式` 已是
     Git Bash 版,与本插件的 `创造模式 · Git Bash`(`cordis-gitbash`,`PEER_COVERED_PRESET_ID`)指向
     同一件事;开关 `suppressPeerCordis`(本插件行 Config 的 volatile 布尔,默认 **false**;旧宿主
     ≤0.1.6 在 settings 命名空间 `gitbash-shell` 里声明同名同默认字段)只决定要不要摘掉本插件那一条。
     - ① **判定必须「开关 ON 且对方能力报 gitBashActive」,缺一不可**:纯函数
       `effectivePresetIds(configured, { suppress, peerGitBash })` 是唯一判据,注册(新宿主)与物化
       (旧宿主)两条路径共用它。对方缺失/未装/未生效/尚未挂载/版本 < 0.14.0 ⇒ **一律不摘**——
       **绝不能因为「探测不到对方」就少注册一个变体**(宁可多一条名录,不可少一个模式);默认 false
       保持 0.24.x 的四变体名录不变。信号只认对方 `ctx.provide('ptcCordisPreset', { id, gitBashActive })`
       的主动上报,**不要**去 `agentPresets.list()` 按 name/description 猜(文本会随对方版本漂移、还可能
       被用户改)。
     - ② **两个时代的取舍**:新宿主(≥0.1.7)**实时**——`ctx.inject(['ptcCordisPreset'])`(与行激活顺序
       无关,同 4a 的教训)+ `ctx.on('loader/volatile-update')` 监听本行开关,两者都触发**串行
       reconcile**(`runDeclarativeEra`):不再需要的 `unregister`(先删 `live` 表再 await)、重新需要的
       `register`,retire/register 各打一行日志;已挂载会话钉在组合快照上、不受影响。旧宿主(≤0.1.6)
       无注册表可观察、无 volatile 通道 ⇒ **启动时判定一次**:有界探测 `detectPeerCoverage(ctx)`
       (默认 1s 轮询,读不到即 false),结果同时喂给物化循环与 `purgeOrphans` ⇒ 打开开关会清掉上一轮
       物化的目录,关掉要**下次启动**才回来(README 已写明这一代价)。
     - ③ **权威状态只有一份**:就是本插件这一行 Config(旧宿主是 `gitbash-shell` 命名空间);对方的设置卡
       经 `ctx.configForms.get('gitbash-shell')` 绑定**同一行**写**同一字段**(官方支持编辑另一插件拥有的
       命名空间)。**不要再引入第二份镜像字段或双向同步逻辑**;旧宿主上 `configForms` 不存在,镜像卡片
       不出现,开关只在本插件设置面可改。
     - ④ **服务契约**:能力名 `ptcCordisPreset`、形状 `{ id, gitBashActive }` 由 dsh-ptc-cordis-preset
       **≥0.14.0** 提供(本插件侧的去重开关自 ≥0.25.0);**该形状变更要同步对方仓库**。改这一层必须跑
       冒烟里的去重判定矩阵、能力探测、旧时代读取与两个时代的接线断言四例。
4f. **run_code 的实验性 Python 后端开关(v0.26.0)**:dsh 的实验性 CPython PTC 后端
     (`@deepseek-ai/dsh-experimental-ptc-runtime-python`)替换的是 **profile 级** `ptc-runtime` 行,
     不是 preset 内的行,所以**开关与运行行都归 dsh-ptc-cordis-preset**:权威状态是它那一行
     (`ptc-cordis`)Config 的布尔 `pythonRuntime`(默认 false),它的 bundle patch 在 boot 时按
     快照条件 disable base 行 + insert 自己的 runtime 行。**本仓库只做两件事**:
     - ① **镜像设置卡**(`src/client.js`):`ctx.configForms.get('ptc-cordis')` 读写 **同一个字段** +
       `subscribe`,默认关;`hasOwnProperty('pythonRuntime')` 为假(对方 < 0.15.0)⇒ 整段不画;
       对方未装 ⇒ 不画。**绝不引入第二份镜像字段**。win32 上后端构造即抛错(仅 POSIX),卡片因此
       显示禁用态 + `python.blocked`(POSIX-only),按钮不出现;宿主侧同样拒绝写入。文案 21 语言,
       必须写明「重启 dsh 后生效」与「原因见宿主启动日志」——后者是因为 `pythonRuntimeIssue`
       这类"宿主探测原因"**没有**客户端可读通道,契约里明确不提供(加了就是第二份会漂移的状态)。
     - ② **组合的工作流互斥**(`src/compositions.js` + `src/index.js`):`workflow-ptc` 构造器硬要求
       `ctx.ptcRuntime.language === 'typescript'`(`packages/workflow/workflow-ptc/src/index.ts:117`),
       而 preset 行在**独立 PresetTree** 里挂载、**base 行 disable 管不到它** ⇒ python 后端期间选
       standard/cordis 会让该行抛错,`agent-preset-registry/mount.ts` 的 `audit.failed` 直接拒绝
       **整棵 preset 挂载**。修法与官方 python 参考组合一致
       (`snapshots/session/ptc-python-turn/cordis.yml:25-36` 同款禁用两行):`pythonRuntime === true`
       时**四个变体**的 `workflow-ptc`/`tool-workflow` 一律 `disabled: true`(用户 workflow 设置值
       保留,关掉后端下次启动恢复);`kind === 'ptc'` 本来就关,不受影响。
     - **信号来源 = 对方能力服务**:`ctx.provide('ptcCordisPreset', { id, gitBashActive, pythonRuntime, pythonBackend? })`
       (dsh-ptc-cordis-preset ≥ 0.15.0;`pythonRuntime` 是**用户意图**,≥ 0.15.1 追加
       `pythonBackend: 'python' | 'node'` **生效态**;两者都支持 getter,读不到一律按保守值);
       家族纪律同 §4e①——**绝不猜**,也不去读 `agentPresets`/配置文件推断。值变化必须**重注册已经在
       live 表里的变体**(行内容变了,只增删名录不够),日志
       `peer reports the experimental CPython run_code backend: workflow rows go off in every variant`。
     - **互斥的判据是「生效态」,不是「意图」(v0.26.1,重要)**:`pythonBackendActive(capability)`
       = 意图为真 **且** 生效态为 `'python'`;`pluginsFor` 的形参因此叫 **`pythonActive`**(语义 =
       run_code 实际会用的后端)。理由:对方的 preflight 失败(包被移除 / 解释器 < 3.10 / win32)时
       `!!js` 兜底与组合仍跑 Node,若按意图关掉 `workflow-ptc`/`tool-workflow`,用户就是**白丢能力**。
       未生效时改打 `peer has the CPython switch on but the effective backend is node|unreported …:
       workflow rows stay on (reason in the host log)`。**旧 peer 回退**:`peerBackend()` 对缺字段/
       类型不符/getter 抛错返回 `undefined`(绝不把"没报"读成 `'node'`),此时**用意图顶替** ——
       对方 < 0.15.1 的行为与 v0.26.0 逐字节一致。卡片侧同理:从同一份 peer 快照读可选的
       `pythonBackend`,意图 on + 生效 `node` 显示 `python.degraded`(21 语言);字段缺省则**不显示**
       降级态。**注意生效态要进"客户端可读"的那一份**,卡片才能显示真实状态 —— 目前客户端只读得到
       settings 表单快照(能力服务是宿主侧的,浏览器读不到)。**Lead 裁决 A(2026-09-25)**:ptc 侧
       **不拒绝**把意图落成 true(不授权任何"回写用户 settings 表单值"的行为)⇒ **"意图 on + 生效
       node" 这个状态是可达的**;不可达的只是**本插件这行降级显示**(ptc v0.15.1 的 Config schema
       没有 `pythonBackend`)。现状:ptc 卡显示 on + 红字原因,本插件卡只显示 on(hint 指向宿主日志)。
       后续项 = 让对方用**加法只读字段**把 `pythonBackend`/`pythonIssue` 投影进行 Config 快照(不动
       用户意图字段);那一刻本插件**无需改动**即亮起(读的是同一个键)。**不要把"降级提示已生效"
       写进面向用户的文案或文档。**
     - 依赖边界:python 运行时包由对方 `optionalDependencies` 声明(**精确 `0.1.7-rc.2`**,不用
       `next`——npmmirror 会解析到 rc.1 被兼容闸拒);**本仓库不声明该依赖、不 insert 运行行**
       (两个插件各插一行会让 `ptcRuntime` 二次注册)。改这一层必须跑冒烟里的
       「python switch」四例 + 真机读数(见 CHANGELOG v0.26.0 的 A/B 装置)。
     - 另注意:python 后端**仅 POSIX**;本插件的路径方言/执行器面按 `process.platform === 'win32'`
       门控,因此在它唯一能跑的平台上这些层本来就不生效 —— 两侧无交互,但升级时仍要复核这条前提。

4g. **子代理/队员的方言开关(v0.27.0,`subagentDialect` 默认 ON)**:用户要求「专门给个设置是否让子代理/队员也使用 Git Bash」。
     - **语义**:默认 ON = 委托代理(子代理、团队队员、嵌套子代理)与主代理享受**同一条方言链路**;OFF = 方言只对主代理生效,委托请求回退官方 shell 语义。
     - **委托身份的判据(纯函数 `isDelegatedAgent`)**:会话头 `origin === 'subagent' || delegationDepth > 0` —— 与 dsh 自己的
       `packages/deliverables/workspace-changes/src/index.ts:59-60` 同一对字段,由子代理驱动在 `packages/subagent/subagent/src/child-agent.ts:139-155` 打上。
       **未知形状一律 false(不视为委托)**:保留方言是有利方向,`agent` 缺失的诊断组装必须照旧。
     - **唯一判定点 `dialectApplies(dialect, agent)`**,五个消费点共用它:① `system-prompt/assemble` 的源头改写与 run_code 句;
       ② 指令 context 的 `text(context)` provider;③ `tools/execute` 的入参翻译 + 成功面回显;④ `tools/post-execute` 的失败面 content/message;
       ⑤ `shellEnv.resolve(execution)` 的 `DSH_PATH_DIALECT` 事实。**任何新方言消费点都必须接同一个 gate**,否则会出现"半方言"。
     - **能力边界(必须如实写进文档)**:dsh **每进程只有一个 shell 执行器**(`ctx.shell` 是单例服务),所以 Git Bash **二进制本身仍是全局的**;
       这个开关管的是方言/翻译层。关闭后委托代理看到与写出的是 Windows 形式路径,而 Git Bash 同样接受 `C:/...`,行为自洽。
     - **两个时代的读取**:新宿主是本行 Config 的 volatile 布尔 `subagentDialect`(默认 true);旧宿主在 settings 命名空间 `gitbash-shell`
       声明同名字段,**缺键 = true**(`v.subagentDialect !== false`)⇒ 旧宿主/老配置行为不变。21 语言文案 `sub.label`/`sub.hint`。
     - 改动必须跑冒烟里的「subagent switch」三例 + 真机两态(见 CHANGELOG v0.27.0 的装置:真 root/child/nested agent + 真 assemble 调用)。

4h. **bashPath 解析链与两条硬边界(v0.28.0,issue #11)**:用户机器上 Git 装在 `Q:\Git` 而 patch 写死
     `C:/Program Files/Git/bin/bash.exe` ⇒ **每条命令 spawn ENOENT**;又因本插件撤掉 `pwsh-sandbox` 而 dsh
     每进程只允许一个 `ctx.shell`,**整个会话的命令能力归零且无提示**。本版把解析统一、并把"没有 Git Bash"
     变成可引导的显式失败。
     - **两条硬边界(用户明确表态,高于任何"为了不报错"的降级提议;动这层前先问用户)**:
       ① **永不回退**:找不到 Git Bash 就**只报错 + 引导**,绝不换 pwsh / cmd / WSL bash / MSYS2 bash 顶上,
          也不做"暂时留个能跑的"。理由(用户原话):"人家大可自己卸载插件,既然人家下载了我们插件就是要用。"
       ② **只认 Git for Windows 的 bash**:WSL(`C:\Windows\System32\bash.exe`、WindowsApps 别名)、
          MSYS2、Cygwin 的 bash **一律不算命中**,宁可报错("绝对不能用 wsl")。
     - **解析链(`src/bash-path.js`,唯一实现;执行器与翻译层共用同一 memo)**,顺序即契约:
       1. **设置里填的**:`gitbash-executor` 行 config(用 `ctx.loader.resolve('gitbash-executor')` 让翻译层也看到)
          > `gitbash-shell` 行/设置 `bashPath` > 空(=自动链)。**显式值即答案,失败也不换别的**。
       2. **默认安装位置**:`C:/Program Files/Git/bin/bash.exe`(主)、`%ProgramFiles(x86)%`、`%ProgramW6432%`、
          `%LOCALAPPDATA%/Programs/Git/bin/bash.exe`。
       3. **PATH**(用户+系统,进程级已合并)逐目录 `bash.exe`;**黑名单在这些候选之前生效**。
       4. **PATH 上的 `git.exe` 反推**(`<gitdir>/../bin/bash.exe`、`<gitdir>/../../bin/bash.exe`)。
       5. **注册表 Path**(`HKCU\Environment`、`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`,
          覆盖"GUI 启动时 PATH 快照过期");`reg query` 走 **argv 数组**,不拼字符串。
       6. 全落空 ⇒ `{ ok:false, path:'', tried:[…] }` + `bashResolutionReport()` 的 fail-loud 文案。
     - **判据(缺一不可)**:黑名单(`system32`/`windowsapps`/`msys`/`cygwin`/`wsl`,归一化后逐段匹配,先于探测)
       → 形状 `<root>/bin/bash.exe` → `<root>/cmd/git.exe|bin/git.exe` → `<root>/usr/bin/bash.exe` →
       (`<root>/mingw64` 或 `<root>/usr/bin/msys-2.0.dll`) → `<git> --version` 含 **`.windows.`** →
       **一票否决**:实跑候选 `bash -c "uname -s"` 必须是 `MINGW32_NT-*`/`MINGW64_NT-*`。
     - **失败的用户可见面**:① 启动日志打印完整报告(当前值/逐条探测/去哪改/下载链接/"不回退"声明);
       ② win32 注册 `GET /dsh-gitbash-shell/api/status`(可选服务 `ctx.inject(['webServer'])`,绝不硬 inject);
       ③ 客户端半在 `shell.overlay` 上弹一次(仅 win32 且 `ok:false`,同 boot 一次、`sessionStorage` 记关闭),
       内含**探测清单 + 内联 bashPath 编辑(写 `configForms` 的 `bashPath`)+「去下载 Git for Windows」**。
       **`pwsh-sandbox` 的 `disabled: true` 永远与 bash 健康无关**(冒烟守卫断言它没有 `!!js`);
       `cordis.patch.yml` 的 `gitbash-executor.config.bashPath` 默认是**空串**(=自动链)。
     - **深链结论(实测)**:官方设置页**没有**公开 API 能跳到指定插件的设置卡
       (`openSettings`/`openSection` 只发给 `settings.launcher`/`settings.onboarding` 占用者,面板状态是
       `ui-settings-general` 私有 store;`ctx.shortcuts` 也没有按 id 执行命令的入口)⇒ 因此弹窗**自带编辑器**,
       用户不必去找设置页;文字指路作为兜底。上游若开放深链 API,这里可以直接换成按钮跳转。
     - 改这一层必须跑冒烟里的「bash resolution」四例 + 「no-fallback guards」+「missing-bash popup」+ 真机弹窗读数。

4i. **官方侧栏终端(「新建终端」)自动接管(v0.29.0,task-25)**:dsh 自己的终端由 **`terminal-controller`** 行决定 shell
     (未配置 ⇒ `subprocess.terminalEnvironment().defaultShell`),与本插件的执行器是两条独立链路;在 PATH 的 `bash`
     指向 `C:\Windows\System32\bash.EXE`(WSL 启动器)的机器上,新终端就是 Ubuntu。
     - **官方 settings 服务写不了它(实测)**:`SettingsService.write()` 只接受 **volatile** 字段
       (`volatileForm(schema) === undefined` ⇒ `Plugin entry "…" has no volatile fields`),而 `TerminalController.Config.shell`
       是普通字段;探针里 `settings.update('terminal', {shell})` 抛 `No configurable plugin entry "terminal"`。
     - **可行通道 = `configEditor.edit(entry, change)`**(官方设置 UI 的同一个 API,"ordinary fields keep normal lifecycle
       rules")⇒ 写入**无需重启**(运行中的 `ctx.terminalController.config.shell` 立刻是新值),落盘到 profile patch 层,
       由官方 YAML 编辑器保留注释、按 `id` 合并。**不要**改官方包。
     - **硬约束(Lead 裁决 2026-09-26,验收会独立 grep)**:① 只能经 `configEditor.edit()` 写入,**src/ 里绝不能出现**
       对 profile patch(`cordis.patch.yml` / `patchPath`)的 `writeFile`/`writeFileSync`/`appendFile`/`appendFileSync`
       或任何 fs 直写(冒烟有断言);② **只写空的**;③ 同值不写(**幂等**,验收看二次启动 patch 的 md5);
       ④ 异值(用户显式选择)**绝不覆盖**,只记日志;⑤ **写入后必须读回校验**,不符 ⇒ `write-failed` + fail-loud,
       日志必须给出可执行下一步;⑥ **回退语义**:关开关只阻止**以后**的写入,**不会**删除已写入的字段 ——
       要彻底恢复原样需删掉该行 `shell` 字段并重启(README 与 21 语言 hint 都写明);⑦ 未改 `shellCandidates` ⇒
       菜单里仍可能列出解析到 WSL 的候选 `bash`,被改的是**默认项** —— 文档必须如实说明,别让用户以为整条菜单被换掉。
     - **只写空的**:该行没有自己的 shell ⇒ 写 `{path, name:'Git Bash', args:['-i']}`(`-i` 与官方 `profile()` 对 bash 的默认一致);
       已指向别处 ⇒ **绝不覆盖**,只记日志并说明怎么交还。
     - **显示名必须是 `Git Bash`(v0.29.1,用户实测)**:官方 `shellCandidates` 里那条 `bash` 在 PATH 命中
       `C:\Windows\System32\bash.exe` 的机器上会解析到 **WSL**,于是「新建终端」菜单里出现**两条 `bash`**,用户分不清
       ("新增的gitbash显示名称得是gitbash,不然回合wsl的混了")。`name` 只是 `TerminalShell.name` **显示名**,不影响
       解析/执行,但**必须**与 WSL 候选区分开;`shellCandidates` 仍不动。
     - **历史配置要迁移**:path 是我们的 Git Bash 但 `name` ≠ `Git Bash`(v0.29.0 写进去的 `bash`,或用户手改)
       ⇒ 新增 `rename` 动作**只改 `name`**(path/args 原样保留),同样**写回后读回校验**(路径与名字都要对),
       不符 ⇒ `write-failed`;迁移后再跑仍是 `unchanged`(**幂等**,patch md5 不变)。
     - **绝不写没验证过的路径**:`resolveShell` 用 `resolveExecutable()` 校验配置路径,失败**没有回退**、直接让「新建终端」启动失败
       ⇒ 只允许写 `src/bash-path.js` 判据全过的 Git Bash。**写入后必须读回校验**,不符 ⇒ `write-failed` + fail-loud。
     - `shellCandidates` 不动(配置的 shell 恒排首位);菜单里可能仍有一条候选 `bash`(解析到 WSL)属预期。
     - 开关 `autoTerminalShell`(volatile,默认 **ON**;旧宿主 settings 命名空间同名字段,缺键 = on);文案 21 语言
       `term.label`/`term.hint`。原 `adoptSidebarShell`(dsh-better-sidebar 通道)**保持独立**,两条互不干扰。
     - 改动必须跑冒烟里的「sidebar terminal」六例 + 真机五态(空→写 `name: Git Bash` / **历史 `bash` 名字→改名迁移** /
       同值→不写且 patch md5 未变 / 异值→不写 / 开关关→不写),并保留 README 的三步复验清单。

5. **无构建**:发布产物就是 src/* + assets/*;npm test 全绿即可;安装不触发 lifecycle
   脚本(保持零 allowBuilds 摩擦)。
   **`exports` 必须含 `"./package.json": "./package.json"`(v0.24.3 修,与 dsh-better-workspace
   issue #9 同源)**:桌面 Electron renderer 没有 `ctx.loader.internal`,模块发现回退
   `createRequire(baseUrl).resolve('<pkg>/package.json')`(dsh 源码
   `packages/client/modules/src/index.ts` `locatePkgJson()`)——**该调用遵守 exports map**,缺行抛
   `ERR_PACKAGE_PATH_NOT_EXPORTED` 并被紧邻的 `catch {}` 吞掉,该包被**永久缓存为「非 client 包」**:
   client 半永不进桌面启动图、设置卡与侧栏半完全不生效,而**宿主日志全绿**(CLI/web 宿主走
   `loader.internal` 分支,本机自测永远测不出来)。冒烟有字段断言 + `createRequire(...).resolve()`
   运行时断言双保险。另外三个子路径同为宿主解析面,不可删:`.`、`./shell`(执行器行名)、
   `./client`(client 半入口)、`./locale/*.json`(插件管理页元数据)。
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
   ① **结构化行序列对比**:取宿主当前的预设组合文本 —— dsh 0.1.7 起在
      `packages/bundle/web-app/presets/{standard,cordis,ptc,minimal}.patch.yml`(行位于
      `insert[0].config.plugins`;0.1.6 及以前的目录预设路径已不存在),抽出 `- id:` / `name:` /
      `disabled:` 三行序列,与本插件对应变体逐条对齐;**提示词**(persona 的 `prefix:`/`suffix:`
      文本)与**工具行**同样要 diff,不要只看 id 名字。
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
   ⑦ **审计窗口从「上一个已知可用版本」起算(v0.24.4 立,issue #6 教训)**:上一轮 rc.1 复核只 diff
      `alpha.1 → rc.1`,而本插件的基线是 alpha.1 —— 整个 `0.1.6 → 0.1.7-alpha.1` 窗口(#4587 的
      volatile Config 投影 + shell 包大重构)从未被对照,于是"用户装上就每次 shell 调用报错"这种
      最粗的破坏直接漏过。规则:每次跟随升级,diff 的起点必须是**本插件上一个真机验证通过的宿主
      版本**(不是上一个 alpha/rc),并按下面这张**执行器半消费面**清单逐项对照:
      `LocalBashExecutor.Config` 字段与读法(裸值 vs `Volatile.get()`)、`ShellExecutor` 抽象面
      (`run`/`start` ↔ `execute`,`runArgv`/`startArgv` ↔ `executeArgv`)、`ShellExecSpec`/
      `ShellExecution` 类型面、`confine` 签名、`ctx.subprocess` 与 `ctx.sandboxPolicy` 读取面、
      `settings` 服务方法面(`get(ns)` 是否存在)。**这类契约验证不需要 Windows**:用宿主构建里的
      真实类 + 打桩 spawn 驱动即可(`apps/desktop/.desktop-build/targets/*/dsh/node_modules/
      @deepseek-ai/dsh-bash-*`),CHANGELOG v0.24.4 记录的 12 项集成检查就是这么跑的。

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
6. **去重改动(§4e,v0.25.0 起)**:隔离实例(`DSH_HOME` 独立 + 新建 profile + 两份插件 `link:` 安装
   + 探针插件定时打印 `agentPresets.list()`)里**真的翻转开关**看名录:默认两侧条目并存 → 写
   `settings.update('gitbash-shell', { suppressPeerCordis: true })` 后出现 `preset 'cordis-gitbash'
   retired …` 且名录少一条 → 写回 `false` 后出现 `preset 'cordis-gitbash' registered declaratively`
   且名录恢复。非 Windows 机上用探针副本把 `gitBash` 能力的 `active` 强制为 `true` 模拟 win32 语义;
   顺带在无头浏览器确认对方设置卡上的镜像行渲染出来(同一份状态)。
7. **Python 后端开关改动(§4f,v0.26.0 起;v0.26.1 起三态)**:隔离实例 + 探针插件
   `ctx.provide('ptcCordisPreset', { id, gitBashActive: true, … })` 跑**三态**:
   ① `{pythonRuntime:true, pythonBackend:'python'}` → 日志
   `peer reports the experimental CPython run_code backend: workflow rows go off in every variant`
   + 四条 `retired … (peer CPython backend changed; rows are rebuilt)`,且四个变体的
   `workflow-ptc`/`tool-workflow` 都 `disabled: true`;
   ② `{pythonRuntime:true, pythonBackend:'node'}` → 日志
   `peer has the CPython switch on but the effective backend is node: workflow rows stay on (reason in the host log)`,
   **没有**重建日志,`readDocument()` 读数里 standard/cordis 的两行**保持启用**(`code-gitbash` 本就关);
   ③ `{pythonRuntime:true}`(旧 peer,缺 `pythonBackend`)→ 与 ① 相同(意图顶替,行为与 v0.26.0 一致)。
   再对其中一态用 `agentPresets.acquireScope('<variant>')` **真挂载**四个变体,要求四条
   `MOUNT OK`(挂载审计不得有 failed 行);读数用 `readDocument()` 的 dump,不要只看注册成功。
   非 Windows 机上无法验证 win32 分支(卡片禁用态 / 宿主拒绝),记为模拟验证。
8. **子代理开关改动(§4g,v0.27.0 起)**:隔离实例 + **真** root/child/nested agent(`ctx.agents.create({ parentAgent, meta: { origin: 'subagent', delegationDepth } })`),
   再对每个 agent 调**真的** `systemPrompt.assemble({ agent, scope: agent })`,断言:开关 ON 时三态都拿到方言指令;OFF 时**只有 root** 拿到,
   child/nested 均无(`directive=no`)。macOS 上需把插件副本的两处 `process.platform === 'win32'` 组装门强制打开(执行器/请求面同理),
   并在报告里标注"平台门被强制";win32 真机仍未覆盖。

9. **bashPath/解析链改动(§4h,v0.28.0 起)**:`npm test` 里的解析链矩阵(fake fs + fake exec)必须全绿;
   真机验证用**隔离 DSH_HOME + 插件副本**:把副本里 6 处 `process.platform === 'win32'` 强制打开、
   把 `/dsh-gitbash-shell/api/status` 的 `platform` 伪装成 `win32`,然后无头浏览器(CDP)断言:
   弹窗渲染(标题/按钮/探测清单条数)、「去下载」点击后 `window.open` 收到 `https://git-scm.com/download/win`、
   内联编辑 + 保存后**宿主侧落盘**(`profiles/<p>/cordis.patch.yml` 的 `bashPath`)、关闭后刷新不再出现。
   **副本改动绝不能落在本仓**(用 `[ "$(pwd)" = "/tmp/..." ]` 之类守卫);Windows 真机部分如实标注未验证。

10. **官方侧栏终端接管改动(§4i,v0.29.0 起)**:隔离实例里用**副本**强制 win32 门 + 伪装"已验证的 Git Bash",
    **只看 profile patch 的字节变化**证明五态:空值→新增 `- id: terminal-controller` 行且 `shell.name: Git Bash`、用户手写行/注释原样保留;
    **历史 `name: bash`→只改这一行 name 的迁移**;再跑一次同值→patch **md5 未变**(幂等);异值→patch 未变且日志含"explicit choice is never overwritten";开关关→patch 未变。
    另用 `--dump-config` 读 `terminal-controller.config.shell.path`、无头浏览器确认零 pageerror。
    Windows 真机(菜单项、`uname -r` 是否 `MINGW64_NT-*`)如实标注未验证,并在 README 给用户三步复验清单。

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
