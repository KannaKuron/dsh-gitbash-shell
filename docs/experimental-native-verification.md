# 实验性实现：验证矩阵、证据分级与复现

> **这是实验性讨论的验证记录，不是发布或安全放行。**
> 关联：[设计/接口/待讨论决定](<experimental-native-execution.md>)、[CHANGELOG](<../CHANGELOG.md>)。
> 验证日期：2026-10-14（保留此前轮次记录）。以下结果适用于所列运行环境，不代表所有宿主版本或生产场景均已通过。

## 1. 验证基准与结果

- 当前实验基线：[上游 v0.39.4（52da331）](https://github.com/KannaKuron/dsh-gitbash-shell/commit/52da331)。前置 PR #24 已合并；2026-10-15 第一轮设计评审后由 v0.39.3（114dcde）rebase 而来，本节末尾补记本轮验证。
- 测试环境：**DSH Core 0.2.1-alpha.2**、Node 24.13.0、Windows / Git for Windows。
- 新native功能按公开能力探测启用；既有兼容版本范围之外的实际覆盖情况见后文待验收项。
- 最终普通全仓：**232 tests / 232 pass / 0 fail / 0 skip / 0 cancel，exit0**。
- 最终实际Core完整preview：**85 tests / 85 pass / 0 fail / 0 skip / 0 cancel，exit0**。
- 语法与`git diff --check`通过；npm dry-run确认新源码包含于发布文件集合。Dry-run不是已安装/发布，也不是新增生产版本。

计数是Node test runner报告口径，包括子测试/套件；不同轮次或独立复跑有重叠，**不累加为独立覆盖数量**。232/85 是当前完整脚本结果，不意味着每项都是真生产进程场景。

## 2. 证据等级

| 等级 | 本提案实例 | 可以证明 | 不能证明 |
|---|---|---|---|
| 静态/源码与公开契约 | 配置、SDK/types、实际安装导出、匹配MSYS因果资料 | 实现依赖与约束、提出机制假设 | 新OS沙箱可用或任意版本兼容 |
| 纯单元/受控注入 | 请求parser、预算、流异常、字段schema、路由矩阵 | 确定性输入输出与拒绝/收尾规则 | 真实磁盘故障或任意producer行为 |
| 实际Core + 禁止spawn桩 | ToolRuntime/scoped装配/提示组装 | 真Core结构化拒绝、零admission、注册/卸载/隐藏 | 生产GUI或真实native程序跑通 |
| 实际Core + 受控native程序 | LocalSubprocessRuntime/executeArgv/Jobs、固定bytes/READY/LATE | 所测环境中的真实argv、编码、kill/quiet/promotion与owner行为 | 全部原生parser、网络/SSH、真受限token |
| 实际PTC + Node/fs | ToolRuntime→NodePtcRuntime→LocalSubprocessRuntime→Node fs读自有输入 | 完整值helper子分发、动态路径、route/tag保持 | 完整插件apply/生产用户policy/模型自主选择 |
| 实际Core提示/SDK生成 | SystemPrompt.assemble普通/PTC及工具visibility | Agent将收到正确的说明与可见binding | 模型每次一定选对 |
| 未执行 | 生产GUI/full apply/LLM选择、OS权限、吞吐/RSS/retention | 仅列为待验收 | 不能作为通过项 |

## 3. 可审阅测试清单

| 文件 | 重点 | 层次 |
|---|---|---|
| [smoke](<../tests/smoke.mjs>) | legacy与modern executor契约、Windows受限/未解析零argv、full/非Windows行为、既有护栏 | 纯回归与受控基类 |
| [runtime regressions](<../tests/runtime-regressions.mjs>) | 受限前台/后台/promotion admission前拒绝，既有Jobs动态卸载 | Cordis受控回归 |
| [compatibility regressions](<../tests/compatibility-regressions.mjs>) | 源码路径边界、live hint、选路判据、16种可见性组合、幂等、SDK-only/路径说明 | 确定性纯回归 |
| [path unit](<../tests/path-tool.mjs>) | 共享translator/fresh env、empty/NUL/URL/未知映射、schema/注册/卸载 | 纯单元 |
| [path preview](<../tests/path-preview.mjs>) | 真实PTC子分发与Node fs读中文/#自有输入、完整值动态组合、route/tag保持、catchable错误 | 实际引擎/子进程/文件读 |
| [output unit](<../tests/native-output.mjs>) | incremental/BOM、默认replace/strict、budget/cursor、异常drain、terminate完整性 | 单元含受控异常 |
| [output preview](<../tests/native-output-preview.mjs>) | 公开OutputCollector、actual raw pipe、多编码、真实exit与decodeError分离、READY后终止/quiet | 实际Core/固定producer与受控I/O异常 |
| [native unit](<../tests/native-executor.mjs>) | typed argv/path、解释器/字段/编码/env拒绝、预abort、准备/mount有界 | 单元 |
| [native preview](<../tests/native-preview.mjs>) | 实际executeArgv/ToolRuntime/Jobs、argv、多流、strict exit7、credential sentinel、timeout/背景/promotion/controller/owner | 实际Core/真实controlled Node |
| [independent regression](<../tests/native-integration-preview.mjs>) | prepared伪造/跨executor、重复policy gate、callback revocation/abort/deadline、owner/kill、自然完成后晚reader | 实际Core独立反证回归 |
| [runtime preview](<../tests/runtime-preview.mjs>) | actual拒绝、agent装配/卸载/重载、官方root保留；普通/PTC真实prompt/SDK及隐藏工具 | 实际Core，执行部分使用桩 |

既有client/FastCtx/host/preset/桥接测试仍在完整脚本中；没有只运行新增测试冒充全仓通过。

## 4. 特别需要看负向断言

### 4.1 Policy不是defaultMode

- RO/WW/missing拒绝；默认full不能放宽另一会话。
- Prepared DTO复制、其他executor产生的对象拒绝。
- 重复resolve阶段与实际executeArgv的spawn seam分别测策略翻转，均零producer spawn。
- Artifact await期间撤销/取消也拒绝，不恢复已取消准备。
- 自有bash前台、显式后台及promotion不得先登记job再报告拒绝。

这些断言验证入口门禁，**不是实际restricted-token写入正负试验**。

### 4.2 Producer outcome与display分离

- Strict非法字节不能把真实exit0/exit7改成“命令没有执行”。
- Raw bytes保留、stdout/stderr单独解码，并发编码不能共享latest状态。
- `sourceComplete`可与`aborted:true`同时出现，不把自然pipe EOF误作自然producer完成。
- 实际ownerdispose/directkill保持range quiet且无LATE，同时status killed/aborted true/artifact incomplete。
- 自然完成后的scope cleanup不得反向污染complete；晚reader产物仍可读。

### 4.3 准备阶段取消

- 挂起workspace、scope mount、trusted artifact callback受有界等待控制。
- 取消/期限到达时不等待late callback才返回；scope释放，零spawn。
- 晚目录结果归trusted owner保留，不冒称自动purge；不武断删除仍可能有引用的资源。

### 4.4 输出字段严格性

真实ToolRuntime对unknown深层facts、错误类型budget、伪造fallback分支进行负向校验。去undefined只做lossless DTO投影，不放宽closed schema；SDK不支持的minimum关键词没有强行加入，非负计数由adapter运行时校验。

### 4.5 Agent选路说明

- Shell与native先按任务性质选，不把native当权限拒绝后的fallback。
- 不再同时承诺“所有命令ALL commands走bash”与“原生入口可用”。
- `pwsh`必须实际可见且switch允许；native/helper缺失不得推荐其名称。
- 重复组装和隐藏后更新提示，不堆叠旧块。
- PTC assembly只见run_code时解释SDK调用，实际SDK含binding自有说明。
- 委托方言关闭仍有选路/禁止绕行提示。

**没有调用真实LLM让它独立选择工具**；此处是prompt delivery，不是行为成功率统计。

## 5. 复现方式（开发测试，不是安装教程）

安装开发依赖并准备对应宿主后运行：

```bash
npm test
```

Windows实际Core测试通过环境变量指定宿主目录：

```bash
DSH_PREVIEW_HOST_DIR='<实际宿主resources/app绝对路径>' npm run test:preview
```

将占位符替换为待测试宿主的 resources/app 绝对路径。

脚本通过[host loader](<../tests/host-loader.mjs>)解析安装的Core导出，并预载[test-only evidence env](<../tests/preview-env.mjs>)创建测试证据目录。

测试默认在临时目录下创建独立scratch并保留证据。每流artifact有预算，测试目录不会自动清理；也可提前创建目录并设置以下环境变量：

- DSH_NATIVE_OUTPUT_EVIDENCE_DIR
- DSH_NATIVE_EVIDENCE_DIR
- DSH_NATIVE_REVIEW_EVIDENCE_DIR
- DSH_PATH_EVIDENCE_DIR

单独运行preview文件时，同时预载host-loader和preview-env，或设置该测试要求的证据目录环境变量。

## 6. 失败记录与证据修正

| 曾出现的失败 | 纠正 | 为什么记录它 |
|---|---|---|
| Cordis bound-function直接===不同 | 比较真实service registry entry身份 | trace proxy不能被误判为root替换 |
| 夹具缺session.header.id | 补实际shellEnv要求 | 不放宽产品env契约 |
| outputFacts可选undefined | 工具边界lossless投影，closed DTO负例保留 | 不掩盖Core拒绝或producer exit |
| ownerkill只terminate | 加operation cause与adapter interruption，反向cleanup断言 | 原有quiet通过不等于完整性正确 |
| callback无限await | 准备deadline/abort race，late资源责任明确 | 零spawn仍可能无限悬挂 |
| 空宽facts schema | 枚举closed shapes与终态，真实负例 | 不能宽schema补签 |
| 最终termination/callback跨模块不同步 | 精确enum和三参signal对齐 | 防止输出校验抹真实outcome |
| 旧description还锁unconfined宣传 | 改为更强拒绝/不绕行护栏 | 行为变化不是弱化测试 |
| 完整preview缺evidence env/夹具固定盘符 | test-only预载、动态盘符、host bootstrap | 本机可重复不等于可迁移 |

独立审查旧态观察测试即使exit0，只证明缺陷被复现。最终将这些观察转为修复后的硬回归。独立专项复跑41/55与全仓结果重叠，不另加总数。

本文提供断言、结果计数和适用限制；完整日志与artifact由测试运行生成。以上测试文件可用于复现对应场景。

## 7. 转正式功能前的验收清单

- [x] 维护者裁决默认开启的 volatile 开关，关闭恢复旧行为。
- [ ] 生产GUI/full plugin apply、Agent真实选择、会话replay。
- [ ] 真Windows confinement正负权限/IPC/token及可接受隔离方案。
- [ ] SSH/PTY、代表性非CRT/解释器程序的实际quoting。
- [ ] 真实disk exhaustion、吞吐/RSS、跨调用配额/retention/清理。
- [ ] 更多真实Core版本与宿主布局；能力不足不得误advertise。
- [ ] Jobs/controller缺失和promotion用户体验。
- [ ] 决定哪些接口应该成为Core公开加法契约。

在这些项完成前，保持Draft/实验讨论定位，不称普遍编码修复或新沙箱实现。

## PR #26 运行时开关裁决后的验证（2026-10-13 历史轮次）

本轮普通完整回归 **226/226**，实际安装 Core 完整 preview **75/75**，均 exit0、无 skip/cancel。环境仍为 Windows、Node 24.13.0、Core 0.2.1-alpha.2。新增覆盖：

- 卡片缺键默认 ON、两向写同一行 Config 字段、21 字典键对齐（当时其余 19 语言暂用英文，本轮已本地化）。
- 实际 ToolRuntime 中现有会话 ON/OFF 反复切换、初始 OFF 后启用、工具 schema 注销/注册、受限 Bash 拒绝/旧 unconfined 结果；root shell 不变。
- 旧路径定义关闭后零翻译；native 已准备请求关闭后零 scope/adapter；artifact 异步准备期间关闭后零 spawn、scope 释放，重新开启后真实 Node producer 运行一次。
- #24 actual promotion DTO 测试以显式 OFF 验证旧 sandbox facts 提示，full-access 无警示。

初版 tools.restrict agent-local mask 被实际 Core 拒绝；改为动态拥有者注册。artifact 负例初版检查仅在 spawn facade 内，被 Core 转为失败 handle；增加准备后检查后以明确错误拒绝，未放宽零 spawn 断言。

仍待正式四项验收：真实 Agent 自主选路、生产 GUI（非 preview）、维护者 win32 真机全量验证、非 CRT 解释器矩阵抽测。当时 #24 未合并；本轮已完成到上游 main 的 rebase。

## 同步 v0.39.3 后的验证（2026-10-14，所有权修复前）

当前完整回归 231/231、实际 Core preview 79/79，exit0、无 skip/cancel。新增缺 workingDirectory 的三工具挂载/cwd/双向开关，真实 native producer 的 policy/header 默认目录；有服务 ensure 错误不降级。两个 companion 也验证真实注册后才报成功。21 份字典已本地化。

代表性解释器抽测：真实 cmd.exe 的 literal /c echo sentinel；Windows PowerShell 的显式 EncodedCommand + UTF16 输出中文 sentinel。均通过；这些固定脚本不证明任意引号、元字符或所有非 CRT parser 的可靠性。真实 Git Bash 在 fixture RO/WW 中 OFF 执行并携带 unconfined facts，ON 再次拒绝；未确定策略在 ON 拒绝。所有进程均在隔离 Context 与临时目录中，不改变生产 Profile。

[已安装实验构建的实机报告](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26#issuecomment-6149607594)覆盖 Bash/native/path 入口与 RO/WW、单次批准不粘滞。报告没有记录精确提交，且明确未覆盖开关 OFF、生产 GUI、真实 LLM 自主选路或非 CRT 矩阵；将其作为有限外部证据，不扩展为当前 rebase 构建的完整验收。

仍需真实 LLM 自主选路、生产 GUI、维护者 Windows 全量验证、非 CRT 矩阵的正式确认；保留 Draft/RFC。

## 独立审查后的工具所有权修复（2026-10-14）

隔离子代理确认一项 P2：开关 OFF 期间外部注册同名工具，恢复 ON 后全局外部工具被遮蔽，同 agent 外部工具则导致 duplicate 异常并中断后续 companion 注册。共用注册入口现对每次初始挂载、开关更新及 native Jobs 刷新重新检查当前 agent 的所有权；外部所有者存在时让位，检查或注册失败记录日志并隔离异常。实际 Core 的 knownNames 包含隐藏工具，旧宿主回退 schemas 检查；旧宿主隐藏工具行为尚未独立验证。

`tests/runtime-preview.mjs` 新增六项实际 Core 回归：path/native × 全局/同 agent 四种冲突的重复 OFF→ON、外部所有者移除后的恢复、native Jobs 卸载/重载冲突，以及隐藏全局同名工具。`tests/runtime-regressions.mjs` 新增一项单个注册失败不阻断另一个工具、后续恢复和卸载清理的回归。scope 就绪与实际注册成功分别记录。

最终普通全仓 **232/232**、实际 Core 完整 preview **85/85**，均 exit0、无 skip/cancel。隔离子代理独立重跑原始所有权复现两项与新增专项七项，**9/9** 通过：全局与同 agent 外部 sentinel 均保持原响应，另一 companion 正常注册。未发现新的确认缺陷。这些专项与完整结果重叠，不累加。

最初疑似 Bash policy 时序问题已撤回：实际宿主契约为逐操作快照，模式变更作用于下一次调用；直接修改 fixture header.policy 不能证明违约。本轮保持该契约。上述四项正式验收仍待，继续保持 Draft/RFC。

## 同步 v0.39.4 后的验证（2026-10-15，第一轮设计评审收敛）

按[维护者第一轮设计评审](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26#issuecomment-6182031633)rebase 到 v0.39.4（52da331）并完成三项收敛：① 新增实际 Core 断言——`fastctxTools` OFF（v0.39.4 默认值）且工具面无 `gb_*`/`ops_*` 的单装场景下 companion 注册检测照常挂载（`tests/runtime-preview.mjs`「companions mount on the single-install face with fastctxTools OFF」）；② 设计文档 §3 补同装 dsh-ops 组合盲点；③ session-workdir 保留模块化 `src/session-workdir.js`（52da331 未触及 bash-tool.js，收敛在 rebase 中自动完成，smoke 新增源码断言防双实现静默回归）。

普通完整回归 **236/236**、实际 Core（desktop-next host，0.2.0-rc.1）完整 preview **86/86**（较上轮 85 增本轮①断言一例），均 exit0、无 skip/cancel。有界只读交叉核验（隔离子代理）独立复跑数字一致，变异测试确认新断言对 fastctx 门控移除有唯一检测力；fastctxTools OFF 下禁用的桥走 unpublish 短路、不进入 publish（disabled 日志断言）。已知非本轮引入的遗留：客户端 FastCtx 卡 21 语言 hint 仍写「默认开启」而实际默认 OFF（继承自 main 52da331），拟作为上游问题在 PR 说明。上述四项正式验收仍待。
