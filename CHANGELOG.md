# Changelog — dsh-gitbash-shell

> 倒序排列,新版本条目在最上面。条目格式:`## vX.Y.Z — YYYY-MM-DD` + 类型(feat / fix / docs / chore)+ 要点 + 相关链接。
> 纪律见 AGENTS.md「变更记录纪律」:发版前先更新本文件并随版本提交;事故复盘、复现与真机验证记录也记在这里。

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
