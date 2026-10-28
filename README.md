# dsh-gitbash-shell

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

简体中文 | [English](README_EN.md)

> **Unreleased／实验性实现讨论**：下述 fail-closed 与两个显式工具尚未正式发布，不是发布候选；安装公开 npm 包不保证包含这些变更。详见[设计、接口与待讨论决定](<docs/experimental-native-execution.md>)、[验证矩阵与复现](<docs/experimental-native-verification.md>)及 CHANGELOG。

> 让 DeepSeek Harness (dsh) 在 Windows 上**默认用 Git Bash 跑命令**的官方风格插件
> —— 不替换宿主执行器(官方 PowerShell 执行器原样保留):新增自有 bash 工具
> (私有 Git Bash 执行器实例,不注册为服务),并为所有模式注册对应的 Git Bash 版
> agent preset。

## 它解决什么

官方 Windows 组合默认把 `dsh-pwsh-sandbox` 作为 `ctx.shell`(PowerShell 执行器),
且各 preset 的 `tool-bash` 行在 win32 上被禁用——因为在 Windows 上裸 `bash`
会解析到 `C:\Windows\System32\bash.exe`(WSL 占位)。本插件**不替换这个执行器**:
它新增一个自有 `bash` 工具,执行在私有的 Git Bash 执行器实例上(继承官方
`@deepseek-ai/dsh-bash-sandbox`,`bashPath` 只认 Git for Windows)。沙箱语义在
POSIX 宿主上完整保留;
**Windows 宿主上受限模式有一处重要例外——见下方
[「安全语义:Windows 上的受限模式」](#安全语义windows-上的受限模式)**。

 安装本插件后(v0.35.0 起,**默认**):

- **官方四个模式直接获得 Git Bash**——模式列表保持官方原样,不再新增变体:
  每个会话创建时,本插件探测该模式的工具面,「有 pwsh 无 bash」(官方 Windows
  组合的形态)即在该会话内注册**自有 bash 工具**(对官方 tool-bash 逐调用镜像:
  后台任务、审批升级、渲染行为不变)。宿主官方 `pwsh` 工具是**真正的
  PowerShell**(v0.39.0 起,本插件不再替换执行器),默认被隐藏、开关显示——见下一条。
- **bash 工具说明附带路由规则**:能用 Git Bash 就用 Git Bash;只有必须用到
  Windows 原生能力(cmdlet/注册表/服务/WMI)时才用 PowerShell;bash 出错在
  bash 里修,禁止在 bash 里嵌 `pwsh -Command`(变量展开与输出编码会在那里坏掉)。
- **`pwsh` 工具(官方 PowerShell,默认隐藏,开关显示)**:宿主官方的 `pwsh` 工具
  就是真正的 PowerShell(官方解析器自动优先 PowerShell 7),可直接用于 Windows
  原生操作(cmdlet/注册表/服务/WMI)。默认关闭(`pwshTool` 开关):该工具对本插件
  会话隐藏,主机保持 bash 优先;开启后它直接可见可用——无需安装任何额外组件。
  旧 PowerShell 7 旁路工具(v0.37–v0.38.5 的独立工具)已随 v0.39.0 新架构退役;
  命令仍然首选 bash 工具。
- **`gb_*` FastCtx 文件工具(默认关,v0.39.4 起弃用)**:`gb_inspect_local_file`/`gb_grep`/
  `gb_glob`/`gb_replace`(Rust 实现:批量范围读取带 token 预算、grep 截断
  标注、编码探测)。它们是官方 read/grep/glob/edit 的**补充**——官方工具接
  文件沙箱,仍是默认推荐。**dsh-ops 0.3.0 起原生 `ops_*` 文件工具取代了
  FastCtx 上游,本组默认关闭**(`fastctxTools` 显式开启可恢复);已安装
  dsh-ops 时无论开关如何都会自动让位。与 dsh-ops 并存时本插件继续负责
  `/c/` 方言统一:`ops_*` 的入参(含 `root`/`operations[].path`/`protect`)
  自动转换、返回与报错路径自动回流 `/c/`。

- **与 dsh-ops 并存:bash 只留一份(v0.42.0)**:宿主机制决定「可见但拒绝」到不了「看不见」——
  `tools.restrict` 只能过滤继承面,而 `ops_bash` 注册在 agent 自有层。于是本插件直接接管 dsh-ops
  自带的 `publishBashTool` 开关(经官方 configEditor 通道写为 `false`):安装本插件时 `ops_bash`
  不再出现在模型工具面;**ops 的 pwsh7 overlay(给官方 pwsh 工具供路径)与文件/后台增强不受影响**
  ——publishBashTool 的门只套在 `mountSessionBash` 上,pwsh 走 `mountBundledPwsh` 独立路径。
  **`ops_run` 无需处理:它在 dsh-ops 的 bundle 装配中本就没有发布路径**——bundle 只有
  shell/file/background/ptc 四行,全插件唯一一处 `new FastCtxTools` 只在 background 组件挂
  后台四件套(`run_background`/`job_*`),前台 `ops_run` 只是未被任何调用点使用的默认参数;
  本机 `dsh-ops-background` 行默认关闭,后台四件套同样不存在。
  **停用或卸载本插件的瞬间自动还原**(dispose 钩子撤回覆盖,同 row 的其它设置原样保留),重新启用
  又会自动接管。两个边界:①关机状态下卸载的残余覆盖,用 dsh-ops 设置卡「恢复默认」一键撤回;
  ②停用时若覆盖值已被你手动改回 `true`,视为你的选择、不动它。无设置开关——想用 `ops_bash`
  就停用本插件,还原是自动的。
   **后台任务与文件/PTC 增强全部让给 dsh-ops(2026-10-19 用户决策)**:剔除清单被守卫测试
   锁死为 `ops_bash` + `ops_run` 两项,永不含 `ops_run_background`/`ops_job_*`——你启用
   dsh-ops 的「后台任务」组件后,这组全局工具在普通会话与 PTC 创造模式下原样可见可用,
   本插件不做任何 deny。bash 归 gitbash,后台与增强归 dsh-ops,职责互不越界。

四个「· Git Bash」**变体 preset 仍保留,默认关闭**(`variantPresets` 开关,
设置卡可开):开启后注册 `standard-gitbash`/`minimal-gitbash`/`code-gitbash`/
`cordis-gitbash` 四个变体并停用官方模式的工具补位(两者互斥)。

> ⚠️ **从 0.34.x 升级**:变体默认关闭。**全局默认模式会自动迁移**——若你之前把默认设成
> 某个变体(`*-gitbash`),升级后首次启动会经官方设置通道切到对应官方模式
> (`standard-gitbash→standard`、`minimal-gitbash→minimal`、`code-gitbash→ptc`、
> `cordis-gitbash→cordis`);打开 `variantPresets` 则不迁移、一切照旧。钉在变体上的
> **旧会话**无法被迁移(官方 `agent-preset/locked` 锁定),请新建会话。

原有 `标准模式`/`极简模式`/`PTC 模式`/`创造模式`(shipped)与
dsh-ptc-cordis-preset 的 `PTC 创造模式` 用户 preset 均不受影响、自动受益。

### 宿主要求与 preset 对齐

自 v0.32.0 起宿主下限为 **dsh >= 0.1.7-rc**(经 peer `@deepseek-ai/dsh` 声明,
prerelease 含入求值;旧宿主不再支持)。四个变体的行集是 `src/compositions.js`
里已提交的 JS 数据,镜像官方 0.1.7 的 standard/minimal/ptc/cordis 行切分并叠加
Git Bash 增量;跟随 dsh 升级的对齐由冒烟测试
`compositions: full variants mirror the official row split` 锁住。
**preset id 保持 `code-gitbash` 不变**——会话钉在 id 上,dsh 0.1.2 把内置 `code`
改名 `ptc` 时本插件的变体 id 就没有跟随(改名会让已固定的会话报 preset not found)。

**dsh 0.2.1 增量自动随行(v0.34.0 起,v0.40.2 对齐 alpha.5)**:官方 0.2.1 给全工具
preset 加了时间上下文(`time-context`)与提醒工具(`schedule_*`);alpha.3 又把这两行
从 subagent 的 `toolFilter.deny` 里移除(提醒工具重新可达子代理),给极简变体加了
image-only `tool-fs` 与专属 compaction 组,alpha.4 给全工具 preset 加了插件市场
(`tool-plugin-market`)。本插件在 0.2.1+ 宿主上探测到对应包即自动把上述行纳入变体
(全工具三变体随探针取 `time-context`/`tool-schedule`/`tool-plugin-market`,极简
变体只取 compaction 增量,与官方一致);旧宿主行为逐字节不变,**无需为此升级 dsh**。

## 安装(公开 npm 插件,推荐)

npm: [dsh-gitbash-shell](https://www.npmjs.com/package/dsh-gitbash-shell)，
源码与 Release: [github.com/KannaKuron/dsh-gitbash-shell](https://github.com/KannaKuron/dsh-gitbash-shell)

```sh
# web 图形界面
dsh plugin --profile web add dsh-gitbash-shell
```

`dsh plugin add` 会自动:① pnpm 安装 npm 包 `dsh-gitbash-shell`;
② 检测到包声明的 `dsh.bundle` 后把它追加进该 profile 的
`dsh.profile.bundles`。**重启该 profile 的 host 后生效。**

## 它做了什么

bundle patch(`cordis.patch.yml`)是**纯新增**(v0.39.0 起):只插入本插件行
`gitbash-shell`,不禁用、不替换任何官方行——宿主官方 PowerShell 执行器与全部
官方组件保持原位。旧版「替换执行器」的三步 patch 在 route B 下变成运行时工作:

1. **不再撤 `pwsh-sandbox`、不再插执行器行**:插件不再替换宿主执行器,官方
   `pwsh` 工具重新是真正的 PowerShell;
2. **自有 bash 工具跑在私有执行器实例上**(`src/bash-tool.js` + `src/shell.js`):
   `GitBashSandboxExecutor` 继承官方 `@deepseek-ai/dsh-bash-sandbox`,仅把内层
   argv 换成 `<git-bash.exe> -c <command>`,在私有 cordis scope 中构造、**永不
   注册为 `ctx.shell` 服务**。沙箱策略/拒绝分类/后台任务/超时/设置节沿用官方
   实现;full-access 分支单独接 Git Bash(父类那里硬编码裸 `bash`);
   **Windows 上受限分支有一处例外,见下一节**;
3. **`gitbash-shell` 行**(`dsh-gitbash-shell`):**v0.35.0 起双形态**——
   默认(`variantPresets: false`)不注册变体,由**行内工具补位**
   (`src/inline-tools.js`)在 `agent/created` 时按工具面注册自有 bash 工具;
   官方 `pwsh`(真 PowerShell)默认隐藏(`pwshTool` 开关显示);`gb_*` 工具
   (`src/fastctx-bridge.js`)随行发布。开关打开时按 v0.32.0 起的**声明式注册**
   (`ctx.agentPresets.register`)提供上表 4 个 preset 变体——
   行集是仓库里已提交、可 diff 的 JS 数据(`src/compositions.js`),**不再物化
   任何目录**;旧版本遗留在磁盘上的物化树,启动时仅当 marker 判定为
   「未被用户改过」才单向清理,用户改过的绝不碰(清理不受开关影响)。

**环境变量**：`bash.exe` 经 host 的托管 subprocess provider 直接启动（不经登录壳）；
父环境经过宿主凭据清洗，再合入受保护的 `DSH_*` 快照，不提供完整未过滤环境或绕过凭据保护。

## 安全语义:Windows 上的受限模式

**POSIX 宿主**：自有执行器的受限路径仍继承官方后端与拒绝分类。本节只讲 Windows。

**Unreleased 的 Windows 自有 bash/native 工具在 experimentalNative 开启时（默认）采用 fail-closed**：`read-only`、
`workspace-write` 或缺失/未解析的策略在执行前拒绝；仅真实解析为
`danger-full-access` 的调用可以执行。受限请求不会登记/启动无围栏进程，也不会自动
回退 pwsh/cmd/WSL、切模式或绕过文件工具拒绝。用户可在设置中关闭 experimentalNative，恢复明确标注 unconfined 的旧版 Bash 行为。

- **拒绝不是沙箱修复**：当前仍无已验证的受限 Git Bash。历史失败为 Win32 error 5 /
  0xC0000142；匹配本机 MSYS 源码后发现 signal pipe 显式 SD 缺 restricting SID，
  现代 cygheap 使用 VirtualAlloc，Core 已补 TokenDefaultDacl。不能继续宣称
  “只补默认DACL就修好”或“所有未来版本无解”；真正 IPC/OS 方案仍需隔离环境验收。
- **策略按调用解析**：默认 full 不会放宽另一个只读会话；原生入口的准备、异步边界与
  spawn seam 重验策略。取消、owner dispose 和主动 kill 会标输出不完整，不伪装自然完成。
- **文件工具是另一层**：官方 write/edit 仍按其 policy 判断；读取不一定只限工作区。
  路径 helper 只转换字符串，不检查存在性、不授予读写权。不得用任一工具绕过已发生的拒绝。
- **范围**：此门控覆盖本插件自有 bash/native 工具；侧栏交互终端、minimal 的持久 PTY
  和其他插件执行器不因此获得围栏。官方 root PowerShell 执行器没有被替换。

旧 unconfined 记录/渲染兼容仍保留供历史结果使用，不代表新调用可降级。历史见 CHANGELOG
v0.13.2，当前行为及验证见 Unreleased。

## 配置

`gitbash-shell` 行(行 id 自 v0.24.0 起与设置命名空间同串;≤ v0.23.0 为 `gitbash-presets`)
支持 `presets` 数组,只注册你常用的模式(未列出的变体不再进入名录;改动经
volatile-update 触发重注册):

```yaml
- id: gitbash-shell
  config:
    presets: [standard-gitbash, minimal-gitbash]   # 默认注册全部 4 个
    suppressPeerCordis: false                       # 与 dsh-ptc-cordis-preset 去重,默认关
```

去重开关 `suppressPeerCordis`(布尔,**默认 `false`**)只在两个事实**同时**成立时才把
`创造模式 · Git Bash`(`cordis-gitbash`)从名录里摘掉:开关为 `true` **且**
dsh-ptc-cordis-preset 报告它的 `PTC 创造模式` 已经是 Git Bash 版。默认关 ⇒ 名录与
0.24.x 的四个变体逐字不变;判定细节、生效时机与两侧同步方式见下方
[「与 dsh-ptc-cordis-preset 联动」](#与-dsh-ptc-cordis-preset-联动)。

### 子代理/队员是否也用 Git Bash:`subagentDialect`(默认开,v0.27.0)

```yaml
- id: gitbash-shell
  config:
    subagentDialect: true   # 默认;false = 方言只对主代理生效
```

默认开启时,子代理、团队队员(含嵌套子代理)与主代理走**同一条**方言链路:提示词里的路径同样是 `/c/...` 形式、
路径参数同样被翻译、结果与报错同样回显为 MSYS 形式、`run_code` 程序里的路径字面量同样被翻译,`DSH_PATH_DIALECT` 环境事实也照常下发。
关闭后这些**只对主代理生效**:委托出去的请求保持官方 shell 语义(提示词不改写、路径参数原样传递),适合"子代理要跑原生 Windows 工具链"的场景。

> 能力边界(如实说明):dsh **每个进程只有一个 shell 执行器**(`ctx.shell` 是单例服务),所以 Git Bash **二进制本身仍是全局的**,
> 这个开关管的是**方言/翻译层**,不是"换一个 shell"。关闭后委托代理见到与写出的是 Windows 形式路径(`C:/...`),Git Bash 同样接受,行为自洽。
> 委托身份的判据用会话头的 `origin === 'subagent'` / `delegationDepth > 0`(与 dsh 自身一致),判定不出来时按主代理处理(保留方言)。

配合 `agent-presets` 的 `default`,新会话直接落在 Git Bash 模式,免去每次在
模式选择器里翻找(原版 shipped 模式无法替换或隐藏——部署级、只读):

```yaml
- id: agent-presets
  config:
    default: ptc-cordis   # 或 standard-gitbash / minimal-gitbash
```

### bash 初始化脚本:`initScript`(默认空 = 不启用,v0.45.0,issue #37)

```yaml
- id: gitbash-shell
  config:
    initScript: "~/.dsh/bash-env.sh"   # 默认 "";填一个脚本路径即可
```

填写后,本插件每次执行 bash 命令都会把它作为 `BASH_ENV` 传给 Git Bash —— 这是 bash 自己为**非交互 shell** 准备的钩子:`bash -c` 会先 source 它,而且没有 `-l`(登录 shell)的任何副作用(`cd $HOME`、PATH 重排、profile 输出混进 stdout 都不会发生)。典型用途是 fnm / nvm 这类需要初始化的 node 管理器:在脚本里写一行 `eval "$(fnm env)"`,`node` / `npm` 就会在每条工具命令里可见。

两点边界:①脚本自身打印的任何内容都会混进命令输出,请不要在脚本里 `echo`;②路径必须存在——bash 对不存在的 `BASH_ENV` 静默忽略,所以填错的效果看起来和"没启用"一样。`~` 会展开为家目录。

## bash 从哪里来:解析链与失败引导(v0.28.0,issue #11;懒化与 exec-path 层 v0.33.0,issue #13)

`bashPath` **默认留空 = 自动探测**;解析顺序就是契约:

1. **设置里填的**(显式值优先,失败也不会被别的路径顶替):
   `gitbash-executor` 行 config 的 `bashPath` > `gitbash-shell` 行 / 设置卡的「Git Bash 路径」;
2. **默认安装位置**:`C:/Program Files/Git/bin/bash.exe`、`%ProgramFiles(x86)%\Git`、`%ProgramW6432%\Git`、
   `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`;
3. **PATH**(用户 PATH + 系统 PATH,进程内已合并)逐目录找 `bash.exe`;
4. **PATH 上的 `git.exe` 反推** `<gitdir>/../bin/bash.exe`;
5. **`git --exec-path` 反推 + GitForWindows 注册表**(v0.33.0):对 PATH 上的 `git.exe`(Scoop / choco 的
   **shim** 也照常启动真身)跑 `--exec-path`,从输出向上找 Git 根 —— 兼容 `mingw64` / `ucrt64` 两种运行时
   布局,补上「Scoop 安装、PATH 上只有 shims、没有 `bash.exe`」的盲区;随后兜底读注册表
   `HKLM\SOFTWARE\GitForWindows` 的 `InstallPath`;
6. **注册表 `Path`**(`HKCU\Environment`、`HKLM\...\Session Manager\Environment`)——覆盖"GUI 启动时 PATH 快照过期";
7. **全落空 ⇒ 报错 + 引导**(启动日志一份完整报告,客户端弹一次引导框)。

**解析结果是活的,不是启动时判一次**(v0.33.0,issue #13):启动那一刻插件行可能还没全部挂载,显式配置
会被短暂读成空 —— 现在启动日志、状态接口、弹窗与侧栏终端接管都在**使用时实时重读**,执行器能用,
它们就不会再说「解析失败」;启动日志也会在行挂载稳定后补一份最终结论。

> **只认 Git for Windows 的 bash。** WSL(`C:\Windows\System32\bash.exe`,永远在 PATH 且排序靠前)、
> WindowsApps 别名、MSYS2、Cygwin 的 bash **一律拒绝**;候选还要通过 Git 布局(`usr/bin` + `cmd\git.exe` +
> `mingw64`)、`git --version` 的 `.windows.` 指纹,以及**实跑 `bash -c "uname -s"` 必须是 `MINGW*_NT-*`**。
>
> **本插件不会回退到 PowerShell / cmd / 任何其它 shell。** 找不到 Git Bash 就是找不到:设计如此 ——
> 装了本插件就是要用 Git Bash,偷偷换一个能跑的顶上是错的。失败时弹窗给两件事:在弹窗里**直接填 bashPath**
> (写入设置卡同一字段)或**去下载 Git for Windows**;同一 boot 只弹一次,可关闭。

## 官方侧栏终端(「新建终端」)自动切到 Git Bash(v0.29.0)

DSH 自己的「新建终端」**不经过**本插件的执行器:它由官方的 `terminal-controller` 决定 shell,未配置时用
「执行环境的默认 shell」——而在 PATH 里 `bash` 指向 `C:\Windows\System32\bash.EXE`(WSL 启动器)的机器上,
新终端跑起来就是 Ubuntu。本插件现在会自动把它切过来:

- 仅 **Windows**、且已解析出**通过验证**的 Git Bash 时;设置开关 **「自动接管侧栏终端」默认开启**(`autoTerminalShell`)。
- 只在官方那一行**没有自己的 shell** 时写入 `{ path: <Git Bash>, name: 'Git Bash', args: ['-i'] }`
  (`-i` 就是官方对 bash 的默认参数;**显示名固定为 `Git Bash`**,这样菜单里不会与那条解析到 WSL 的候选 `bash` 混淆)。
  已经由 v0.29.0 写入过、名字还是 `bash` 的历史配置会在启动时**只改名字**(path/args 原样保留,幂等);
  **只迁移我们自己写的那个旧默认名 `bash`** —— 你自己起的名字(例如 `My Bash`)一律不动(它本来也不会与 WSL 候选混淆)。
  **你已经手动指定过别的 shell(例如某个 WSL 配置)⇒ 绝不覆盖**,只在宿主日志里提示,并告诉你如何交还给 Git Bash(清空该字段)。
- 写入走**官方配置编辑器**(设置 UI 用的同一个 API),落到 profile 的 patch 层;**新终端立即生效**,已打开的终端保持原样。
- **不需要重启**,也不会写坏「新建终端」:只写我们验证过存在的 Git Bash(官方对无法解析的路径没有回退,会直接启动失败)。
- 失败时 **fail-loud**:日志写清原因,并通过**读回校验**确认值真的落进去了(不出现"假成功")。
- ⚠️ **如实说明**:我们**没有**改 `shellCandidates`,所以「新建终端」的 shell 选择菜单里**仍可能列出**一条解析到 WSL 的
  候选 `bash` —— 被改掉的是**默认项/首项**(它现在是我们写入的 Git Bash),不是整条菜单。想彻底不让 WSL 出现在菜单里,
  需要另外调整 `terminal-controller` 行的 `shellCandidates`(本插件本轮**不做**,以免覆盖别人的部署配置)。

**三步复验(Windows)**:
1. 装好 Git for Windows,重启 DSH,打开本插件设置卡:开关「自动接管侧栏终端」为开;宿主日志出现
   `official sidebar terminal switched to Git Bash: …`。
2. 新建终端,在终端里确认**它确实是 Git Bash**(两条判据任选,**`uname -s` 最硬**):
   - `uname -s` ⇒ `MINGW64_NT-10.0-<build>`(Git Bash 的 system name;WSL 这里是 `Linux`);
   - `echo $MSYSTEM` ⇒ `MINGW64`(最简)。
   ⚠️ **不要用 `uname -r` 判定**:Git Bash / MSYS2 下它是 **MSYS 运行时版本**(形如 `3.6.9-b4195d69.x86_64`,
   真实用户实测就是这个值),而 **WSL 的 `uname -r`** 才是 `6.x.y.z-microsoft-standard-WSL2` —— 两者都不能单独用来判定。
3. **回退**:⚠️ 关掉设置卡里的开关**只阻止以后的自动写入,不会删除已经写进配置的字段**。要彻底恢复原样,
   请把 profile 的 patch 里 `terminal-controller` 行的 `shell` 字段**删掉**,再重启 DSH(终端随即回到原来的 shell);
   只想让它别再自动改、但不介意保留现状的话,关开关即可。

## 配置(自有 bash 工具)

`bashPath` 经设置卡「Git Bash 路径」(= `gitbash-shell` 行 config 的 `bashPath`
字段)配置;pre-v0.39 旧 profile 遗留的 `gitbash-executor` 行配置仍被读取
(兼容,优先级更高):

```yaml
- id: gitbash-shell
  config:
    bashPath: "D:/Tools/Git/bin/bash.exe"   # 默认空 = 自动探测链
```

## 验证

```sh
npm test
```

重启 host 后新会话:
- 工具列表里出现自有 `bash` 工具(执行在 Git Bash 上);官方 `pwsh` 工具默认隐藏,
  设置卡开启「pwsh 工具」开关后可见(真正的 PowerShell);
- `echo \$BASH_VERSION` 有输出、`command -v bash` 指向 Git 安装目录。

## 卸载

```sh
dsh plugin --profile web remove dsh-gitbash-shell
```

或删除 profile`package.json` 中依赖 + `dsh.profile.bundles` 中的条目后
`dsh plugin --profile web install`。卸载并重启后,未改过的 `* -gitbash`
preset 会被插件自动清理;宿主官方 PowerShell 执行器原样保留(本插件从未替换它),
官方 `pwsh` 工具不再被隐藏。

## 与 dsh-ptc-cordis-preset 联动

本插件在 host 上发布 `gitBash` 能力服务(`{ active, bashPath }`,仅 Windows 为 active)。
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset) v0.5.0+ 在注册
`PTC 创造模式` 时会检测该信号:两个插件都安装时,**PTC 创造模式自动注册为 Git Bash 版**
(`tool-bash` 启用、`tool-pwsh` 禁用),无需新增模式、无需手工修改 preset;
只装本插件时 PTC 创造模式保持原样(由它自己的插件管理)。

### 去重开关:`suppressPeerCordis`(默认关,v0.25.0)

联动生效后,`创造模式 · Git Bash`(本插件的 `cordis-gitbash`)与对方已经 Git Bash 化的
`PTC 创造模式` 面向的是同一件事,而两插件同装时它们默认**并列出现**。把本插件行 Config 上的
`suppressPeerCordis` 打开,本插件才会把自己的那个变体摘掉(需求与取舍见
[issue #7](https://github.com/KannaKuron/dsh-gitbash-shell/issues/7))。

**判定 = 两个事实同时成立,缺一不可**:

- 开关为 `true`;
- 且对方通过 host 能力服务 `ptcCordisPreset` 报告 `gitBashActive: true`(即它的
  `PTC 创造模式` 确实按 Git Bash 版生效)。

对方**没装 / 尚未挂载 / 没生效 / 版本低于 0.14.0** ⇒ 一律**不摘**:宁可名录里多一个条目,
也绝不因为"探测不到对方"就少给用户一个模式。默认关,所以不主动打开就没有任何行为变化。

**生效时机**:

- **开关是实时的**:走行 Config 的 volatile 通道,对方的能力则经
  `ctx.inject(['ptcCordisPreset'])` 观察(**与插件行激活顺序无关**),两边任一变化都当场
  reconcile——摘掉打日志 `preset 'cordis-gitbash' retired (dsh-ptc-cordis-preset covers Creation
  mode on Git Bash)`,恢复打 `preset 'cordis-gitbash' registered declaratively`。已经挂载的会话
  钉在自己的组合快照上,不受影响;名录变化从新会话开始可见。

**两侧设置卡上是同一份状态**:权威值只有本插件这一行 Config 一份;对方的设置卡通过
`ctx.configForms.get('gitbash-shell')` **绑定同一行**、写同一个字段(DSH 官方支持编辑另一个
插件所拥有的命名空间),所以任一侧改动另一侧立即同步——不存在两份拷贝,也没有同步逻辑。
旧宿主上 `configForms` 不存在、镜像卡片不出现,开关只在本插件自己的设置面(`gitbash-shell`
命名空间)可改。

**依赖版本**:去重开关本体在**本插件 ≥ 0.25.0**;对方的协作能力在
**dsh-ptc-cordis-preset ≥ 0.14.0**。

### run_code 后端开关:`pythonRuntime`(默认关,v0.26.0)

dsh 有一个**实验性 CPython 后端**用于 PTC 的 `run_code`
(`@deepseek-ai/dsh-experimental-ptc-runtime-python`)。它换掉的是 **profile 级**的
`ptc-runtime` 行(不是 preset 里的行),所以**权威开关属于 dsh-ptc-cordis-preset**:它那一行
Config 的布尔字段 `pythonRuntime`(默认 `false`),由它在 profile 组合期决定挂哪个后端。

本插件做的是**第二张设置卡**——同装 dsh-ptc-cordis-preset 时,本插件的设置页也会出现这一行,
通过 `ctx.configForms.get('ptc-cordis')` 读写**同一个字段**,任一侧改动两侧立即同步
(与 `suppressPeerCordis` 同构,方向相反)。对方没装、或版本低于 0.15.0(没有该字段)时,
这一行**不显示**。

- **开关关闭(默认)**:`run_code` 用官方 Node/TypeScript 后端,组合与官方逐字节一致。
- **开关开启**:`run_code` 的语言、生成的 SDK 提示词与工具呈现整体切到 Python(由后端实例的
  `language`/`executionInstructions` 决定,组合文本不变)。
- **生效时机**:**重启 dsh 之后生效**(后端行的替换在 profile 组合期求值);设置卡上的状态
  两侧即时同步,只有后端切换需要重启。若开启后没有生效,原因见 dsh 启动日志。
- **"想开"与"真的开了"是两件事**:后端不可用(包被移除 / 解释器低于 3.10 / Windows)时,开关的
  意图仍可为"开",但组合**照旧跑 Node** —— 此时 **workflow 侧不再被连带禁用**(v0.26.1:互斥只看
  实际生效的后端;v0.26.0 只看意图,会让用户白丢 workflow 能力),**原因见 dsh 启动日志**。
  > 关于卡片上的"后端不可用,当前仍为 Node"这行提示:本插件已实现该降级文案(21 语言),但它要等
  > **对方把生效态投影进行 Config 快照**后才会亮起 —— 浏览器只读得到那份快照,而生效态目前只在
  > 宿主侧的能力服务里(见 AGENTS.md §4f)。在此之前:对方卡片显示"已开启 + 原因",本插件卡片
  > 显示"已开启"(hint 指向宿主日志)。
- **平台**:该后端**仅支持 POSIX**——它在 Windows 上构造即抛错,所以 Windows 上开关显示为
  禁用并注明原因,宿主侧也会拒绝写入。
- **与 workflow 互斥**:`workflow-ptc` 硬要求 TypeScript 后端(`ctx.ptcRuntime.language ===
  'typescript'`),官方 Python 组合同样把 `workflow-ptc` / `tool-workflow` 一起禁用。因此**开启
  期间本插件四个变体的这两行一律禁用**(用户自己的 workflow 设置值保留,关掉后端后下次启动
  恢复)——不这样做,选标准/创造模式会因一行构造失败而拒绝**整棵 preset 挂载**。
- **依赖**:python 运行时包由 dsh-ptc-cordis-preset 声明(`optionalDependencies`,
  `0.1.7-rc.2`);本插件不声明该依赖、也不 insert 任何运行行(两个插件各插一行会造成
  `ptcRuntime` 二次注册)。

## POSIX 路径方言(v0.7.0 引入,受 `posixPaths` 开关门控)

Windows 上本插件让命令默认走自有 Git Bash 工具的同时,让**模型看到的路径**统一成 MSYS 盘根
POSIX 形式(`/c/Users/...`、`/c/Program Files/...`)。开关是 settings 命名空间
`gitbash-shell` 的布尔字段 `posixPaths`,**默认开启**(v0.10.0 起),可在 **设置 → 插件**
里本插件的「Git Bash 路径方言」卡片上随时切换;不修改任何 preset / 组合文件,标准/极简/
PTC/创造及用户自建模式一律覆盖。

开启时(仅 Win32),`posixPaths` 门控以下全部行为:

- **提示词源头替换**:组装期(`system-prompt/assemble`)把官方提示词 sections / contexts /
  variables 里的 Windows 绝对路径**原位**改写成 `/c/...`——不增删任何内容、不动工具 schema;
- **一句话指示**:经 `systemPrompt.context`(order 126)注入全局指示——shell 是 Git for
  Windows bash,路径用 MSYS 盘根,所有工具都直接接受这种写法——含 `~`、`/tmp`、`/dev/null`、
  `/usr` 等 bash 原生习惯(v0.17.0 起与 Git Bash 挂载表一致地解析);
- **参数翻译**:`tools/execute` 上把工具的路径参数(`file_path` / `path` / `workdir`,含 present
  的嵌套 `files[].path`)由 `/c/...` 翻回 `C:/...` 交给 Node 文件工具;bash 的 `command` 字段
  不动——那是 Git Bash 母语;**bash 虚拟路径按 Git Bash 挂载表解析(v0.17.0)**:`/tmp` → 用户
  TEMP、`/dev/null` → Windows NUL 空设备、`~` → 家目录、`/usr` `/bin` `/etc` 等 → Git 安装根,
  与 bash 写入/读取同一物理位置;glob 的绝对 pattern(`/c/.../*.md`)自动拆成 `path` + 相对
  `pattern`(原先静默匹配空);
  `/c/...` 翻回 `C:/...` 交给 Node 文件工具;bash 的 `command` 字段不动——那是 Git Bash 母语;
- **结果回流**:成功结果里的路径元数据(`read`/`read_image`/`write`/`edit` 的 `path`、`glob` 的
  `paths[]`、`grep` 的 `matches[].path`、`present` 的 `files[].path`)改写回 MSYS 形式,其中落在
  用户 TEMP 下的路径回显为 `/tmp/...`(与 bash 的 `$TMP` 一致);文件内容与错误结果不动;
  `grep` 的 `matches[].path`)改写回 MSYS 形式;文件内容与错误结果不动;
- **运行时事实**:向官方 `dsh-shell-env` 注册表贡献 `DSH_PATH_DIALECT=msys`,模型可在执行时
  核验(随开关实时生效);
- **右侧栏文件链接(v0.31.0)**:对话里的文件链接带着 `/c/...` 拼写进入 dsh **原生右侧栏**
  (`ui-sidebar-documentpreview`),而宿主文件系统只认 Windows 盘符/UNC 拼写 —— `/c/...` 会被
  解析成 `<当前盘符>:\c\...`,于是显示「文件不存在,可能已被移动或删除」。插件在右侧栏的**唯一
  入口**(`ctx.sidebarRight.openResource`)上把地址还原成宿主拼写,`~` / `/tmp` / `/dev/null` /
  `/usr` 等挂载点按与工具参数翻译**同一张表**处理;宿主事实经只读路由
  `GET /dsh-gitbash-shell/api/pathmap` 提供,**只有宿主自报 `win32` 时才改写**
  (macOS/Linux 宿主永不翻译,事实未到时也不翻译)。**没有改动任何 dsh 源码**,包装随插件卸载还原。

关闭后回到 dsh 原生行为:指示文本为空(组装期直接丢弃,零提示噪声),路径参数与结果元数据
都不再改写,文件工具收 Windows 路径。**bash 始终是 Git Bash,不受此开关影响**——它只决定
跨工具的路径方言。

## 显式工具（Unreleased）

**运行时开关 `experimentalNative`（默认 true）：** 设置 → 插件 → dsh-gitbash-shell →「实验原生执行 / fail-closed」。开启时 Windows 受限/未确定模式拒绝 Bash，提供可用的两个显式工具；关闭立即注销并禁用两个工具，恢复明确标注 `unconfined` 的旧版 Bash（不执行 shell 文件写入限制）。修改作用于现有会话后续调用，无需重启，不终止已启动的任务。拒绝时用户也可在会话访问模式控件选择 `danger-full-access`；Agent 不得自行放宽权限。与路径方言及 codePaths 开关独立。


两个工具随 Windows 的自有 bash 工具挂入同一 agent-owned scope；不替换官方工具或 root
provider，已有同名工具不覆盖。旧 Core 缺少公开 native executor/OutputCollector 能力时不
注册 native 工具，bash/path 不受影响；minimal 的持久终端不通过此补位通道。

- **`gitbash_to_native_path`**：`{ msys_path: 完整值 } → { native_path }`，复用共享且新鲜的
  挂载事实；Windows/cwd-relative 值可原样，未知 MSYS 根/缺 mount、URL、空值/NUL 显式拒绝。
  独立于自动方言与 `codePaths` 开关，不猜程序字符串用途、不授文件权限。
- **`gitbash_native`**：`description`、绝对 `executable: { kind: 'path', value }`、
  `argv: [{ kind: 'literal'|'path', value }]`；literal 不经 MSYS 转换，path 明确转换并规范化。
  可选绝对 typed `cwd`；不支持裸 command、model env、隐式脚本、`.cmd/.bat` 或 escalation。
  已知解释器须显式 `entrypoint: 'interpreter'`；这不是二进制鉴定，也不保证任意 cmd/非CRT parser quoting。
- 每流 `stdoutEncoding`/`stderrEncoding`：`utf8`（默认）、`gbk`、`utf16le`、`raw`；
  `errors: 'replace'`（默认）或显式 `strict`。同流未知混合字节应选 raw，不能自动猜码。
  解码/存储问题独立于真实 exitCode：命令已执行不等于输出可靠，不应因此重复副作用操作。
- 现有 Jobs 提供后台与 timeout promotion（须有 controller）；缺能力明确拒绝，不静默忽略参数。
  没有 Jobs 时为前台 kill deadline。准备阶段也有取消/有界预算；owner dispose/kill 标为中止。
- 产物存放在 host 自有临时目录，不是 model cwd。默认两流 raw+decoded 总磁盘上限8MiB，
  适配器自有载荷预算16MiB；不是OS/RSS或跨任务硬限。完成产物保留便于读取，无自动purge承诺。
  `sourceComplete`、管线 `complete`、tail `lossy`、`artifact.complete` 是不同事实，须联合读取。

**Agent 路由指引**：提示组装与工具说明会明确区分：shell语法/管道/重定向/POSIX脚本用
`bash`；原生.exe精确argv或已知逐流编码用可见的 `gitbash_native`；Node I/O需要完整MSYS
运行时路径时才用可见的 `gitbash_to_native_path`；真正cmdlet/服务/WMI用可见且开关允许的
`pwsh`。按实际工具面引导，不推荐未注册/隐藏的工具，重复组装随可见性更新、不堆叠。
权限拒绝必须停止，不能换工具/模式；解码失败不等于命令没执行，不能盲目重跑副作用。

PTC 模式只直调 `run_code`，里面使用已提供的 `tools.gitbash_to_native_path` / `tools.gitbash_native`。
run_code描述给出SDK选路规则，实际绑定各自说明适用场景；不编造未提供的绑定名称。
已验证实际Core普通/PTC提示与SDK文案送达；未运行真实LLM自主选择验收，不保证每次选择正确。
假设已取得完整 `inputPath`，直接 Node I/O 可写：

```typescript
const resolved = await tools.gitbash_to_native_path({ msys_path: inputPath });
const fs = await import('node:fs/promises');
return await fs.readFile(resolved.native_path, 'utf8');
```

若程序含路径状路由/搜索数据，选择 `codePaths: false` 避免 legacy 自动误改；工具参数翻译仍在。

## 原生 Windows 程序与 run_code 的兼容边界

工具描述始终警示下面的参数、编码和安全限制;这些限制不随路径方言关闭而消失。
插件**不会自动改写 command、全局关闭 MSYS 参数转换或猜测输出编码**。

- **斜杠开关**:MSYS 在启动原生 Windows 程序时可能把 `/all`、`/c` 当路径。
  本机已验证 `ipconfig //all`、`cmd //c` 或单命令
  `MSYS2_ARG_CONV_EXCL='/all' ipconfig /all` 可保留开关。
  排除值是前缀:排除 `/c` 也会影响真正的 `/c/...` 路径,该次原生调用应明确用
  Windows drive-letter 路径。不要全局设置 `MSYS2_ARG_CONV_EXCL='*'`。
  `cmd /c` 被转换后可能 exit0 却没有执行所需命令,应检查预期效果而非只看退出码。
- **输出编码**:宿主按 UTF-8 解码;原生 Windows 程序可能输出 CP936/GBK 或其他代码页。
  先使用程序自己的 UTF-8 输出选项,或在捕获前按已知编码显式转换字节,保持原退出状态。
  `LANG/LC_ALL` 不保证改变原生程序的代码页。不要全流默认 GBK 或依替换字符数自动猜码:
  同一 Bash 调用可能混合 UTF-8/GBK,已有乱码字符串也不能可靠恢复原字节。
- **run_code**:`codePaths` 默认开,与 `posixPaths`/委托 gate 同时生效时,完整、可判定的
  普通路径字面量按共享挂载表尽力转换,包括中文/组合字符/空格/`#` 文件名。
  EOF 行注释不再阻止转换;tagged template(包括 String.raw)保持原样,避免破坏 raw/tag 语义。
  插值模板、转义路径、不确定的正则/除法语法仍可能不改;不确定时整份 no-op。
  直接调用 Node fs/path 时优先明确的 Windows drive-letter 或 cwd-relative 路径;
  工具 path/file_path 字段仍走工具参数翻译。词法扫描不能识别路由、搜索数据或 shell
  command 的用途;此类字符串不要依赖自动重写,必要时关闭 `codePaths`(提示同步标为 OFF)。
- **沙箱**：参见上方安全章节。Unreleased 在 experimentalNative 开启时改为受限请求执行前拒绝，不是恢复了真实围栏；文件工具拒绝不授权 shell/native 重试。

## 与 dsh-better-sidebar 联动

装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)(v0.15.2+) 时,Windows 上本插件会通过**它的官方设置补丁口**(运行时 `terminalShell` 设置,对方文档明示"settings-page overrides win for terminals opened afterwards")把它打开的终端 shell 指向 Git Bash——**UI 终端标签与模型侧 `terminal_*` 工具统一生效**,不改对方一行代码、新开的终端即生效。此外,**本插件的 bundle patch 还会给对方的行补上 `config.shell`**(启动期解析,连 **tab 标题也会显示 bash**;对方未安装时该行无害跳过)。规则:

- **插件全权接管**:Windows 上每次启动都无条件把它的 `terminalShell` 设为 Git Bash——即使你在设置页/别处改过,下次插件启动也会改回来;
- 卸载本插件 → 自动还原为你改之前的原值(回到它的默认解析:pwsh / powershell);
- 想关掉本联动 → 本插件 row 配置加 `betterSidebarShell: false`。

## 许可

MIT © KannaKuron。参考与致敬:[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset)。
