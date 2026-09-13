# Changelog — dsh-gitbash-shell

> 倒序排列,新版本条目在最上面。条目格式:`## vX.Y.Z — YYYY-MM-DD` + 类型(feat / fix / docs / chore)+ 要点 + 相关链接。
> 纪律见 AGENTS.md「变更记录纪律」:发版前先更新本文件并随版本提交;事故复盘、复现与真机验证记录也记在这里。

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
