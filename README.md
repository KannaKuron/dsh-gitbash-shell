# dsh-gitbash-shell

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

简体中文 | [English](README_EN.md)

> 让 DeepSeek Harness (dsh) 在 Windows 上**全部使用 Git Bash** 的官方风格插件
> —— 以 Git for Windows 的 `bash.exe` 替换 PowerShell 执行器,并为所有模式
> 物化对应的 Git Bash 版 agent preset。

## 它解决什么

官方 Windows 组合默认把 `dsh-pwsh-sandbox` 作为 `ctx.shell`(PowerShell 执行器),
且各 preset 的 `tool-bash` 行在 win32 上被禁用——因为在 Windows 上裸 `bash`
会解析到 `C:\Windows\System32\bash.exe`(WSL 占位),本插件直接指定
`C:/Program Files/Git/bin/bash.exe` 并保留官方沙箱语义。

安装本插件后:

| 模式 | preset id | 说明 |
| --- | --- | --- |
| 标准模式 · Git Bash | `standard-gitbash` | 完整编码 Agent,shell 为 Git Bash |
| 极简模式 · Git Bash | `minimal-gitbash` | 持久 Git Bash 终端 + str_replace_editor |
| PTC 模式 · Git Bash | `code-gitbash` | PTC(Code Mode SDK)+ Git Bash |
| 创造模式 · Git Bash | `cordis-gitbash` | 自引用 Cordis 工具集 + Git Bash |

原有的 `标准模式`/`极简模式`/`PTC 模式`/`创造模式`(shipped,不可修改)在
Git Bash host 下会拿到"暗示 PowerShell 语法的工具",请改用上面的变体;
已装 dsh-ptc-cordis-preset 的话,`PTC 创造模式` 用户 preset 不受影响。

### dsh 版本双适配(0.1.1 与 0.1.2+)

dsh 0.1.2 把内置 `code` preset 改名为 `ptc`(`mode: code` → `mode: ptc`,官方不做
兼容别名),并给各内置 preset 新增 `command-goal` 等行。本插件为受影响的变体
(standard/code/cordis)**同时携带两个 era 的已提交组合文本**,启动时探测内置
roster 自动选择,并记进 `.plugin-managed.json` 的 `base` 字段;探测翻转(dsh
升级前后)自动重物化。`minimal-gitbash` 的内置底稿跨版本未变,单文本服务两个
era。**preset id 保持 `code-gitbash` 不变**(会话钉在 id 上,改名会让已固定的
会话报 preset not found)。无论先升级插件还是先升级 dsh,都会自动收敛;用户改
过的目录照旧不碰。

### dsh 0.1.6 适配(工作流引擎行改名)

dsh 0.1.6-alpha.1 把内置预设的工作流引擎行 `workflow-worker-thread` 改名为
`workflow-ptc`,并**删除**了旧包。组合里一行 import 失败会拒绝**整棵 preset 挂载**,
所以把旧名钉死在资产里的 preset 在新版上会直接不可用。本插件两个拼法都不钉:物化时
**从宿主自己的内置 preset 现场抄**那一行的 id、包名与 `disabled` 状态
(`rowFormsOf` / `alignEngineRow`),并让 `tool-ralph` 跟随新版默认的 `disabled: true`。
改写是纯字符串手术(不解析 YAML,`!!js` 安全)且幂等;探测失败(旧宿主、无 roster)时
资产保持逐字节原样——**一份资产通吃两个 era,升级顺序无关**。

同一版还把 `LocalBashExecutor` 的受保护钩子改成了异步:插件的 `runArgv` 结果解包、
`start` 的返回形态与 `confine` 的取消信号都按**加载期探测**自适应,新旧宿主行为一致。

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

bundle patch(`cordis.patch.yml`)应用三个改动:

1. `pwsh-sandbox` 行 `disabled: true` —— 每进程只允许一个 `ctx.shell`;
2. 插入 `gitbash-executor`(`dsh-gitbash-shell/shell`):继承官方
   `@deepseek-ai/dsh-bash-sandbox`,仅把内层 argv 换成
   `<git-bash.exe> -c <command>`。沙箱策略/拒绝分类/后台任务/超时/设置节
   全部沿用官方实现;full-access 分支单独接 Git Bash(父类那里硬编码裸 `bash`);
3. 插入 `gitbash-presets`(`dsh-gitbash-shell/presets`):启动时把上表 4 个
   preset 物化到首个 user-trust preset 根目录,并写
   `.plugin-managed.json`(逐文件哈希)——未改动则随版本刷新;被用户改过就
   不再碰;卸载时(且仅当未改动)会清理。

**环境变量**:`bash.exe` 是 host 进程的直接子进程(不经 git-bash 登录壳),完整继承
系统环境变量与 `DSH_*` 快照,和原来 pwsh 拿到的完全一致。

## 配置

`gitbash-shell` 行(行 id 自 v0.24.0 起与设置命名空间同串;≤ v0.23.0 为 `gitbash-presets`)
支持 `presets` 数组,只物化你常用的模式(未列出的旧物化目录、且未被用户修改过的,会自动清理):

```yaml
- id: gitbash-shell
  config:
    presets: [standard-gitbash, minimal-gitbash]   # 默认物化全部 4 个
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

## bash 从哪里来:解析链与失败引导(v0.28.0,issue #11)

`bashPath` **默认留空 = 自动探测**;解析顺序就是契约:

1. **设置里填的**(显式值优先,失败也不会被别的路径顶替):
   `gitbash-executor` 行 config 的 `bashPath` > `gitbash-shell` 行 / 设置卡的「Git Bash 路径」;
2. **默认安装位置**:`C:/Program Files/Git/bin/bash.exe`、`%ProgramFiles(x86)%\Git`、`%ProgramW6432%\Git`、
   `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`;
3. **PATH**(用户 PATH + 系统 PATH,进程内已合并)逐目录找 `bash.exe`;
4. **PATH 上的 `git.exe` 反推** `<gitdir>/../bin/bash.exe`;
5. **注册表 `Path`**(`HKCU\Environment`、`HKLM\...\Session Manager\Environment`)——覆盖"GUI 启动时 PATH 快照过期";
6. **全落空 ⇒ 报错 + 引导**(启动日志一份完整报告,客户端弹一次引导框)。

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

## 配置(执行器)

`gitbash-executor` 行支持:

```yaml
config:
  bashPath: "D:/Tools/Git/bin/bash.exe"   # 默认 C:/Program Files/Git/bin/bash.exe
  timeoutMs: 60000                         # 默认 60s,可继续用 shell 设置节调整
```

## 验证

```sh
npm test
```

重启 host 后新会话:
- 工具列表里出现 `bash`(不再有 `pwsh`),描述为 Git Bash;
- `echo \$BASH_VERSION` 有输出、`command -v bash` 指向 Git 安装目录。

## 卸载

```sh
dsh plugin --profile web remove dsh-gitbash-shell
```

或删除 profile`package.json` 中依赖 + `dsh.profile.bundles` 中的条目后
`dsh plugin --profile web install`。卸载并重启后,未改过的 `* -gitbash`
preset 会被插件自动清理;宿主 shell 回退为 PowerShell。

## 与 dsh-ptc-cordis-preset 联动

本插件在 host 上发布 `gitBash` 能力服务(`{ active, bashPath }`,仅 Windows 为 active)。
[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset) v0.5.0+ 在物化
`PTC 创造模式` 时会检测该信号:两个插件都安装时,**PTC 创造模式自动物化为 Git Bash 版**
(`tool-bash` 启用、`tool-pwsh` 禁用),无需新增模式、无需手工修改 preset;
只装本插件时 PTC 创造模式保持原样(由它自己的插件管理)。

> 切换生效后若 `ptc-cordis` 目录已存在且被旧版本物化,删除
> `~/.dsh/.agent-presets/ptc-cordis` 并重启,即由新逻辑重新物化。

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

- **新宿主(dsh ≥ 0.1.7)是实时的**:开关走行 Config 的 volatile 通道,对方的能力则经
  `ctx.inject(['ptcCordisPreset'])` 观察(**与插件行激活顺序无关**),两边任一变化都当场
  reconcile——摘掉打日志 `preset 'cordis-gitbash' retired (dsh-ptc-cordis-preset covers Creation
  mode on Git Bash)`,恢复打 `preset 'cordis-gitbash' registered declaratively`。已经挂载的会话
  钉在自己的组合快照上,不受影响;名录变化从新会话开始可见。
- **旧宿主(dsh ≤ 0.1.6)是启动时判定一次**:旧宿主没有可观察的注册表,能力探测是有界的
  (默认 1s,读不到即视为"对方不覆盖"),所以打开开关后,上一轮物化出来的 `cordis-gitbash`
  目录会被清理;把开关关掉后,该变体要到**下一次启动**才重新物化。

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

Windows 上本插件把宿主 shell 换成 Git Bash 的同时,让**模型看到的路径**统一成 MSYS 盘根
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

## 与 dsh-better-sidebar 联动

装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)(v0.15.2+) 时,Windows 上本插件会通过**它的官方设置补丁口**(运行时 `terminalShell` 设置,对方文档明示"settings-page overrides win for terminals opened afterwards")把它打开的终端 shell 指向 Git Bash——**UI 终端标签与模型侧 `terminal_*` 工具统一生效**,不改对方一行代码、新开的终端即生效。此外,**本插件的 bundle patch 还会给对方的行补上 `config.shell`**(启动期解析,连 **tab 标题也会显示 bash**;对方未安装时该行无害跳过)。规则:

- **插件全权接管**:Windows 上每次启动都无条件把它的 `terminalShell` 设为 Git Bash——即使你在设置页/别处改过,下次插件启动也会改回来;
- 卸载本插件 → 自动还原为你改之前的原值(回到它的默认解析:pwsh / powershell);
- 想关掉本联动 → 本插件 row 配置加 `betterSidebarShell: false`。

## 许可

MIT © KannaKuron。参考与致敬:[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset)。
