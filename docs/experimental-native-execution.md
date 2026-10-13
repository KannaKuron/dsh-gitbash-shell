# 实验性讨论：Windows 安全拒绝、typed native argv 与显式路径转换

> **状态：实验性实现讨论 / Draft，Unreleased。**
> 这是可运行的工作区实现，用来验证接口与讨论工程取舍，不是发布建议，也不是完整安全认证。
> 尚未部署到生产实例；没有改变宿主安装产物、权限、版本号或发布流程。

关联：[验证矩阵与复现](<experimental-native-verification.md>)、[变更记录](<../CHANGELOG.md>)。

## 1. 要讨论的决定

本提案把三个容易混为一谈的问题拆开：

1. **没有可靠的 Windows Git Bash 围栏时怎么办？** 当前实验选择 fail-closed，不再“标注无围栏后继续”。
2. **必须精确保留 Windows 原生参数、明确解码原生输出时怎么办？** 新增独立 typed argv 入口，复用 Core 托管执行。
3. **原生 Node API 如何使用模型得到的 MSYS 路径？** 新增完整值运行时转换，不再把源码字符串猜测当作可靠机制。

另补 Agent 路由指引，让上述机制不是仅存在于 README 中的“需要用户手动教模型”的能力。

**维护者需要确认的是取舍，不是只看测试绿色：** 是否接受拒绝行为变化、是否需要真正的 opt-in 开关、哪些契约应移入 Core，以及缺少哪些验收才能从实验转为正式功能。

## 2. 问题与非目标

### 2.1 MSYS 参数转换

在 Bash 启动原生程序时，MSYS 可能把 `/all`、`/c` 当作路径。单命令 EXCL、双斜杠等只适用于确定场景；EXCL 按前缀匹配，排除 `/c` 也可能影响真正的 `/c/...` 文件参数。

实验不全局设置 `MSYS2_ARG_CONV_EXCL=*`，不重写 Bash command，不猜某个字符串究竟是 option、路径还是程序源码。

### 2.2 输出编码

UTF-8 捕获不等于原生程序输出 UTF-8。locale 变量不保证改变其代码页；同一调用、甚至同一流可以混合编码。没有替换字符也不能证明转码正确。

实验只支持显式已知编码。**未知同流混编码不能普遍可靠解码；损坏后的字符串不能普遍还原原始字节。**

### 2.3 源码字面量猜测

legacy `codePaths` 无法识别 `/c/users` 是路径还是路由数据，也不能可靠处理所有动态表达式。它的默认值和既有兼容机制没有在本提案中移除。

显式 helper 是完整值接口，不是“更聪明的全程序重写器”。处理路径状业务数据时建议关闭 `codePaths`；普通工具路径参数翻译不因此关闭。

### 2.4 真正 Windows confinement

本提案**没有修复 OS 围栏**。匹配研究纠正了旧泛化：现代 MSYS cygheap 使用 VirtualAlloc，signal pipe 使用显式 SD；实际 Core 已补 TokenDefaultDacl。不能据此声称“再补默认 DACL 就解决”或“所有未来方案都无解”。

IPC/Token/AppContainer/VM 路线仍需隔离环境的真实正负权限验证；本 PR 不修改 ACL、token、registry 或宿主 Core。

## 3. 原则与体验变化

| 项目 | 旧行为或既有原则 | 当前实验 |
|---|---|---|
| Windows 受限自有 Bash | 无围栏执行并标注 unconfined | RO/WW/缺失策略在执行前拒绝 |
| 默认 Shell | Git for Windows Bash | 保持；原生入口是显式补充，不是隐式 fallback |
| root PowerShell/provider | route B 不替换 | 保持 |
| 原生参数 | 通过 Bash/MSYS，可能转换 | typed native 入口只转换标明的路径 |
| Node 路径 | 字面量尽力重写 | 可显式转换运行时完整值；legacy 默认未改 |
| 编码 | 原有 UTF-8 捕获边界 | 新入口逐流显式编码，默认 utf8/replace |
| 设置/界面 | 现有 Config/UI | 不增字段；没有独立 experimental enable 开关 |

**重要：Draft 标签不等于运行时 opt-in。** 当前源码被安装后，Windows own-bash scope 会挂载可用 companion；拒绝行为也会生效。这是否应该增加默认关闭的 feature flag，是待讨论项，而不是已经实现的保护。

## 4. Agent 应如何选择

| 意图 | 选择 | 禁止的理解 |
|---|---|---|
| Shell 脚本、管道、重定向、globbing、POSIX utilities | `bash` | 不能把权限拒绝当作改用另一个执行入口的许可 |
| Windows `.exe` 精确 literal argv，或已知逐流编码 | 可见的 `gitbash_native` | 不是 shell source，也不是通用脚本包装器 |
| 完整 MSYS 路径交给原生 Node fs/path | 可见的 `gitbash_to_native_path` | 不转换路由、搜索数据、command/code；不授文件权限 |
| 真正 PowerShell cmdlet/服务/WMI | 可见且开关允许的 `pwsh` | 不调用隐藏名称、不把 PowerShell 嵌进 Bash 绕行 |
| 权限/访问拒绝 | 停止并说明 | 不自动换模式、解释器、文件工具或 Node I/O |
| 显示/解码失败 | 核对 producer exit 与输出事实 | 不盲目重复有副作用的命令 |

[路由生成](<../src/inline-tools.js>)在[提示组装](<../src/index.js>)按实际工具面生成，不只看开关意图。自有提示块可替换、幂等；重组后不残留失效建议。方言/子代理方言关闭不关闭安全选路指引。

PTC 中直调 schema 可只有 `run_code`：该描述解释如何选择已提供 SDK binding，具体 native/path binding 的描述进入 `tools:sdk`。没有把 SDK 声明误当成可直调工具，也不编造缺失名称。

**已验证提示送达，不等于已验证 LLM 必然正确决策。** 当前没有真实模型自主选工具评测。

## 5. 架构：不建立第二套进程系统

```text
agent-owned tool scope
  ├─ bash → private GitBashSandboxExecutor → existing Core lifecycle/provider
  ├─ gitbash_to_native_path → fresh shared translator → native_path（无I/O）
  └─ gitbash_native
       ├─ 每调用解析真实 standing policy / 严格请求校验
       ├─ prepared capability（WeakMap；不是可伪造的 policy DTO）
       ├─ bounded preparation / trusted artifact owner
       └─ per-operation scope（属于 agent，隔离 shell + subprocess）
            └─ actual LocalBashExecutor.executeArgv
                 └─ private guarded provider facade
                      └─ actual managed provider + per-stream output adapter
```

对应：[执行器](<../src/native-executor.js>)、[工具/Jobs/DTO](<../src/native-tool.js>)、[输出适配](<../src/native-output.js>)。

不改 root 服务条目，不另造 child_process runner/Jobs registry，不覆盖 private spawnSpec。新模块不静态导入宿主 peer；由既有 host resolution 通道注入真实模块。

## 6. 权限与拒绝

### 6.1 自有 Bash

[策略门](<../src/shell.js>)要求 Windows spec 明确为 `danger-full-access`；其他/缺失策略拒绝。工具层[预检查](<../src/bash-tool.js>)位于工作目录准备、环境收集和 Jobs admission/promotion之前。

实际 host SandboxUnavailableError 能解析时保留结构化 SANDBOX_UNAVAILABLE；直接/旧调用者缺导出也必须拒绝，不能因此运行。非 Windows 的受限路径仍继承父后端。

### 6.2 Native

不以部署 defaultMode 代替逐调用策略；准备、执行、目录 callback 前后、最终 spawn seam 重验真实 standing policy。Prepared request 只能由同一个 executor 产生，复制或跨 executor 不构成能力授权。

这只是本地 Windows danger-only 入口，**不是 native restricted-token adapter**；不支持模型传入 env、sandbox_permissions 或自动 escalation。

### 6.3 边界

官方文件工具有独立 policy；helper 转换不扩大权限。minimal 持久 PTY、侧栏交互终端和其他插件执行器不因本门控获得围栏。历史 unconfined 渲染仍兼容旧记录，不授权新调用降级。

## 7. 接口

### 7.1 `gitbash_to_native_path`

输入 `{ msys_path: string }`，成功值 `{ native_path: string }`。复用共享 translator 与 fresh mount facts；无 fs I/O、存在性判断或 env seeding。

Windows-native/cwd-relative 值声明后可 passthrough；未知 POSIX mount、缺映射、空值、NUL、URL明确拒绝。`msys_path`/`native_path`避开旧参数/结果的自动路径字段翻译，避免转换前被改写或成功值回流。

PTC 程序示例，假设 `inputPath` 是已经取得的完整路径值：

```typescript
const resolved = await tools.gitbash_to_native_path({ msys_path: inputPath });
const fs = await import('node:fs/promises');
return await fs.readFile(resolved.native_path, 'utf8');
```

这不是绕过文件拒绝的方式；已发生拒绝必须停止。

### 7.2 `gitbash_native`

| 字段 | 契约 |
|---|---|
| description | 必填、非空、NUL-free |
| executable | 必填 `{kind:'path',value}`，可解析绝对 `.exe`；无 bare command |
| argv | 必填 typed 数组；literal 原值，path 显式转换/规范化；允许空 literal |
| cwd | 可选绝对 typed path；默认 agent workspace |
| entrypoint | native 默认；已知解释器需显式 interpreter |
| stdoutEncoding/stderrEncoding | utf8 默认，或 gbk/utf16le/raw；不支持 auto |
| errors | replace 默认，strict opt-in |
| timeoutMs | 正有限数，默认120000ms，上限600000ms |
| run_in_background | 仅能力允许时声明；与显式 timeoutMs 同时给出会拒绝 |

Native typed path 不支持相对值、变量/home展开；需要时先通过显式 helper取得可用绝对值。Windows 启动字段/path argv规范化反斜杠；literal `/all`、`/c` 等不经过 MSYS。

拒绝未知字段、model env、path-list env、隐式脚本、`.cmd/.bat`。当前限制4096个argv及保守Windows command-line预算。已知解释器名称检查是防误门，不是二进制鉴定；重命名/custom exe可有自己的语言。

**Exact argv 指验证过的 Core/CRT/Node 语义，不承诺任意 cmd/非CRT parser 的 quoting。**

## 8. 编码与输出事实

只有已知 collect disposition `{maxBytes,spill?:{maxBytes}}` 转 raw pipe；未知/其他 disposition按原 provider契约委托。每 operation immutable config，stdout/stderr独立 decoder，只在 ingest解码。

- UTF8默认宽容替换，保留BOM；strict显式。
- Decoder能力在spawn前探测；unknown同流mixed选raw。
- 原字节产物与normalized UTF8产物分开；raw无可靠文本承诺。
- Reader为独立、非消费normalized UTF8 byte cursor；不是原编码byte游标，也不是Core Jobs全局游标。
- handle.done保留真实provider outcome/error身份；decode/storage问题只记facts，不伪造命令未执行。
- OutputCollector只使用公开push/snapshot/seal；不访问其私有spill字段。

| 字段 | 解释 |
|---|---|
| sourceComplete | 是否收到自然EOF；不能单独证明程序未被中止 |
| complete | 管线完整性；不承诺tail包含全文 |
| lossy/reliableText | 与尾缓存、解码、存储等损失合读，不是编码自动鉴定 |
| aborted | 取消/主动terminate/owner终止事实 |
| artifact.complete/capReached/error | 对该产物自身完整性、预算、存储错误判断 |
| rawBytes/rawCursor | 原流字节计数/游标 |
| decodedUtf8Bytes/decodedCursor | normalized UTF8计数/游标 |

Foregound DTO使用closed schemas；去undefined投影不放任unknown字段。无facts/投影失败是显式分支，不通过宽schema吞错。后台最终exit/facts进入现有Jobs文本source，不声称扩展Core Jobs结构化API。

## 9. 生命周期与预算

准备阶段workspace/scope/plugin mount/artifact callback受同一取消/有界期限控制，剩余预算交Core；后台/onExpiry:none只限制准备，已handoff producer不会被准备timer杀死。

operation-owned AbortController统一caller cancel、explicit kill、ownerdispose；先记录cause再terminate。正常settlement后释放scope不能反向污染已完成facts。

输出end/error/close/abort/provider failure分别收尾；默认250ms有界drain，不无限等后代持有管道。不保证所有输出在短drain窗口内到达，未完整必须如实标注。

默认两流raw+decoded总磁盘8MiB、自有payload16MiB；含保守tail/copy/scratch预留。**不是OS/RSS、provider buffer、caller副本或跨调用硬quota。**

trusted owner在真实policy/校验后创建自有临时目录，不从model cwd建产物目录。Adapter不创建目录、chmod、删除或授权；文件有限wx创建。完成产物保留供晚reader读取，无自动purge承诺。晚callback结果不续spawn，不武断删除可能仍被引用的目录；归trusted retention owner。

## 10. Jobs 与动态装配

复用registry.start/wait/read/kill/remove、processJob/processSources和owner/controller admission。Scope属于agent，不属于tool registration fiber；后台/promotion后卸载工具不提前销毁运行进程。

没有controller时明确拒绝，不以“admission失败后再运行前台”冒二次副作用风险。没有Jobs时为前台kill deadline；有Jobs时可timeout promotion。该差异需在正式用户体验验收中检查。

Windows own-bash agent scope挂两个companions，不覆盖已有同名工具。缺native executor/OutputCollector公开能力不撤bash/path。新工具不加入minimal持久终端通道，不改变root PowerShell、market patch或preset id。

## 11. 已发生的反证与修正

1. 初版ownerdispose/direct kill虽quiet且无LATE，却错报completed/aborted:false/artifact.complete:true。独立固定sentinel反证后，operation cause与adapter terminate共同修正；正常cleanup反向用例确保不污染成功结果。
2. trusted artifact callback初版可无限await；abort/deadline时0spawn但不返回。现准备阶段有界race，晚callback不恢复执行，保留资源责任明确。
3. 初版facts空宽schema现closed DTO；跨模块termination枚举/三参callback曾不同步，已对齐并真实Core负向校验。
4. 集成发现显式证据env未配置、路径夹具硬编码盘符/安装bootstrap；改test-only目录预载、动态盘符、宿主自身bootstrap，真实Node fs复跑通过。没有放宽产品断言掩盖失败。

详情见[验证文档](<experimental-native-verification.md>)。失败观察用例退出0只表示复现成功，不能算修复通过。

## 12. 合并讨论 / 未覆盖

- [ ] 是否接受受限模式从旧绕过改为拒绝的breaking体验？
- [ ] 是否拆分fail-closed、native/path、路由三个PR？本地基线包含此前兼容修复，需确认目标base/依赖。
- [ ] 是否增加默认关闭的experimental开关？当前没有此开关。
- [ ] Native argv、逐流encoding、normalized cursor、artifact facts是否应成为Core公开加法契约？
- [ ] 在哪一层承担跨任务quota、artifact权限/retention/清理？
- [ ] Controller缺失/Jobs promotion如何形成一致的前台体验？
- [ ] 真实Agent选工具评测、生产GUI/full apply、会话replay尚未验收。
- [ ] 真restricted-token/ACL/IPC/VM正负权限、PTY/SSH、任意非CRT/解释器quoting尚未验收。
- [ ] 真实disk exhaustion、吞吐/RSS峰值、跨任务DOS/自动purge尚未验收。
- [ ] 若未来Core提供受限native adapter，应如何探测启用而非偷换mode？

**当前结论：接口机制与确定性隔离用例可讨论；不能据此宣布普遍乱码解决、Windows沙箱恢复或正式发布就绪。**
