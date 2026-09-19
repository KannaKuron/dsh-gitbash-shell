# Changelog — dsh-gitbash-shell

> 倒序排列,新版本条目在最上面。条目格式:`## vX.Y.Z — YYYY-MM-DD` + 类型(feat / fix / docs / chore)+ 要点 + 相关链接。
> 纪律见 AGENTS.md「变更记录纪律」:发版前先更新本文件并随版本提交;事故复盘、复现与真机验证记录也记在这里。

## v0.22.0 — 2026-09-19

**类型**:feat(失败消息面统一方言 + glob 认 `~`;含两项实证修正与一项「明确不做」)

**本轮的取证手段(值得写下来)**:`~/.dsh/sessions/<项目>/<会话>/session.v3.jsonl.zstd` 是**逐帧追加**的 zstd 文件——Node 的 `zstdDecompressSync` **只解第一帧**,按 magic `28 B5 2F FD` 切帧后逐帧解才能全解。它把「每个面到底存了什么」变成**可测事实**:本轮三条结论(消息面是 Windows、卡片参数是我们自己重写的产物、`autocrlf=false` 的 diff 噪声)都出自它,没有一条靠猜。

- **① 失败的「第二个面」也翻译(主项)**:一次失败有**两个面**——`content`(模型在失败调用上读到的文本、UI 卡片显示的就是它)与 `error.message`(PTC 桥交给**程序**的那条 `ToolCallError` 消息)。v0.17.1/v0.21.0 只翻了前者,于是**程序里 `catch (e) { console.log(e.message) }` 打出来的是 `C:\Users\...`**,而同一个失败在未捕获面/UI 里是 `/c/...`——同一个错误两种方言,正是「方言幻觉」最容易复发的位置(会话记录实测:`tool/ptc-dispatch` 的 content 已是 `/c/...`,程序拿到的 message 仍是 `C:\...`)。
  - **修法**:`tools/post-execute` 中对同一个 result 的 `error.message` **原地改写**——注册表在 `normalizeDispatchResult` 里按**引用**透传 error、直到 `materializeFinalResult` 才快照,所以这一次写入同时到达 PTC 桥与最终记录。新增纯函数 `rewriteErrorMessage` / `rewriteFailureMessage`(冻结、缺字段、非字符串一律 no-op;内容面照旧独立生效)。
  - **为什么不用官方 `block` 决策**(唯一另一条能改 message 的路):`block` 会用反馈重建 `{ message }`,**丢掉 `error.info`**(`FS_NOT_FOUND` 这类结构化身份,记录与 UI 都在用)。一次纯方言改写不该动失败的身份;冒烟有断言锁死「正文里不得出现 `kind: 'block'`」。
  - **`/tmp` 回显扩展到「句子中间」的路径**:新增 `msysEcho` + `mountTempRoot`,诊断里**内嵌**引用的 temp 路径也回显为 `/tmp`(以前只在整串就是那条路径时才映射);`rewriteResultPaths`(成功面)改走同一个 helper,失败面与成功面从此同源。
- **② glob 认 `~`**:`glob { pattern: '~/sandbox/*.tgz' }` 以前**静默 0 命中**——bash 与其它工具都认 `~`,只有 glob 的 pattern 不在挂载表里。现在 pattern 开头的 `~`/`~/...` 先按家目录展开再拆 `path`/`pattern`;`~user/...` 不认(插件没有这个事实,猜错会搜错树),无 env 时维持原样。
- **③ 行尾值 `false` → `input`(对 v0.21.0 的实证修正)**:在**已经是 CRLF 工作区**的仓库里(Windows 用系统默认 autocrlf=true 检出的仓库,本机这几个插件仓库本身就是),`core.autocrlf=false` 会让 git 拿工作区 CRLF 与索引 LF 逐行比对 → **`git diff` 整文件飘红、`git add` 连行尾差异一起暂存**。本机实测同一仓库:`false` = 4387 增 / 4233 删,`input` 与 `true` = 198 增 / 44 删(我本轮改动的真实 diff)。这与「Linux 访客看到干净工作区」直接冲突,而 v0.21.0 想要的是**检出侧**不写 CRLF。`input` 两件都满足:提交侧把 CRLF 归一成 LF(索引不变 → git diff 不再有幻影改动),检出侧永不写 CRLF;代价是 `git diff` 会给每个将被归一化的文件打一行 stderr 提示(如实告知,不是错误)。
  - **措辞更正(重启后实测,2026-09-19)**:上面那句「工作区读作干净」说得太满。精确事实:CRLF 工作区在 input 下 git diff 无幻影改动、真实改动只算自己(scratch 仓库实测:纯 CRLF 差异 → diff --shortstat 为空;再加一行 → 1 file changed, 1 insertion(+)),但**被 touch 过的文件仍会被 git status --porcelain 列为 modified**(stat 层的报告,与 Linux 遇到 CRLF 工作区时同类)。false 下同一仓库则是 1 file changed, 2 insertions(+), 2 deletions(-) —— 幻影改动进了 diff。
- **明确不做:PTC 记录/卡片里的 Windows 参数形态**。PTC 子调用记录(`tool/ptc-dispatch.arguments`)存的是**程序实际传出去的**参数;那里的 `C:/Users/...` 不是宿主写的,而是**我们自己 v0.20.0 程序字面量重写**的产物(模型写的 `/c/...` 在程序里已被换成 `C:/...`,否则原生 `fs` 调用会写到 `C:\c\...`)。让卡片显示 `/c/` 只能放弃或收窄那次重写,代价是**静默写错路径**;而**模型看不到这条记录**(它只见自己写的源码与程序输出)。故本轮不动,留作可选项(收窄规则 = 只跳过 `tools.X({...})` 直传的字面量;误判即静默错路径,风险大于这条纯展示收益)。
- **验证**:`npm test` **53/53**。新增两例:① `rewriteErrorMessage`/`rewriteFailureMessage` 的方言、`/tmp` 内嵌回显、冻结对象 no-op、幂等、`error.info` 保留;② 源码守卫——post-execute 的两个分支都要调用消息改写、run_code 仍只翻路径不带 `/dev/null` 提示、正文不得出现 block 决策。另加 glob 的 `~` 展开矩阵(`~/...`、裸 `~`、`~user`、无 env、相对 pattern 引用不变)。21 份词典的 `errs.hint`(now 覆盖程序捕获到的消息)与 `eol.hint`(`autocrlf=input`)同步。**真机自检(用户重启后在本会话内跑)**:程序里 `catch` 到的消息应为 `/c/...`;未捕获失败面仍 `/c/...`;`git config --get core.autocrlf` 应为 `input`;`glob` 的 `~/sandbox/*.tgz` 应命中。

## v0.21.1 — 2026-09-19

**类型**:fix(v0.21.0 的回归:行尾开关把整个 shell-env 贡献一起弄坏了;用户重启后真机自检发现)

- **现象(真机自检)**:重启后 bash 里 `git config --get core.autocrlf` 仍是 `true`,`GIT_CONFIG_COUNT` **与 `DSH_PATH_DIALECT` 都是空的**。隔离实例日志给出答案:`shellEnv fact registration failed: bash env contributor "gitbash-shell" declared invalid key "GIT_CONFIG_COUNT"`。
- **根因**:官方 `dsh-shell-env` 注册表**只接受 `DSH_*` 键**;v0.21.0 把 `GIT_CONFIG_*` 声明进同一个 contributions 映射 → 注册**抛错**,而注册整段在一个 try/catch 里 → **连原有的 `DSH_PATH_DIALECT` 一起丢掉**(即 v0.11.0 的"官方注册表事实"被这次改动打回原点)。**行尾开关因此从未生效**,而错误只写在日志的一行里、测试又只断言源码形状,两边都没拦住。
- **修法**:注册表贡献**退回只声明 `DSH_*`**(恢复 `DSH_PATH_DIALECT`);行尾环境改由**我们自己的执行器**注入(`src/shell.js` 新增 `withParityEnv(spec)`,`run`/`start` 入口把 `GIT_CONFIG_COUNT/KEY_0/VALUE_0/KEY_1/VALUE_1` 合并进受信任的 `dshEnv` 层)——这正是子进程 env 真正被组装的地方,且只作用于模型跑的 shell。
- **防回归(冒烟新增两条硬规则)**:① 注册表贡献里**字面量键必须是 `DSH_*`**、计算键只允许已知的 `PATH_DIALECT_KEY`(且断言其字面量以 `DSH_` 开头)、**声明块里不得出现 `GIT_CONFIG`**;② 行尾注入必须在**执行器**里(`withParityEnv`、五个 GIT_CONFIG 键、`dshEnv` 合并、开关可关)且**任何地方都不得写 `--global`**。`npm test` 50/50。
- 教训(写进本条,避免重蹈):**"注册表拒绝某个键"这类契约在源码层完全看不出来**,只断言"我声明了什么"的测试是假安全——断言必须写成"**只允许什么**"。真机自检(重启后跑一遍工具面)是这类问题的唯一可靠拦截点。

## v0.21.0 — 2026-09-19

**类型**:feat(以「减小模型跨系统性能差距」为尺子的三项:行尾对齐 Linux、run_code 的 temp、run_code 的错误方言)

**背景(用户定的尺子)**:插件的 KPI 不是"路径看起来像 Linux",而是**让 Linux/mac 训练出来的模型在 Windows 上表现一致**。据此重新审计后,本轮只做**Windows 特异**的三项;凡是 mac 上同样存在的行为,一律**不碰**(碰了才是制造差异)。

- **① Git 行尾对齐 Linux(v0.21.0 主项)**:Windows 的 Git 默认 `core.autocrlf=true`,模型按 LF 写出的文件**检出后变 CRLF**——脚本报 `\r` 错、字节级断言全挂、diff 整文件飘红(我们在 dsh-ide-git 的夹具上真踩过);而 Linux 访客的 `autocrlf=false`。现在插件经官方 `dsh-shell-env` 注册表,**只给模型执行的 shell** 注入 `GIT_CONFIG_COUNT=2` + `core.autocrlf=false` + `core.eol=lf`:模型跑的每条 git 都是 Linux 行为,**你自己终端的 git、以及仓库的 `.gitattributes` 都不受影响**。设置卡新增开关 `gitAutocrlf`(默认开),21 语言词典同步。
- **② run_code 的 TEMP/TMP(只补 Windows 会缺的那两个)**:run_code 的程序**故意**跑在空 env 里(官方设计,mac 一样),所以这**不是**"给它一个 shell 环境"。真正 Windows 特异的症状只有一条:空 env 下 Node 的 `os.tmpdir()` 在 Windows 上返回字面量 `undefined\temp`(mac 会回退到真实的 per-user 目录),程序据此写文件会**静默写进一个叫 undefined 的目录**。现在在执行前给程序加**一行 prelude**,只种 `TEMP`/`TMP`(Windows 自己的约定);`HOME`/`PATH` **故意不种**——mac 上没有的值给了 Windows,才会让两个平台行为分叉。prelude 只存在于**那一次执行的派发副本**里(入参在派发前先 `snapshotJsonValue` 再 `deepFreeze`,会话记录/下一轮请求/回放都看不到它),**零上下文负担**;代价是程序报错行号偏移 1 行。
- **③ run_code 的错误也走方言**:程序未捕获的失败会把**Windows 路径**直接甩给模型(`ENOENT: ... open 'C:\\Users\\...'`)——这是"方言幻觉"唯一破掉的地方(文件工具的错误早就翻译了)。现在 `run_code` 并入错误方言分支:**只翻路径,诊断原文逐字保留**,并且**不追加** `/dev/null` 提示(那是文件工具专用的引导)。
- **明确不做(本轮的决定,避免以后重复讨论)**:
  - **给 run_code 种完整 env(HOME/PATH)**:撤回。空 env 是官方设计且 **mac 相同**,种了反而让 Windows 与 mac 行为分叉。
  - **补齐缺失命令(tree/zip/wget/make/watch)**:撤回。不能装用户的环境,也不该用假 shim 冒充——缺件如实失败,模型自己换 `curl` 这类等价物是一次便宜的自适应。
  - **`python3` shim**:降级为可选。实测 WindowsApps 的 `python3` 占位**会自动下载安装并跑通**(只是首次慢、有告警),而 mac 上没装 CLT 时 `python3` 同样弹安装——不是 Windows 特有。
  - **替换 run_code 本体**:不做。那要接管核心运行时 + 会话格式(code-mode 子调用段是落盘词汇),收益(动态拼接路径)远小于风险。
- **验证**:冒烟 50/50(新增三例:prelude 只种 TEMP/TMP 且恰好一行、git 行尾注入接线且不碰 global config、run_code 错误路径回写 + 诊断保真);客户端 21 份词典键集齐平;设置卡真机渲染确认新开关。**真机行为验证(模型侧)在用户重启 DSH 后于本会话内直接跑**:`git config --get core.autocrlf` 应为 false、run_code 里 `os.tmpdir()` 应为真实临时目录、程序报错里的路径应为 `/c/...`。

## v0.20.1 — 2026-09-19

**类型**:fix(提示词按场景注入:只在真的有 run_code 的模式里说那句话)

- **问题(用户要求)**:v0.20.0 把「run_code 程序内的路径字面量会被翻译」写进了**基础指令**,于是**每一种模式**都会看到这句——包括根本没有 run_code 的 standard/cordis 会话、以及 code 模式下把 run_code 关掉的会话。对它们来说这是纯噪声,还占提示词预算。
- **修法**:句子从基础指令里拆出来,变成 `RUN_CODE_DIRECTIVE_TEXT` / `RUN_CODE_DIRECTIVE_STRICT_TEXT`,由 `system-prompt/assemble` 钩子在**本次组装真的带 run_code 时**追加到同一条 context(`gitbash-shell:posix-paths`)末尾。判据来自官方组装体本身:`PromptAssembly.tools`(**在 waterfall 之前**就已填充)里有没有名为 `run_code` 的工具——`runCodeHintFor(tools)` 是纯函数,工具表缺失/为空/不含该工具一律返回空串。标准/cordis 模式与关闭 run_code 的模式因此**一个字都不多说**。
- **自检**:`tests/smoke.mjs` 新增一例(有 run_code → 有句;无/空/不含 → 空串;重复工具名幂等),并把原断言反转为「**基础指令不得出现 run_code 字样**」+「装配钩子必须用工具表门控」;另一例的开关/指令接线断言同步更新。`npm test` 47/47。
- 相关:翻译层本身(v0.20.0)与设置卡开关 `codePaths` 不变;本条只动「说给模型听的那句话」的注入条件。

## v0.20.0 — 2026-09-19

**类型**:feat(run_code 程序内的路径字面量也吃同一张挂载表;用户要求「必须修复」)

- **现象(本机实测,用户当场看到)**:在 run_code 程序里写 `fs.writeFileSync('/c/Users/kanna/sandbox/x.png', …)`,文件**真的被写出来了,但位置是 `C:\c\Users\kanna\sandbox\x.png`**——翻译层只作用于「工具调用的入参 / 出参」,而程序源码里的路径字符串是**程序数据**,由原生 Node 自己解析:根路径 `/c/...` 落到「当前盘符下的 \c\...」。测试脚本与模型生成的代码都踩过(见 AGENTS.md 4c 的边界记录)。
- **修法(新能力)**:`rewriteCodePaths(code, env)` 扫描 run_code 的 `code`,把**整体就是一条绝对 MSYS 路径**的字符串字面量按**同一张挂载表**翻译:盘根 `/c/...`、`/tmp/...`、`/dev/null`(NUL 设备,`\\.\NUL` 会按字面量语境转义)、`/usr` 等 Git 根挂载、`~/...` 家目录。扫描器逐字节走查源码(注释、单双引号、模板字面量、正则字面量与除法、`${` 插值、转义),**任何不确定就整份 no-op**——半改的程序比不改更糟,这一层绝不猜:
  - **不动**:注释与字符串里的「像路径的文本」、`http://` 之类带 scheme 的串、`\$HOME/x`(JS 字面量是数据,不做 shell 展开)、已是 Windows 形式、相对路径、含转义或引号的串;
  - **整体 no-op**:未闭合的字面量、走不到头的模板/正则、扫描结果不可信;
  - **防串味**:翻译结果里若出现该字面量的引号(家目录带撇号)、或反引号语境下出现 `${`,放弃这一条而不是破坏字面量。
- **开关**:设置卡新增 **「run_code 程序内路径」(codePaths,默认开启)**,21 种语言词典同步;关掉只影响程序字面量,工具参数的方言不受影响(`posixPaths` 仍是总开关)。
- **提示词同步**:方言指令补一句事实——run_code 程序里的路径字面量同样会被翻译,shell 展开在那里不存在,`\$VAR` 要写成实路径。
- **自检**:`tests/smoke.mjs` 新增两例——字面量翻译矩阵(翻译/不动/整体 no-op 三类,含 `/dev/null` 经 `eval` 求值确认为设备路径、正则里的引号与除法不串味、无 env 时只翻盘根)**必须全绿**;另一例锁住开关与指令接线(`codePaths` schema 默认、wrapper 条件、指令提到 run_code)。`npm test` 46/46。
- **真机验证**:隔离实例(独立 DSH_HOME + 3099)装本地构建后,插件正常加载、设置卡出现新开关;并从**已安装产物**直接跑一次端到端:被改写的程序用真实 fs 写文件,**落到目标路径而不是 `C:\c\...`**,同时确认「不可扫描的程序」一字未动。
- 相关:AGENTS.md 4c 的边界记录随之更新为「已实现 + 剩余候选」。

## v0.19.1 — 2026-09-19

**类型**:fix(bundle 页卡片壳)

- 修复:v0.19.0/v0.5.3/v0.12.1/v0.6.1 把磨砂与卡片样式挂在旧座位的折叠卡类上,而插件面板的 bundle 页(page 形态)此前渲染的是**无壳裸 div**——磨砂/边框/背景在面板里根本没出现。page 形态现在渲染完整卡片壳(边框 + 背景 token + any-background 磨砂链 + 标题/描述头部 + 默认光标),与 dsh-better-workspace 的 bundle 页同构。
## v0.19.0 — 2026-09-19

**类型**:feat(细粒度开关 + bashPath 设置 + 设置页重做)

- **三个新开关**(默认全开,设置卡分段按钮):`virtualMounts`(虚拟挂载 + ~ + 变量简写;关闭 = 严格 /c/ 盘根-only,指令文本同步切换为严格版)、`errorDialect`(报错路径翻译 + NUL 引导块;关闭保留原文便于排障复制)、`globSplit`(glob 绝对 pattern 拆分;关闭原样传递)。
- **bashPath 设置项**:设置卡新增自定义 bash.exe 完整路径输入框(保存按钮 + 已保存反馈);buildTranslateEnv 以其为 Git 根探测候选首位(Map 缓存按路径键)——修复自定义安装位置下 /usr 系挂载找错根的问题。
- **设置页重做(better-workspace 同款形态)**:分区结构(路径方言区:总开关 + 三子开关 + bashPath;侧栏终端区:接管开关);卡片表面加 any-background 磨砂链(backdrop-filter: var(--dsh-any-blur-card-panels, blur(12px) saturate(1.15)),-webkit- 同步);输入框/保存按钮全 token 化。
- **21 语言词典新增 12 键**(sec.dialect/sec.terminal/mnts.*/errs.*/split.*/bash.*),键集对齐断言保持全绿。
- host 侧 readDialectSettings 统一读取五项设置;execute/post-execute wrapper 与指令闭包全部改经它分发。
- 冒烟 44/44(词典 key 对齐 + 组件渲染 smoke 通过新 UI 结构)。
## v0.18.2 — 2026-09-19

**类型**:fix(空环境进程的 /tmp 翻译兜底)

- 在空环境进程(PTC run_code 子进程,官方零环境设计)里 import 本模块做路径翻译时,os.tmpdir() 退化为垃圾串、探测被 existsSync 防御拦截,导致 /tmp 不翻译;新增 Windows 兜底:homedir 下的标准布局 AppData/Local/Temp 存在即用。宿主进程不受影响(tmpdir 正常,兜底不触发)。run_code 内的进阶姿势(import 本模块翻译原生 fs 路径)自此覆盖 /tmp。
## v0.18.1 — 2026-09-19

**类型**:fix(glob 绝对 pattern 的变量前导)

- glob 的绝对 pattern 若以变量简写开头($HOME/.../*.md、花括号形态),原先不参与拆分(pattern 首字符非 / 或盘符)→ 静默匹配空;现先经 expandLeadingVar 展开(同 v0.18.0 的路径字段语义)再走拆分链。
- 附注(错误翻译的观察通道):PTC run_code 子调用里 ToolCallError.message 取自结果的 error.message 字段,而 v0.17.1 的错误翻译作用于 content 字段(模型直调与 UI 展示面)——在 run_code 内观察 e.message 看不到翻译,不代表翻译未生效;模型直调路径的效果以 UI 工具卡片错误文本为准。
## v0.18.0 — 2026-09-19

**类型**:feat(例外交织的最后一轮:变量简写 + 设备路径引导)

- **前导变量简写展开**:路径参数开头的 HOME/TMPDIR/TMP/TEMP 变量(裸名与花括号两种形态)按 Git Bash 语义展开(HOME→用户主目录,TMPDIR/TMP/TEMP→/tmp 挂载即用户 TEMP)——bash 的 $HOME/.gitconfig、${TMPDIR}/x 习惯在文件工具直接可用。未知变量与 NAMEX 型误匹配原样透传(工具如实报错,不猜测);无 env 时保持旧行为。
- **/dev/null 报错引导**:文件工具撞 EINVAL(设备路径被 harness 的 realpath 步骤拒绝)时,在保留原始诊断的前提下**附加**一条引导块(提示经 bash 丢弃输出),模型首次撞错即获得正确路径,无需试错。
- 实现注记:expandLeadingVar 用字符码手写。归因更正(2026-09-19 复核):开发中曾出现一次长程序输出的截断事故(index.js 被写出 700 行重复段,git checkout + 干净重放恢复),当时疑为 PTC 代码传输层截断引号内 dollar 字节;随后做了两组对照实验(直接 dollar 字面量、charCode 拼接经 code 通道写盘读回)均**完好**,通道无罪——事故归因于模型生成长程序的偶发输出错误,字符码写法仅作为防御习惯保留。
- 已知边界(不解决,语义限制):路径通配符展开(pkgs/*/x.md 传给单值 path 字段)是 shell 预处理语义,由 glob 工具/bash 承接;run_code 程序文本内的原生 fs 调用不经工具参数翻译(其 process.env 为空是 PTC 官方设计——runtime.spec.ts 以断言钉死模型环境必须为空,白名单变量只保留在 OS 环境块服务进程创建;副作用是 Windows 下 os.tmpdir() 退化为 undefined-backslash-temp 垃圾串、mac 下兜底 /tmp,run_code 内写临时文件应用显式路径或经 bash cygpath 换算)。
## v0.17.1 — 2026-09-19

**类型**:fix(错误消息的方言一致性)

- **错误文本翻译**:文件工具(read/read_image/write/edit/glob/grep/present)的**错误消息**里 harness 生成的 Windows 路径诊断(cannot read 加 C:/ 形式路径的报错)改写回 MSYS 方言——模型不再从失败文本里「重新学到」Windows 形式。实现走 tools/post-execute 的 content 替换通道(registry 明确拒绝错误结果的 value 替换,content 是官方通道)。
- **内容红线(不变)**:成功结果的文件内容(read 行文本、grep 匹配行)从来不动;错误翻译仅限文件工具名单——bash 等工具失败时的 content 是命令输出(stdout/stderr)= 数据,一律原样;非盘符诊断(设备路径、URL)不匹配 windowsToMsys,原样保留。smoke 新增断言:错误翻译、bash 不在名单、内容红线。
## v0.17.0 — 2026-09-19

**类型**:feat(修复 + 能力增强:bash 虚拟路径习惯全工具统一)

- **背景**:模型把 bash 的原生路径习惯带进所有工具时,翻译层只认 `/c/` 盘根形式,其余透传——实测矩阵暴露一串空档:`write /tmp/x` 在当前盘符根**静默创建 `C:\tmp\`**(历史污染实锤:C:\tmp 里躺着旧会话文件);`write /dev/null` 在**用户真实目录 `C:\dev\` 里创建 `null` 文件**;`bash workdir=/tmp` 直接 spawn ENOENT(spawn 的 cwd 原样传 Win32,Posix 形式无效);`~/.gitconfig`、`/usr/bin/...`、裸盘根 `/c`、`present` 的嵌套 `files[].path`、glob 绝对 pattern 全部失效或静默空结果。
- **虚拟挂载表翻译**:入参翻译升级为「盘根 + Git Bash mount 表」两级——`/tmp` → 用户 TEMP(usertemp 挂载,文件工具与 bash 写**同一物理文件**);`/dev/null` → `\\.\NUL` 空设备(**不是**回收站,忠实 bash 即焚语义;**裸 `NUL` 字符串是陷阱**:libuv 相对路径会在 cwd 下创建名为 NUL 的真实文件,实测内容可读回,只有 `//./NUL` 设备路径才是真即焚);`/usr` `/bin` `/etc` `/var` `/home` `/root` `/mnt` → Git 安装根下对应目录(`/bin`→`usr/bin`、`/home` 是 Git 挂载而 `~` 才是用户主目录——均忠实 bash);`~`/`~/...` → `$HOME` 展开(`~user` 不碰);裸盘根 `/c` → `C:/`。全部段边界匹配、大小写敏感(忠实 msys 挂载表,`/Tmp` 不匹配)、探测失败即 no-op(env 由 `buildTranslateEnv()` 进程内一次探测:默认安装 + PATH 候选 bash.exe,以 `<root>/usr/bin` 存在性排除 WSL shim;tmpdir/homedir 有 existsSync 防御)。
- **glob 绝对 pattern 拆分**:glob 的绝对 pattern(`/c/.../*.md` 或 Windows 形式)原先静默匹配空;现按「第一个通配符前的目录前缀」拆成 `{ path, pattern }`(无通配符时目录 + basename;绝对 pattern 覆盖已有 path;相对 pattern 原样返回)。仅对 glob 工具生效。
- **present 嵌套路径**:`files[].path` 入参随翻译层(顶层字段白名单够不着的嵌套形状,v0.17.0 起覆盖);出参回流同步覆盖 `present` 的 `files[].path`。
- **出参 TEMP → /tmp 回显**:结果元数据落在用户 TEMP 下的路径回显为 `/tmp/...`(与 bash 的 `$TMP` 一致,大小写不敏感前缀匹配),非 TEMP 路径维持 `/c/` 盘根方言;无 env 时保持旧行为(兼容)。
- **指令与环境事实**:order-126 指示与 `DSH_PATH_DIALECT` 描述补「bash 原生习惯(~、/tmp、/dev/null、/usr)在所有工具同样有效」;设置卡 **21 语言 hint 同步更新**(工具列表补 present + bash 习惯句)。
- 冒烟测试新增 1 块(~ 展开、虚拟挂载、段边界、大小写、无 env 兼容、present 嵌套/冻结、glob 拆分矩阵、TEMP 回显/大小写/present/无 env),41/41 全绿。
- 真机矩阵验证:`read`/`write`/`grep` 的 `/tmp` 落 TEMP;`bash workdir=/tmp` 修复;`\\.\NUL` 写 OK 读 EOF;`/usr/bin/bash.exe`、`~/.gitconfig` 可读;`glob pattern=/c/...\*.md` 正常返回。
- **已知限制(/dev/null × 文件工具)**:read/write 直接指向 `/dev/null` 时,harness 文件工具内部的 `realpath` 步骤对 `\.\NUL` 设备路径报 `EINVAL`——翻译方向正确、**无任何副作用**(不再创建 C:/dev 文件),但设备语义只能在 bash 内完整使用(`echo x > /dev/null` 原生即焚);文件工具撞此错误应改走 bash。如实报错优于伪造成功(红线),见 AGENTS.md 4b 铁律。

**类型**:docs(npm description 双语化)

- **package.json 的 description 改为「中文 · English」双语**(v0.16.0 的描述仍是纯英文长文):dsh 0.1.6-alpha.2 的 Plugins 页直接显示 npm description 单字符串,官方 bundle 的中文是页面硬编码表、第三方无按语言切换通道,按生态惯例双语拼接。顺带把 v0.16.0 里没写完的长清单式描述收敛成要点式。无代码改动。

## v0.16.0 — 2026-09-17

**类型**:feat(dsh 0.1.6-alpha.2 适配 + 接管开关)

- **侧栏终端接管可开关(`adoptSidebar`,默认开)**:命名空间 `gitbash-shell` 新增布尔项,设置卡新增「接管侧栏终端」开关。开启时把 dsh-better-sidebar 的 `terminalShell` 写成 Git Bash(同旧版);**关闭时恢复接管前的值——仅当当前值仍是我们写的**(用户手动改过的终端设置永不被碰)。owner scope 的 `watch` 驱动实时翻转(轮询路径与注册路径双保险,晚注册也能 reconcile)。卸载回滚语义不变。
- **设置卡双座位(dsh 0.1.6-alpha.2 设置页体系迁移)**:旧 `settings.plugin.item`(key=命名空间)之外新增 `plugins.bundle.config`(key=**包名**);两个 `slots.inject` 各等各的槽声明,任何宿主版本恰好一个生效。组件按 `view: "page"` 分支渲染纯表单体;**两个座位都经 LocaleLive 包装**(0.15.0 的 21 语言词典对新座位同样生效)。
- **tool-plugin-manager 行注入(0.1.6-alpha.2 官方 preset 对齐)**:官方 ptc/standard/cordis 新增该行(官方 ptc 为 disabled)。包 0.1.6-alpha.2 才存在、import 失败拒绝整棵挂载,故按 present 同款模式:**宿主探测通过才注入**、纯字符串手术(锚定 present 行后,无锚则尾部)、幂等、绝不写死进资产。形态镜像各变体官方底稿:code-gitbash DISABLED、standard/cordis-gitbash ENABLED、minimal 不注入、code-era 冻结。marker 新增 `pluginManager` 维度。
- **cordis-gitbash 的 `.ps` 资产 persona 同步 alpha.2**:新增 plugin_manager 用法/创造模式视觉指引/cordis-plugin-development/MCP 接入/安装审批五段;text-era 孪生不动(旧宿主自洽)。
- **windowsHide**:官方 0.1.6-alpha.2 在 subprocess 层统一创建时隐藏控制台窗口;本插件执行器只包装官方 bash-sandbox、不自建进程,自动受益。
- 冒烟测试新增:双座位、开关默认值/读取/不覆盖手动选择、注入两形态/锚定/幂等/尾部兜底、资产不写死包名、ps/text 孪生分野、syncDecision pluginManager 翻转。
- **0.15.0 的 19 门 LOCALES 词典同步新增 `adopt.label` / `adopt.hint` 两键**(机器辅助翻译,欢迎 issue/PR 修正),键集断言保持全绿。
- 与 v0.15.0(21 语言)变基合并:client 半冲突按「保留 LocaleLive 包装 + 提升共享 injected 工厂 + 新座位同样 LocaleLive」解决。

## v0.15.0 — 2026-09-15

**类型**:feat

- **界面支持 21 种语言**。卡片文案从「zh/en 两本内联词典」扩成三层:zh/en 仍内联,19 门第三语言各占 `LOCALES` 表里的一条,每条前带 `/* locale: <tag> */` 标记(冒烟测试按该标记切块)。语言集合:zh、en + ar、de、fr、hi、id、it、ja、ko、nl、pl、pt、ru、sv、th、tr、vi、zh-HK、zh-MO、zh-TW。
- **词典经 `ctx.locale.register` 交给 DSH 的 locale 服务**:`ctx.locale.register(NS, Object.assign({ zh: zh, en: en }, LOCALES))`,21 个 tag 全部注册,宿主侧消费者读到与卡片相同的文案;插件自己的查找(`dictionaryFor`:精确 tag → 主语言子标签 → 英文)覆盖 DSH 语言目录里没有的第三语言,繁体 tag(zh-HK / zh-MO / zh-TW 与 `Hant`)归到 zh-hk 词典,`pt-BR` 这类区域 tag 落到主语言。
- **语言跟随 DSH 的 `ctx.locale`,切换即时生效**。字典不在激活期被捕获:每次查表按当时的 active tag 取、按 tag 缓存;卡片外面包一层 `LocaleLive`,订阅 `locale.subscribe` 在语言切换时重绘,不需要刷新页面。
- **新增守护测试「每本词典的键集与中文完全相等」**(替代原先只比 zh/en 的断言):缺键在查表时只会**静默回退英文**,面板会呈现半翻译状态,所以 19 本词典逐本与 zh 的键集做全等断言;另加「查找必须是活的、不得在激活期捕获」断言,含 mock locale 服务下的真实渲染(切到 ja / de / zh-Hant-TW / pt-BR 各自出词,空 tag 回退英文)。
- **译文为机器辅助翻译,欢迎在 issue / PR 里修正**。每门语言只占 `LOCALES` 表里的一处,互不影响——改一门不碰其他门,也不碰 zh/en 内联词典;键集断言会在改动后立刻校验。
- **顺带修掉两处过时文案/文档**:卡片描述与 host 侧注释仍写着「默认关闭 / default OFF」,而 v0.10.0 起 `posixPaths` 已是**默认开启**(文案改为「默认开启 / on by default」,注释标注 v0.10.0);README 与 README_EN 的「POSIX 路径指示(v0.7.0)」一节停留在 v0.7.0 的旧行为(只讲 `systemPrompt.context` 一条指示),已重写为「POSIX 路径方言」——门控开关、源头替换、参数翻译、结果回流、`DSH_PATH_DIALECT` 运行时事实逐条写明。另补上 README / README_EN / AGENTS.md 文件末尾缺失的换行。
- 冒烟测试 34 → 35 项,`npm test` 全绿。
- 相关:[Release v0.15.0](https://github.com/KannaKuron/dsh-gitbash-shell/releases/tag/v0.15.0)

## v0.14.0 — 2026-09-15

**类型**:feat + fix

- **适配 dsh 0.1.6-alpha.1:物化时按宿主拼法对齐工作流引擎行(致命项修复)**。新版把内置预设的引擎行从 `workflow-worker-thread` 改名为 `workflow-ptc`,并**删除**了旧包(`packages/workflow/workflow-worker-thread` 整包消失)。组合里一行 import 失败会拒绝**整棵 preset 挂载**(agent-presets `mount.ts`),所以四个 Git Bash 变体在 0.1.6 上会直接不可用。修复不是再加一套 era 资产,而是**从宿主内置 preset 现场抄**:`rowFormsOf` 读出内置 `ptc`/`standard`/`cordis` 的引擎行拼法(id + 包名 + `disabled`),`alignEngineRow` 在物化时把资产里的那一行改写成宿主的形态。纯字符串手术(绝不 YAML parse→dump,`!!js` 照旧安全)、幂等、**探测失败即 no-op**——旧宿主保持逐字节原样。
- **同步 `tool-ralph` 的新默认**:0.1.6 起四个内置预设都给它加了 `disabled: true`(工具描述把 ralph 限制为「人类显式要求」)。`alignRalphRow` 按宿主默认对齐,不让物化出的 preset 替部署偷偷打开一个已被关掉的工具。
- **执行器适配新版的受保护钩子契约**:`runArgv` 的返回值从裸 `ShellRunResult` 变成 `{ result, spawnRequested }`,旧写法会把包装对象当成结果展开,调用方拿到的对象**没有 exitCode、没有任何输出流**——Windows 上(本插件的主场)受影响最重。`unwrapRunArgv` 按形状解包,并区分「准备阶段被取消、argv 从未 spawn」(`spawnRequested: false` 时不标注 `unconfined`)。
- **`start()` 契约自适应**:0.1.6 把 `start` 从同步改成 `async`,而旧宿主仍按同步消费返回值。`baseStartIsAsync()` 在加载期探测基类形态,据此返回普通句柄或 Promise——绝不让同步宿主收到一个 thenable。
- **`confine()` 透传取消信号**:新版的沙箱 provider 接受调用方的 `AbortSignal`(基类会传第三个参数)。插件原样转发,旧 provider 忽略多余参数,行为不变。
- **marker 新增 `rows` 维度**:宿主形态翻转时 `syncDecision` 自动重物化(与 `base` / `persona` / `present` 同一套模式),升级顺序无关。
- **AGENTS.md 新增第 9 条「适配新版 dsh 的核对纪律」**:每次跟随升级必须对四个内置 preset 做结构化行序列(`- id:` / `name:` / `disabled:`)与提示词的完整 diff,而不是只看本站资产的自身 diff。
- 冒烟测试 29 → 34 项:行形态读取/对齐/幂等/反向降级、物化端到端与 marker 记录、`syncDecision` 翻转、资产不得写死新包名、执行器双 era 契约。

## v0.13.2 — 2026-09-13

**类型**:fix

- **Windows confined 调用改走不受限执行并如实标注**([issue #1](https://github.com/KannaKuron/dsh-gitbash-shell/issues/1),已关闭):MSYS2 无法在 dsh-sandbox-windows-acl 的 restricted token 下启动——msys-2.0.dll 的 cygheap 映射与 signal pipe 的 DACL 只含用户 SID,而 WRITE_RESTRICTED 的 pass-2 写检查要求 restricting-SID ACE,故 DLL 初始化即死于 `Win32 error 5` / `0xC0000142`(0.6.0 起所有版本如此;cmd/pwsh 走匿名管道不受影响)。修复:win32 的 read-only / workspace-write 调用改经 `runArgv`/`startArgv`(不受限执行),结果 sandbox 字段标注 `enforcement: 'unconfined'`,并输出实例级一次性 console.log 提示;fs 工具沙箱不受影响(另一层)。红线:绝不静默假成功——要么真受限、要么明示 unconfined、失败如实带错误码。社区同类取舍:绕过(zimzaza4/dsh-bash-win、Jyleaves/dsh-win-bash-fix)vs 拒绝(liceses/dsh-gitbash-preset),本插件选绕过 + 如实标注。
- **本机复现记录(2026-09-13,发布后补做)**:直接以官方 AclSandbox(sandbox-windows-acl)workspace-write 模式驱动 bash.exe,stderr 逐字出现 `CreateFileMapping S-1-5-21-…-1001.1, Win32 error 5` fatal error(与 issue #1 补充报告一致);同一 argv 不经 confine 直接 spawn 则 exit 0 正常——证明根因在受限令牌而非 bash 安装,且修复采用的 runArgv 路径本身可用。
- 冒烟测试新增 executor 用例(new Function 驱动真实类体 + mock 执行链,断言 win32 confined 分支走 runArgv 并如实标注),29/29 全绿。
- 相关:[issue #1](https://github.com/KannaKuron/dsh-gitbash-shell/issues/1) · [Release v0.13.2](https://github.com/KannaKuron/dsh-gitbash-shell/releases/tag/v0.13.2)

## v0.13.1 — 2026-09-10

**类型**:fix

- present 行探测不再单靠包解析——shipped 组合文本(roster 探针)为权威,CLI 安装与 linked 树均正确;包解析降为 OR 兜底。
- 加 npm version 脚本同步 dsh.plugin.json 与 package.json,并新增版本一致性冒烟断言。

## v0.13.0 — 2026-09-10

**类型**:feat

- 同步 dsh 0.1.5-alpha.2:官方 present 行(不可变文件交付卡片)在物化时按宿主能力探测注入(`hostHasToolPresent`),**绝不写进资产**(组合里一行 import 失败会拒绝整棵 preset 挂载);marker 记录能力,宿主升级自动重物化补行。
- minimal 变体同步官方单工具化:删 filesystem 组、网络行改环境相关、banner 与描述改单工具措辞。

## v0.12.0 — 2026-09-08

**类型**:feat

- persona 拆分 era(dsh 0.1.3-alpha.2):`.ps` 组合孪生 + roster persona 形态探针;候选链 `.ptc.ps.yml` → `.ptc.yml` → `.ps.yml`(minimal)→ 基文件,升级顺序无关,smoke 20 项。

## v0.11.1 — 2026-09-05

**类型**:chore

- package.json 声明 `engines.dsh`(插件市场「宿主要求」显示面)。

## v0.11.0 — 2026-09-04

**类型**:feat

- `DSH_PATH_DIALECT` 进驻官方 `dsh-shell-env` 注册表:`ctx.inject(['shellEnv'])` 服务就绪即注册贡献者 `gitbash-shell`;resolver 每次执行读活设置(关→空),unregister 随插件 fiber 可逆。与提示词源头替换互为印证。

## v0.10.5 — 2026-09-02

**类型**:feat

- ptc-era 变体同步 dsh 0.1.2-alpha.4:`tool-workflow` 行 `disabled: true`(官方 #3425:`run_code` 为唯一模型编排面);smoke 增加 era 断言。

## v0.10.4 — 2026-09-01

**类型**:feat

- 输出侧回流:成功结果的路径元数据(read/write 的 path、glob paths、grep matches 相对路径归一)经 tools/post-execute 改写回 MSYS 方言;文件内容行与错误结果不动。

## v0.10.3 — 2026-09-01

**类型**:fix

- 设置卡槽注册是两段式(`slots.inject` 洞回调内 `return slots.register`)——直接把 (options, component) 当 inject 参数会静默不注册。

## v0.10.2 — 2026-09-01

**类型**:fix

- 翻译层改经 `exec.arguments` 整体替换——registry 在构造 exec 时即 deepFreeze(arguments),原地写入被防御吞掉、静默不翻译(0.10.0/0.10.1 真机 read /c/ 报 C:/c/...)。smoke 加冻结输入用例。

## v0.10.1 — 2026-09-01

**类型**:fix

- client 半 factory **必须 return module.exports**——漏 return 时模块物化为 undefined,浏览器插件行报 invalid plugin(0.9.0 埋雷、0.10.0 首启才炸)。

## v0.10.0 — 2026-09-01

**类型**:feat

- 源头替换:开启 posixPaths 时 system-prompt/assemble waterfall 把官方提示词里的 Windows 绝对路径**原位替换**为 /c/ 盘根(不删减官方内容、不动工具 schema);方言默认开启;指令缩为一句纯事实。

## v0.9.0 — 2026-09-01

**类型**:feat

- 统一 POSIX 路径方言设置化:默认关闭,由 settings 命名空间 gitbash-shell 的 posixPaths 门控;client 半(手写 ModuleLoader bundle)注册设置卡。

## v0.8.0 — 2026-09-01

**类型**:feat

- 全工具统一 POSIX 路径方言 + MSYS 根翻译层(host 侧 tools/execute wrapper 把路径字段 /x/ 前缀改写为 X:/)。

## v0.7.2 — 2026-09-01

**类型**:fix

- inspect-registry shim 改 `ctx.inject` 服务就绪安装(对齐 ptc 0.6.3)——apply 期一次性采样时宿主 runner 行尚未激活,shim 静默未安装,双 cordis 模式即撞 already registered。

## v0.7.1 — 2026-08-31

**类型**:fix

- POSIX 指令文本只写 /c/ 形式(盘符形式被隐式排除)。

## v0.7.0 — 2026-08-31

**类型**:feat

- Git Bash 会话全局 POSIX 路径指令(systemPrompt.context,order 126,Win32)。

## v0.6.0 — 2026-08-29

**类型**:feat

- 双 era 组合文本与 marker.base:dsh 0.1.2 把内置 code preset 改名 ptc;各变体备双 era 已提交文本,`detectBase` 每启动探测 roster 选文件,preset id 永不随官方改名。
- **真机验证(2026-08-29,dsh 0.1.2-alpha.1)**:三个物化变体 marker 全为 `base:"ptc"`、`standingKeyFor` 挂载全 OK、roster 无重复/无 broken/无 orphan;此前本机为 ≤ 0.1.1(code era 双向验证的另一半)。

## v0.5.5 — 2026-08-23

**类型**:docs

- package/manifest 描述提及 better-sidebar 适配。

## v0.5.4 — 2026-08-23

**类型**:fix

- better-sidebar 配置编辑的块标量 !!js 表达式(配置值走字面文本)。

## v0.5.3 — 2026-08-23

**类型**:fix

- 同时设置 boot-time `config.shell`,终端标签页显示 bash。

## v0.5.2 — 2026-08-23

**类型**:fix

- 设置服务改轮询(单次静默尝试会错过晚激活)。

## v0.5.1 — 2026-08-23

**类型**:feat

- Windows 上无条件接管 better-sidebar 终端 shell。

## v0.5.0 — 2026-08-23

**类型**:feat

- 经 better-sidebar 设置缝(terminalShell)接管终端 shell。

## v0.4.4 — 2026-08-23

**类型**:docs

- 修复重复配置标题;manifest 描述与版本同步。

## v0.4.3 — 2026-08-23

**类型**:docs

- 移除 TUI/cc-tui 引用(官方 dsh 无 TUI 面)。

## v0.4.2 — 2026-08-23

**类型**:ci

- node 24 + setup-node@v6(OIDC 要求 npm ≥ 11.5.1)。

## v0.4.1 — 2026-08-23

**类型**:ci/docs

- npm 安装通道与 trusted publishing(OIDC)文档;发布 workflow 切 OIDC(零令牌)。

## v0.4.0 — 2026-08-23

**类型**:feat

- 预设元数据按官方 shipped 顺序排序,物化清单可按 profile 配置前置版本。

## v0.3.0 — 2026-08-23

**类型**:feat

- 可配置物化清单(`gitbash-presets` 行配置)+ 孤儿清理 + 默认预设指引。

## v0.2.0 — 2026-08-23

**类型**:feat

- 发布 `gitBash` 宿主能力服务(`{ active, bashPath }`)供 dsh-ptc-cordis-preset 联动;修复 presets 行挂载包根(./presets 子路径从未导出)。

## v0.1.0 — 2026-08-23(无独立版本 tag)

**类型**:feat

- 首版:Windows 上把 dsh 的 ctx.shell 换成 Git for Windows bash;物化 standard/minimal/code/cordis 的 Git Bash 变体(哈希标记管理、卸载清理)。
