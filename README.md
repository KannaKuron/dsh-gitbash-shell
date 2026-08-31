# dsh-gitbash-shell

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

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

`gitbash-presets` 行支持 `presets` 数组,只物化你常用的模式(未列出的旧物化目录、
且未被用户修改过的,会自动清理):

```yaml
- id: gitbash-presets
  config:
    presets: [standard-gitbash, minimal-gitbash]   # 默认物化全部 4 个
```

配合 `agent-presets` 的 `default`,新会话直接落在 Git Bash 模式,免去每次在
模式选择器里翻找(原版 shipped 模式无法替换或隐藏——部署级、只读):

```yaml
- id: agent-presets
  config:
    default: ptc-cordis   # 或 standard-gitbash / minimal-gitbash
```

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

## POSIX 路径指示(v0.7.0)

Windows 上本插件把宿主 shell 换成 Git Bash 的同时,会向**每个会话的系统提示**注入一条全局指示(仅 Win32,走 `systemPrompt.context`,不影响任何 preset/组合文本):**bash 命令里一律用 POSIX 风格路径**(`/c/Users/...`、`/c/Program Files/...`),不要 `C:/...` 或 `C:\...`。这样模型在工具调用里不会再拿 Windows 盘符路径喂给 Git Bash——标准/极简/PTC/创造及用户自建模式全部覆盖,无需任何模式单独改。

## 与 dsh-better-sidebar 联动

装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)(v0.15.2+) 时,Windows 上本插件会通过**它的官方设置补丁口**(运行时 `terminalShell` 设置,对方文档明示"settings-page overrides win for terminals opened afterwards")把它打开的终端 shell 指向 Git Bash——**UI 终端标签与模型侧 `terminal_*` 工具统一生效**,不改对方一行代码、新开的终端即生效。此外,**本插件的 bundle patch 还会给对方的行补上 `config.shell`**(启动期解析,连 **tab 标题也会显示 bash**;对方未安装时该行无害跳过)。规则:

- **插件全权接管**:Windows 上每次启动都无条件把它的 `terminalShell` 设为 Git Bash——即使你在设置页/别处改过,下次插件启动也会改回来;
- 卸载本插件 → 自动还原为你改之前的原值(回到它的默认解析:pwsh / powershell);
- 想关掉本联动 → 本插件 row 配置加 `betterSidebarShell: false`。

## 许可

MIT © KannaKuron。参考与致敬:[dsh-ptc-cordis-preset](https://github.com/KannaKuron/dsh-ptc-cordis-preset)。