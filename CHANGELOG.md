# Changelog — dsh-gitbash-shell

> 倒序排列,新版本条目在最上面。条目格式:`## vX.Y.Z — YYYY-MM-DD` + 类型(feat / fix / docs / chore)+ 要点 + 相关链接。
> 纪律见 AGENTS.md「变更记录纪律」:发版前先更新本文件并随版本提交;事故复盘、复现与真机验证记录也记在这里。

## v0.28.0 — 2026-09-26

**类型**:fix(issue #11 —— Git 没装在 `C:\Program Files\Git` 时,写死的默认 `bashPath` 让每条命令 `spawn … ENOENT`,而整个会话的命令能力归零且无提示)+ feat(fail-loud 引导:弹窗可填写路径 / 可跳转下载)

> 报障:https://github.com/KannaKuron/dsh-gitbash-shell/issues/11(Windows 11,Git 装在 `Q:\Git`;作者是另一台 DSH agent「蓝鲸」,诊断准确、自带 workaround)。两条用户口径逐字确立:**"默认用设置里填的 空的就去默认路径 没有就去用户环境path 和 系统path找 还没有就报错,弹窗让他去下载或者去设置里填写路径,而且要支持点击转跳过去"**;**"绝对不能因为找不到就用pwsh … 绝对不能用wsl"**。

### 一、默认值假设被推翻:解析链接管
- **起因**:`cordis.patch.yml` 把 `gitbash-executor.config.bashPath` 写成 `C:/Program Files/Git/bin/bash.exe`;Git 装在别处 ⇒ 每条命令 ENOENT。更糟的是本插件撤掉 `pwsh-sandbox` 而 dsh 每进程只允许一个 `ctx.shell`,于是**连原本可用的 pwsh 也一并没了**,且没有任何提示。
- **新解析链(`src/bash-path.js`,唯一实现;执行器 `src/shell.js` 与翻译层 `src/index.js` 共用同一 memo)**:
  **设置里填的**(`gitbash-executor` 行 config > `gitbash-shell` 行/设置卡;用 `ctx.loader.resolve('gitbash-executor')` 让翻译层看到同一个显式值,显式值失败也不换别的) → **默认安装位置**(Program Files / Program Files (x86) / ProgramW6432 / LOCALAPPDATA) → **PATH 逐目录 `bash.exe`** → **PATH 上 `git.exe` 反推** → **注册表 `Path`**(HKCU + HKLM,`reg query` 走 argv 数组) → **失败**。
  `cordis.patch.yml` 的 `bashPath` 默认改为**空串(=自动)**。
- **只认 Git for Windows(用户第二条口径)**:黑名单先于探测(`system32`/`windowsapps`/`msys`/`cygwin`/`wsl`,归一化后逐段匹配 —— System32 是头号陷阱,它永远在 PATH 上);正向判据 = `<root>/cmd|bin/git.exe` + `<root>/usr/bin/bash.exe` + (`<root>/mingw64` 或 `usr/bin/msys-2.0.dll`);指纹 = `git --version` 含 `.windows.`;**一票否决** = 实跑候选 `bash -c "uname -s"` 必须是 `MINGW32_NT-*`/`MINGW64_NT-*`(`Linux`/`MSYS_NT-*`/`CYGWIN_NT-*` 一律不合格)。全部候选失败 ⇒ `{ ok:false, path:'' }`,**绝不返回替补 shell**。
- **永不回退(用户第一条口径,写进 AGENTS §4h)**:`pwsh-sandbox` 仍是无条件 `disabled: true`(与 bash 健康无关);`src/shell.js` 每次 argv 都过 `requireBashPath()`,解析失败**直接 throw 带引导的错误**(不再让用户只看到裸 ENOENT);冒烟守卫断言 patch 里没有 `!!js` 条件、执行器源码不出现 `pwsh.exe`/`powershell.exe`/`cmd.exe`/`wsl.exe`/裸 `bash`。

### 二、fail-loud 与可点击引导
- **启动日志**:完整报告 —— 当前 `bashPath` 取到什么 / 按顺序探测过哪些位置(逐条 code+detail)/ 去哪里改 / 下载链接 / "本插件不会回退到 PowerShell"。
- **客户端弹窗**(`shell.overlay`,仅 win32 且 `ok:false`;同 boot 一次、`sessionStorage` 记关闭;21 语言新增 6 个 `bashmiss.*` 键):探测清单 + **内联 bashPath 编辑框(写 `configForms` 的同一字段,保存落盘到 profile 的 `cordis.patch.yml`)** + **「去下载 Git for Windows」**(`window.open`,Electron 下走外部浏览器)+ 关闭。
- **写入判定按宿主的布尔返回值(验收反馈修复,commit 见下)**:`ConfigForm.set()` 的契约是 `Promise<boolean>` = **Host 是否接受这次写入**。原先弹窗与设置卡的 bashPath 保存都**丢掉该返回值**、无条件显示「已保存」⇒ Host 拒绝时会**假成功**(与 §4h「绝不静默假成功」同一条纪律)。现在两处都按 `accepted === true` 决定成败,拒绝时显示 `bash.saveFailed`(21 语言,含"确认路径存在且是 Git for Windows 的 bash / 查看宿主日志"的下一步),并处理"没有 form 座位"这一同类情形(同样是拒绝而不是成功)。
- **数据通道**:host 半注册 `GET /dsh-gitbash-shell/api/status`(`ctx.inject(['webServer'])` 可选服务,家族既有范式同 dsh-ide-git),客户端**在 effect 里 fetch**(不在 apply 取服务,避开客户端半的取服务竞态);`gitBash` capability 同时**加法**扩展为 `{ active, bashPath, ok, source, configured, tried, downloadUrl }`。
- **深链实测结论**:官方设置页**没有**公开 API 能跳到指定插件的设置卡 —— `openSettings`/`openSection` 只发给 `settings.launcher`/`settings.onboarding` 占用者,面板开关状态是 `ui-settings-general` 私有的 store,`ctx.shortcuts` 也没有"按 id 执行命令"的入口。因此弹窗**自带编辑器**(用户不必去找设置页),文字指路作为兜底;上游若开放深链 API,这里可以直接换成按钮跳转。

### 三、验证
- `npm test` **93/93 绿**(新增 7 条:解析链显式优先且**失败不替换** / 默认→PATH 含陷阱拒绝 / 只认 Git(WSL+MSYS2+Cygwin+`.windows.`+`uname` 矩阵)/ 全落空报告含引导与下载链接 / **无回退守卫** / 弹窗形状与 21 语言 / 路由与 capability 形状);`tests/align-official.mjs` 四变体仍逐字节对齐。
- **真机(隔离 `DSH_HOME` + 插件副本强制 win32 门 + 无头 Chrome/CDP,macOS)**:
  - 启动日志打出完整报告(15 条探测记录,含 `missing`/`bad-shape` 分类);
  - `curl /dsh-gitbash-shell/api/status` → `{"ok":false,"platform":"win32",…}`;
  - **弹窗渲染**:标题「找不到 Git Bash —— 命令无法执行」+ 按钮 `[保存, 去下载 Git for Windows, 关闭]` + **12 条探测清单** + 输入框;
  - **下载动作**:「去下载」点击后 `window.open` 收到 `https://git-scm.com/download/win`;
  - **内联编辑**:填入 `Q:/Git/bin/bash.exe` → 保存 → 卡片显示「已保存」,**宿主侧落盘** `profiles/verif/cordis.patch.yml` 的 `bashPath: Q:/Git/bin/bash.exe`;
  - **一次性**:关闭后刷新页面不再出现(会话内已记)。
  - 过程中自查修掉一个真缺陷:一次性判定原先写在 render 里(设标志的那次渲染之后的**任何 re-render 都会让弹窗消失**),改为在 effect 中决定 + 本地 state 呈现。
- **拒绝态实测(隔离实例 + 副本把 host 写入强制为 `false` + 无头 Chrome/CDP)**:`showsSaved=false`、`showsFailure=true`,界面显示
  「写入失败: 保存未生效:宿主拒绝了这次写入 —— 确认路径存在且是 Git for Windows 的 bash,或查看宿主日志」,零 pageerror;
  弹窗此时仍有「去下载 Git for Windows」与探测清单作为下一步。`npm test` **94/94**(新增第 8 条守卫:两处写入都必须看布尔返回值、不得出现无条件 `setBashSaved(true)`、21 语言失败文案齐)。
- **未验证(如实标注,需 issue 作者在 Windows 真机复验)**:注册表 `Path` 兜底、真实 Git 安装布局、WSL/WindowsApps/MSYS2 实机路径的拒绝行为(均为 fake io 单测 + 静态核对);深链不可用是上游能力缺口。
- 相关:issue #11 https://github.com/KannaKuron/dsh-gitbash-shell/issues/11

## v0.27.0 — 2026-09-25

**类型**:feat(新设置「子代理/队员是否也使用 Git Bash」,默认开启 —— 用户 2026-09-25 追加需求)

### 需求与语义
用户原话:「gitbash 插件也是专门给个设置是否让子代理或者子队员使用 gitbash,默认启动。」

- **开关 `subagentDialect`(本插件行 Config 的 volatile 布尔,**默认 `true`**;旧宿主 ≤0.1.6 在 settings 命名空间 `gitbash-shell` 声明同名字段,**缺键 = true**)。
- **开(默认)**:委托代理 —— 子代理(`subagent`/`subagent_fork`)、团队队员(`spawn_teammate` 走 continuable-subagent 的 `spawn`/`fork`)、**嵌套子代理** —— 与主代理享受同一条方言链路。
- **关**:方言只对主代理生效,委托出去的请求回退官方 shell 语义(提示词不改写、路径参数不翻译、结果/报错不回显为 MSYS、`run_code` 程序字面量不翻译、不下发 `DSH_PATH_DIALECT`)。

### 委托身份的判据(先查清链路,再动代码)
- 用**会话头**判定:`origin === 'subagent' || delegationDepth > 0` —— 与 dsh 自己的 `packages/deliverables/workspace-changes/src/index.ts:59-60` 同一对字段;由子代理驱动在 `packages/subagent/subagent/src/child-agent.ts:139-155` (`childSessionMeta`) 打上,`spawn`/`fork` 两种 provider 与嵌套深度都走它。
- 纯函数 `isDelegatedAgent(agent)` + 唯一判定点 `dialectApplies(dialect, agent)`;条件挂在 `assembleContext.agent`(`packages/core/agent/src/dispatch.ts:174` 的 `assembleContextFor` 传 `{ agent, scope }`)与 `exec.agent` / `execution.agent` 上。
- **未知形状一律视为"非委托"**(保留方言):判定不出来时按主代理处理。

### 覆盖到的五个消费点(全部接同一个 gate,避免"半方言")
① `system-prompt/assemble` 的源头改写与 run_code 句;② 指令 context 的 `text(context)` provider;③ `tools/execute` 的入参翻译 + 成功面回显;④ `tools/post-execute` 的失败面 `content`/`error.message`;⑤ `shellEnv.resolve(execution)` 的 `DSH_PATH_DIALECT` 事实。

### 能力边界(如实写明,写进 README/AGENTS)
dsh **每个进程只有一个 shell 执行器**(`ctx.shell` 是单例服务),所以 **Git Bash 二进制本身仍是全局的**,本开关管的是**方言/翻译层**;关闭后委托代理见到与写出的是 Windows 形式路径,而 Git Bash 同样接受 `C:/...`,行为自洽。

### 测试与证据
- 冒烟 **86/86 绿**:新增 3 条(① `isDelegatedAgent`/`dialectApplies` 矩阵:origin、depth 1/2、root、未知/抛错/`agent` 缺失,以及卡片写入断言;② OFF 时主代理保留、委托代理被挡 + 五个消费点都接 gate 的源码断言;③ 旧宿主/老配置**缺键 = true** 的回退);`tests/align-official.mjs` 四变体仍全绿(本版不动组合)。
- **真机两态(隔离 `DSH_HOME` + 新建 profile + 插件副本 `link:` 安装,真实 dsh 0.1.7-rc.2,本机 macOS)**:探针用 `ctx.agents.create()` 造**真**的 root / child(`origin:'subagent', delegationDepth:1`)/ nested(depth 2)三个 agent(实测会话头 `undefined` / `"subagent":1` / `"subagent":2`),再对每个 agent 调**真的** `ctx.systemPrompt.assemble({ agent, scope: agent })`:

  | 开关 | main(root) | subagent | nested |
  | --- | --- | --- | --- |
  | **默认 ON** | 方言指令 = yes | **yes** | **yes** |
  | **OFF**(行 Config `subagentDialect: false`) | yes | **no** | **no** |

  ⇒ 两态下委托代理的方言确实不同(指令 context 出现/消失即 gate 的可观测面),主代理两态都保留。
  **平台说明**:macOS 上方言/执行器面本来被 `process.platform === 'win32'` 门控,本次把**插件副本**的两处组装门(`system-prompt/assemble` 与指令 context)强制打开以取得请求级证据(报告中如实标注);**win32 真机仍未覆盖**(执行器是单例,与方言开关无关,不受本版影响)。
- 设置卡:方言区新增一行(21 语言 `sub.label`/`sub.hint`),写入本行 `subagentDialect`;文案明确"二进制仍全局、此开关管方言/翻译层"。

- 相关:用户需求(2026-09-25 追加);实现不变量见 AGENTS.md §4g,验证装置见「验证清单」第 8 条。

## v0.26.1 — 2026-09-25

**类型**:fix(v0.26.0 的 workflow 互斥按「意图」而非「生效态」收敛:后端不可用时用户会白丢 workflow 能力)

> v0.26.0 把互斥条件写成「对方能力报 `pythonRuntime: true`」——那是**用户意图**。当对方的 preflight 失败(包被移除、解释器不合格、Windows),`!!js` 兜底与组合实际仍跑 Node,而本插件却已经把四个变体的 `workflow-ptc`/`tool-workflow` 关掉了:用户白丢一项能力,且卡片显示"已开启"与实际不符。dsh-ptc-cordis-preset **v0.15.1** 在能力服务上加了**加法字段** `pythonBackend: 'python' | 'node'`(用与 `!!js` 完全相同的合取计算),本版据此收敛。

- **① 互斥只在真正生效时发生**:新增纯函数 `pythonBackendActive(capability)` = 「意图 `pythonRuntime` 为真 **且** 生效态为 `'python'`」;`pluginsFor({ …, pythonActive })` 的形参由 `pythonRuntime` 改名 **`pythonActive`**,语义写明「run_code 实际会用的后端」——`workflowOn = kind !== 'ptc' && pythonActive !== true`。
- **② 旧 peer 回退(兼容硬要求)**:`peerBackend()` 对缺字段 / 类型不符 / getter 抛错一律返回 `undefined`(绝不把"没报"读成 `'node'`),`pythonBackendActive` 此时**用意图顶替** ⇒ 对方 < 0.15.1 的行为与 v0.26.0 **完全一致**,不会因缺字段崩溃或改变既有联动。
- **③ 日志把"真换了"与"想换但没生效"分开**:生效 → `peer reports the experimental CPython run_code backend: workflow rows go off in every variant`;意图 on 但未生效 → `peer has the CPython switch on but the effective backend is node|unreported (older peer: the intent stands in): workflow rows stay on (reason in the host log)`。
- **④ 卡片显示真实状态(防御性实现,当前不可达)**:从**同一份 peer 快照**读可选的 `pythonBackend`;意图 on + 生效 `node` ⇒ 状态值显示「Python(实验性) · **后端不可用,当前仍为 Node(原因见宿主启动日志)**」并另起一行红字;新增第 7 个词典键 `python.degraded`(**21 门语言**同齐)。字段缺省(旧 peer)⇒ 卡片与 v0.26.0 **逐字节一致**(不显示降级态)。
  - **可达性拆分(Lead 裁决 A,2026-09-25)**:**「意图 on + 生效 node」这个状态本身是可达的** —— ptc 侧不拒绝把意图落成 true(Lead 明确不授权任何"单方面回写用户 settings 表单值"的行为,即不做"点开关被拒绝")。**不可达的是本插件这行降级显示**:浏览器侧只能读 `configForms.get('ptc-cordis').getSnapshot().value`(该行 **Config / settings 表单**),而 `pythonBackend` 只挂在**能力服务**上(宿主侧,浏览器读不到),ptc v0.15.1 的 Config schema 里没有该字段。因此现状是:ptc 卡显示 on + 红字原因,**本插件卡只显示 on**(hint 已指向宿主日志)。
  - **后续项(本轮不做,避免再开一轮发布)**:由对方用**加法只读字段**把 `pythonBackend`/`pythonIssue` **投影进行 Config 快照**(不动用户意图字段 `pythonRuntime`);那一刻本插件**无需改动**即自动亮起(读的就是同一个键)。已记入最终报告的「已知限制/后续项」。
- **测试**:冒烟 **83/83 绿**(改写 2 条到 `pythonActive` 语义 + 新增 3 条:①生效态矩阵含旧 peer 回退与闭集校验 ②降级意图只上报不驱动 ③卡片降级态与 21 语言文案);`tests/align-official.mjs` 四个变体仍全绿(本版不动组合的官方行形态)。
- **真机 A/B/C(隔离 `DSH_HOME` + 新建 profile + `link:` 安装 + 探针能力,dsh 0.1.7-rc.2,本机 macOS,端口 3262-3264,收尾已清理)**:探针分别报三种能力形态,读数(`readDocument()` 的 `disabled`)与日志三例全部符合预期:

  | 探针能力 | 日志 | 四变体的 `workflow-ptc`/`tool-workflow` |
  | --- | --- | --- |
  | `{pythonRuntime:true, pythonBackend:'python'}` | `peer reports the experimental CPython run_code backend: workflow rows go off in every variant` + 四条 `retired … (peer CPython backend changed; rows are rebuilt)` | **`disabled: true`**(互斥生效) |
  | `{pythonRuntime:true, pythonBackend:'node'}` | `peer has the CPython switch on but the effective backend is node: workflow rows stay on (reason in the host log)`(**无**重建日志,行未变) | **保持启用**(`standard/cordis-gitbash` 不丢 workflow;`code-gitbash` 本就关) |
  | `{pythonRuntime:true}`(旧 peer,缺生效字段) | 与第一行相同(意图顶替) | `disabled: true` —— 与 v0.26.0 行为**逐字节一致** |

- 协作边界:v0.15.1 的 `pythonBackend` 是**加法字段**,本插件零形状破坏;`pythonRuntime` 仍是两侧卡片读写的权威**意图**字段。发布后由 contract-rc2 在 task-10 复验两条通道一致性。

## v0.26.0 — 2026-09-25

**类型**:feat(run_code 的实验性 Python 后端开关,与 dsh-ptc-cordis-preset 双向联动)+ fix(issue #10:JSON 转义的 Windows 路径多出前导斜杠)+ chore(dsh 0.1.7-rc.2 增量对齐复核)

### 一、issue #10:JSON 转义的 Windows 路径多出前导斜杠(报障 @youyv)

> https://github.com/KannaKuron/dsh-gitbash-shell/issues/10 —— `windowsToMsys('"D:\\\\dsh\\\\工作"')` 得到 `"/d//dsh/工作"`,期望 `"/d/dsh/工作"`。

- **根因**(与报障者的定位一致,独立复核后确认):两个正则的**盘符后分隔符原子都只吃一个**(`(?:\\|\/)`),而生产输入是**JSON 转义**形态 —— 宿主 `packages/sandbox/sandbox-policy/src/index.ts:47` 用 `${JSON.stringify(policy.workspaceRoot)}` 渲染 `sandbox:policy` 上下文行,于是进入提示词的字面文本带**双反斜杠**。第一个反斜杠被原子吃掉,第二个留在 `rest` 头部,`rest.replace(/[\\/]+/g,'/')` 把它归一成**前导斜杠** ⇒ `/d/` + `/dsh/工作` = `/d//dsh/工作`。缺陷点:`src/index.js:960`(`BARE_WIN_PATH`)、`src/index.js:961`(`QUOTED_WIN_PATH`)、合成点 `src/index.js:967-970`;对照组整值字段走 `driveToMsys()`(带 `^\/*` 剥离)一直正确 —— **只有散文改写器在 JSON 转义输入下坏掉**。
- **修法(用户批准的方案 A)**:两处原子改为 `[\\/]+`(一次吃光盘符后的全部连续分隔符)。单分隔符输入逐字节不变;`D://dsh//工作` 也一并收敛。**没有**对整段文本 collapse `//`(本文件其它地方把 UNC 拼成 `//server/share`,全局收敛会破坏该形态)。
- **回归测试**:冒烟新增 `windowsToMsys keeps JSON-escaped Windows paths canonical (v0.26.0, issue #10)` —— 引号分支 + 裸分支、`JSON.stringify('D:\\dsh\\工作')`、`D://dsh//工作`、带空格目录,外加 UNC / URL / `file://` / 已 MSYS 形态的负例。
- **影响面**:仅"盘符后紧跟 ≥2 个连续分隔符"的文本;三面(`system-prompt/assemble` 的 sections/contexts/variables 与失败 content / error.message)共用该纯函数,同时受益、不会产生方言分歧。语义上是**规范性**修复(Windows 与 MSYS 本来都会收敛中间的 `//`),不是权限或功能故障。

### 二、dsh 0.1.7-rc.1 → rc.2 增量对齐复核(AGENTS.md §9)

- **官方预设文本逐字节未变**:`packages/bundle/web-app/presets/{standard,cordis,ptc,minimal}.patch.yml` 在 rc.1→rc.2 的 sha256 **完全一致**(`git diff dsh-v0.1.7-rc.1 dsh-v0.1.7-rc.2 -- packages/bundle/web-app/presets/` 为空),所以 `src/compositions.js` 的行数据与 `PLAN_SECTION` 本版无需重新对齐。
- **新增可复跑的核对工具 `tests/align-official.mjs`**:按 §9① 抽官方 patch 的 `- id:` / `name:` / `disabled:` 行序列(含嵌套组层级),与本插件四个变体逐条对比,并**钉住 rc.2 的四个 sha256**;官方文本将来变化时会以 `DRIFT` 明确报警而不是静默漂移。当前结果:**四个变体 × unix/win32 两个分支全绿**,唯一的差异是文档化的 Git Bash 增量(bash 行常开、pwsh 行常关)。
- **执行器 / 路径方言 / 沙箱面**:rc.1→rc.2 的 `packages/shell/bash-local`、`bash-sandbox` **只有版本号 bump**,`ShellExecutor`/`Config`/`confine` 契约无变化 ⇒ 本插件执行器半无需改动。rc.2 的真实改动集中在 `@deepseek-ai/dsh-tool-bash`/`tool-pwsh` 的**描述文本搬迁**(description → 参数描述、新增 `sandboxPermissionsDescription`)、`tool-*-persistent` 的代理对截断修复、`sandbox` 的 escalation `displayReason`、boot/plugin-manager 的 profile 并发保护、client UI。本插件不消费这些描述文本,启动的翻译层/执行器面不受影响(rc.2 新增的 `PreToolDecision.ask.displayReason` 是可选字段,本插件不产 `ask` 决策)。
- **exports / manifest / peer 复核**:rc.2 新增 `packages/boot/app-boot/src/package-meta.ts`(插件图标与 locale 显示元数据走 exports map,**不执行插件代码**)。本插件已具备 `./package.json`、`./locale/*.json`、`./client`、`./shell`、`.` 五条导出 + `icon.svg` + `dsh.client.platform: 'web'` + `dsh.bundle.patch`,与 rc.2 的解析规则一致(`packages/client/modules/src/index.ts` 的 `locatePkgJson()` 在 rc.2 未变),无需改动。
- **工具面覆盖复核(§9⑥)**:rc.2 未新增/改动带路径参数的工具 schema(`read/write/edit/read_image/glob/grep/present/bash` 的字段名与嵌套形状不变),`TRANSLATABLE_PATH_FIELDS` + present 嵌套覆盖仍然完整。

### 三、run_code 后端开关:实验性 Python(与 dsh-ptc-cordis-preset 双向联动,默认关)

- **需求**:有时想用 Python 跑 `run_code`(少踩转义/编码坑),但默认必须与官方逐字节一致;两插件同装时**只在一处改**、两侧即时同步。
- **归属(Lead 裁决 + ptc 定案)**:换掉的是 **profile 级** `ptc-runtime` 行(`packages/bundle/base/cordis.patch.yml:389`),不是 preset 内的行;isolate realm 方案实测无效(provider 落在私有 realm,root 的 `tools` 服务看不到)。所以**运行行只由 dsh-ptc-cordis-preset insert**(它的 `./src/runtime.js` + 条件 disable base 行),**本插件不 insert 任何运行行、不声明该依赖**(两插件各插一行会让 `ptcRuntime` 二次注册)。权威状态 = 对方行 Config 布尔 `pythonRuntime`(默认 false)。
- **本插件侧只做两件事**:
  - ① **镜像设置卡**(`src/client.js`):`configForms.get('ptc-cordis')` 读写**同一个字段** + `subscribe`,任一侧改动两侧立即同步;对方未装或版本无该字段(对方 < 0.15.0)⇒ 整段不画;win32 显示禁用态 + POSIX-only 原因(实验性 CPython 后端在 win32 构造即抛错),按钮不出现。文案 21 语言(`sec.python` / `python.label/on/off/hint/blocked`),写明**重启 dsh 后生效**与**原因见宿主启动日志**(对方不提供 `pythonRuntimeIssue` 这类字段:客户端读不到宿主探测结果,加了就是第二份会漂移的状态)。
  - ② **组合的工作流互斥**(`src/compositions.js` + `src/index.js`):`workflow-ptc` 构造器硬要求 `ctx.ptcRuntime.language === 'typescript'`(`packages/workflow/workflow-ptc/src/index.ts:117`),而 preset 行在**独立 PresetTree** 里挂载、**base 行 disable 管不到它** ⇒ python 后端期间选 standard/cordis 会让该行抛错,`agent-preset-registry` 的 `audit.failed` 直接**拒绝整棵 preset 挂载**。修法与官方 Python 参考组合一致(`snapshots/session/ptc-python-turn/cordis.yml:25-36` 同款禁用两行):对方能力报 `pythonRuntime: true` 时,**四个变体**的 `workflow-ptc`/`tool-workflow` 一律 `disabled: true`(用户 workflow 设置值保留,关掉后端后下次启动恢复);`code-gitbash` 本来就关。
  - **信号来源**:对方能力服务 `ptcCordisPreset` 新增 `pythonRuntime`(boolean 或 getter,读不到一律 false);值变化必须**重注册已在 `live` 表里的变体**(行内容变了,只增删名录不够),日志 `peer reports the experimental CPython run_code backend: workflow rows go off in every variant` + 每条 `retired … (peer CPython switch changed; rows are rebuilt)`。
  - **提示词自动跟随**:后端实例自己提供 `language`(`'typescript'` / `'python'`)与 `executionInstructions`,`packages/core/tools/src/ptc.ts:752` 与 `agent-tool-presentation`(`ctx.inject(['ptcRuntime'])`)据此渲染 run_code 的 SDK 提示词与工具呈现 ⇒ 组合文本两种状态都不变,无需本插件硬编码 Python 文案。
- **测试**:冒烟 +4(`peerFact` 保守读取矩阵、组合的 workflow 互斥矩阵、宿主重注册与"不 insert 运行行"断言、镜像卡的门控/写穿/win32 断言),共 **80/80 绿**。
- **真机验证(隔离 `DSH_HOME` + 新建 web profile + 插件 `link:` 安装 + 探针插件,真实 dsh 0.1.7-rc.2,本机 macOS,端口 3251-3256,未触碰 `~/.dsh` 下任何在用 profile)**:
  - **A(默认关)**:四个变体注册成功,名录 8 项;`readDocument()` 读数 = 官方形态(`standard/cordis-gitbash`:`workflow-ptc`/`tool-workflow` 启用;`code-gitbash`:两者 `disabled: true`;`tool-bash` 启用 / `tool-pwsh` 禁用;`tool-ralph` 全禁用)。
  - **B(探针报 `pythonRuntime: true`)**:出现上面两行日志,四个变体**全部重建**,读数变为两行 `disabled: true`。
  - **两态都做真实挂载**:`agentPresets.acquireScope('<variant>')` 四个变体各返回 `MOUNT OK`(挂载审计无 failed 行),证明显式注册的组合在 rc.2 上确实可挂载,而不只是"注册成功"。
  - **Windows 专属面**:win32 分支(卡片禁用态、宿主拒绝写入、python 后端构造抛错)在 macOS 上**无法真机验证**,按实现 + 单测/模拟记录;本插件的执行器与路径方言层按 `process.platform === 'win32'` 门控,而 python 后端仅 POSIX,两者在各自平台上互不重叠。
- **独立验证(发布后补记,2026-09-25,task-8,由另一位成员执行)**:用 **npm 已发布的 `dsh-gitbash-shell@0.26.0`** + `dsh-ptc-cordis-preset@0.15.0` 在隔离 `DSH_HOME` 上复验 —— **ptc → gitbash 方向联动通过**:把对方的行 Config `pythonRuntime` 置 `true` 后 boot,本插件打出 `peer reports the experimental CPython run_code backend: workflow rows go off in every variant` 以及四条 `retired … (peer CPython switch changed; rows are rebuilt)`;关态 boot **没有**这些行 ⇒ 能力感知 + 变体重建按设计工作(完整报告:`_rc2-contract/PYTHON-SWITCH-VERIFY.md`)。
  - 仍未覆盖(留给集成阶段/真机):**反方向「在 gitbash 卡上改 → ptc 跟随」与两张卡的 UI 即时同步**(headless 无法操作设置卡,需真实 web 实例人工点选;两侧写的是同一个 `configForms` 字段,机制与 v0.25.0 已验证的 dedupe 镜像同构)以及 **win32 真机**(本机无 Windows;静态核对确认 ptc 侧平台表达式与 python 后端 `ptc-runtime-python/src/index.ts:837-839` 的「win32 构造即抛」一致,本插件侧按 `python.blocked` + 不画按钮实现平台限制)。
- 相关:issue #10 https://github.com/KannaKuron/dsh-gitbash-shell/issues/10 ;对方仓库 dsh-ptc-cordis-preset v0.15.0(能力字段与运行行)

## v0.25.1 — 2026-09-24

**类型**:fix(issue #8 —— 路径方言在 dsh 0.1.7 上**整层静默失效**:工具分发面用错了设置读取器;同一次审计另修侧栏终端还原的同类漏网)

> 报障:第三方用户 @youyv 的 https://github.com/KannaKuron/dsh-gitbash-shell/issues/8 —— 在 0.1.7-rc.1 上,`posixPaths` 指示词进了提示词、`DSH_PATH_DIALECT=msys` 也在环境里,但**参数翻译整层不工作**。用户侧的五条最小复现全部命中:文件工具把 `/c/...` 变成 `/c/c/...`、`~` 不展开、`glob`/`grep` 的 `path` 原样丢给原生 `rg`、`bash` 的 `workdir` 不翻译(spawn ENOENT)、工作区内的 `/c/...` 写入被沙箱拒绝(未翻译 ⇒ 落到工作区外)。方向判断也对:"插件翻坏了"与"完全没翻"两种形态混在一起,说明方言层是"半活"的。

- **root cause(一行)**:v0.24.4 的 era 适配(`makeLiveReader`)只改了一部分消费点 —— `tools/execute` 这个**唯一承担入参翻译**的 wrapper 仍在调 `readDialectSettings(ctx)`,而它读的是 `settings.get(ns)`;0.1.7 上该方法**已不存在**,于是永远返回 `{ posixPaths: false, … }` 的全关 fallback ⇒ wrapper 里 `if (dialect.posixPaths)` 永不成立,**一个参数都不翻**。同一时刻指示词、shell env、prompt 组装早就在 live reader 上(所以它们看起来"正常") —— 这正是"半活"的来源,也与 issue 里"指示词在、翻译不在"的观察完全一致。
  - 五条症状逐一对应:`read`/`write` 拿到未翻译的 `/c/...`,由 Node 解析成 `<当前盘符>:\c\...`,再经**输出侧**回显器转回 MSYS 形态 ⇒ 用户看到的 `/c/c/...`(输入没翻、输出翻了);`~`/`/tmp` 属挂载表翻译,同样被跳过;`glob`/`grep` 的 `path` 与 `bash` 的 `workdir` 字段同理原样下发。
- **修法**:wrapper 改用 `liveSettings.dialect()`(与其余消费点同源),并把参数翻译抽成可测的 `translateDispatch(exec, dialect, env)` 导出到 `_internal` —— issue 里那句"现有冒烟只跑纯函数、没跑过一次工具分发的参数翻译"点到了要害:纯函数一直是绿的,**喂给它的接线**没人测。
- **同一次审计查出的第二处(同类)**:`adoptSidebarShell` 的 dispose 分支用 `s.get(SIDEBAR_NS)` 读当前值再决定是否恢复接管 —— 0.1.7 上没有 `get`,异常直接被 catch 吞掉,**插件卸载时侧栏终端从不还原**。现改走已有的 era-aware `readShell()`。
- **回归测试(75/75,新增 2 条,其中一条就是 issue 建议的那种)**:
  - `translateDispatch covers every argument face issue #8 reported`:对 issue 的五条症状逐条断言(`/c/...` → `C:/...`;`~` → home 挂载;`/tmp` → TEMP 挂载;`glob`/`grep` 的 `path`;`bash` 的 `workdir`,且 `command` 绝不被改写),外加 glob 拆分、run_code 程序字面量、以及"已原生/相对路径保持对象身份(不触发无谓重渲染)"。
  - `issue #8 root cause stays fixed`:锁定根因本身 —— 断言**旧读取器在 0.1.7 形状的 settings 上返回全关**(这就是它不能给分发面当输入的原因),并断言 `apply()` 的代码里不再出现 `readDialectSettings(ctx)`、侧栏还原不再出现 `s.get(SIDEBAR_NS)`。
- **验证(真实 dsh 0.1.7-rc.1 宿主上的 A/B,本机 macOS)**:
  - 先核对宿主契约:`packages/core/tools/src/index.ts` 的 `dispatchScheduledExecution` 仍以 `mutableExec` 走 `tools/execute` waterfall,tool 体在 waterfall **之后**读 `exec.arguments`(`tool.execute(exec.arguments, exec)`)—— 所以"就地改写 `exec.arguments`"这条机制在 rc.1 上依然成立,问题只在读取器。
  - A/B 装置:隔离 `DSH_HOME` + 新建 profile + 两份插件 `link:` 安装 + 探针插件**自注册一个回显工具**并通过 `ctx.tools.execute()` 走一次**真实分发**(把工具体收到的参数打出来);由于方言面按 `process.platform === 'win32'` 门控,探针副本只强制打开这一处门 + 把 `gitBash` 能力置 `active: true`,其余全为真代码。
  - **未修复副本**(把 wrapper 换回 `readDialectSettings(ctx)`):工具体收到 `{"file_path":"/c/Users/x/.dsh/f.txt","path":"/c/Users/x/dir","workdir":"/c/Users/x/.dsh"}` 与 `{"file_path":"~/.anonymous-user-id","path":"/tmp/a.txt"}` —— **issue #8 的五条症状在同一台机器上完整复现**。
  - **修复后**:同一装置收到 `C:/Users/x/.dsh/f.txt`、`C:/Users/x/dir`、`C:/Users/x/.dsh`,以及 `~` → home、`/tmp` → TEMP 的挂载翻译。
- 相关:issue #8 https://github.com/KannaKuron/dsh-gitbash-shell/issues/8 (报障与定位线索来自 @youyv)

## v0.25.0 — 2026-09-24

**类型**:feat(与 dsh-ptc-cordis-preset 去重:issue #7)

- **需求(用户提的,不是 bug)**:两插件同装时模式名录 9 项,其中本插件的 `创造模式 · Git Bash`(`cordis-gitbash`)与对方的 `PTC 创造模式`(`ptc-cordis`,在 `gitBash` 能力联动下已按 Git Bash 版物化:`tool-bash` 启用、`tool-pwsh` 禁用)面向的是**同一件事**。issue 的两条硬要求:①开关**默认关**(保持现状、不改老用户行为);②开关在任一侧都能看到并修改,且必须是**同一份状态**。对方仓库的同一条需求见 dsh-ptc-cordis-preset#1(该 issue 的备注「npm 包不带 CHANGELOG、用户无法核对历史行为」在本轮一并处理,见文末附带项)。
- **① 新开关 `suppressPeerCordis`(volatile 布尔,默认 `false`)**:dsh ≥ 0.1.7 上是本插件**行 Config** 的字段(与其余字段同款的 `live()` 探测 + volatile 投影,改动经 `loader/volatile-update` 实时生效);旧宿主(≤ 0.1.6)在 settings 命名空间 `gitbash-shell` 里声明同名字段(`readSuppressPeerCordis`),因为旧 era 既没有行 Config 表单也没有跨命名空间编辑。默认 `false` ⇒ **0.24.x 的四变体名录逐字节不变**,去重是用户主动要的增量而非新默认。
- **② 判定是「两个事实同时成立」,缺一不可**:开关 ON **且** 对方通过 `ctx.provide('ptcCordisPreset', { id, gitBashActive: true })` 报告 Git Bash 侧真的生效。对方**缺失 / 未安装 / 装了但 `gitBashActive` 不为 true / 尚未挂载**⇒ 一律**不摘**——绝不因为「看不到对方」就少给用户一个变体。规则由纯函数 `effectivePresetIds(configured, { suppress, peerGitBash })` 承载(`configured` 为空/非数组时回落 `PRESET_IDS`,只在两个事实都为 `true` 时过滤掉 `PEER_COVERED_PRESET_ID = 'cordis-gitbash'`),注册与物化两条路径共用同一个决策,不可能各自解释。
  - **为什么不用 `agentPresets.list()` 判断**(issue 里的建议之一):名录只能给出 `{ id, name, description, order, broken }`,读不出「对方这一条是不是 Git Bash 版」这个事实——名字与描述会随对方版本漂移,还可能被用户改;判定要求对方**主动上报**能力事实,我们只读那一个布尔值。宁可少一个信号来源,也不要按名字猜。
- **③ 新宿主(≥ 0.1.7)是实时的**:`ctx.inject(['ptcCordisPreset'], …)`(与行激活顺序无关——同一个坑 v0.7.2 在 inspect-registry shim 上踩过)+ `ctx.on('loader/volatile-update', …)` 监听本行开关 → 两者都触发**串行 reconcile**:不再需要的变体 `unregister`(`live` 表逐条记录 disposer,先删表再 await,失败只记日志不中断其余条目),重新需要的变体 `register`。两种迁移都打日志,便于真机核对:`preset '<id>' retired (dsh-ptc-cordis-preset covers Creation mode on Git Bash)` / `preset '<id>' registered declaratively`。**已挂载会话的 preset revision 不受影响**(会话钉在组合快照上,retire 只动名录),新会话才看到变化——与 v0.24.0「声明式注册不重写在跑的会话」同一条纪律。
- **④ 旧宿主(≤ 0.1.6)是启动时一次性判定**:旧 era 没有可观察的注册表、也没有 volatile Config 更新通道,故用**有界探测** `detectPeerCoverage(ctx)`(默认 1s 超时、25ms 轮询;服务缺失/读抛错/始终 `gitBashActive !== true` 都是 `false`),`effectivePresetIds` 的结果**同时喂给物化循环与 `purgeOrphans`**——所以打开开关后,上一轮物化出来的 `cordis-gitbash` 目录会被当作孤儿**清理掉**;关掉开关后该变体在**下一次启动**才重新物化(启动时读一次开关是这个 era 的取舍,README 已写明)。
  - **探测有界而不是「等对方出现」**:两行是并发挂载的,无限等待会把本插件自己的启动拖死;1s 内没有能力 = 当作对方不覆盖(保守方向:保留变体),这与「绝不少给」的取舍一致。
- **⑤ 同一份状态出现在两侧设置卡上,没有第二份拷贝**:权威值就是本插件这一行 Config;对方的设置卡通过 `ctx.configForms.get('gitbash-shell')` **绑定同一行**并写同一个字段(DSH 官方支持编辑另一个插件所拥有的命名空间),所以任一侧改动另一侧立即同步——不引入「镜像字段 + 同步逻辑」那套双份状态。旧宿主上镜像卡片不出现(`configForms` 服务不存在),开关只在本插件自己的设置面(命名空间 `gitbash-shell`)可改,且按启动时读取生效。
- **依赖边界**:去重开关本体在**本插件 ≥ 0.25.0**;对方的协作能力(`ptcCordisPreset` 能力服务)在 **dsh-ptc-cordis-preset ≥ 0.14.0**。对方低于 0.14.0 ⇒ 能力服务不存在 ⇒ 探测恒为 `false` ⇒ 名录保持四个变体(降级安全,不会因为对方旧版本而误摘)。
- **验证(端到端,隔离的真实 dsh 0.1.7-rc.1 实例,本机 macOS)**:`DSH_HOME` 隔离 + 新建 web profile + 两份插件用 `link:` 安装 + 一个探针插件定时打印 `agentPresets.list()` 并**中途真的写设置**:
  - 默认(开关未开):名录 **10 项**,同时含 `cordis-gitbash|创造模式 · Git Bash` 与 `ptc-cordis|PTC 创造模式 · Git Bash`——即默认行为与 0.24.x 一致;
  - 写入 `settings.update('gitbash-shell', { suppressPeerCordis: true })` → 宿主日志出现 `preset 'cordis-gitbash' retired (dsh-ptc-cordis-preset covers Creation mode on Git Bash)`,**名录里该条消失**;
  - 写回 `false` → 日志出现 `preset 'cordis-gitbash' registered declaratively`,**名录恢复**;
  - 唯一的人为点是探针副本里把 `gitBash` 能力的 `active` 强制为 `true`(macOS 上模拟 Windows 语义),其余全为真代码。
- **设置面验证**:无头浏览器在**同一实例**上确认对方设置卡出现两行——`workflow 工具: 提供（默认） 不提供` 与 `与 dsh-gitbash-shell 去重: 去重 保留两个（默认）`——即两侧绑定同一行的写法在真实宿主上渲染成立。
- **`npm test` 72/72**(新增 4 条:去重判定矩阵(两个事实的四种组合 + 空/缺省列表)、能力探测(真实能力/`gitBashActive: false`/服务缺失/读抛错)、旧时代读取(命名空间默认关)、两个时代的接线断言(volatile 开关 + `ctx.inject` 能力 + `live.delete` 真退注册 + `purgeOrphans` 跟随有效清单))。
- **未覆盖**:Windows 真机复验仍待用户(本机 macOS)。判定逻辑、两时代接线与名录变化已在真实 0.1.7-rc.1 宿主上跑通,但 win32 上「真的挂载 `PTC 创造模式`(Git Bash 版)后摘掉变体」这一条尚未在 Windows 上走过一遍。
- **附带(npm 产物补 `CHANGELOG.md`)**:`package.json` 的 `files` 数组加入 `CHANGELOG.md`。起因是对方仓库 issue #1 的备注:两边的 npm 包都不带 CHANGELOG,用户装了包也无法核对「某个行为是曾经有还是从未有过」。只影响 npm tarball 的内容,不改仓库结构、不改运行时、不影响 `dsh plugin add`。
- 相关:issue #7 https://github.com/KannaKuron/dsh-gitbash-shell/issues/7 ;对方仓库对应条目 https://github.com/KannaKuron/dsh-ptc-cordis-preset/issues/1

## v0.24.4 — 2026-09-23

**类型**:fix(dsh 0.1.7 执行器半整体失修:issue #6 的 Config 缺 `.volatile()` + 同一次审计查出的 `run`/`start`→`execute` 改名 + 两处 `settings.get(ns)` 在新宿主上静默失效)

> 复盘:本轮的 root cause 是**审计窗口**而非某一行代码。0.24.3 的 rc.1 复核只 diff 了 `alpha.1 → rc.1`,而本插件的基线是 alpha.1 —— 整个 0.1.6 → 0.1.7-alpha.1 的窗口(`feat(settings): project volatile Config through profile-backed forms` #4587 与它带动的 shell 包大重构)**从未被对照过**。用户在自己的 Windows 机上装了 0.24.2 后报 issue #6,才把这条线暴露出来。规则已写进 AGENTS.md:审计窗口必须从**上一个已知可用版本**起算。

- **① 真 bug(用户报的 issue #6):`src/shell.js` 的 `Config` 漏了 `.volatile()` ⇒ 每一次 shell 调用 `TypeError`**。dsh 0.1.7-alpha.1(#4587)把 `LocalBashExecutor.Config` 的 `cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/`graceMs` **全部改成 `.volatile()`** 并改为经 `.get()` 读取(`packages/shell/bash-local/src/index.ts:100-107` + `assertServiceableBashConfig`/`resolve`/`spawnSpec`);`SandboxBashExecutor` 自己不声明 Config、原样继承,所以子类这份重声明就是执行器的契约。插件重声明成了裸值 ⇒ 基类第一次 `.get()` 就抛 `config.timeoutMs.get is not a function`,而本 bundle 的 patch 把 `ctx.shell` 换成了这个执行器 ⇒ **整个 agent shell 不可用**;装/卸载插件即坏/即好,宿主日志里没有本插件的加载错误。
  - **修法**:六个继承字段一律经 `live()` 探测加 `.volatile()`(0.1.7+ 的 schemastery 有该方法、≤0.1.6 没有,而旧基类读的是裸值——一个探测同时服务两个 era);插件自己的 `bashPath` 基类既不声明也不 `.get()`,保持裸值。Config 构造抽成 `export function gitBashShellConfig(z)`,冒烟用"带/不带 volatile 的记录型 schemastery"分别驱动两个 era。
  - **本机复现(无需 Windows)**:用宿主构建里的真实 `SandboxBashExecutor` + 0.1.7 的 schemastery(3.18.4,有 `volatile`)驱动本插件的执行器半——`HEAD`(0.24.3)抛 `TypeError: this.config.maxSpillBytes.get is not a function`,修复后六个字段全部 `.get()` 正常。
- **② 同一次审计查出的第二处(0.1.7 执行器方法改名:`run`/`start` → `execute`)**:0.1.7 的 `ShellExecutor` 抽象面只剩 `resolve` + `execute(spec): Promise<ShellExecution>`(`run`/`start` 已删除,后台执行 = `onExpiry: 'none'` 的一次 execution,前台/后台由调用方是否 await `result()` 决定)。插件原有的 `run`/`start` 覆盖在新宿主上**是死代码**:全权访问会走 `LocalBashExecutor.execute` 里硬编码的裸 `bash`(Windows 上解析到 WSL 占位),Windows 受限调用会重新落回 MSYS2 必死的 restricted-token runner(issue #1 回归)——即"Config 修好之后插件本来的两个存在理由都不生效"。
  - **修法**:新增 `execute(spec)` 覆盖,用 `gitBashRoute()` 判定路由(全权访问恒走 Git Bash argv;win32 受限调用走 unconfined 并如实标注 `enforcement: 'unconfined'`;其余一律 `super.execute` 继承父类,含插件自己 `confine` 覆盖提供的 Git Bash argv),并用 `decorateExecution()` 复刻父类私有 `decorateResult` 的就地记忆化投影。`run`/`start` 保留给 ≤0.1.6 宿主(`execute` 在无 `super.execute` 时委派给 `run`)。
  - **真实宿主类集成验证(12/12,本机 macOS,spawn 打桩)**:win32 全权访问 → `argv = [bash.exe, -c, cmd]`、未触受限 provider、`sandbox` 事实正确;win32 `workspace-write` → 同样 Git Bash argv + `enforcement: 'unconfined'` + 一次性提示;非 Windows 受限 → 仍走父类 confine 路径且 provider 收到的 argv 也是 Git Bash;`withParityEnv` 仍并入 spec;结果投影按句柄记忆化;≤0.1.6 无 `execute` 的基类 → 委派 `run`。
- **③ 同类漏网:`settings.get(ns)` 在 0.1.7 上已不存在**(新 `settings` 服务只有 `describe()`/`update()`),两处旧调用因此**静默降级**:
  - `src/shell.js` 的 `withParityEnv`(v0.21.1/v0.22.0 的 Linux 行尾一致性:GIT_CONFIG autocrlf=input/eol=lf)**在新宿主上从不生效**。现按 era 分流:旧 = `get(ns)`,新 = `describe()` 里本行(行 id `gitbash-shell`)的表单值 —— 与 agent-lang 读 `locale` 命名空间同一姿势。
  - `src/index.js` 的 `adoptSidebarShell.readShell`(Windows 上把 better-sidebar 的 `terminalShell` 接管到 Git Bash)同样只认 `get(ns)` ⇒ 新宿主上接管被静默跳过。现同样按 era 分流读值,写入仍走 `update(ns, patch)`(两代都有)。
  - 冒烟新增一项覆盖两个 reader × 两个 era,外加"开关关闭 / 行不存在 / 服务缺失 / describe 抛错"四种降级。
- **未覆盖**:Windows 真机矩阵仍待用户复验(本机 macOS):三个 `* · Git Bash` 变体挂载、设置卡可写、bash 工具真跑、`command -v bash` 指向 Git 安装目录、以及受限模式下的 `enforcement: 'unconfined'` 标注。本轮所有 win32 结论来自"真实宿主类 + 打桩 spawn"的集成驱动,它覆盖契约与 argv/事实,但不覆盖 Windows 上的进程行为。
- 相关:issue #6 https://github.com/KannaKuron/dsh-gitbash-shell/issues/6 ;#4587 的契约来源:`packages/shell/bash-local/src/index.ts`、`packages/shell/bash-sandbox/src/index.ts`、`packages/shell/shell/src/types.ts`。

## v0.24.3 — 2026-09-23

**类型**:fix(适配 dsh 0.1.7-rc.1:exports 缺 manifest 子路径导致桌面客户端 client 半永不进启动图 + 声明 dsh peer + host 半惰性 peer 导入;附一轮 rc.1 资产/契约复核)

- **⓪ 加固:host 半的 schemastery 改惰性导入(与 ① 同一失败类,先堵住另一半)**。`@deepseek-ai/schemastery` 是 **peer**:普通 Node 从本包位置解析不到它(实测 `createRequire(<插件目录>).resolve('@deepseek-ai/schemastery')` → `MODULE_NOT_FOUND`),只靠宿主自己的解析(profile shared fallback)供上来。顶层静态 `import` 一旦解析失败,dsh Loader 把插件行的导入失败当**非致命跳过**(`vendor/loader/src/config/entry.ts` `_init()`:`logger.error` + `return`,永不建 fiber)⇒ 本插件 **preset 变体、执行器接线、client 半全部消失,而宿主日志全绿**——与 ① 的 `exports` 缺陷是同一类"全绿日志 + 永久失效"。**实证**:造两个除这一行外完全相同的夹具插件(一个静态 import 解析不到的 peer、一个 `await import` + try/catch),同一 profile 启动:静态版的 `apply()` **从不执行**,惰性版照常执行(`mod=null`)。修法:`await import('@deepseek-ai/schemastery')` + try/catch,拿不到时 `Config` 导出 `undefined`(cordis 对 `!runtime.Config` 直接放行配置),插件照常挂载;有 schemastery 时行为逐字节不变(冒烟 65/65,含"不得出现静态导入行"新断言)。

- **① 真 bug:`exports` 缺 `"./package.json"`,桌面客户端上 client 半静默失效**(其余四个同族插件都有,只有本插件没有)。
  - **机制**:官方 `packages/client/modules/src/index.ts` 的 `locatePkgJson()` 在 `ctx.loader.internal` 不可用时(桌面 Electron renderer 没有 Node internals)回退 `createRequire(baseUrl).resolve('<pkg>/package.json')`(L886)——**这条解析遵守 exports map**;缺该行抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`,异常被紧邻的 `catch {}`(L889)吞掉、返回 `undefined`,上层把该包**永久缓存为「非 client 包」**(`this.pkgMeta.set(sourceKey, null)`,L831/L842)。后果:**client 半永不进桌面启动图、宿主日志全绿**——Windows 桌面客户端上设置卡与侧栏半完全不生效,且没有任何报错可查。与 dsh-better-workspace issue #9 同源(那边 v0.21.0 修的就是同一行)。
  - **本机复现(修复前的 HEAD 产物与修复后产物各跑一次同一条 fallback 语句)**:
    `createRequire('<profile>/node_modules/.../smoke.mjs').resolve('dsh-gitbash-shell/package.json')`
    → 修复前 `ERR_PACKAGE_PATH_NOT_EXPORTED`,修复后返回 `<pkg>/package.json`。仓库内等价复现:`createRequire(tests/smoke.mjs).resolve('dsh-gitbash-shell/package.json')`——Node 包自引用走同一张 exports 表。
  - **修法**:`package.json` 的 exports 表补 `"./package.json": "./package.json"`(其余四项 `.` / `./shell` / `./client` / `./locale/*.json` 原样不动;`./shell` 是宿主半执行器入口、`./locale/*.json` 是插件管理页元数据的解析路径,都不可少)。
  - **防回归(smoke 65 项,新增 3 项,均做过反向验证)**:①字段断言 + **运行时双胞胎**(真跑 `createRequire(...).resolve('dsh-gitbash-shell/package.json')` 并比对绝对路径,缺行即抛真错误);②`@deepseek-ai/dsh` peer 断言;③minimal 描述形状断言。回植三处缺陷后三项全红、修复后全绿。
- **② 声明 `@deepseek-ai/dsh` peer(rc.1 唯一被强制执行的兼容性机制)**:rc.1 的 `packages/boot/app-boot/src/plugin-compatibility.ts` **只**读取 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 range(`semver.satisfies(..., { includePrerelease: true })`),`engines.dsh` 是纯声明字段、源码里**没有任何读取方**。本插件此前 peer 只有 cordis/schemastery ⇒ **永远不被兼容性检查覆盖**。现补 `"@deepseek-ai/dsh": ">=0.1.0"`,取值理由:与 `engines.dsh` 同值(单一事实来源)、覆盖 0.1.0…0.1.7-rc.1 全线(逐版本实测 satisfies:0.1.0/0.1.1/0.1.2/0.1.6/0.1.7-alpha.1/alpha.2/rc.1 全 true,0.0.9 false),**不加人为上界**——官方 0.1.6(删 workflow-worker-thread 整包)、0.1.7(删目录预设)两次破坏都发生在 0.x minor,上界拦不住、反而会误伤未来的兼容版本。旧宿主不受影响:该 range 对 0.1.x 全放行,且 profile 侧 `autoInstallPeers: false`(官方 `packages/boot/app-boot/src/profile.ts` 自己写的就是这个值),不会去 registry 拉 `@deepseek-ai/dsh`。**同时把该 peer 标进 `peerDependenciesMeta.optional`**:门禁只读 `peerDependencies`、不读 meta,但一旦有人用 `autoInstallPeers` 默认开启的 pnpm/npm 工程安装本包,包管理器会去 registry 解析这个 range——而 `@deepseek-ai/dsh` 已发布的 26 个版本**全是 prerelease**、普通 range 按 semver 排除 prerelease,会让整单安装以 `ERR_PNPM_NO_MATCHING_VERSION` 失败;optional peer 不会被自动安装,危害消失而门禁照常(冒烟断言锁死)。
- **③ rc.1 资产复核(结论:对齐成立,并修掉一处 v0.24.1 引入的一字节偏差)**:
  - 官方 `packages/bundle/web-app/presets/*.patch.yml` 四个预设自 alpha.1 起**零改动**(`git diff dsh-v0.1.7-alpha.1 dsh-v0.1.7-rc.1` 对该目录为空);`packages/shell/*` 唯一实质改动是 `tool-pwsh-persistent/src/index.ts` 的**提示符机制**(删 `SHELL_PROMPT`/`promptCompleted`,改看 `waitReason === 'stdin_read'`),**工具 description 文本一字节未动**。
  - 用 rc.1 检出重跑对齐脚本:四个变体 × darwin/win32 两平台逐行走查行序列 + `id`/`name`/`group`/`isolate`/`disabled`/`config`(含 `!!js` 表达式按平台求值),结果 **ALIGNED:零未解释漂移**;16 项差异全部是设计内的 Git Bash 增量(bash 强制开、pwsh 强制关、minimal 的 `shellPath` 显式钉住、bash 描述首行环境说明、cordis skills 目录现场解析)。
  - **修掉一处**:v0.24.1 给 minimal 的 `persistent-pwsh` 描述加了尾换行(`+ '\n'`),而官方该描述是 `|-` 块标量(**无**尾换行;同一文本在 0.1.6 目录预设与 rc.1 web 预设里都是 `|-`),本插件自己的旧 era 资产 `assets/minimal-gitbash/agent.cordis.yml` 也是 `|-` ⇒ 两个 era 会喂给模型两个不同字符串。现改为与官方/旧 era 一致(该行在 Git Bash 变体里恒 `disabled: true`,对模型零影响,属一致性修正)。
- **④ 声明式注册与预检复核(rc.1 未变)**:`packages/preset/agent-preset-registry/src/index.ts` 的 `register(definition)` 仍是「异步注册 + 返回 disposer」,`list()` 返回 `{ id, name?, description?, order?, broken? }` 形状未变;rc.1 新增的 `@Remote('read') readDocument(id)` 只是只读组合文本查看器,不影响注册方。rc.1 新增的 profile 兼容性预检 `prepareProfileEntries`(`mount.ts`)只在**兼容性冲突**时把 row 标 `disabled`(其余失败仍交 Loader 自己报),而 `auditRows` 跳过 disabled row ⇒ **不可用 row 只会被禁用,不会把整棵 preset mount 打挂**,与插件既有设计一致。
- **⑤ 其它契约复核**:`settings.plugin.item`(≤0.1.6-alpha.1)与 `plugins.bundle.config`(0.1.6-alpha.2+,按**包名**键)双席位注册仍然正确——rc.1 上活着的是后者(`ui-plugin-manager` 以 `entryKey: pkg.name` 渲染,本插件键就是 `dsh-gitbash-shell`);`locale/{en,zh}.json` 的 `{ meta: { title, description } }` 形状与文件名规则、`icon.svg`(相对路径、`.svg`、454 B ≤ 256 KiB、留在 manifest 目录内)全部满足 `packages/boot/app-boot/src/package-meta.ts`;`dsh.bundle.patch` 字符串形式仍被接受。rc.1 新增的 `practices.md`「不要 require 官方 client 包」一条本轮**刻意不动**:client 半仍只 require `react` + `@deepseek-ai/dsh-client-ui-primitives`(家族统一基线,冒烟白名单锁死;改它是一次重写级重构,不属于本轮适配)。
- **验证**:`npm test` **65/65**;隔离实例(独立 `DSH_HOME` + 3113 端口、`@deepseek-ai/dsh-base` + `dsh-web-app` + 本插件的 probe profile)上确认 rc.1 **不把本插件行 disabled**(启动 stderr 无 `disabling profile plugin`)、`--dump-config` 组合正确、client 半进启动图(`window.__DSH_BOOT__` 含 `dsh-gitbash-shell` 行、页面 console 无包加载错误)。
- **未覆盖**:本机是 macOS,插件执行器与受限分支是 Windows/Git Bash 专用,本机**无法复现 win32 真机矩阵**(`gitbash-executor` 行在非 Windows 上本就 `disabled`)。本轮所有 win32 结论均来自源码契约与两平台求值的对齐脚本,**待用户在 Windows 真机复验**:desktop 客户端上设置卡出现且开关可写、侧栏终端接管、四个 `* · Git Bash` 变体可挂载、`command -v bash` 指向 Git 安装目录。
- 相关:dsh-better-workspace issue #9(同一 `locatePkgJson` 根因):https://github.com/KannaKuron/dsh-better-workspace/issues/9

## v0.24.2 — 2026-09-22

**类型**:fix(0.24.0 埋雷事故:模块级 helper 越域引用 apply() 局部量,win32 全量挂载失败)

- **事故与影响面**:v0.24.0/v0.24.1 在 Windows 上**完全无法加载**——挂载 `gitbash-shell` 行时同步抛 `ReferenceError: liveSettings is not defined`,宿主报 `plugin tree failed to load: failed to apply loader entry gitbash-shell (dsh-gitbash-shell)`,启动守卫直接阻挡启动(用户侧表现:安装即报错、被要求卸载/进安全模式)。非 Windows 不受影响(`gitbash-executor` 行 disabled,sidebar 分支本就 win32 门控)。
- **埋雷点**:v0.24.0 的 `makeLiveReader` 双时代重构把 `adoptSidebar` 的消费点收进 apply() 的 scope-local `liveSettings`,但 `run()`(模块级 `adoptSidebarShell` 内,`void run()` **同步**执行)仍写 `liveSettings.adoptSidebar()`——该标识符在那个作用域根本不存在,首次 tick 即抛;调用点又不在任何 try/catch 里,一路抛穿 `apply()` → loader。用户启动日志逐字复现:`Error: dsh: plugin tree failed to load: failed to apply loader entry gitbash-shell (dsh-gitbash-shell): liveSettings is not defined`。
- **为什么 smoke 60 项没拦住**:全部用例从未**执行**过 `apply()`(纯函数 + 源码文本断言);两条 `liveSettings.…` 的文本断言反而给重构后的写法盖了章。教训入册:**消费点接线必须有至少一条真跑 `apply()` 的挂载冒烟**,源码文本断言不能替代执行。
- **修法**:`adoptSidebarShell(ctx, bashPath, readAdopt)` 接收 apply 的时代感知 gate getter(调用点传 `() => liveSettings.adoptSidebar()`),旧宿主命名空间 / 新宿主 Config refs 的双时代语义原样保留;`run()` 每 tick 经 `readAdopt()` 读活开关,行为与设计一致(v0.24.0 意图本就如此,属接线遗漏)。
- **防回归(smoke 62 项)**:①源码守卫——`adoptSidebarShell` 函数体不得出现 `liveSettings`,调用点必须传 getter;②挂载冒烟——stub ctx 真跑 `apply()`(legacy 分支早退、零 fs 副作用),win32 上并断言 sidebar 接管真的写进 `dsh-better-sidebar` settings seam。两条均做过反向验证:回植 bug 后双双失败、修复后双双通过。
- **环境备查(与本事故无关)**:`core.autocrlf=true` 检出的 Windows 克隆把工作区弄成 CRLF 时,`alignEngineRow` 系 LF 纯字符串手术会失配,`materialize aligns the engine row` 一项误报失败;工作区统一 LF(或 `autocrlf=input`)即消失,记录备查。
- 真机验证(安装 v0.24.2 → 重启 DSH → 不再报 loader 错、模式选择器出现 `* · Git Bash`)按验证清单执行,记录待补。

## v0.24.1 — 2026-09-22

**类型**:fix(声明式组合文本与官方逐字节对齐)

- **plan-mode 段落措辞修正**:转写漏字(官方为「including an answer confirming **something** you asked」),现由官方 0.1.7 解析值程序化回填,逐字节一致(含尾换行)。
- **cordis 变体行序对齐官方 0.1.7**:skill-filesystem/tool-skill 移到 tool-cordis 之后(官方 cordis 把 skills 行放尾部;standard/ptc 仍在 tool-jobs 之后)。
- **minimal 的 persistent-pwsh 描述补回官方漏抄的一行**(「State is persistent across command calls and discussions with the user.」)并按官方补尾换行;persistent-bash 仅首行 Git Bash 说明是预期增量。
- **skill-filesystem 行无 skillsDir 时省略 config 键**(官方形态)。
- 旧时代资产(≤0.1.6 宿主)与 0.1.6 官方预设的配置级核查通过:差异仅剩设计内的运行时对齐(引擎行拼写由 `alignEngineRow` 现场改写、ralph 由 `alignRalphRow` 对齐、bash/pwsh 翻转)。
- smoke 60 项全绿。

## v0.24.0 — 2026-09-22

**类型**:feat(适配 dsh v0.1.7-alpha.1 声明式预设,保持旧版本完全兼容)

- **声明式注册路径(dsh >= 0.1.7)**:dsh 0.1.7 删除了目录预设机制。探测到 `agentPresets.register()` 的宿主上,四个 Git Bash 变体改为直接注册定义:
  - 新增 `src/compositions.js`:`pluginsFor({ kind, gitBash, skillsDir })`(standard/ptc/cordis 行集,镜像官方 0.1.7 对应预设的 workflow/presentation/plugin-manager 拆分)与 `minimalPluginsFor()`(单工具变体,bash 行钉在 Git Bash);cordis 变体的 skills 直接指向 `@deepseek-ai/dsh-agent-preset` 包旁目录(现场解析,不再拷贝)。
  - 启动时清理旧宿主时代物化的目录树(**仅 marker 判定 unmodified 的**;用户改过的/外来的一律不碰只提示)。
  - 预设清单沿用行配置 `presets`(Config 普通字段,改动触发重挂载)。
- **设置面双时代**(dsh-agent-lang v0.6.0 同款):host 半静态导出 `Config`(8 个开关全部 volatile 探测),apply 内 `makeLiveReader(ctx, config)` 统一供给 shellEnv 解析器、prompt 组装、tools/execute、post-execute、posix 指示闭包、adoptSidebar —— 所有消费点逐次读取,翻转下一次分发即生效;旧宿主上保留 settings.register 命名空间路径不变。client 半可选注入 settingsScope/configForms。
- **行 id 更名**:`gitbash-presets` → `gitbash-shell`(与设置命名空间同串:0.1.7 的 Config 表单键与旧 settings.yaml 一次性导入都按行 id 落位)。
- **插件管理页展示资产**:icon.svg + locale/{en,zh}.json(旧宿主忽略)。
- 仓库新增 devDependencies(schemastery),冒烟测试前需 `npm install`;60 项全绿(新增组合数据/Config/双时代获取/包元数据/行 id 断言)。
- 已知边界:先升 dsh 后未升插件的窗口期内四个变体会从模式选择器消失;升级本插件后恢复。翻译层全部 API(bash-sandbox/shellEnv/tools 瀑布/system-prompt 组装)在 0.1.7 上形状不变,已逐一核对。

## v0.23.0 — 2026-09-19

**类型**:fix(两个社区 issue:成功面的 `value` 回流与任何 `content` 替换者互斥;带空格路径的混合方言)

**两条都是真 bug、都不是需求**;修法都换成了比 issue 建议更彻底的那条(issue #2 见 https://github.com/KannaKuron/dsh-gitbash-shell/issues/2,issue #3 见 https://github.com/KannaKuron/dsh-gitbash-shell/issues/3)。

- **① 成功结果的 `value` 回流与 `content` 替换者互斥(issue #2)**:v0.10.4 起,成功结果的路径元数据靠 `tools/post-execute` 的决策补 `value` 回流。而注册表**禁止**同一条决策里同时出现 `content` 与 `value`(`dsh-tools` 的 `postExecute`:`throw new TypeError('tools/post-execute accept decision cannot replace both value and content')`),且这次抛错发生在**整条瀑布收束之后、任何监听者的 try/catch 之外** → 调用以 isError 结束,模型拿到的是校验错误而不是结果。
  - **本机取证(为什么本机从没炸)**:逐帧解码 85 个会话、3.3 亿字符历史日志,该报错 **0 次**;模型侧发起的根级调用 `run_code=10542`、根级 `glob`/`grep` **0 次**——本机调用几乎全是 PTC 子调用,而官方两个 content 替换者对子调用直接 bail(`acceptedDirectCallValue` 要求 `exec.parent === undefined`),`spill-policy` 还 prepend + 遇 `value` 主动让路 + 跳过 `read`。**所以本机是靠用法躲过,不是代码安全**:issue 作者机器上的 read 内容过滤器、或任何一次根级 glob/grep 截断,都会踩。
  - **修法(治本)**:成功面的回流**搬出 post-execute**,改在 `tools/execute` 的 around-dispatch 包装里**自作结果**(`return { ...result, value }`)。这是宿主**官方且有测试**的扩展点(`normalizeDispatchResult` → `createSuccessResult` → `render`:注册表会用交回的 value **重新渲染 content**),于是本插件**在任何决策上都不再产出 `value` 键**——冲突结构性消失;附带收益是别的插件渲染的 content(spill 预览之类)也一起变 MSYS。失败面仍留在 post-execute(那里只产 `content`;`value` 对失败结果本就非法,永不冲突)。结果未变时返回**原对象**,注册表据此跳过重渲染。
  - **为什么不用 issue 给的第 1 条(见到 `content` 就让路)**:那只消除抛错,改写仍会被外层丢弃,换个监听者又会复发;第 2 条(换挂点)才是正解,这里按第 2 条做。
- **② 带空格路径的混合方言(issue #3)**:`windowsToMsys` 是**散文改写器**,裸路径正则遇空格就断——`C:\my dir\f.txt` 变成 `/c/my dir\f.txt`(反斜杠残留),而这条路径正出现在**成功结果**里。本机复现:`/tmp/my dir/f.txt` 的 `read` 回流为 `/tmp/my dir\f.txt`。实际面比 issue 描述的更宽:`C:\Program Files\Git\bin\bash.exe` → `/c/Program Files\Git\bin\bash.exe`(空格之后整段没转)。
  - **修法(两个面分开治)**:①新增 `driveToMsys` / `pathEcho`——**整值路径**不再经过散文正则:盘符前缀直接翻、剩余分隔符全归一,再走 `/tmp` 挂载;`read`/`read_image`/`write`/`edit` 的 `path`、`glob` 的 `paths[]`、`grep` 的 `matches[].path`、`present` 的 `files[].path`,以及 `tempDir` 自身全部改走它(带空格的 TEMP 目录同样能挂成 `/tmp`)。②散文面(提示词、错误文本)的裸路径正则改为**只有空格后那个词本身还带分隔符时才跨空格**——`C:\Program Files\Git\bin\bash.exe` 整条转对,而 `see C:\Users\kanna for details` 不会把后面的英文吞进路径。带引号的诊断(harness 的错误信息都加引号)本来就没问题,未动。
  - **issue 建议的 `posixSeparators(windowsToMsys(...))` 没有照抄**:它只对「整条就是一个路径」成立(而漏的正是这个场合:read/write/edit 分支当时没加),且散文面套上它会把英文当路径。
- **验证**:`npm test` **56/56**。新增三条:①整值路径矩阵(带空格目录、相对路径只归一、盘符相对路径不误判、带空格 TEMP 的 `/tmp` 挂载);②散文正则的跨空格规则(程序目录整条转对 / 英文不被吞 / URL 不动);③源码守卫——成功面必须在 `tools/execute`、旧写法 `value: patch` 必须消失、post-execute 段内不得出现 `value:`、`next().catch` 不得出现(拒绝必须继续向上抛)。两条 issue 修复后已回复并关闭。
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
