# Changelog — dsh-gitbash-shell

> 倒序排列,新版本条目在最上面。条目格式:`## vX.Y.Z — YYYY-MM-DD` + 类型(feat / fix / docs / chore)+ 要点 + 相关链接。
> 纪律见 AGENTS.md「变更记录纪律」:发版前先更新本文件并随版本提交;事故复盘、复现与真机验证记录也记在这里。

## [0.43.0] — 2026-10-23

### feat:终端工具任务的取消能力与可观测性(#35,@youyv 报告)

- **背景**:#35(高质量报告,代码事实逐行核验全部准确):winget 安装/升级任务「只进不出」——
  下载卡住时卡片停在「处理中」,没有取消按钮、看不到已用时与 winget 的重试输出、单条目最长干等
  15 分钟(`INSTALL_TIMEOUT_MS`,为 UAC 等待保留,不动),唯一出路是重启 DSH;`clear` 只丢
  `activeJob` 锁不杀进程,第二个任务能与仍在跑的 winget 并发(半装状态风险)。
- **取消(主诉求)**:新路由 `POST ?action=cancel`(`index.js`,与 `run`/`clear` 同一 fence);
  `cancelToolJob()` 标记 job 并经 `io.cancelActive()` **杀整个进程树**——win32 用
  `taskkill /PID <pid> /T /F`(winget 会派发 forwarder/msiexec/DeliveryOptimization 子进程,
  只杀父进程留孤儿),POSIX 用 SIGKILL。进行中的条目 verdict 归 `cancelled`,剩余条目归
  `skipped`(用户要求的是停止,不是失败);任务留在「已取消」终态直到卡片关闭。取消落在
  inventory 读取期间时全部条目 skipped(什么都没尝试,什么都不报失败);落在 winget 已正常
  退出之后时不改写已完成条目的 verdict(只信 run 自己的 `cancelled` 标志,不信 job 级兜底)。
- **clear 语义修正(堵并发洞)**:任务未完成时 `clearToolJob()` 现在**等价于取消**(杀树 + 标记),
  不再丢锁放行第二个任务;已完成任务照旧忘记。
- **runner 流式改造**:`defaultRunnerIo` 的 `execFile` 换 `spawn`(stdio pipe,16MiB 输出上限
  语义保留):`hooks.onOutput` 逐行送出最新一行(300 字符截断),job 快照新增
  `startedAt` / `currentSince` / `lastOutput` / `cancelled`(`index.js` snapshot 显式挑字段,
  io 引用不上线路)。超时、取消、看门狗三种终止都走进程树击杀,并以
  `timedOut` / `cancelled` / `networkRetry` 标志区分——`execFile` 时代 ETIMEDOUT 被压成
  `code=-1` 归「一般失败」的问题一并修正。
- **卡死下载看门狗**:`NETWORK_RETRY_PATTERN`(`/failed to download, waiting a bit and
  retry|0x80072ee2|0x80072efd/i`,#35 实测的 DO→WinINet 重试循环信号)首次命中起计时,一个
  窗口(默认 120s,`defaultRunnerIo({networkRetryWindowMs})` 可注入)后进程仍在即杀树,verdict
  归 `network` 并附最后一行——不再静默烧完 15 分钟。健康下载永远不会碰到它(窗口只从首个
  retry 行起算,且只触发一次)。
- **UI**:进行中行新增**已用时**(`currentSince` 起算,`2m13s` 数字形,随 1.2s 轮询刷新)、
  **取消按钮**与最新 winget 行(单行灰色 `gb-toolTail`);badge 按 verdict 归类——已取消 /
  已跳过(中性 `–` + `gb-st-skip`)/ 超时 / 网络失败 与 成功/失败 区分;skipped 条目不打失败
  明细行;任务被取消后在卡片上显示总况行。21 门词典各新增 6 键
  (`tools.cancel` / `tools.cancelledNote` / `tools.kind.cancelled|skipped|timeout|network`)。
- **测试**:新 `tests/terminal-cancel.mjs` 11 项(取消状态机三条路径 / clear 等价 / timeout 与
  networkRetry 归类 / watchdog / onOutput / spawn 失败兼容 / 路由与卡片源码断言);全量 334 项
  333 pass + 1 平台 skip + 0 fail。win32 的进程树击杀(taskkill 路径)本机(macOS)只能验证
  SIGKILL 分支,**Windows 真机复验待做**(卡死下载场景:装一个 GitHub 源包,断网点「取消」,
  看树是否全灭、卡片是否显示已取消)。
- UAC 提示:杀树后系统 consent.exe 弹窗一般随之撤下;若残留,手动关掉即可,不影响已取消的判定。

## [0.42.3] — 2026-10-23

### fix:全仓严格 review 的十项修复(PR #34,@KouzakiUmi 贡献;16 文件 +1229/−123)

- **R01(P2,路径字面量扫描器)**:ASI 后的合法语句正则(`/.../`)曾被误判成字符串并把其中的
  路径改写成 Windows 形态——**静默改变程序语义**。现在闭组符之后、与下一个 `/` 之间隔着换行且
  无法确定是除法还是正则时,整份 no-op(铁律:任何不确定 = 整份 no-op);行终止符判定从 `\n`
  扩到 `\r\n\u2028\u2029` 全集。主扫描与模板插值共用同一守卫。
- **R02(P2,pathEcho)**:whole-value 分支不再做无前缀要求的 TEMP 根映射——`D:/backup/c/Temp/result.txt`
  这类备份树内嵌副本是数据,不再被改写;只有从开头开始且有段边界的真实 TEMP 根才映射到 `/tmp`。
- **R03(P2,绝对 glob 拆分)**:`{}` 加入 `GLOB_META`,brace alternatives 整体留在 pattern 中,
  不再被目录/basename 拆分散架。
- **R04(P2,promotion 缺口传播)**:后台输出只检查 `lossy`、丢弃 `chunks[].gapBefore`,模型不知道
  ring 驱逐留下缺口。native promotion 复用 `renderJobRead`,同时传播 `lossy`/`gapBefore` 与可用
  spill 路径;`bash-tool.js` 镜像的同款遗漏一并修正。
- **R05(P2,winget 清单可信化)**:`winget export` 原用固定共享临时路径且静默吞异常——无法建立
  可信清单时仍可能启动安装。现在每次导出用 UUID 独立路径、只清理本次;检查退出码/JSON/清单结构;
  清单不可信时可见失败,**绝不启动任何安装/升级**。状态路由对 probe 失败返回 500+详情(fail-loud
  优于假「全没装」)。
- **R06(P2,FastCtx 桥生命周期)**:①用户开关 OFF/ON **可逆**(旧实现首次 OFF 即永久判死);
  ②dsh-ops 让位独立且不可逆;③payload 不可用独立记录,开关翻转可重试;④publication/discovery/
  lazy connect 全程代际所有权约束(generation owner),旧代际的挂起任务不覆盖新状态;⑤`close()`
  后动态 import 晚到的 spawn 被 `this.dead` 守卫拒绝(不再复活已停桥);⑥**`tools/call` 失败不
  自动重放**——调用可能已写文件;⑦dispose 先于 listeners 安装,部分 wiring 也拥有子进程;⑧ops
  检测扫描全体存活 agent 的 face(不再只看当前),渐进加载不再漏检。
- **R07(P2,设置卡草稿所有权)**:scope/ready 变化时初始化干净草稿但保留用户 dirty 编辑;保存回包
  用 scope + 不透明 draft owner 绑定,迟到的保存不再误标新 scope 的状态;镜像 hydration 不覆盖
  本地编辑。
- **R08(P2,命令扫描)**:readdir 改用 Dirent(`withFileTypes`),同名目录(含 `make/`、`jq.exe` 同目录
  骗局)不再被当成命令;仅对符号链接候选检查文件目标(`issue #31` 同源补遗:符号链接与无扩展名场景)。
- **R09(P2,诚实退出码)**:`proc.exitCode ?? 0` 把合法 `null` 伪造成「exit code: 0」。现在缺字段
  显示 `unknown`,真实 0/非零/kill 原样。官方 `tool-bash` 存在同款(已另行报告官方),官方修复后
  我们镜像跟进。
- **R10(P3,typed native path)**:展开拒绝正则整体锚定 `^`——只拒绝 `~`/`$`/`%VAR%` **展开前缀**,
  绝对路径内部的 `%`/`$`(如 `C:/data/100%.txt`)保持数据语义,不再误拒。
- **R06 合并时的实质判断(贡献者)**:`OPS_PRESENCE_MARKERS` 六名不全(dsh-ops 实际 10 个 `ops_*`
  工具,`ops_batch`/`ops_glob`/`ops_replace`/`ops_run` 未收录),改为**前缀匹配 + 常量兜底**——
  评审接受:对任何 `ops_*` 名字让位只会少发布一个重复文件面,方向保守,无误伤性后果。
- **测试**:新增 `tests/review-core-regressions.mjs` / `review-native-regressions.mjs` /
  `review-native-preview.mjs` 并扩充 client/bridge 回归,全部纳入 test 脚本;先红后绿(旧代码
  39 处 fail),修复后 323 项全绿(贡献者 Windows Node 24.13.0;维护者 macOS 322 pass + 1 平台
  门控 skip)。修复前 review 快照保留在下方「全仓严格 review」一节。

## [0.42.2] — 2026-10-20

### fix:gb_* 对 dsh-ops 0.4.0 渐进加载的退避检测(每会话首个 agent 会多挂一轮 gb_*)

- **上游变化**:dsh-ops 0.4.0 把 PTC 工具面改成渐进加载(T-Auto/dsh-ops #261)——agent 的第一个
  face 只常驻 `ops_read_files` / `ops_result` / `ops_load_sdk` 三件,`ops_inspect_local_file` /
  `ops_grep` / `ops_bash` 等高级 API 要到「owning session 的 committed step 结束、下一次 provider
  schema 捕获前」才发布。
- **症状**:`src/fastctx-bridge.js` 的退避检测在 `agent/created` 时只认三个旧名字;0.4.0 下 face 1
  三个都不在 ⇒ 检测落空 ⇒ gb_* 照发;下一步 ops 高级 API 到场后,gb_* 三件与 ops_* 文件工具冗余
  并存(名字不冲突,但白占 token)。只有每会话第一个 agent 受影响(后续 agent 创建时旧名字已到场)。
- **修法**:退避名单提取为导出常量 `OPS_PRESENCE_MARKERS`(六个名字:三个经典标记 + 0.4.0 的三个
  渐进常驻),`reconcile` 改为对名单求 `some/includes`;任何一个在场即整体撤下,语义与 §4l 的
  「见 ops_* 即让位」不变量一致。
- **测试**:tests/bridge-regressions.mjs 新增两例——face schemas 只返回 0.4.0 渐进三件 ⇒
  definitions 与 FastCtx payload 实例数都必须为 0(payload 不许启动);守卫锁死六个标记名。
- **ptc-preset 侧无需跟进**:`detectOpsPresence` 只认 dsh-ops-shell / dsh-ops-file 行 id,与渐进
  加载无关。

## [0.42.1] — 2026-10-19
  
  ### Guarded
  - **dsh-ops background/file tools are contractually out of reach** (user decision, 2026-10-19): the removal
    list `OPS_SHELL_TOOLS` is now pinned by a guard test to exactly `ops_bash` + `ops_run` — it can never
    grow to cover `ops_run_background` / `ops_job_*` (background jobs) or the `ops_*` file tools. Users who
    enable the dsh-ops background component keep those global tools in every session, including PTC ones.
  - README: documented the division of labor — bash belongs to gitbash, background jobs and file/PTC
    enhancements belong to dsh-ops; neither side denies the other.
  
## v0.42.0 — 2026-10-19

### feat:dsh-ops 的 ops_bash 从模型 face 彻底移除(可见面,不再只是拒绝);插件停用/卸载自动还原该配置

- **为什么 v0.41 的 deny 不够**:宿主 tools.restrict({deny}) 只过滤**继承面**(全局层+祖先层;core/tools view() 源码),而 ops_bash 由 dsh-ops 注册进每个 agent 的**自有层**——自有层注册明确在过滤范围之外,restrict 对其名甚至直接报「names unknown global tool」。所以 v0.41 的 deny 注定只剩 pre-execute 守卫兜底:工具仍可见、调用才被拒。用户要求「直接看不见,不增加模型心智负担」⇒ 可见面移除唯一路径 = 让 dsh-ops 不注册。
- **机制**:dsh-ops 自带精确开关 publishBashTool(config 键,false ⇒ mountSessionBash 首行返回、resolveShells 报 disabled、提示词工具表自动少一行)。本插件经官方 configEditor 通道把 dsh-ops-shell 行的该键写为 false(**不碰其余键、不碰别人的设置**),ops_bash 从模型 face 消失;ops 的 file / 后台 / PTC 增强不受影响。无设置开关——产品语义:本插件在场,bash 归本插件;想用 ops_bash 就停用本插件(还原是自动的)。
- **生命周期还原(本次主诉求)**:写 false 的同时在本插件 fiber 上注册 dispose 钩子——**停用或卸载**插件的瞬间,覆盖被撤回:override 键删除(无继承值)或赋回继承值(有),同 row 里用户自己的其它覆盖原样保留;还原后回读验证。唯一盖不到的残余:关机状态下卸载(进程已不在,钩子没机会跑)⇒ dsh-ops 设置卡「恢复默认」一键可撤,README 已写明。若 patch 覆盖是用户后来手写的 true(我们的 false 之后),停用时**不动它**——那是用户的选择,不是我们的残余。
- **为什么写 true 的用户选择不还原、而我们的 false 要还原**:还原钩子只在「移除确实生效(adopted/present)」后才注册;运行时无法区分「present 的 false 是我们上次写的还是用户手写的」,保守取「撤掉」,README 说明边界。
- **写通道与安全规则**:与侧栏终端接管同一纪律(官方 configEditor.edit,禁 fs 直写 patch;本插件模块守卫测试断言 ops-adopt.js 零 fs 面);edit 失败(如「overridden by a home patch」)如实报 write-failed 并给出手工路径,绝不谎报成功;每次写后回读,读到 false 才算 adopted。
- 验证:tests/ops-adopt.mjs 11 项全绿(计划矩阵 7 态 / adopted 回读 / 三类 no-write 零编辑 / write-failed×2 / restore 继承回赋与删键 / 用户后选 true 不动 / 报告文案含安全网指引 / 模块守卫 / index.js 接线守卫),npm test 全套纳入该文件。
## v0.41.1 — 2026-10-19

### fix:桌面版设置页「安装 / 升级选中」无反应(栅栏 no-origin 误伤 Electron + 前端静默吞 403)

- 报告:[issue #33](https://github.com/KannaKuron/dsh-gitbash-shell/issues/33)(@AncherEven,报告自带完整根因定位,感谢)。dsh 桌面版(Electron)设置 → 插件 → 终端工具,点「安装 / 升级选中」不报错、不出进度、按钮复原。
- **fix(栅栏侧,tool-runner.js)**:`fenceToolRequest` 原要求改写类请求必须携带同源 Origin/Referer,而桌面版 Electron 渲染进程的同源 fetch **不携带**这两个头 → 恒 403 `no-origin`。现改为:缺 Origin 时放行 origin 半(信任围栏的真防线是 loopback 限定,保持不变);**携带** Origin/Referer 时仍必须同源,跨站一律拒。安全性论证:浏览器对一切改写请求(同站与跨站)都附加 Origin,缺头请求不可能来自网页 CSRF,只能来自非浏览器客户端——而后者本就能伪造同源头,栅栏对其原本就不构成额外防线。
- **fix(前端侧,client.js)**:`runTools()` 对非 2xx 响应直接 `res.json()` 解析错误体、取不到 `job` 静默吞掉;现与 `loadTools()` 一致先判 `res.ok`,栅栏拒绝等失败会显示「HTTP 403」类错误而不是无反应。
- 验证:`npm test` 263 项全绿;栅栏测试矩阵更新(缺头 POST 放行 / 携带跨源 POST 仍拒 / LAN 携带同源头仍 not-loopback / 前端 res.ok 守卫断言)。

## v0.41.0 — 2026-10-19

### feat:官方「持久终端」实验包 Git Bash 化自动接管;dsh-ops 并存时剔除其 shell 工具;terminal_* 方言说明

- **持久终端自动接管(v0.41.0 主特性)**:官方实验包 `@deepseek-ai/dsh-experimental-terminal-bundle` 在 win32 上默认 `optional-terminal-bash` 禁 / `optional-terminal-pwsh` 启——开启「持久终端」后终端是 PowerShell,与本插件的 bash-first 语义相反。v0.41 起检测到 bundle 挂载后,由插件维护 profile patch(bundle 组子行按 id 覆盖,官方 `applyEntryPatches` 通道):`optional-terminal-bash` → `disabled: false` + `shellPath` 指 Git Bash;`optional-terminal-pwsh` → `disabled: true`(仅当该行不存在时写入,已存在则不动并提示并存)。用户显式配置(bash 行 `disabled: true` 或 `shellPath` 指向别处)一律尊重,不覆盖。
- **为什么直写 patch 文件**:官方 config-editor 两个硬限制(实测 packages/boot/config-editor)——`entries()` 只寻址 include 挂载的顶层行(bundle 组内子行不可见);`edit()` 只写 config 键,写不了行级 `disabled`。bundle 子行覆盖只能落在 profile patch 文件上。安全链:`parseDocument` 保注释保 `!!js` → 变更后 re-parse 自检 → 原子写(`@deepseek-ai/dsh-atomic-write` 优先,降级 tmp+rename,mode 0600)→ 回读验证 → 失败回滚原字节。守卫测试随之演进:index.js 豁免「no fs path to the profile patch」整版禁令(bundle 接管是有意的直写,安全特征有断言),**侧栏终端接管仍走 configEditor 不变**。
- **terminal_* 方言说明**:bundle 接管生效后(`terminalDialect.gitBash`),工具路由说明进入持久终端通道——`terminal_send`/`terminal_signal` 的命令按 Git Bash/MSYS 方言书写,与单次 bash 工具同一套提示。
- **dsh-ops 并存时的 shell 工具剔除(用户决策定案)**:安装了本插件 = bash 用本插件方案;`ops_bash` / `ops_run` 在本插件 bash 工具在场的 agent 上默认 deny(`tools.restrict` + `tools/pre-execute` 双层),不做设置开关;ops 的 file / 后台 / PTC 增强不受影响。
- 验证:`npm test` 263 项全绿(新增 tests/terminal-bundle.mjs 26 项:plan 矩阵 12 + writer 12 + report + detect);守卫测试演进 2 处(compatibility assemble 段参数面补 `terminalDialect`;smoke 侧栏守卫按上述范围收窄)。

## Unreleased — 2026-10-18

### 严格 review 的 R01–R10 已修复（fix / test，未发布）

- **R01**：[路径字面量扫描](src/index.js) 为换行后的含混 slash 添加整份 no-op 守卫，主扫描与模板插值共用；覆盖 LF / CRLF / Unicode 行分隔符、跨行注释、let/var、带标签 break/continue 与模板内声明，保留同一行除法和明确正则的原行为。仍是保守扫描器，不宣称成为完整 JS parser，也不改变已知的路径状业务字符串启发式边界。
- **R02 / R03**：[whole-value TEMP 回显与绝对 glob 拆分](src/index.js) 分别改为仅匹配真实 TEMP 根前缀，以及把 brace alternatives 留在 pattern 中。补备份路径/UNC/相对值/大小写/目录段边界与 brace 目录回归；没有改宿主搜索工具的根锚定规则。
- **R04**：[native promotion](src/native-tool.js) 复用 `renderJobRead`，消费 read 时同时传播 `lossy` 与 `chunks[].gapBefore`，附带可用 spill 路径；没有恢复路径时明确显示 unavailable。合并验收时也修正了 [Bash promotion](src/bash-tool.js) 同一类只检查 lossy 的遗漏，补有缺口/无缺口负控。保留原输出片段、消费次数、闭合 DTO、producer 结局与权限/取消契约，不重跑命令。
- **R05**：[winget inventory](src/tool-runner.js) 每次导出使用 UUID 独立路径，仅清理本次路径；检查 export 退出码、JSON 和清单结构。状态探测失败直接报错，不伪造 missing；安装/升级任务在无法建立可信 inventory 时结成可见失败，**不启动任何安装/升级**。并发状态探测 + auto 升级回归保留已安装的 GNU 构建，不改装首选 MSVC；合法空清单的正常安装路径仍通过。所有 winget 回归均为受控 IO，无真实软件安装。
- **R06**：[FastCtx bridge](src/fastctx-bridge.js) 分离用户开关、peer 让位与载荷不可用状态，监听 volatile 更新双向协调；publication / discovery / lazy connect 用代际所有权约束，OFF 撤名、关闭连接并拒绝旧 SDK。异步 spawn import 后也重验 stopped，避免 dispose 后晚 spawn；后端已发出的 tools/call 不自动重试。默认 OFF、弃用定位、无 OS confinement 声明与 ops_* 让位不变。
- **R07**：[设置卡](src/client.js) 在 scope / ready 状态 / 镜像值变化时初始化干净草稿，保留用户 dirty 编辑；用 scope + 不透明 draft owner 绑定保存状态，迟到的保存回包不能误标新 scope、继续编辑或 scope 往返后的新草稿。拒绝保存仍不显示成功，21 语言词典和宿主父层订阅方式不变。
- **R08**：[默认目录 IO](src/tool-runner.js) 使用 Dirent，[命令扫描](src/toolchain.js) 排除同名目录，并仅对候选符号链接检查文件目标；保留真实无扩展名文件、有效文件链接、扩展名白名单和首个 PATH 命中顺序。字符串式注入 IO 兼容旧确定性夹具，生产 IO 始终提供文件类型。
- **R09 / R10**：[后台结局](src/bash-render.js) 对 null 保留 null、缺字段显示 unknown，真实 0/非零/kill 原样；[typed native path](src/native-executor.js) 仅拒绝展开前缀，绝对路径内部百分号、美元符号和波浪号保持数据语义，不新增变量展开。
- **先红后绿**：首批核心回归旧代码 11 fail、native 普通回归 19 fail、设置卡/桥回归 9 fail；随后追加的 scope 迟到保存与 Bash source-gap 回归也在修复前各捕获 1 fail。真实 Core native 新 preview 旧代码 1 pass / 2 fail（大输出缺警示、百分号路径误拒），修复后同组全部通过。没有降低已有断言或禁用检查。
- **最终验证**：Windows / Node 24.13.0，`npm test` **309/309**，0 fail / skip / cancel；原版 `npm run test:preview` 在隔离的实际 **Core 0.2.1-rc.2** 依赖快照上 **89/89**，0 fail / skip / cancel。新增 [核心回归](tests/review-core-regressions.mjs)、[native 回归](tests/review-native-regressions.mjs)、[真实 Core native preview](tests/review-native-preview.mjs)，扩充 [设置卡回归](tests/client-regressions.mjs) 与 [桥回归](tests/bridge-regressions.mjs)，均接入 [测试脚本](package.json)。所有产品 JS / 新增测试语法检查、`npm pack --dry-run --ignore-scripts` 与 `git diff --check` 通过。
- **实际 Core 重点补验**：1 MiB producer 的首次 read 仍为 `lossy=false / gapBefore=true`、64000 字符尾部，修复后另带丢失警示且只有 1 个 producer；无缺口负控不误警示。真实 Node/fs 在 native 与 MSYS argv/cwd 两种路径中读回含 `%fixed% / $literal / ~literal` 的自有 sentinel；根 shell/subprocess provider 未被替换。未知退出码、UNC 解析、FastCtx 开关/取消、winget 并发与 GUI 草稿使用各自受控夹具验证，不冒充真实软件安装或生产 GUI 验收。
- **边界**：未操作生产 GUI、未安装/部署、未改生产 profile、未重启宿主；真实受限 token/ACL/IPC 围栏、每个旧 Core、非 CRT 任意解释器、真实磁盘耗尽与跨任务 quota 仍未覆盖。没有提交、推送、版本号变更或发布。下面保留修复前的 review 快照供追溯。

### 全仓严格 review：9 项 P2、1 项 P3（test / docs，修复前快照）

审查快照为 [v0.40.5 / 6c5f1cd](https://github.com/KannaKuron/dsh-gitbash-shell/commit/6c5f1cda5828ee5cbd5dba1aa704496f69e34412)。范围是当前全仓，不只本次同步增量；覆盖全部 19 个产品 JS 模块的行为实现（客户端词典按键集/结构检查，未逐条人工审译），以及组合、patch、包清单、发布/CI 脚本与相关测试。结论为 **10 项确认问题：9 项 P2、1 项 P3；未确认 P0/P1**。其中 R08/R09 是上一轮已记录问题，其余为本轮补充，不表示均由 v0.40.5 引入；以下未执行修复。

#### R01 · P2：路径扫描器将 ASI 后的正则内容改成 Windows 路径

- 定位：[scanCodeLiterals](src/index.js#L1393-L1424)。Windows 方言与 `codePaths` 开启时，合法程序 `let x\n/['/c/foo']/.test('C') && (x=true); return x ?? false` 中的 regexp 起始 `/` 被误当除法，其字符类里的引号又被当作 JS 字符串。
- 实际改写为 `/['C:/foo']/`；分别用 `new Function` 执行，原程序返回 `false`，改写程序返回 `true`。这不是已知的“路径状业务字符串启发式”边界，而是正则被错误识别为字符串，违反“正则不改/不确定整份 no-op”的约束。
- 建议：补声明/ASI 与 regexp 的判定；不能确定时整份跳过。回归应覆盖 let/var 声明后的正则与原有除法负控，不以仅锁定这个样例替代词法验证。

#### R02 · P2：TEMP 回显会改写非 TEMP 路径的中间子串

- 定位：[pathEcho](src/index.js#L756-L760) 将 whole-value 路径交给 [mountTempRoot](src/index.js#L709-L714) 全串替换，仅检查匹配后侧边界，不要求真实根前缀。
- `rewriteResultPaths('read', {path:'D:/backup/c/Temp/result.txt'}, {tmpDir:'C:/Temp'})` 实际返回 `/d/backup/tmp/result.txt`，正确值应为 `/d/backup/c/Temp/result.txt`。备份树复刻真实用户 TEMP 路径时同样可触发；后续文件操作与 UI 链接可能指向另一位置。
- 建议：whole-value 只做从开头开始且有段边界的 TEMP 根映射；散文内嵌诊断另保留有边界的全文逻辑。覆盖备份目录、UNC 与相对结果路径的负控。

#### R03 · P2：绝对 glob 的目录 brace alternatives 被当成实体目录

- 定位：[GLOB_META 与 splitGlobPrefix](src/index.js#L1506-L1522) 没将 `{` 识别为 glob 元字符。`/c/project/{src,test}/*.js` 被拆为 `path='C:/project/{src,test}'`、`pattern='*.js'`，表达式错误进入文件系统根路径。
- 唯一临时目录内创建两目录/两文件，同一真实 ripgrep 从 fixture cwd 以 `{foo,bar}/*.js` 搜索返回 2 项；用插件拆分产物执行则 exit 2、根目录不存在。这里确认的是 brace 被移入 path，不把 Core 绝对搜索根与带斜杠 pattern 自身的锚定语义混为同一个问题。
- 建议：仅提取确定的字面目录前缀，完整识别支持的 glob 目录元字符，并对照真实搜索工具补 brace 目录回归。

#### R04 · P2：native 超时提升消费输出后丢掉缺口事实

- 定位：[native promotion](src/native-tool.js#L167-L169) 仅保留 `ringDelta(read.chunks)`，既不保留 `read.lossy`，也不检查 `chunks[].gapBefore` 或呈现可用的完整输出路径。[promoted renderer](src/native-tool.js#L96-L99) 也没有对应警示。
- **真实 Core 补证**：Core 0.2.1-rc.2 的真实 ToolRuntime / LocalJobRegistry / LocalSubprocessRuntime 下，运行一个仅输出 1 MiB 固定字符及 tail sentinel、随后等待的 Node producer，700ms 前台等待后提升。实际消费 read 为 `lossy=false`、`gapBefore=true`，DTO 仅留 64000 字符且带 tail sentinel，模型文本没有 dropped/truncated/gap/full-output 提示。只看 `read.lossy` 同样修不全；该次 chunk 缺口已随消费游标前移，不能指望下一次 read 重现同一告警。进程由自有 Jobs 显式取消并等待结束。
- 建议：在消费 read 的同一位置综合 ring eviction 与 source gap，并携带可用恢复路径或闭合 DTO 元数据；补真实 source-gap 与 ring-loss 两种提升回归。最终输出事实可能另外说明 loss，不能替代首次提升时的即时警示。

#### R05 · P2：并发 winget 探测与安装共用导出文件，可能装错构建

- 定位：[状态探测的临时清单](src/tool-runner.js#L111-L119) 与 [安装任务的临时清单](src/tool-runner.js#L198-L204) 均使用固定文件名，读取后各自删除，且导出失败后把清单缺失当作空清单继续动作。
- 受控异步 IO 调度中，两次 export 都已写完，状态请求先读并删除，安装任务后取结果时读到 ENOENT；原来 `BurntSushi.ripgrep.GNU` 已安装且可升级，`auto` 任务却生成 `install --id BurntSushi.ripgrep.MSVC`，而不是升级已安装 GNU 构建。正常的另一设置页刷新即可与任务重叠；单个 activeJob 锁不覆盖状态请求。
- 建议：每次导出使用自有唯一临时目录/文件并仅清理自己；检查 export 结局，无法建立可信 inventory 时不应静默把升级意图变成安装。证据为受控 IO 时序与实际 runner 决策，无真实 winget 安装。

#### R06 · P2：FastCtx 的 volatile 开关不能双向生效

- 定位：[FastCtx reconcile](src/fastctx-bridge.js#L461-L477) 仅在 agent/created 时读取开关；OFF 还将 `withdrawnByOps` 永久设为 true。[调用路径](src/fastctx-bridge.js#L333-L357) 不重验 enabled。
- 受控 transport 复现：ON 时发布 `gb_replace` → 将权威开关置 OFF，现有工具仍在且旧定义仍成功 dispatch → 下一次创建 agent 才撤下 → 再置 ON 并创建 agent，工具仍不回来。默认 OFF 已被观察过的进程也无法仅靠设置卡重新开启。
- 建议：把用户 OFF 与 peer 让位分成不同状态；监听开关并重新协调，同时阻止 OFF 后未启动的新调用。不要将此项描述成提供了 FastCtx OS confinement；它只涉及所承诺的开关行为。

#### R07 · P2：设置卡首次 loading→ready 竞态可清空有效 bashPath

- 定位：[bashDraft 初始化 effect](src/client.js#L2077-L2082) 使用空依赖数组；[保存](src/client.js#L2308-L2310) 写入当前草稿，而不是权威配置。
- 当插件 inventory 先到、own ConfigForm 仍 loading 时卡片首次挂载，初始化跳过；设置镜像随后 ready、宿主父组件正常重渲染也不会重跑 effect。原 Client 函数配合受控 Hook 渲染复现：权威值为 `Q:/Git/bin/bash.exe`，输入框仍空，用户未编辑直接保存会写 `bashPath:''`，意外切回自动探测。
- 已核 Core 0.2.1-rc.2 的真实父层契约：PluginManagerPage 的 loaded 只等待插件 inventory，PackageDetail 对 configured slot 的挂载不等待 ConfigForm ready，父页订阅 settings namespace 后会正常重渲染。因此不是“自身未订阅导致整个 GUI 永不更新”；后者是已排除的初始误判。本项证据为真实契约 + 原函数受控渲染，未做生产 GUI 延迟注入。
- 建议：首次 ready 后初始化草稿，并用 dirty 状态防止后续镜像刷新覆盖用户正在编辑的值。

#### R08 · P2：PATH 同名目录误报为命令（上一轮已知遗留）

- 定位：[scanCommands](src/toolchain.js#L236-L263) 与 [默认 readdir IO](src/tool-runner.js#L67-L72)。真实临时 PATH 只有 `make` 目录时仍判定命令存在，winget 可用且清单为空时得到 `external` / `actionable:false`，安装入口被错误关闭。
- v0.40.4 已明确保留目录类型区分为后续项，本轮不冒充新增。应补类型验证且保留真实无扩展名文件/可执行文件符号链接。

#### R09 · P2：未知后台退出码被报告为 0（上一轮已确认）

- 定位：[processOutcome](src/bash-render.js#L163-L168)。真实 Cordis 挂载自有 bash 模块，以受控已结束句柄 `exitCode:null` 执行后台路径，detail 被 `?? 0` 写成 `exit code: 0`；同一结果的前台仍为 `[exit code: null]`。
- Core 0.2.1-rc.2 官方 tool-bash 同样含此表达式，属于镜像继承问题，不是本次 UI 更新新引入。应保留未知值，而非将 Job 的 completed 词汇与命令成功混同；本项未用真实 OS 子进程制造缺失退出码结局。

#### R10 · P3：typed absolute path 误拒合法百分号文件名

- 定位：[nativePath](src/native-executor.js#L24-L34) 的 `%[^%]+%` 无位置限制，在确认原生绝对路径前就拒绝字面百分号片段。
- 唯一临时目录内 `%fixed%.txt` 为真实文件，普通 Node fs 能读回 sentinel，Windows absolute 判定为真；相同值传 kind:path 仍报“需要 absolute path / 不支持变量展开”，literal argv 则接受。若 executable 或 cwd 目录包含同类合法名字，没有改用 literal 的入口。
- 建议：拒绝真正依赖展开的相对/前缀变量输入；已经是绝对路径中的 `%` 应保留为数据。发生频率低于上述问题，按 P3 排序；不涉及越权。

#### 验证、反证与范围边界

- **便携全量回归**：Windows / Node 24.13.0，重新执行 `npm test`，**237/237**，0 fail / skip / cancel。语法与发布清单检查沿用同一产品快照上一轮通过的 `node --check` / `npm pack --dry-run --ignore-scripts`。
- **完整原版 preview**：从现有桌面 ASAR 只读复制所需依赖到唯一临时目录，保持原有嵌套依赖布局，记录包版本/来源/manifest SHA256；不安装、不改宿主。普通 Node 24.13.0 + Core 0.2.1-rc.2 下，**原版 `npm run test:preview` 86/86**，0 fail / skip / cancel。包含真实 native argv、独立编码/原始字节、PTC→Node/fs、后台/超时/取消/卸载、policy负控和 provider 所有权。复制件是当前安装代码的隔离验证，不等于更新了正在运行的产品。
- **补充审查**：两项独立专项回归分别 62/62 与 49/49，与全量重叠，不累加成额外通过数；96 次真实 dispatch listener 门控矩阵通过。上述确认问题的临时复现由主审逐项复跑；R04 另有真实 Core + 真 producer 补证，其余按各条注明的受控层级解释。
- **失败尝试保留**：Electron Node 24.21 的原 loader 重入递归属于该启动路线的测试装置问题，不据此报产品失效；临时 ASAR 复制最初遇到目录 cp 不支持与嵌套 yaml 副本，改逐文件复制且保留嵌套布局；首完整预览 85/86 唯一失败是复制件缺少只用于打印 Core 版本的 manifest，补原始 manifest 后完整重跑通过。没有把这些失败尝试计入成功次数。
- **已排除**：自身 ConfigForm 未 subscribe 并不导致当前宿主设置卡永不刷新（父组件订阅）；终端未清理 retry timer 的一次迟到回调，在真实 Cordis dispose 后被 inactive-context 检查拒绝，受控 editor **0 次写入**，不报告“卸载后覆盖配置”。
- **未确认候选**：percent-encoded 非 UUID sessionId 二次编码的正常可达性；旧 Core minimal compaction 探针区分度；status 路由与外层认证的远程部署组合；`virtualMounts` OFF 的 NUL 设备特例。没有证据前不归入上述 10 项。
- **明确不覆盖**：生产 GUI 延迟/视觉验收、真实 LLM 自主选路、真实受限 token/ACL/IPC 围栏正负验收、每个旧 Core 版本实机、非 CRT 任意解释器 quoting、真实磁盘耗尽/RSS/跨任务 quota。已有默认 fail-closed、用户显式关闭后的 legacy UNCONFINED、codePaths 路径状业务字符串启发式与动态拼接边界均按既定产品约束评价，未冒充新增漏洞。
- 本轮只更新审查记录；未改产品源码、未提交/推送、未安装/部署、未改生产 profile、未重启宿主。

### 同步 v0.40.5 后的功能审查（test / docs，未修复）

- 审查基线：[v0.40.5（6c5f1cd）](https://github.com/KannaKuron/dsh-gitbash-shell/commit/6c5f1cda5828ee5cbd5dba1aa704496f69e34412)。相对本地原基线快进 8 个提交，无合并冲突；本条只记录检查，未修改产品源码。
- **P2，已知遗留复现：PATH 同名目录仍会阻止安装。** [scanCommands](src/toolchain.js#L236-L263) 只收到字符串文件名，扩展名白名单不能区分目录与文件。[默认 IO](src/tool-runner.js#L67-L72) 的真实 `readdirSync` 读取一个仅含 `make` 目录的临时 PATH 目录时仍返回命中；在 winget 可用、清单为空的受控装置中，[probeToolchain](src/tool-runner.js#L91-L162) 将该行判为 `external` / `actionable: false`，实际没有命令却不提供安装操作。与 v0.40.4 记载的目录类型区分遗留项相同，不是本次同步新引入。需后续补文件类型判定，同时保留无扩展名真实可执行文件与可执行文件符号链接。
- **P2，后台退出事实丢失：未知退出码被写成 0。** [processOutcome](src/bash-render.js#L163-L168) 的 `proc.exitCode ?? 0` 把合法的 `null` 改成成功退出码。真实 Cordis 挂载自有 bash 模块、以受控已结束进程句柄执行 `run_in_background: true` 后，[Jobs 接线](src/bash-tool.js#L389-L414) 产出的终态 detail 为 `exit code: 0`；同一结果的前台渲染为 `[exit code: null]`。这不是「completed 应等于 failed」的问题，而是具体退出码被捏造；应保留未知值。当前桌面 Core 0.2.1-rc.2 的官方 tool-bash 同样含此表达式，属于镜像继承问题；未用真实 OS 子进程制造无退出码结局。
- **验证：** Windows / Node 24.13.0，`npm test` **237/237**，0 fail / skip / cancel；全部产品 JS 的 `node --check` 与 `npm pack --dry-run --ignore-scripts` 通过。两个针对性复现均 exit 0：目录案例使用真实文件系统与受控 winget 清单，后台案例使用真实 Cordis 与受控进程/Jobs，不执行 winget 安装或真实异常进程。
- **实际 Core 的有界补验：** 桌面壳 2.0.19-next / Core 0.2.1-rc.2 / Electron Node 24.21.0，从现有 ASAR 只读解析依赖；[基础预览](tests/preview.mjs)、[桥预览](tests/bridge-preview.mjs)、[运行时预览](tests/runtime-preview.mjs)、[宿主预览](tests/host-preview.mjs) 合计 **30/30**，0 fail / skip / cancel。覆盖真实 Git Bash / PowerShell、根执行器保留、可见性开关、拒绝时序与卸载。原版 [host-loader](tests/host-loader.mjs#L10-L17) 在该 Electron Node 环境内 `hostRequire.resolve` 重入自身解析钩子，首跑 4 个测试文件均因 `RangeError: Maximum call stack size exceeded` 未进入用例；改用临时目录内的防重入解析器后通过，仓库加载器未修改。不能将补验称为原版 `test:preview` 全套通过。
- **未覆盖：** 完整 native/path/输出 preview、生产 GUI、模式选择器与 PTY、真实 LLM 自主选路、真实受限 OS 围栏。未安装或部署插件，未改生产配置，未重启宿主。

## v0.40.5 — 2026-10-18

### 工具行字号跟随宿主字体设置;半像素字号归整(fix)

- **内容面接官方 delta**:工具行可见面接 `--dsh-content-font-delta-secondary`(官方派生变量 = 宿主「设置 → 字体大小」正文值 − 1px 再钳制,非独立设置项)——`.gb-toolRow`(12px 基准)、`.gb-toolState` / `.gb-toolSrc`(11px 基准)、`.gb-toolResult` / `.gb-toolFail`(基准 11.5→12px)。用户把正文字号调大后,工具行、状态徽标、来源路径、结果与失败说明同步放大,不再钉死。
- **半像素归整官方档位**:官方字号体系没有 x.5 值——`.gb-sectionTitle` 12.5→12px(设置卡 chrome 标题,保持固定不接 delta,与官方设置卡一致);`.gb-toolResult` / `.gb-toolFail` 11.5→12px 基准(默认观感 +0.5px,换来 delta 跟随)。
- 调查结论(四插件联合排查,2026-10-18):官方 ui-deliverables 的 IDE 类面板本身全部固定字号、零 delta,设置卡 chrome 固定亦合规;本插件只有上述工具行属于「内容随设置缩放」范畴,其余小字(偏移、徽标)为有意设计不动。
- 验证:`npm test` 236 项全绿(1 skip 为既有基线);CSS_TEXT 内 delta 引用 5 处、半像素残留 0;真机双端验证待用户复验(改后默认 14px 设置下视觉基本无变化,调大后生效)。

## v0.40.4 — 2026-10-17

### 终端工具扫描只认可执行条目：手册页/文档/同名目录不再冒充命令（fix）

- `scanCommands`（`src/toolchain.js`）原先用 `entry.replace(/\.[^./\\]+$/, '')` 剥掉**任意**扩展名，于是 PATH 目录里任何与工具同名的条目都算命中：
  - **真实案例**：winget 便携包目录中 `just.1`（手册页）在字典序上排在 `just.exe` 之前，而扫描是「首个命中者胜出」⇒ 卡片「完整路径 / 由谁提供」列把手册页当成了 `just` 的可执行文件（实测 `commandPath` = `…\Casey.Just_Microsoft.Winget.Source_8wekyb3d8bbwe\just.1`）。
  - **判定层影响**：`classifyToolState` 在 `wingetOwned === false` 时只看 `hasCommand`，所以一台**确实没装**该命令、而 PATH 里恰好有同名文档 / 手册页 / 目录的机器，该行会被判成 `external`（`isActionable` 为 false）——**安装入口永不出现**。本机 `just` 之所以未暴露，只是 winget 清单命中在前把它掩盖了。
- 修法（**纯函数改动、零 io 变更**）：新增扩展名白名单 `EXEC_EXTS = {.exe,.cmd,.bat,.com}`，扩展名不在白名单的条目直接跳过；**无扩展名照旧命中**——Git for Windows 自带 `/usr/bin/make` 这类无扩展名可执行文件（`fzf` 同理），这条不能丢。未加 `.` / `..` 防御分支：`readdirSync` 本就不返回这两项。
- 回归用例（`tests/smoke.mjs`「only executable extensions resolve」）锁三层：手册页 / 文档 / 目录不命中；无扩展名真可执行仍命中；`just.1` 排在 `just.exe` 之前时**首个可执行命中者**路径正确（另覆盖 `.EXE` 大小写）。判定层补一条联动断言：扫不到 ⇒ `missing` ⇒ `isActionable` 为真。**该用例已在未修复的源码上验证会失败**（`actual: 'C:/pkg\just.1'`），修复后通过。
- 目录区分（无扩展名目录 vs 无扩展名 MSYS 可执行文件）**留作后续**：需要给 `io.readdir` 增加 `stat`/`Dirent` 能力并牵动调用方，本版不动 io 契约。
- 验证：Windows 10.0.26200 / Node 24.19.0，`npm test` 通过（当时基线计数把 skip 计入记作 237；维护者复核：基线 235 pass + 1 skip，合并分支 236 pass + 1 skip，本用例恰好多 1）。维护者另在 macOS / Node 24 复跑全量同绿，CI ubuntu+windows × Node 22/24 四矩阵绿。
- 相关：[issue #31](https://github.com/KannaKuron/dsh-gitbash-shell/issues/31)。

## v0.40.3 — 2026-10-17

### gitBash 能力服务新增 `pwshToolEnabled`(feat,additive——配对 dsh-ptc-cordis-preset v0.20.1)

- **背景**:PTC 创造模式(ptc-cordis preset)的 pwsh 可见性矩阵有个残余不一致——gitbash-shell 单独安装且用户开启 `pwshTool` 开关时,官方 PTC/标准模式有 pwsh(遮蔽层放行、翻译层保护),而 ptc-cordis 组合仍禁(v0.20.0 只探测 dsh-ops 的 `opsPresent`,看不到本插件的私有设置)。跨插件没有读对方 config 的通道,唯一干净做法是把判定结果发布在已有的 `gitBash` 能力服务上。
- **改动**:`gitBashCapability` 新增 `get pwshToolEnabled()` —— 返回 `liveSettings.pwshTool() === true`,与遮蔽层(`src/inline-tools.js` 的 `pwshVisible` 判定)**同一读取器、同一语义**:能力字段回答的就是「pwsh 行此刻对本机 agent 是否可见」。纯 additive(先例:`ok/source` v0.28.0、`inlinePatched` v0.35.1),老消费方忽略新字段。
- **接线重排**:`const liveSettings = makeLiveReader(ctx, config)` 从能力服务之后提升到之前——getter 共享同一 reader,且声明先于能力对象构造,杜绝任何同步读取路径上的 TDZ。
- **测试**:smoke 源码断言补 getter 形状 + liveSettings 必须先于 `gitBashCapability` 声明(防 TDZ 复发)。236 tests / 235 pass / 1 skip / 0 fail。
- **消费方**:dsh-ptc-cordis-preset v0.20.1 起,组合条件从 `gitBashActive && !opsPresent` 扩为再 `&& !peerPwshTool`,「手动开 pwshTool、不装 dsh-ops」场景下 PTC 创造与官方模式一致放行。

## v0.40.2 — 2026-10-17

### 适配 dsh 0.2.1-alpha.5(0.2.1-rc.1 与其同码):组合对齐重跑 + exit-status 解析器跟齐(feat / fix / test)

- **组合行集跟随官方 0.2.1-alpha.3..alpha.5**(行 id 零改名;`tests/align-official.mjs` 重 pin 四枚 SHA256 后全绿):
  - 官方在 alpha.3 **删除**了 subagent/subagent_fork 的 `toolFilter.deny`(`schedule_*` 四项——官方提醒工具重新可达子代理):插件侧 `subagentDeny` 整体删除,任何探针组合都不再产出 deny,与官方逐字节一致。
  - alpha.4 给三个全工具 preset 新增 `tool-plugin-market` 行(紧跟 `tool-plugin-manager`;standard/ptc `disabled: true`,cordis `!!js !ctx.get('profileContext')`):挂新探针 `pluginMarket`(探测 `@deepseek-ai/dsh-plugin-market/tools`),disabled 分法与 manager 相同。
  - alpha.3 给 **minimal** 新增 image-only `tool-fs`(`{read:false, readImage:true, write:false, edit:false}`)与专属 compaction 组(`isolate` 仅 `{compaction:true}`,**无** tool-result-pruner 行):`minimalPluginsFor` 增加 `hostExtras` 参数,挂 `compaction` 探针(探测 `@deepseek-ai/dsh-compaction-basic`)——minimal 不再是「永不加行」。
  - `probeHostExtras` 扩为四探针(新增 plugin-market/tools、compaction-basic),返回 `{ timeContext, toolSchedule, pluginMarket, compaction }`;注册日志行同步;缺包/旧宿主仍保持 0.1.7 逐字节行集。
- **exit-status 解析器 null 感知(fix)**:`parseExitStatus` 的 exit 正则 `/(\d+)/` → `/(-?\d+|null)/`、`'null'` → `null`。官方 0.2.1-alpha.5 把 `TerminalResultView.exitCode` 放宽为 `number | null`(正常结束但无退出码),客户端卡模型(ui-tool `terminal-card-model.ts`)已解析 `[exit code: null]`,而本插件的移植解析器会把该标记当「未匹配」错落 `exitCode: 0`(读作成功)。本解析喂的是 terminal 卡(镜像 client 侧读法),故对齐 client 实现;官方服务端 `dsh-shell render.ts` 的同名解析器仍为 `(\d+)` 未跟(如实记录,不抄)。生产端 `renderResult` 对 `exitCode: null` 本就打出 `[exit code: null]`(与官方 background 断言一致),bash 工具 schema 早已允许 `integer|null`,均无需改。
- **测试同步**:`smoke.mjs` era 测试重写(默认无行 + probe-on 官方槽位 + deny **不得再出现** + minimal 四行断言)、`probeHostExtras` deepEqual 四键形状、minimal 接线正则(现在传 `hostExtras`)、`parseExitStatus` 加 null 例;`compatibility-regressions.mjs` 加 producer/parser 的 null 往返;`host-preview.mjs` hostExtras 形状同步。
- **元数据**:version 0.40.2;`dsh.compatibility.dshReleases` 增 `0.2.1-alpha.3`/`alpha.4`/`alpha.5`/`0.2.1-rc.1`(rc.1 于 2026-10-17 发布,与 alpha.5 同码——全仓 diff 仅 355 个 package.json 版本号 bump,align-official 对 rc.1 树复跑四 SHA 全绿;依据:静态对齐 + 全量回归;**Windows 双端真机验证待做**,发版前按家族纪律补)。
- 相关:dsh v0.2.1-alpha.3/4/5 Release;`tests/align-official.mjs`(需 dsh checkout,不属于 `npm test`)。

## v0.40.1 — 2026-10-15


### 清理 gitbash_native 的两个死配置读取（chore）

- 删除 `gitbash_native` 模块对 `config.enableRunInBackground`/`config.promoteOnTimeout` 的读取（[v0.40.0 已知项](#v0400--2026-10-15)就此销账）：该模块由 inline 接线**手动挂载在 agent scope**（`scope.ctx.plugin({...module})` 无参调用），行/执行器 Config 不可达，两个字段自 v0.40.0 起读到的恒为 undefined、按 `!== false` 恒开——是"没接线的开关面板"而非活门控。清理后行为一个字节不变：`background` 仅由 Jobs 注册表在场决定（这正是实际生效的逻辑），超时转 Job 跟随后台可用性；用户级开关仍是 `experimentalNative` 总闸（要关 native 后台只能整体关闭 native/path，官方 tool-bash 的同名活开关不受影响）。
- 模块 `apply(ctx)` 签名不再收 config，并加注释说明挂载差异与官方 tool-bash 的区别；`tests/native-preview.mjs` 装置同步（装置曾以 `plugin(mod, { promoteOnTimeout })` 作为**测试注入点**参数化 promote——删除后装置不再传第二参；唯一的 promote 场景（jobs 在场断言 promoted）清理前后行为一致）。**preview 改动待 Windows 真机复验**（本机 Node 24 无法运行 preview 套件；`npm test` 普通回归 235 pass + 1 skip / 0 fail）。
- 保留说明：`src/bash-tool.js` 的 `config?.enableRunInBackground ?? true` 防御式读取**不清理**——bash 工具是官方 tool-bash 的逐调用镜像物，这两个字段在官方行 Config 上真实存在且可关；我们的镜像接不到行 Config 时按 `?? true` 显式走官方默认，语义是"默认开"而非"假装可配"。
- 相关：[PR #26](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26) 评审遗留清理。

## v0.40.0 — 2026-10-15

### PR #26 合并：实验原生执行 / fail-closed（feat / docs）

- [KouzakiUmi 的实验性 RFC](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26)经维护者两步评审后 squash 合并（[74f0186](https://github.com/KannaKuron/dsh-gitbash-shell/commit/74f01865a1046f8d2fae053fd4b7d1dfd93694a0)）：
  - **`experimentalNative` 开关（默认开，可实时关）**：开启时 Windows read-only/workspace-write/缺失策略的 Git Bash 在工作目录准备、Jobs admission 与 argv 解析之前拒绝（宿主真 `SandboxUnavailableError`，导出缺失仍拒绝）；关闭时实时注销 `gitbash_native`/`gitbash_to_native_path` 并恢复明确标注 `enforcement: 'unconfined'` 的旧 Bash（缺失策略保持旧版宿主委派）。拒绝文案指路设置开关与会话访问模式控件，Agent 不得自动换工具/模式绕过。
  - **`gitbash_native`**：typed argv（literal/path 二值、4096 项 / 30000 字符、仅 `.exe`、已知解释器强制显式 `entrypoint: interpreter`）、逐流显式编码（utf8/gbk/utf16le/raw，无 auto，spawn 前 fatal 探测）、prepared capability（WeakMap，不可伪造 DTO）、8MiB/16MiB 输出预算（双流共享、UTF-8 游标对齐）、Jobs 提升（超时转 managed job，admission 不重试）、解码/存储失败绝不改写命令真实结局。仅 danger-full-access 策略放行。
  - **`gitbash_to_native_path`**：显式整值 MSYS→Windows 转换（`msys_path` 刻意避开翻译层白名单）；无 I/O、无权限授予；无挂载映射时显式拒绝，绝不把 POSIX 拼写冒充 `native_path`。
  - **共享注册入口**：每次开关/Jobs 刷新先注销自身再检查所有权（knownNames 含隐藏工具，旧宿主回退 schemas）；外部占名让位、注册失败不阻断其他 companion、OFF→ON 恢复。
  - **路由提示**：`bash`/`run_code` 的提示块改为按实际工具面生成的可替换幂等块；PTC 只提「SDK 实际提供的 binding」。
- 评审确认：拒绝时序、开关四态多点重读、与 v0.39.4 翻译层零交集（`msys_path`/`native_path`/`executable`/`argv`/`cwd` 均不在 `TRANSLATABLE_PATH_FIELDS`）、平台门控（POSIX 受限调用走父类真沙箱）。
- 文档修正（维护者评审发现，合并后在 main 修正）：设计文档 §3 组合盲点句原写「同装 dsh-ops 的受限会话均无命令工具」，与 `inline-tools.js` 的 `hidePwsh && !opsPresent` 短路矛盾——`ops_*` 在场时 pwsh 不被遮蔽，官方执行器带真围栏，受限会话是「无 bash 但 pwsh 可用」。
- 已知项（后续清理）：`gitbash_native` 的 Jobs 门控字段 `enableRunInBackground`/`promoteOnTimeout` 从 agent scope 读取，行 Config 不可达，实际恒开；行为无害，`experimentalNative` 总开关仍可整体关闭。
- 验证：维护者本地（macOS/Node 24.21）`npm test` 235 pass + 1 skip（原有 macOS-only 项）/ 0 fail；贡献者 Windows（Node 24.13.0/Core 0.2.1-alpha.2）普通回归 236/236 + 实际 Core 完整 preview 86/86；分支 CI ubuntu+windows × Node 22/24 全绿。
- 实验帽子保留：真实 Agent 自主选路、生产 GUI、维护者 Windows 全量验证、非 CRT 解释器矩阵四项门槛正式确认前，`experimentalNative` 命名与文档定位不变。
- 相关：[PR #26](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26)、[评审评论](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26#issuecomment-6186822600)。感谢 @KouzakiUmi 的完整 RFC、隔离子代理自审与三轮收敛。

### PR #26：第一轮设计评审后 rebase 到 v0.39.4（fix / test / docs）

- 按[维护者第一轮设计评审](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26#issuecomment-6182031633)将实验分支 rebase 到[上游 v0.39.4 main（52da331）](https://github.com/KannaKuron/dsh-gitbash-shell/commit/52da331)；冲突集中在 CHANGELOG、smoke 的路由文本断言、index.js/client.js 的开关读法（`experimentalNative` 默认 true 读 `!== false`，`fastctxTools` 默认 OFF 读 `=== true`）。
- 新增实际 Core 断言（评审①）：`fastctxTools` OFF（v0.39.4 默认值）且工具面无 `gb_*`/`ops_*` 的单装场景，companion 注册检测（knownNames/faceNames）照常挂载 `gitbash_native` 与 `gitbash_to_native_path`（设计文档 §10 语义）；禁用的桥走 unpublish 短路、不进入 publish（新增用例断言 disabled 日志；`createRequireFrom`/`msysToWin` 桩在 publish 路径上，门控移除时由该日志断言判负）。
- 设计文档 §3 体验表补组合盲点一句（评审②）：同装 dsh-ops 的受限会话中本插件 bash fail-closed、ops_bash 只发 full-access、gb_* 默认关，但 **pwsh 不被遮蔽**（`ops_*` 在场时 hidePwsh 短路，官方执行器带真围栏）——受限会话不是「零命令工具」，可直接用 pwsh；bash 回归需切 danger-full-access 或关 experimentalNative。（合并前措辞误作「均无命令工具」，维护者评审时对照 `inline-tools.js` 的 `hidePwsh && !opsPresent` 短路修正，见 v0.40.0。）
- session-workdir 双实现收敛（评审③）：保留模块化 `src/session-workdir.js`（`throwIfAborted` 更完整、diff 噪声更小），bash-tool.js 单行调用。
- 相关：[PR #26](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26)。Windows / Node 24.13.0：普通完整回归 **236/236**、实际 Core（desktop-next host，0.2.0-rc.1）完整 preview **86/86**（较上轮 85 增本轮①断言一例），均 exit0、无 skip/cancel。PR 已为非 draft，按维护者第一轮评审（rebase + ①断言后声明 ready）视为 ready for review；真实 Agent 自主选路、生产 GUI、维护者 Windows 全量验证和非 CRT 矩阵正式确认仍待。

### PR #26：工具所有权修复与独立复核（fix / test / docs）

- 共用注册入口在每次开关或 Jobs 刷新时，先注销自身注册，再检查当前 agent 可见的工具所有权；外部全局或同 agent 的同名工具均让位。实际 Core 的 knownNames 检查也包含隐藏工具，旧宿主回退 schemas 检查。
- 两个 companion 按 agent 创建注册模块，初始冲突仍保留待命 scope；外部所有者移除后，下次刷新可恢复。所有权检查或注册失败记录明确日志，不向 volatile 事件抛错，不阻断另一个 companion。
- scope 就绪与工具注册成功分别记录，避免让位或关闭状态被报告为注册成功。Bash 的逐操作 policy 快照契约保持不变。
- 新增实际 Core 回归覆盖 path/native × 全局/同 agent 的 OFF→ON 冲突、重复开关、所有者移除恢复、native Jobs 刷新以及隐藏的全局同名工具；普通回归覆盖单个注册失败的隔离与恢复。
- Windows / Node 24.13.0 / Core 0.2.1-alpha.2：普通完整回归 **232/232**、实际 Core 完整 preview **85/85**，均 exit0、无 skip/cancel。隔离子代理独立复核原始所有权复现与新增专项 **9/9** 通过，未发现新的确认缺陷；专项与完整结果有重叠，不累加覆盖数。
- 相关：[PR #26](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26)。继续保持 Draft/RFC；真实 Agent 自主选路、生产 GUI、维护者 Windows 全量验证和非 CRT 矩阵正式确认仍待。

### PR #26：隔离子代理独立审查（review / 修复前复现记录）

- 由未继承本次对话历史的子代理重新审查[当前实验提交](https://github.com/KouzakiUmi/dsh-gitbash-shell/commit/771c618dde5e509a80cb2b77733d1517fc7c89f2)
  相对[上游基线](https://github.com/KannaKuron/dsh-gitbash-shell/commit/114dcde434b99755532cc402f13cecbfe86c9a67)的完整增量。
  普通回归 231/231、实际 Core preview 79/79 均 exit0、无 skip/cancel；静态审查覆盖策略/开关、目录、注册/Jobs 生命周期、argv/编码/预算及文档证据。
- 确认一项 P2：experimental-tools 的 refresh 仅在首次挂载之外直接重注册，不重查同名工具所有权。
  OFF 期间外部注册全局同名 path 工具，ON 后真实 ToolRuntime 调用从 FOREIGN_OWNER 变为本插件 native_path 对象；
  同 agent 层则同步抛 already registered，阻断本次后续 companion 激活。真实 Core/Cordis 与受控 sentinel 工具复现，未启动 native 进程。
- 建议将冲突判定纳入每次 refresh 的共用注册入口；存在外部所有者时让位并明确日志，不向 volatile 事件抛 duplicate。
  补 OFF→ON 的全局/同 agent 层及 native Jobs refresh 回归。产品源码尚未修改，未推送或发送 GitHub 评论。
- 排除最初疑似的 Bash policy 时序问题：实际 sandboxPolicy 契约是逐操作快照、模式变更作用于下一次调用；
  fixture 直接修改 header.policy 的反证不足以证明违约，且 base 已有此行为，因此撤回拟议 P1。反证脚本的失败数不等于缺陷数。
- 无确认 P0/P1；继续保持 Draft/RFC。真实 Agent 自主选路、生产 GUI、维护者 Windows 全量验证和非 CRT 矩阵正式确认仍待，测试绿色不替代这些门槛。

### PR #26：同步 v0.39.3 与旧宿主兼容（fix / docs / test）

- 已 rebase 到[上游吸收 PR #28 改进后的 main](https://github.com/KannaKuron/dsh-gitbash-shell/commit/114dcde434b99755532cc402f13cecbfe86c9a67)，前置 PR #24 已合并；正式 v0.39.3 的记录完整保留。
- Bash/native 共享可选 workingDirectory 读取：有服务保留官方 ensure 及其失败，缺服务使用 policy.workspaceRoot ?? session.header.cwd。native 不再硬 inject 缺失服务。
- 两个 companion 的成功日志同样要求 apply 已执行及工具面回读；OFF 只报告 scope 就绪且工具关闭，避免 INACTIVE/关闭状态假阳性。
- 设置开关的 21 份字典均完成本地化，新增文案护栏保留工具名、UNCONFINED 与 danger-full-access 事实；人工译文审阅仍欢迎维护者补充。
- 新增旧宿主形状下的三工具挂载、双向开关与 cwd；native policy/header/服务失败；真实 cmd 字面 /c 和 PowerShell EncodedCommand + UTF16 输出。真实 Git Bash RO/WW 开关双向切换、未确定策略拒绝亦通过。
- 当前普通完整回归 **231/231**、实际 Core 完整 preview **79/79**，均 exit0、无 skip/cancel；Windows / Node 24.13.0 / Core 0.2.1-alpha.2。语法、diff 和 npm pack dry-run 通过。
- 已安装实验构建的[三入口实机报告](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26#issuecomment-6149607594)作为外部证据引用；报告未记录精确提交，不作为当前 rebase 构建的生产 GUI 验收。真实 LLM 自主选路、维护者 Windows 全量验证与完整非 CRT quoting 矩阵仍待。


### PR #26：维护者裁决与运行时开关（fix / feat / docs / test）

- docs：PR 描述和实验文档的提交引用使用可点击链接及说明性标签，避免明文提交 ID。

- 行 Config 新增 volatile 布尔 `experimentalNative`，默认 true，旧配置缺键亦开启；设置卡即时编辑。
  开启时 Windows 受限/未确定 Bash 拒绝；关闭恢复明确标注 `unconfined` 的旧版 Bash 与实例级日志，不提供真实 shell 写入围栏。
- 两个新工具随开关实时注销/注册，既有会话无需重启；旧 SDK 引用关闭后拒绝。路径工具在翻译前检查；
  native 在准备入口、异步准备后、执行入口和最终 spawn 重验。已启动后台 producer 保留生命周期。
- 拒绝错误与 Bash 描述说明设置卡关闭路径，以及由用户在会话访问模式控件选择 danger-full-access 的路径。
  21 份词典键齐备，中文/英文先行，其余 19 份暂用英文，合并前补本地化。
- 实验已 rebase 到 [前置 PR 的最新修复提交](https://github.com/KouzakiUmi/dsh-gitbash-shell/commit/c79332ea2fb6da38042063f7b55046115de8e530)，保留其 promotion sandbox 警示回归，显式 OFF 验证旧行为。
  当时 #24 仍 OPEN，到 main 的 rebase 尚待（已于本轮完成）；建议两步 review（fail-closed + 开关/UI；native/path/输出/路由），保留 Draft/RFC。
- 长期跟踪：Core 开放对应 native/encoding/closed DTO API 后优先整体迁移并退役私有实现；artifact 自管，controller 缺失保持拒绝。
  正式门槛仍为真实 Agent 选路、生产 GUI、维护者 win32 全量验证及非 CRT 矩阵抽测。
- 本轮纠正：实际 Core 的 tools.restrict 只认全局工具，初版 agent-local mask 失败；改为拥有者动态注销/注册。
  artifact 准备期间关闭的负例推动增加准备后检查，避免把拒绝落成 providerFailure；零 spawn、scope 释放及再次开启通过。
- 验证：Windows / Node 24.13.0 / Core 0.2.1-alpha.2，普通完整回归 **226/226**、实际 Core 完整 preview **75/75**，
  exit0、无 skip/cancel；syntax、diff、npm pack dry-run 通过。不等同于上述四项正式验收。
- 相关：[PR #26 裁决](https://github.com/KannaKuron/dsh-gitbash-shell/pull/26#issuecomment-6146363513)、[前置 PR #24](https://github.com/KannaKuron/dsh-gitbash-shell/pull/24)。

**类型**:feat(显式运行时路径/native typed argv/逐流解码) / fix(受限请求 fail-closed、生命周期与输出事实) / test / docs。

### Agent 选工具指引补齐（Unreleased）

- 移除“ALL commands都优先bash”的歧义；明确shell语法/管道/POSIX脚本、精确native argv/已知逐流
  编码、完整值Node路径转换、真正PowerShell cmdlet/WMI四类场景。只按实际可见工具名称引导，
  pwsh同时要求开关允许；缺native/helper不建议虚构名称，不自动换解释器/权限绕拒绝。
- 路由与方言开关独立，替换幂等文案块随可见性变化；PTC-only run_code得到SDK决策说明，
  native/path绑定自身描述在实际Core生成SDK中可见。未知混编码不猜，decoder失败不盲目重跑副作用。
- 增加5项路由/可见性矩阵/重组/SDK-only/路径说明回归、2项实际Core普通/PTC提示与SDK送达验证。
  普通全仓 **223/223**、完整实际Corepreview **72/72**，exit0、无skip；不是实际LLM自主选择验收，
  不承诺每次选对。工具执行参数与Config/UI保持不变。

### 实验性实现（Unreleased）

- **策略变化**：Windows 自有 bash 与 native 在 read-only/workspace-write/缺失策略时拒绝，
  实际 Core 返回 SANDBOX_UNAVAILABLE；工作目录准备、Jobs admission/promotion与spawn前不走旧
  unconfined绕过，不自动换工具/权限。default full不放宽会话policy；root官方provider不变。
  历史unconfined渲染保留仅为旧记录。不是恢复真实IPC/OS围栏，不覆盖minimal PTY/交互终端。
- **完整值路径工具**：新增gitbash_to_native_path，参数msys_path、输出native_path，复用每调用
  fresh共享mount；与自动方言/codePaths独立。未知映射、URL、空值/NUL拒绝，不访问文件或授权限。
  实际ToolRuntime→NodePtcRuntime→LocalSubprocessRuntime→Node/fs读取自有中文/#输入，route/tag不变。
- **原生工具**：新增gitbash_native，绝对typed executable/cwd、literal/path argv，逐流utf8/gbk/
  utf16le/raw与replace/strict；只显式path转换，literal /all、/c、空串/引号保真。
  拒绝bare command、model env、.cmd/.bat/隐式脚本；已知解释器需明确opt-in，非二进制鉴定或任意parser保证。
- **托管与输出**：每execution私有scope复用真实executeArgv/provider/Jobs，不另造runner或依赖private
  spawnSpec；decoder错误保真实exit，不诱导重跑。增量UTF8/BOM兼容、独立reader/cursor、raw/decoded产物
  与payload预算；scope属agent，后台/promotion卸载工具后仍可结束、仅清自身资源。
- **独立验证发现的问题与修正**：实证ownerdispose/direct kill曾错报completed/complete、artifact callback
  可无限await、facts schema过宽；均修为operation-owned cause、中止/不完整事实、准备阶段abort/deadline
  race与closed schemas。终态enum/callback三参同步；晚产物保留trusted retention，不伪称已清除。
- **最后全仓结果**：普通回归 **218/218**，实际安装Core 0.2.1-alpha.2完整preview **70/70**，均exit0、
  无skip/cancel。独立专项复跑unit41/41、preview55/55；与全仓结果重叠，不另加总数。
  语法、diff检查和npm dry-run源码清单通过。
- **测试整合纠正**：首全仓旧description断言还锁旧unconfined措辞，改为更严格拒绝/禁止绕行护栏。
  首preview缺3项显式证据env；加test-only preview-env，operator目录优先，否则unique host temp。
  路径夹具原硬编码D盘/安装bootstrap，改动态盘符/宿主自身bootstrap；C盘临时目录真实fs读复验通过。
  所有失败尝试证据保留，不称失败观察为修复PASS。
- **边界**：未知同流混编码不可普遍解码；legacy codePaths业务字符串猜测仍在，显式工具不改变其默认。
  8MiB两流raw+decoded/16MiB自有payload不是RSS或跨任务硬quota，无自动purge；生产GUI/完整插件apply、
  真受限token/ACL/IPC/VM负向权限、SSH/PTY与非CRT任意quoting尚未覆盖。未增加Config/UI文案字段。
  公开讨论文档见[实验设计与接口](docs/experimental-native-execution.md)、
  [验证分级与复现](docs/experimental-native-verification.md)。对应测试可随仓库复现。

### 前置修复的历史验证（首次记录时未发布）

- **重启后复测(2026-10-13)**:desktop Profile 的本地安装来源为
  [PR #24](https://github.com/KannaKuron/dsh-gitbash-shell/pull/24) 的
  [`4816cd8`](https://github.com/KouzakiUmi/dsh-gitbash-shell/commit/4816cd8848a52f73f5f054f761d3ec862cb87ade)
  修复构建(包/插件清单0.39.2,不是额外发版);四个关键已安装源码与工作树逐字节一致、bundle开启。
  当前实例status路由200/ok=true;真实前台、后台、超时转后台均输出预期sentinel,中文输出正常;
  native `cmd //d //c echo`通过,未设置全局EXCL。原始固定GBK字节仍乱码,显式GBK→UTF-8通过,
  说明编码边界仍在,没有把警示宣称为底层修复。再次执行普通回归 **166/166**、宿主preview **17/17**。
  已安装包helper覆盖中文/#路径、EOF注释和tagged-template保护,描述包含参数/编码/安全提示;
  独立render探针首轮误把stdout/stderr传为字符串,按真实stream DTO修正后通过,未修改产品代码。
  本次复测未覆盖真实PTC引擎与生产受限会话；unconfined反馈仅由隔离Core/renderer测试核验。

### 未修复问题研究(2026-10-13;不是产品实施或发版)

- **原生参数/编码**:实际安装 Core 0.2.1-alpha.2 的隔离 argv/raw-pipe/私有 facade→executeArgv
  与固定字节机制断言 **21/21**;可复用托管 provider,不需另造 runner。不同流显式解码可行,
  已混在同流的未知编码不可可靠猜测;private spawnSpec 不当稳定接口。cmd 的前斜杠 executable
  是另一个本机失败反例,反斜杠固定 echo 通过不代表任意 cmd/批处理 quoting 已验收。
- **真实 PTC 补证**:ToolRuntime→真实 NodePtcRuntime→真实 LocalSubprocessRuntime→Node/fs
  隔离实验 **8/8**，独立复跑 exit0。显式完整值 helper 配合 codePaths OFF 能读对动态路径,
  并保留 `/c/users` 路由数据;legacy 字面量猜测仍误改。不是完整插件 apply/生产 GUI/受限 OS 证明。
- **安全因果纠正**:现场 MSYS 3.6.10-5a1665c8 源码的 cygheap 使用 VirtualAlloc,signal pipe
  显式 sec_user DACL 缺 restricting SID;当前 Core Flags=13 且 TokenDefaultDacl 已补 ACE。
  因而历史笼统“用户-only cygheap 映射/只补默认 DACL/所有未来版本无解”不再作为当前根因依据。
  私有 IPC 身份路线仅静态可行,SID 集合模型 **9/9**不是 AccessCheck 或新沙箱实测。
- **研究提出的方向**：受限模式spawn前fail-closed、显式native typed argv/逐流decoder/path helper；
  Core加法契约与隔离Windows VM中的IPC/AppContainer/LPAC/guest边界仍需进一步验收。
  当前实现与验证见[实验设计](docs/experimental-native-execution.md)、
  [验证矩阵](docs/experimental-native-verification.md)；前置兼容修复见[PR #24](https://github.com/KannaKuron/dsh-gitbash-shell/pull/24)。

## v0.39.4 — 2026-10-14

**类型**:feat(dsh-ops 0.3.0 互通:gb_* 退役 + 统一方言桥) / fix(docs)。

### dsh-ops 0.3.0 互通:gb_* 退役 + 双工具家族统一 `/c/` 方言

dsh-ops(T-Auto)0.3.0 起以原生 Rust `ops_*` 文件工具(`ops_inspect_local_file`/`ops_grep`/`ops_glob`/`ops_replace`,
走 DSH 原生 policy/sandbox/subprocess 通道)取代 FastCtx 上游,并新增 PTC 批量能力(`ops_batch`/`ops_result`,
opt-in)与跨平台(win/mac/linux)支持。本版把并存形态收敛为「各司其职 + 方言由本插件统一」:

- **`fastctxTools` 默认关(弃用声明)**:上游 FastCtx 已被亲爹弃用,`ops_*` 同职能且更强(原生沙箱 mediation、
  统一 `path` 契约、CAS 原子替换、跨平台)。默认值 true→false(schema、stub reader、live reader、client 卡
  四处同步);显式开启可恢复,已装 dsh-ops 时无论开关如何都自动让位(既有 `opsPresent` 检测,0.3.0 工具名
  未变,零改动兼容)。
- **bash 不让位(产品裁决,2026-10-14)**:dsh-ops 的 `ops_bash` 仅 full-access 会话发布且走裸 `ctx.subprocess`
  (无沙箱 confine、无 unconfined 如实标注);受限会话只有本插件的 bash 可用,且两工具不同名并存无害——
  本插件继续是「全模式真 Git Bash 沙箱通道」,`ops_bash` 是 full-access 下的第二选择。
- **入参翻译扩展**:字段白名单加 `root`(ops_batch/ops_result 的路径参数,官方工具无此键,零碰撞);
  新增 `operations[]` 对象数组的 `path`/`to` 与 `protect[]` 字符串数组的嵌套翻译(同 present `files[].path`
  的先例)。模型说 `/c/...`,Rust worker 收到原生绝对路径。
- **出参成功面回流**:ops_* 六件加入 `rewriteResultPaths`——文件四件的 `items[].path`/`matches[].path`
  (Rust 端所有路径字段统一叫 `path`)与 PTC 两件的 `root` 回显 `/c/`;`detailsRef` 等引用 ID 不透明不改写。
- **失败面回流**:`ERROR_CONTENT_TOOLS` 加 ops_* 六件——失败 content 与 `error.message` 里的 Windows 路径
  统一回答 `/c/`(`error.message` 走无条件 `msysEcho`,自动覆盖)。
- **提示词无需改动**:dsh-ops 的提示走 `systemPrompt.section`(与官方同挂点),本插件的 `windowsToMsys`
  源头替换覆盖全部 sections;其文案无 `C:/` 字面量(「正斜杠分隔符」与 `/c/` 方言天然兼容)。
- **已知事项**:未安装 dsh-better-sidebar 的部署,启动时宿主对探测式 patch edit 打一条
  `entry "better-sidebar" not found` warn——宿主 patch 引擎对缺失行的固有行为,插件侧无法在保留该 edit
  功能(boot 层侧栏终端 shell 默认)的前提下去除,README 已说明。
- **测试**:新增 dsh-ops 互通矩阵(入参 root/operations/protect、出参 items/matches/root、失败 content/message、
  wrapper 门控源码断言、fastctxTools 默认关断言);全量 **172/172**(+1 win32-only skip)。
## v0.39.3 — 2026-10-14

**类型**:fix(自有 bash 工具的宿主服务兼容 #27、MSYS 参数/编码提示、源码路径边界与 unconfined 可观测性) / test / docs。

### issue #27:自有 bash 工具在无 `workingDirectory` 服务的宿主上永不注册

- **根因(route B 镜像的契约盲区)**:自有 bash 工具镜像的是新版宿主(`0.2.1-alpha.x`)官方 tool-bash
  的 `inject` 列表(含 `workingDirectory`),而兼容矩阵声明的 `0.2.0-rc.2` 上**没有该服务**——cordis 对
  无法满足的 inject 让模块 fiber **永久 INACTIVE**:`apply()` 从不执行、工具永不注册、零错误日志,且
  inline-tools 的激活日志照打(`await` 一个 INACTIVE fiber 会正常 resolve)——**假阳性成功**。
  与 v0.24.0 settingsScope、v0.24.3 静态 peer import 同一失败类(静默失效、宿主日志全绿)。
- **修复**:① `inject` 收敛为 `['tools', 'systemPrompt', 'shellEnv']`(服务最小面,`workingDirectory`
  改为使用点 `ctx.get()` 可选读取);② cwd 接缝双向兼容——有 `workingDirectory` 的宿主走
  `ensure()`(与新版官方一致),没有的宿主退回 rc.2 时代官方 `resolveWorkdir` 的同一条接缝
  (`policy.workspaceRoot ?? session.header.cwd`),**不再落到宿主进程目录**;③ 激活日志必须经
  `tools.schemas(agent)` 回读确认 `bash` 真正在册,不在册打显式失败行(点名 INACTIVE 可能性 +
  请携带 dsh 版本报告)——**消除假阳性**。
- **教训(§4l 追记⑧)**:镜像宿主模块时,`inject` 面是**契约面**——必须取兼容矩阵内**最老宿主**的
  形状,或一律可选读取;「宿主新版本有」不等于「矩阵内都有」。
- 报告者 largoalladonzella 提供了完整根因链(asar 字节级取证 + cordis `_refresh`/`_setEpoch` 源码 +
  官方两版 inject 对照)与本机验证补丁;本仓库按其建议实现并补真断言。
- 新增回归:无 `workingDirectory` 的最小 ctx 上 `apply()` 照常注册 + cwd 回退正确;有服务的宿主
  `ensure()` 接缝不变;源码断言锁死硬 inject 列表与「回读门控激活日志」。本地全量 **168/168**(+1
  win32-only skip)。

### PR #24:超时转后台的独立 sandbox 警示

- promoted 返回值显式携带可选 sandbox facts，输出 schema 保持闭合；defineTool 与 JSON-schema 回退共用此契约。
- `renderPromoted` 自行追加 sandbox notes，不再依赖 output 预先含警示；promotion 输出保留丢失/spill 提示，
  避免重复追加 sandbox 警示。无 sandbox/full-access 的原反馈保持不变，denied/runnerFailed 分支继续保留。
- 纯回归改用不含警示的原始文本，覆盖空输出、full-access、拒绝与 runner failure。
  新增实际 ToolRuntime→私有执行器→内存 provider 的 promotion 回归（Jobs wait/read 为受控桩），
  验证 RO/WW 警示各出现一次、full 无警示、DTO 与最终模型文本分离、丢失/spill 提示及 root 服务不变。
- 验证：普通完整回归 **166/166**、实际安装Core完整preview **18/18**，均exit0，无skip/cancel；
  语法与diff检查通过。不等同于生产GUI或真实Jobs时钟验收。

### MSYS 兼容边界尝试修复

- **范围**:从 [`6b26ded`](https://github.com/KouzakiUmi/dsh-gitbash-shell/commit/6b26ded6cc3a2a6113579149286047629b433c48)
  开出 `fix/msys-compatibility-boundaries`;不改 root PowerShell、market patch、生产 Profile、
  安全默认或版本号。原生参数转换/混合编码/Windows shell confinement 不能在这层安全地普遍修好,
  因此修工具提示与可观测性,不全局 EXCL=*、不猜码、不将警示冒充沙箱修复。
- **源码路径**:run_code 的完整 Unicode 字母/组合字符/数字和含 `#` 文件名字面量走共享挂载表;
  合法 EOF 行注释不再让整份重写弃权;tagged templates(含 String.raw、调用/索引 tag)保持原样,
  避免 raw 设备路径被错误转义;of/await/yield 等上下文词可作 tag 时保守不改。
  未闭合/不确定正则与除法仍整份 no-op,未扩展插值或动态表达式猜测。
  词法层仍无法识别非路径数据的业务用途,提示明确建议直接 Node fs/path 用 native/cwd-relative 路径。
- **提示门控**:真实 prompt listener 读取 live codePaths;OFF 不再承诺程序字符串会被翻译,
  ON 改为 best-effort 并指出模板、动态/非路径数据限制。关闭 codePaths 不改变工具路径字段翻译。
- **原生互操作**:登记的 bash 描述无条件说明 `/all`/`/c` 转换、双斜杠/单命令 EXCL 前缀及其
  对 `/c/...` 的影响;检查预期效果而非只看 exit0。说明 UTF-8 捕获与 CP936/GBK 不匹配,
  显式转码须在字节捕获前且保持退出状态;locale 与全流猜码不是普遍修复。
- **unconfined 可见性**:执行句柄在等待 result() 前带 sandbox facts;前台正文、后台 outcome/
  增量嵌入与超时转后台显示警示。后台登记输出联合新增可选 sandbox facts,指出计划执行边界,
  不把未启动的 job 宣称为已经执行。保留原请求 mode,不把 unconfined 当 denial/escalation,
  并明确不得通过 shell 绕过文件工具策略拒绝。双语说明区分文件读能力与 write/edit 围栏,
  删除“所有未来版本都无解”的过度结论。
- **验证**:新增9项兼容回归和1项后台登记回归,普通全量 **166/166**;新增3项实际 Core
  ToolRuntime/执行句柄/run_code transport 回归,完整无头 preview **17/17**。旧护栏保留;打包 dry-run、语法和 diff
  检查通过。新增 preview 使用实际宿主 API 与内存 subprocess,已有 preview 保留真实 Git Bash/
  PowerShell 进程验收;不等同于生产 GUI、真实 PTC 引擎或新 confinement 方案验证。

## v0.39.2 — 2026-10-13

**类型**:fix(route B 工具/预设生命周期、动态配置与客户端回归) / test。

- **复现与裁定**:两名 Sol 分区审查、Grok 交叉反证与主代理隔离复验确认了工具面、生命周期、
  组合、代码扫描和客户端状态转换的问题;普通子 scope 的原始冲突仍由 v0.39.1 的 `shell` 隔离修复。
  FastCtx 全文路径回显是既定策略,不误当文件工具替换问题;minimal 的 persistent PTY 不与全工具
  变体的执行器来源混为一谈。只修既有功能,不新增功能、改 root shell 或市场 patch。
- **变体接线**:Windows 全工具 Git Bash 变体不再启用依赖 root PowerShell 的官方 `tool-bash`;
  保留官方 pwsh 面,经同一行内补位通道接入私有 Git Bash 工具。minimal 的 persistent 通道保持。
- **工具生命周期**:存活 agent 的 `pwshTool` 双向翻转同步解除/重建自身的 restrict;异步导入/
  挂载在插件或 agent 退役后不再迟到注册;jobs 服务卸载按真实 Cordis 活跃状态恢复前台 bash。
- **降级分支**:plain definition 的 required 标志递归转换为合法 JSON Schema;升级助手不可用
  时仍解析并传递每会话 standing policy,不错误回退部署默认。两项为模块解析降级的受控复现,
  不宣称本机生产已发生导入失败,也不改变 Windows 受限模式明示 unconfined 的既定取舍。
- **预设与默认值**:串行 reconcile 退役时关闭新任务、清理晚到 register 并等待 unregister;
  动态关闭变体在退役前迁回部署默认,避免后续新会话引用不存在的 preset。既有钉住会话不迁移。
- **路径与终端**:run_code 扫描辨认关键字后的正则并在不确定时整份 no-op,不改正则数据;
  FastCtx 入/出参获得 execution 上下文并服从总方言、委托与虚拟挂载开关;better-sidebar 的
  adoptSidebar 动态翻转恢复接管前值并保护接管后的用户手选,不改变官方 autoTerminalShell
  关后只停止未来写入的独立语义。
- **FastCtx 错误**:子进程/写管道 error 进入初始化 Promise,失败清理 pending 计时器与连接;
  MCP `isError:true` 按官方桥约定抛错,不再把失败包装成宿主成功 value。
  发现与连接启动采用 single-flight,拥有在途连接并在卸载时取消/等待,不让并发 agent 的发现流程
  覆盖已在使用的 lazy client。该丢失所有权链已用受控 MCP 传输复现,并新增关闭/晚注册回归。
- **客户端**:设置卡所有 Hooks 在 readiness early-return 前调用;工具链进度轮询在网络/HTTP
  暂态失败后重试,卸载或失效时取消,不因单次请求失败永久卡在忙碌状态。
- **回归入口**:新增可移植客户端/桥/运行时/宿主回归与实际 Core preview 集成用例,接入现有
  `npm test`/`npm run test:preview`;不新增依赖、不跳过旧断言或 Node 22 矩阵。对齐上游 v0.39.1
  (`521be01`)后完整测试 **156/156**、实际 Core 无头 preview **14/14**、打包 dry-run 和 diff 检查
  通过。新增执行级回归保留 #21 的 real-array glob 契约与 stringified-array 响亮拒绝;不改已发布
  版本号、历史记录或 npm 发布流程。Grok 对修复 diff 的只读反证未发现确定遗漏。
  首轮全量检查发现三条旧源码正则仍锁旧实现,改为对应新保护条件并补同值/手选行为测试,没有删掉
  保护断言。原 [Issue #19](https://github.com/KannaKuron/dsh-gitbash-shell/issues/19) 和
  [PR #20](https://github.com/KannaKuron/dsh-gitbash-shell/pull/20) 已完成;这些后续修复由新 PR 承载,
  Windows/Linux × Node 22/24 的远端结果见其检查。preview 不等同于完整 Electron GUI 或真 MCP
  exe 并发验收,模块解析降级使用受控夹具复现。

## v0.39.1 — 2026-10-13

**类型**:fix(route B 私有执行器的真实服务隔离与读取授权) / test / ci。

- **根因**:普通 `ctx.plugin()` 子 fiber 只隔离副作用所有权,不隔离服务命名空间。
  `GitBashSandboxExecutor` 仍经 `SandboxBashExecutor → LocalBashExecutor → ShellExecutor → Service`
  注册 `shell`,与 route B 保留的 `SandboxPwshExecutor` 冲突,报
  `service "shell" has been registered at <SandboxPwshExecutor>`;bash 工具尚未注册即中断。
  Git Bash 路径已成功解析时同样发生,不是工具发现或路径探测问题。
- **修复**:`mountPrivateExecutor` 仅对 `shell` 调用 `ctx.isolate('shell')`,其余宿主依赖原样继承;
  类插件仍走官方 `plugin()` 通道,Config/volatile/static inject 与生命周期不变。
  空 scope 通过 `get('shell')` 读取活跃私有实例,工具就绪检查用 `get('tools')`,避免
  缺少 inject 声明的属性访问再度中断补位。失败时销毁已建 scope,成功/失败均清理挂载计时器。
- **边界**:不撤官方 PowerShell 执行器、不改 bundle patch、不改 shell 执行/沙箱/后台协议,
  不抬 Core 兼容下限,不发版、不触发 npm 发布。
- **回归**:新增 5 项真实 Cordis 测试,覆盖普通子 scope 冲突、显式隔离后的 Config/inject 与
  根 shell 保留、卸载、构造失败清理/再挂载、缺服务失败与挂载超时清理;不是仅正则源码检查。
  既有 minimal PTY 测试的非 Windows 断言现在显式模拟 Linux,不再在恢复 win32 后误断言 `/bin/bash`。
  首轮远端 CI 发现两项独立 error-content 测试误嵌套在父测试中,Node 22 会取消未等待的子测试;
  恢复独立结构并保留全部断言,不跳过测试、不移除 Node 22 矩阵。
- **验证入口**:`npm test` 合并 smoke 与真实 Cordis 回归;新增 `npm run test:preview`,通过
  显式 `DSH_PREVIEW_HOST_DIR` 只读解析目标宿主包,在新 Context + 临时 cwd 做无头运行时 preview。
  Windows 本机已通过:Core **0.2.1-alpha.2**,宿主 Cordis **4.0.5-alpha.1**,Node **24.13.0**;
  原路径真实重现服务冲突,修复后 bash 出现在实际 ToolRuntime schema 中并执行
  `command -v bash`/`uname -s`/sentinel(退出码 0),官方 pwsh 执行 `Get-Process`,
  `pwshTool` 开/关两态与卸载恢复均通过。**不等同于完整 GUI、PTY、后台任务或受限模式验收**。
- **CI**:新增非发布 `ci` 工作流(push 修复分支 / PR / 手动触发),Windows/Linux × Node 22/24,
  锁定依赖、禁止生命周期脚本与可选载荷、完整测试及 `npm pack --dry-run --ignore-scripts`。
  本机完整测试 **127/127 通过**,打包预检与 `git diff --check` 通过;远端矩阵结果见对应 PR 检查。
  复验命令和覆盖边界见 `tests/README.md`。
- **gb_glob 守卫封杀了上游主用法([#21](https://github.com/KannaKuron/dsh-gitbash-shell/issues/21),同日报告)**:
  上游 `tools/list` 的 glob `pattern` 是 `string | string[]` 的 untagged enum——**数组才是主形态**
  (schema 示例本身就是数组),v0.38.5 的只认字符串守卫把它一并拒绝;且模型常把数组 JSON 序列化后
  传入(实测 25 次调用 24 次为 `["*.txt"]` 字符串),上游按**一个字面 glob** 匹配 → 静默返回空
  ——恰好是守卫要防的「静默错误答案」。修法(`validateFastctxPattern`,提取为纯导出函数):
  glob 接受非空字符串或非空字符串数组;**字符串化数组响亮报错并给出正确形状**(绝不代模型反序列化
  ——那会掩盖错误);replace 维持单正则字符串契约;其他类型报错带类型名。gb_glob 的 description
  增补 pattern 形状声明(模型侧修正源)。**教训**:给上游加防御守卫必须从 `tools/list` 的
  `inputSchema` 原文出发,单一探针会误判(v0.38.5 的「静默当全部文件」实测即单一探针结论)。

## v0.39.0 — 2026-10-13

**类型**:feat(架构转向:route B——插件自带 bash 工具,不再替换宿主执行器;DSH STORE 收录合规)。

- **背景**:AI-Scarlett/DSH-Store(第三方插件市场)的固定 Commit 检查对 v0.38.5 给出确定性拒绝
  `SUBMISSION_PATCH_PROTECTED: Bundle Patch appears to disable an official component`
  ([DSH-Store#1396](https://github.com/AI-Scarlett/DSH-Store/issues/1396))——扫描器
  (`check-plugin-submission.mjs:173-175`)对 patch 文本做双正则 AND 判定
  (`出现 @deepseek-ai/ 字样` ∧ `出现字面 disabled: true`),而本插件的 patch 恰好双中:
  禁用官方 `pwsh-sandbox` 执行器行正是「替换 shell 底座」架构的落点。市场契约
  (「不禁用、替换官方组件」)与旧架构**本质冲突**,用户裁决走 route B:为收录改造架构,
  而不是钻扫描器字面的空子。
- **新架构(route B)**:宿主 PowerShell 执行器(`pwsh-sandbox`)**原样保留**,patch 变为
  **纯新增**(只 insert `gitbash-shell` 插件行 + better-sidebar 终端 shell 探测式 edit)。
  bash 能力改为**插件自有工具**:
  - `src/bash-tool.js`:自有 `bash` 工具,对官方 `@deepseek-ai/dsh-tool-bash`
    **调用级镜像**(schema/输出三态 union/后台 jobs/超时晋升/沙箱升级/渲染/prompt 节),
    唯一替换点 = `ctx.shell.resolve/execute` → **私有执行器实例**
    (构造于私有 cordis scope 的 `GitBashSandboxExecutor`,`static inject` 全链生效,
    永不注册为 `ctx.shell` 服务——官方 PowerShell 执行器的工作不受任何影响);
  - `src/bash-render.js`:官方 render.ts/background.ts 的逐调用镜像
    (exit 标记契约、`[stderr]` 段、denial/escalation 标记、ring 读、晋升文本),
    沙箱 marker 内联为官方原文;
  - 宿主依赖(`dsh-tools` 的 defineTool、`dsh-sandbox` 的升级助手)经宿主 loader 通道解析,
    缺席时定义退化为 plain JSON schema、升级面整体不广告——**严格变窄,不变宽**。
- **pwsh 语义反转**:官方 `pwsh` 工具重新成为**真 PowerShell**(官方解析器自动优先
  PowerShell 7)——假工具恒灭逻辑随执行器替换一起退役。`pwshTool` 开关(字段名不变,
  默认关)语义变为「**显示 pwsh 工具**」:关 = 每 agent `tools.restrict` 隐藏 + pre-execute
  兜底拒(理由句指路设置卡);开 = 真工具直接可见。**`pwsh7` 旁路工具整体退役**
  (与官方 pwsh 跑同一二进制,纯冗余);`resolveHostPwsh7`/`pwshArgv`/`validatePwshArgs`
  及其 21 门语言词条随之删除,设置卡词条改写为 pwsh 显示开关。
- **patch 收紧**:`pwsh-sandbox` 禁用行与 `gitbash-executor` 行删除;`executorConfiguredBashPath`
  的二段式读取保留作老 profile 兼容层(读不到即回退 `gitbash-shell` 行值);better-sidebar
  edit 的硬编码 `C:/Program Files/Git/bin/bash.exe` 改为 boot 期 `!!js` 探测
  (默认安装位置 → LOCALAPPDATA,两处皆缺返回 '' 交还官方行为,issue #13 教训)。
  **冒烟新增「市场门禁自检」断言**:patch 永远不得同时携带 `@deepseek-ai/` 字样与字面
  `disabled: true`——把上架契约锁进测试,防未来回归。
- **行为变化**:①官方 `pwsh` 不再被无条件拒绝(开关开后是真 PowerShell);②bashPath 显式
  配置只认 `gitbash-shell` 行(executor 行随 patch 删除,该层配置本来就是空串默认);
  ③老 profile 里手写的 `gitbash-executor` 行会在启动日志出现「unknown row」级提示
  (宿主行为),配置值请迁移到设置卡 bashPath。
- **冒烟**:122 项(121 绿 + 1 项历史实测跳过「path rescue measured」,与本版无关):inlineNeeds 新形状(hidePwsh 随开关)、
  bash-tool 模块面(无 shell inject/双形态 schema/硬校验)、bash-render 标记契约、
  后台适配、市场门禁自检、patch 形态锁(不再出现 pwsh-sandbox/gitbash-executor/字面禁用)。
- **真机验证(win32)**:待做——按 AGENTS §4l 纪律,真机通过前本版本不标「完成」:
  ①启动日志 `own bash tool ready (private Git Bash executor at ...)`;
  ②新会话 bash 工具出现,`command -v bash` 指向 Git 安装目录;官方 pwsh 不在工具面;
  ③设置卡开 pwsh 工具 → 新会话 pwsh 出现且 `Get-Process` 等 cmdlet 真实执行;
  ④后台任务:`sleep 30` + run_in_background → job_output/job_kill;
  ⑤PTY 终端「· Git Bash」不受影响;⑥dsh-ops 同装时让位不变。

## v0.38.5 — 2026-10-13

**类型**:fix(用户 27 工具全量冒烟报告的 FastCtx 两项;bash 工具真机验收通过)。

- **同轮验收**:用户 Windows 真机全量测试确认 **bash 工具出现且作为唯一命令通道正常工作**(退出码标记、后台任务、job_kill 全过)——v0.35.0 以来「行内补位」五层问题(注入缺失/output 契约/restrict 作用域/asar 解析/fiber 时序/服务授权)全部闭环。
- **gb_glob 畸形 pattern 由静默放行改为响亮报错**:上游对非字符串 pattern 静默当「全部文件」处理(测试实测:传数组形状的字符串返回全库),桥侧在 `glob`/`replace` 的 execute 里前置校验——pattern 必须非空字符串,否则抛 `pattern must be a non-empty string`。静默错误结果比报错更危险。
- **忽略规则透明化**:三套「找文件」默认行为各不相同(官方 glob 不忽略任何;gb_grep 尊重 .gitignore 跳 .git;gb_glob 只认裸 .ignore 且 .git 恒可见)——在 gb_glob/gb_grep 的 description 里**如实声明各自规则**,混用时模型不再拿到意外结果集而不知情。
- 其余发现归属:web_search 402 是 web-search-deepseek 插件的端点余额问题(非本插件);read_image webp 重编码/行尾不对称/wait_agent 下限等为宿主行为,不在本仓库范围。
- **冒烟**:119 项全绿(新增畸形 pattern 校验与忽略规则断言)。

## v0.38.4 — 2026-10-13

**类型**:fix(bash 挂载的服务授权 + 折叠分区自绘;两条真机日志驱动)。

- **bash 挂载改走 cordis 官方插件通道**(`agent.ctx.plugin(mod)`):官方 tool-bash 模块对象自带 `inject: ['tools','shell','systemPrompt','shellEnv','workingDirectory']` 声明;此前手动 `mod.apply(scope.ctx)` 绕过声明,被 cordis 拒读服务(`cannot get property "shell" without inject`——上一版 fiber 时序修复的后续,ctx 已就绪、死在授权)。`ctx.plugin(mod)` 注册**真正的 fiber**(声明生效、cordis 自己跑 apply、Config 走官方 schema),`await fiber` 等激活完成;卸载 = `fiber.dispose()`,回滚语义由 cordis 保证。
- **折叠分区改为自绘**(按钮头 + 条件体,零外部组件):官方 `DisclosureRow` 在真机的插件受限 require 形状里拿不到(`icon("DisclosureRow")` 为 null),v0.38.0–0.38.3 的每个分区都在静默退化成「静态标题 + 平铺」——正是用户截图里那个"一条线分割的一列"。自绘后:七个带边框卡片、标题行常驻可点、默认全收起。
- **冒烟**:118 项全绿;断言改锁自绘形态(无外部组件依赖、折叠头、条件体)。
- **真机判据**:升级重启新建会话 → bash 出现 + 日志 `official bash tool activated for this agent`;设置卡 = 七个可折叠卡片。

## v0.38.3 — 2026-10-13

**类型**:fix(补位激活的 scope 上下文时序;用户终端日志一锤定音)。

- **根因(日志 `official tool-bash activation failed: Cannot read properties of undefined (reading 'shell')`)**:cordis 的 `ctx.plugin()` **只创建 Fiber 就返回,插件的 apply 回调是异步启动的**(`vendor/cordis/lib/index.js:1619`,wrapped fiber 是 thenable)——`createScope` 返回时 `childCtx` 还是 `undefined`,`mod.apply(undefined, {})` 在官方模块第一行 `ctx.shell.sandboxMode` 上炸。此前的解析修复(v0.38.1)已生效:模块拿到了,死在最后一步。
- **修复**:`createScope` 返回 `{ fiber, get ctx(), dispose }`;`activateOfficialBash` 与 `providePwsh`(同款隐患,此前 pwsh7 开了也会静默发不出)在动手前 `await scope.fiber` 等回调跑完,再校验 `scope.ctx` 就绪。
- **冒烟**:118 项全绿。
- **真机判据**:升级重启新建会话 → 工具面出现 `bash`;日志出现 `official bash tool activated for this agent`。若再现 activation failed,错误行会指向官方模块内部的真实原因(而非 ctx undefined)。

## v0.38.2 — 2026-10-13

**类型**:fix(v0.38.0 折叠分区在真机上完全失效;用户截图定位)。

- **`fold()` helper 签名与调用点不匹配(实锤 bug)**:七个调用点是 `fold("sec.xxx", 行, 行, ...)`,实现却按 `(key, titleKey, ...行)` 解析——**每个分区的第一行内容被吞进标题参数**,`t(<React元素>)` 得到空标题,卡片退化成一列无标题的平铺开关(v0.38.0 的折叠在真机从未生效)。修复:实现改为 `(titleKey, ...行)`,折叠状态键直接用词典键,调用点零改动。
- 官方用法核对(SystemPromptRow/PresentRow):`DisclosureRow` 的 props 形状(icon/title/open/expandable/expandOnRowClick/onToggle/children)与本插件用法一致,问题只在签名错乱。
- **冒烟**:118 项全绿;断言改锁 `folds[titleKey]`。

## v0.38.1 — 2026-10-13

**类型**:fix(bash 补位在桌面版宿主解析不到官方包;真机反复确认的最后一个开放问题)。

- **根因(无日志下的代码级定位,待真机确认)**:bash 激活的解析通道用的是裸 `createRequire(ctx.baseUrl).resolve('@deepseek-ai/dsh-tool-bash')`——**桌面版宿主把官方包打进 `app.asar`,从插件的 profile 布局裸解析必然失败**(返回空 → 日志 "not resolvable" → bash 永缺)。这也解释了为何同一进程里 deny/pwsh7/gb_* 全部正常(插件自带代码,不依赖该解析)而唯独 bash 缺。
- **修复:解析通道改为宿主 loader 优先**——`ctx.loader.internal.import(name, ctx.baseUrl, {})`,与宿主挂载行包**完全相同的调用**(`vendor/loader/src/config/tree.ts:122`),走宿主自己的 resolve 钩子(可达 asar 内部);失败才退回裸 createRequire(旧通道,非桌面布局保底)。两通道都失败才如实记日志。
- `resolveToolBashEntry` 返回形状从 href 字符串改为 `{ load }` 惰性加载器;`activateOfficialBash` 接收 loader 对象;调用点与缓存变量同步更名。
- **冒烟**:118 项全绿;新增「bash resolution tries the HOST loader before a plain require」(断言通道顺序、官方包名、baseUrl 透传、惰性加载)。
- **待真机复验**:升级重启后官方模式新建会话,工具面应出现 `bash`;日志应出现 `official bash tool activated for this agent`。

## v0.38.0 — 2026-10-13

**类型**:feat(设置卡折叠分区;用户反馈「开关堆一列不知道主题」)。

- **七分区全部改为可折叠卡片**:v0.36.0 只加了标题文字,视觉上仍是一列开关。现在每个分区是官方 `DisclosureRow`(seed `ui-primitives` 组件,client bundle 的 require 白名单内)**折叠卡**——默认全部收起,页面只剩七行分区标题(模式 / 行内工具 / 路径方言 / 执行器 / 终端 / 终端工具 / 插件联动),点哪行展开哪区,找设置 = 先认主题再点开(用户原话:「内部可以折叠,这样我找的时候就只需要去展开我大概知道的某个设置主题,然后去找更细节的按钮」)。
- **视觉卡片化**:每分区带边框 + 圆角(`.gb-fold`),分区边界一眼可辨;不再依赖上一分区底部的分隔线。
- **新增 `sec.mode` 分区标题 × 21 语言**(模式区此前借用变体开关的长文案做标题)。
- **退化路径**:极简宿主没有 `DisclosureRow` 导出时,分区退化为静态标题+内容(v0.36.0 形态),卡片永不白屏。
- 功能面零变化:所有开关的字段名、写入通道、默认值原样。
- **冒烟**:117 项全绿;七分区断言改锁 fold 形态(官方 DisclosureRow 接线、默认收起、退化路径)。

## v0.37.0 — 2026-10-13

**类型**:feat(用户拍板的命名与开关重构;真机反馈驱动)。

- **`gitbash_pwsh` 更名 `pwsh7`(破坏性:工具名变更)**:旧名读起来像「bash/pwsh 二选一的混合工具」,让人误解(用户真机反馈)。新名 `pwsh7` 语义直白(PowerShell 7),且**绝不占用宿主被污染的 `pwsh` 名**(那个名字的全局工具在本机执行 Git Bash,是假 pwsh,恒定拒绝)。真机已装旧版的会话在新版下自然看到 `pwsh7`。
- **`pwshTool` 开关默认翻转为 `false`(破坏性:默认值变更)**:默认**不提供**专门的 PowerShell 工具——平时全部走 bash 工具,需要 Windows 原生操作的用户在设置卡自己打开。开关只在 gitbash-shell 一侧行上(ptc 创造模式零参与,装了本插件即自动适配,2026-10-13 拍板)。
- **pwsh7 的提供方式改为 per-agent scope 注册**(原为全局注册):agent 独立 scope 内注册、随 agent 销毁回收;与 dsh-ops 共存时照旧让位(它的宿主 pwsh 故事优先)。
- **路由提示词按开关分支**:`pwsh7` 关(默认)时 bash 工具的描述**不再提及任何 PowerShell 工具**(给模型指一条到不了的路只会教它调用被拒的名字);开时才出现「pwsh7 仅用于 Windows 原生能力」的路由句。新增 `GITBASH_ROUTE_ADDENDUM_NO_PWSH` 常量,assemble 处按 `pwshTool()` 现场选择。
- **调用层守卫保持恒定 deny `pwsh`**:`pwsh7` 是纯加法名字,不会误杀;deny 理由句更新为指路 `pwsh7` 与设置卡开关。
- **词典**:pwsh.label/pwsh.hint × 21 语言重写(名字 pwsh7、默认关、**必须已安装 PowerShell 7** 的提醒与下载地址);工具 description 与错误消息同步更名。
- **冒烟**:117 项全绿;路由句测试加「OFF 变体不得出现 pwsh7 字样」与「 misleading 名绝迹」断言。
- **待真机复验**:bash 工具补位仍未在标准模式出现(v0.35.3 观察)——`activateOfficialBash` 链路失败必有日志行("not resolvable"/"import failed"/"activation failed"),等宿主日志定位;与本版无耦合。

## v0.36.0 — 2026-10-13

**类型**:feat(设置卡分组重排;用户反馈「一排按钮不知道分类」)。

- **七分区语义分组**:此前 9 个开关一锅炖在「路径方言」分区里(方言、终端接管、Git 行尾、bash 路径混排),行内工具区连标题都没有。重排为按功能域的七个分区,显示顺序即用户决策顺序:**模式**(变体开关)→ **行内工具**(gitbash_pwsh、gb_*——补上标题)→ **路径方言**(瘦身,纯翻译层 6 开关)→ **执行器**(新分区:Git 行尾 + Git Bash 路径——找「为什么 diff 飘红」或填 bash 路径不用再滚过六个翻译开关)→ **终端**(新建终端接管 + 侧栏接管)→ **终端工具**(win32 工具链,原样)→ **插件联动**(新合并分区:去重开关 + python 后端两个席位一个标题)。
- **词典**:新增 `sec.inline`/`sec.executor`/`sec.peer` × 21 语言;`sec.terminal` 文案从「侧栏终端」改为「终端」(该分区现在装的是两个终端接管开关)。合计 21 门逐键对齐(冒烟键集断言全过)。
- **冒烟**:117 项(116 过 + 1 跳)。新增「client card: the body groups switches into seven labelled sections」——锁七分区定义齐全、body 挂载顺序、方言区不再吞执行器/终端行、行内工具区有标题。
- 功能面零变化:所有开关的字段名、写入通道(configForms)、默认值全部原样,纯布局重组。

## v0.35.3 — 2026-10-12

**类型**:fix(issue [#18](https://github.com/KannaKuron/dsh-gitbash-shell/issues/18) 三个独立根因;Windows 真机 v0.35.0 四面全灭)。

外部用户(zjh1159086960-crypto / Lntano)的高质量报告:v0.35.0 四个新面(行内补位 bash、假 pwsh 遮蔽、`gitbash_pwsh`、`gb_*`)在 Windows 真机**一个都没生效**,且定位到行。三个根因相互独立,v0.35.2 的挂载时扫描只是让「断得更早的 wiring」多了一次运行机会——**根因仍在,四面依然全灭**。本版逐一修复,修法全部对照 dsh-ops 已在真机验证的实现:

- **根因一:`resolveHostPwsh7()` 零参调用 → 整个行内补位 wiring 流产**(主凶)。`exists` 是必填注入项,win32 下对象字面量求值即抛 `exists is not a function`,被 `mountInlineTools` 外层 catch 吞成一行日志——bash 补位、假 pwsh 遮蔽、`gitbash_pwsh` 三个面同死。修复:调用点注入 `{ exists: existsSync }`(`node:fs`,候选矩阵与 PATH 兜底逻辑本身无恙,报告者已验证)。
- **根因二:工具定义缺 host 必填的 `output` 契约 → `gitbash_pwsh` 与 `gb_*` 注册全被拒**。host `ToolRuntime.register` 硬校验 `output { schema, render }`(官方工具全部经 `defineTool` 包装补出)。修复:新增冻结的 `TOOL_OUTPUT_SCHEMA` + `renderTextContent`(dsh-ops `lib/tools.js` 的 OUTPUT_SCHEMA 同款形状,两个工具家族共享),`gitbashPwshDefinition` 与 `gb_*` 注册全部补上。
- **根因三:`restrict()` 从根 ctx 调用必然抛错 → 假 pwsh 的 deny 从未建立**。host 硬校验「requires a scoped context」,根 ctx 无 scope 键,异常被 catch 吞成 `fake-pwsh deny failed` 日志。修复:改走 **`agent.ctx.tools.restrict({ deny: ['pwsh'] })`**(dsh-ops `lib/index.js` `installHostShellDenial` 的同款调用;host 文档原文「Hiding tools from one agent is ctx.tools.restrict() on that agent's context」)。
- **冒烟**:116 项(115 过 + 1 跳)。新增两个测试:「the three issue-#18 root causes stay fixed」(三个根因的源码防回归锁,含 `doesNotMatch` 禁止零参调用与根 ctx restrict 回潮)与「the tool definitions speak the host output contract」(两家族共享契约 + render 行为:多块拼接、空 content 渲染单个空文本块)。
- **致谢**:三个根因全部由报告者先行定位,本版修复与其复现脚本逐一对齐;真机验证(四面生效)待报告者与用户复验。

## v0.35.2 — 2026-10-12

**类型**:fix(Windows 真机报告;行内补位的时序洞 + 调用层兜底)。

- **修复:已存在的 agent 拿不到补位(用户 Windows 真机报告)**。症状:AI 调 `pwsh` 工具收到 `/usr/bin/bash: line 1: Select-String: command not found`——假 pwsh 的执行器在本机就是 `ctx.shell`(Git Bash),PowerShell 命令进了 bash。根因:补位判定此前**只挂在 `agent/created`** 上,本插件行**激活晚于 agent 存在**时(插件热重载、宿主先恢复会话后本 bundle 行才挂完),全部已存在的 agent 保持假 pwsh 且没有 bash,且永不再触发判定。修复为 **dsh-ops 验证过的双重独立层**(`installHostShellDenial` 同款形态):
  - **层 1 — 挂载时补扫**:`mountInlineTools` 新增 `agents(ctx)` 依赖(index.js 传入 `ctx.get('agents')`),挂载那一刻对 `agents.list()` 里的每个**已存活 agent** 跑一遍 `reconcile`——与 created 事件同一条路径,250ms×5 有界重试等同样生效;
  - **层 2 — 调用层守卫**:新增 `tools/pre-execute` 监听,凡 `pwsh` 调用到达分发层一律 deny,理由句直接指路替换品(bash 工具 / `gitbash_pwsh`)。两层层层独立:即便 per-agent 的 `restrict({ deny })` 输了竞态,谎工具也到不了执行器。
- **顺手修复:重名声明 SyntaxError**。v0.35.2 开发中引入的 `agents` 依赖与 `mountInlineTools` 内部的 agent 状态 Map 同名(`const` 重复声明,模块整体加载失败)。内部 Map 改名 `tracked`;冒烟加防回归断言(源码不得再现 `const agents = new Map()`)。
- **冒烟**:新增「inline tools: the mount-time sweep and the call-layer guard exist (v0.35.2)」;「…wires the patch…」补 `agents` 依赖接线断言。合计 114 项(113 过 + 1 跳)。
- **Windows 真机复验清单(升级后)**:①官方模式新会话有 bash 工具;②假 pwsh 调用被拒(deny 理由指路);③`gitbash_pwsh` 跑真 pwsh 7;④`gb_grep` 出参 /c/ 方言。v0.35.0 的真机验证项(见该条目)顺延至此版一起验。

## v0.35.1 — 2026-10-12

**类型**:fix(dsh-ptc-cordis-preset 联动显示;真机反馈)。

- **`gitBash` 能力加法字段 `inlinePatched`**(win32 恒 true):v0.35.0 的行内补位使**官方四个模式全部自带 Git Bash**,对端名录里 `PTC 创造模式 · Git Bash` 这类后缀不再有区分意义,反而与已下线的变体命名风格混淆(用户真机反馈)。对端(≥ v0.17.3)读到该字段即用普通名称;旧对端忽略该字段,行为不变。加法字段演进,同 §4f 的 `pythonBackend` 先例。

## v0.35.0 — 2026-10-12

**类型**:feat(重大行为变更)。官方四个模式**默认直接获得 Git Bash**——四个「·Git Bash」变体 preset 转为可选开关(默认关);新增真正的 `gitbash_pwsh` 工具与 `gb_*` FastCtx 文件工具;与 dsh-ops 自动共存。

- **⚠️ 破坏性变化(用户拍板,新/老用户一律默认)**:`variantPresets` 开关(行 Config,volatile,**默认 false**)。关闭时不注册四个变体,官方 `standard/minimal/ptc/cordis` 经**行内工具补位**获得 Git Bash;开启则恢复 0.34.x 的四变体名录并停用补位(两者按观测互斥,无需显式锁)。**钉在 `*-gitbash` id 上的旧会话升级后需重新选择模式**;`cleanupLegacyTrees` 不受开关影响(旧物化残留照常清理)。
- **部署默认自动迁移(用户要求)**:全局默认模式是**唯一可写的默认层**(会话级绑定被官方 `agent-preset/locked` 锁死,不可迁移;新会话屏的模式 chip 是暂存态不落盘)。当 `variantPresets` 关闭且部署默认仍指向我们的变体 id 时,启动即经**官方通道**(`settings.update('agent-preset-registry', { selectedDefault })`,与官方模式选择器同一条缝)迁移到官方后继:`standard-gitbash→standard`、`minimal-gitbash→minimal`、`code-gitbash→ptc`、`cordis-gitbash→cordis`。**幂等**(迁移后或用户自选的官方默认不再匹配变体 id,永不重写)、**roster 先验**(目标 id 不在册即停手——官方 id 有 code→ptc 改名前科,宁可不动也不写未知 id)、**写后读回校验**(没写进去如实报错,绝不谎报成功)、`variantPresets` 开启时整套逻辑不运行(变体默认是合法选择)。钉住的旧会话仍需新建会话(官方锁定,已在迁移日志与文档如实说明)。
- **为什么是运行时补位而不是 patch 翻转(调查结论,源码+最小模拟实证)**:官方四 preset 的行集是 web-app bundle patch 的 `insert` 行,其 `tool-bash`/`tool-pwsh` 行嵌在 `config.plugins` 里;而 `applyEntryPatches` 的 id 索引**只递归 `group: true` 的行**(`vendor/include` buildMap)——patch edit 按 id 只能命中 base 全局层那份,对 preset 组合内那份**不可达**;改写 preset 行整个 `config`(restatement)会把官方行集冻结在复刻时刻,维护成本反超变体方案。故落地形态为:`agent/created` 时读该 agent 工具面(`ctx.get('tools').schemas(agent)`),「有 pwsh 无 bash」→ 在 agent 自有 scope 内**激活官方 `@deepseek-ai/dsh-tool-bash` 模块**(`apply(ctx, config)` 全量行为,零复刻;官方注册表错误文案背书的 per-agent 变体路径),并 `tools.restrict({ deny: ['pwsh'] })` 遮蔽假 pwsh;变体模式下工具面已有 bash,补位天然跳过。时序防御:created 时工具面两工具皆无视为「未接线」,250ms×5 有界重试。
- **路由提示词(用户明确要求)**:bash 工具 description 经 `system-prompt/assemble` waterfall 追加两段——**路由句(恒加)**「能用 Git Bash 就用 Git Bash;只有 Windows 原生能力(cmdlet/注册表/服务/WMI)才用 PowerShell;bash 出错在 bash 修,禁止嵌 `pwsh -Command`」与 **MSYS 句(方言开才加)**「路径用 /c/ 盘根,~、/tmp、/dev/null、/usr 照 Git Bash 语义」。description 属工具 schema 层,极简 preset 的 `complete: true` persona 覆盖不掉;幂等以「Prefer this bash tool」标记判定。
- **`gitbash_pwsh`(新工具,默认开,`pwshTool` 开关)**:治「AI 在 bash 里嵌 `pwsh -Command`」的全家桶(吞变量:bash 先展开 `$env:`;乱码:PowerShell 5.1 管道输出 GBK、MSYS 侧按 UTF-8 解)。走官方 `ctx.subprocess` 通道(凭证清洗/进程治理/spill 全官方),spawn **系统安装的 pwsh 7**(well-known 安装位 > PATH;绝不 5.1、绝不自带载荷,机器没装不发布);`command`/`script_path` 二选一(长脚本走文件,不进工具 JSON)、严格拒绝未声明参数(`run_in_background` 等显式报错)、UTF-8 输出、stdout/stderr 各 64KB 截断+64MB 溢写、结果回显走方言改写。仅 danger-full-access 会话发布(该通道无沙箱,如实拒绝)。
- **`gb_*` FastCtx 文件工具(新,默认开,`fastctxTools` 开关)**:`gb_inspect_local_file`/`gb_grep`/`gb_glob`/`gb_replace`——FastCtx(github.com/yc-duan/fastctx,Apache-2.0)的 Rust 实现:批量范围读取带 token 预算、grep 截断标注、编码探测(报候选而不是猜)。**是官方工具的补充,绝不替换**——官方 read/grep/glob/edit 接文件沙箱,每个 gb_* description 明示 FastCtx 无 workspace confinement、官方工具是默认推荐。传输为**自写薄 MCP stdio 客户端**(约 120 行 JSON-RPC;官方 `@deepseek-ai/dsh-mcp-client` 是静态行配置,无 `!!js` 解析载荷路径的能力、无工具过滤、名字锁死 `mcp__` 前缀——不匹配本插件「运行时动态桥接+让位+方言」形态,官方若开放运行时桥接 API 则此模块第一个退役,已记 AGENTS.md 跟随清单)。载荷新增 `optionalDependencies @dsh-ops/fastctx-win32-x64@0.2.1`(锁版本,SHA-256 provenance;上游 `@fastctx/win32-x64` 在场则优先);`serve` 不带 `--enable-shell`,FastCtx 的命令/后台工具在本部署**不存在**。方言适配全接既有挂载表:`gb_*` 入参(path/file_path/files[].path/绝对 pattern)MSYS→Windows,结果文本回显 Windows→MSYS——官方工具与 gb_* 看到同一个方言世界。断线惰性重连;进程退出经 `ctx.effect` 清理。
- **与 dsh-ops 自动共存(用户要求)**:每个 agent 工具面出现 `ops_*`(dsh-ops)时,`gb_*` 与 `gitbash_pwsh` 自动撤下(它的 ops_* 与宿主 pwsh7 已覆盖同一地面),提示词面各自独立;`gitBash` capability 的 `active` 语义明确为「本机命令执行是否为 Git Bash」(与 variantPresets 无关),dsh-ptc-cordis-preset 的名录措辞与去重判定**零改动兼容**(对方 ≥0.14.0 探测逻辑核查过)。
- **设置卡**:三新键 × 21 语言(`variant.label/hint`、`pwsh.label/hint`、`fctx.label/hint`),`variantPresets` 关/开、pwsh 与 FastCtx 开/关双态按钮;smoke 断言 21 字典键全齐。
- **测试**:smoke 111 过(基线 101 → +10:补位判定三态、gitbash_pwsh 严格参数与 argv、pwsh7 解析矩阵、路由/MSYS 分句、接线断言、gb_* 参数翻译/渲染/载荷探测、卡片 21 语言一致性、optionalDependencies 锁版本);同步更新 2 处 `runDeclarativeEra` 调用行断言。本机(macOS)为逻辑级验证;**Windows 真机验证待做**(补位激活/假 pwsh 遮蔽/pwsh7 路由/gb_* 出参,见 README 验证清单)。
- **依赖边界**:FastCtx 载荷为 optionalDependencies(缺失时 gb_* 不发布,一行日志说明);不声明 `@fastctx/*`(上游包在场优先用,不在场靠 fork 包);无 lifecycle 脚本(零 allowBuilds 摩擦);非 Windows 宿主全部新面 inert。

## v0.34.3 — 2026-10-11

**类型**:fix([issue #16](https://github.com/KannaKuron/dsh-gitbash-shell/issues/16):Git Bash 预设 persona suffix 引用 `{{cwd}}`,dsh 0.2.1-alpha.1+ 每轮在任何模型请求前抛错)+ dsh 0.2.1-alpha.2 官方组合对齐。

- **根因(issue #16,报告 @tkhs101)**:`compositions.js` 的 persona 行带 `suffix: 'Your working directory is {{cwd}}.'`——上游 **79bd3d8da7**(2026-09-13,session working-directory 集中化)删除了 agent-loop 的 `cwd` 提示词变量注册,而 system-prompt 对未注册变量引用**在任何模型请求之前直接抛错**,整轮失败。0.1.7-rc.2 仍注册该变量所以 desktop 侧无感;0.2.1-alpha.1 起必炸。官方预设同步在 **0.2.1-alpha.2** 删除该子句(**2eb058d887**,"remove retired directory persona templates")。修法即上游 README 明文指令:**从四个变体删除该子句**——工作目录由宿主 working-directory 运行时上下文(WORKING_DIRECTORY,order 100)提供,官方各预设均无 persona suffix。冒烟新增回归锁:组合不得再引用 `{{cwd}}`。
- **组合对齐(0.2.1-alpha.2 官方漂移,`packages/bundle/web-app/presets/`)**:
  - 官方删除的三个占位行(`tool-subagent-codex` / `tool-subagent-claude-code` / `tool-ralph`,上游 **8ed0b530ed**,codex/claude-code provider 移交「按需安装」官方组合包)从全部变体删除——三行在各代宿主都是 `disabled: true` 占位,删除零损失;冒烟断言 ralph 不复存在。
  - `tool-subagent` / `tool-subagent-fork` 的 `backgroundMode: 'continuable'` 改 **hostExtras 双态**(0.2.1-alpha.2 官方删除该字段;≤0.2.0 官方带)。既有 `probeHostExtras` 信号直接复用,零新增探测。
  - plan-mode section **首句双态**(共享正文):0.2.1-alpha.2 官方把首句改回「until the user approves your plan through exit_plan_mode」(alpha.1 为「until exit_plan_mode succeeds」),跟随同一条 hostExtras 信号;其余段落逐字节不变。
- **`tests/align-official.mjs`**:PRESET_SHA256 四 pin 重新钉到 0.2.1-alpha.2(standard/cordis/ptc 变更,minimal 逐字节不变);`DSH_HARNESS_SRC` 指向 0.2.1-alpha.2 checkout 全 OK。
- 测试:smoke 101 过;唯一失败 `minimal PTY shellPath … (issue #15)` 为本机 Git Bash 环境下的既有失败(与 0.34.2 基线一致,stash 验证与本版改动无关,待单独排查)。

## v0.34.2 — 2026-10-09

**类型**:fix([issue #15](https://github.com/KannaKuron/dsh-gitbash-shell/issues/15):极简模式 · Git Bash 的 PTY 终端无法启动,node-pty `File not found`)

- **根因**:`minimalPluginsFor()` 是四个变体里**唯一**给 terminal-bash 行写死 `shellPath: DEFAULT_GIT_BASH`(`C:/Program Files/Git/bin/bash.exe`)的地方——Git 装在自定义路径(Scoop / 便携版 / 其他盘符)的 Windows 机器上,PTY spawn 在进程创建阶段即失败,且本插件撤掉 `pwsh-sandbox` 而 dsh 每进程只允许一个 `ctx.shell`,极简模式 shell 能力完全归零、无备用。其余三个变体(`pluginsFor`)不含 `shellPath`、走 `src/shell.js` → `resolveGitBashCached()` 动态解析,天然正确——与 issue #11 同类残留,这次漏在 PTY 行上。
- **修法(采纳报告人 @Jingqi05 的「入参传入」变体,`compositions.js` 保持纯数据)**:`minimalPluginsFor({ bashPath })`——win32 下有解析结果用解析结果,否则兜底 `DEFAULT_GIT_BASH`(失败保持可见的 spawn 报错、绝不换成别的 shell,§4h 两条硬边界不变);非 win 恒 `/bin/bash`。
- **解析来源比报告人裸 `resolveGitBashCached({})` 更完整一层**:`src/index.js` 新增 `minimalPtyBashPath(readBashResolution)`,每次(重)注册时懒读(issue #13 纪律:不在 apply() 期冻结),喂的是**含显式配置层**的 `readConfiguredBashPath` 链(`gitbash-executor` 行 > `gitbash-shell` 行 `bashPath` > 自动链)——与执行器同一条解析链,设置里显式填的路径优先。
- **测试**:冒烟 +1 用例(win32 平台 stub 三态:解析成功用解析结果 / 失败与空值兜底默认 / 非 win `/bin/bash` + 读取器异常安全 + 接线断言);102 项全绿(基线 101:100 pass + 1 win32-only skip → 101 pass + 同一 skip,纯增量无回归);同步更新 3 处锁源码文本的既有断言(`registerVariant` / `runDeclarativeEra` 调用行、`pluginsFor` 形参)。
- **真机**:Windows 真机复现与修复 A/B 对照(真实 node-pty:修复前 spawn `File not found: C:/Program Files/Git/bin/bash.exe`,修复后 `D:/git/Git/bin/bash.exe` exit=0)由报告人 @Jingqi05 在 issue 中完成,修复评论已引用;本机(macOS)为逻辑级验证 + 全量测试。
- **已知边界(已在 issue 评论如实说明)**:极简变体行集是注册时快照,运行中改 `bashPath` 设置需重启 dsh 才进 PTY 行(其余三变体走执行器懒解析、无此限制);热重注册需跟踪 `registeredBashPath` 的 retire/重建模式,超出本次范围。

## v0.34.1 — 2026-10-05

**类型**:chore(清理 `dsh.client.inject` 里的死引用 `@deepseek-ai/dsh-client-runtime`)

- **背景**:该包只在 dsh 0.1.0-rc.7 ~ 0.1.1-rc.2 期间存在(当时挂在 `packages/bundle/web-app` 的依赖里),自 **0.1.2-alpha.1 起被官方移除**(Web Client runtime unbundling;npm 上停在 `0.0.1-rc.1`);本插件源码对它已无任何引用,只剩 `dsh.client.inject` 这一条元数据残留。
- **原先的保留理由已失效**:此前复核曾有意保留该条,理由是「避免改变旧宿主排序」——0.1.0-rc.7~0.1.1-rc.2 上它确实是客户端启动图里的真实 row。自宿主下限抬升起本插件宿主下限为 `>=0.1.7-rc`,**该理由保护的那批宿主已不在服务范围内**,死引用因此可安全清除。
- **安全性**:加载器对 `inject` 里无对应 row 的名字本就静默跳过(官方 `packages/client/modules/src/client/system.ts`),而在服务范围(`>=0.1.7-rc`)内该包从未存在 ⇒ 删除前后行为一致,纯元数据清理。
- **验证**:`npm test` 全绿(101 项)。


## v0.34.0 — 2026-10-04

**类型**:feat(跟随 dsh 0.2.1:宿主可用时三个全工具变体自动纳入官方时间上下文与提醒工具)

- **背景**:dsh 0.2.1 给每个全工具官方 preset(standard/ptc/cordis)新增两行——`time-context`(@deepseek-ai/dsh-time-context,请求时钟上下文)与 `tool-schedule`(@deepseek-ai/dsh-tool-schedule,提醒工具 schedule_create/delete/list/update),并给 subagent / subagent_fork 的 config 加 `toolFilter.deny` 四个 schedule_* 工具(官方「提醒工具按模式提供:极简模式和子代理不可用」);官方 minimal 无变化(0.1.7-rc.2 与 0.2.1 的 minimal.patch.yml sha256 逐字节一致)。
- **同步方式(探测式,不抬宿主下限)**:preset 行的包缺失会拒绝**整棵挂载**(AGENTS 不变量 2),所以新行不能无条件加——`src/index.js` 新增 `probeHostExtras(ctx)`:从 **`ctx.baseUrl`**(行挂载的同一解析基准,`prepareProfileEntries`)逐包 `require.resolve` 探测,可用才加行 + 加 toolFilter;探测一次每 boot,peer 翻转触发的 reconcile 重注册复用同一结果;**任何解析异常都降级为不可用,绝不 reject boot**。`minimalPluginsFor` 不动(minimal 无新行)。dsh ≤ 0.2.0 宿主行为逐字节不变(0.1.7 镜像),0.2.1+ 宿主全对齐(0.2.1 镜像)——`engines.dsh` 保持 `>=0.1.7-rc`。
- **组合与测试**:`pluginsFor` 增加 `hostExtras` 参数(`{ timeContext, toolSchedule }`,缺省全 false;toolFilter 跟随 toolSchedule 单独走)。冒烟 99 → 101 项(+hostExtras 专项 + probeHostExtras 单测,含抛异常降级与半探测边界);**`tests/align-official.mjs` 的 pins 升级到 dsh-v0.2.1-alpha.1**(standard/cordis/ptc 换新 sha;minimal 不变),对齐目标切为「全探测行集 × 0.2.1 文本」——本机实测 **alignment OK: all four variants mirror the official row sequence**(34/35/35/7 行);旧宿主形态由 smoke 的 0.1.7 镜像断言继续锁死。两处既有源码形状断言随签名同步(`pluginsFor` 形参、`registerVariant` 调用)。
- **上游预警(AGENTS 第 8 条追记)**:dsh 仓库有 **proposed** 状态的「让 shell 环境声明只负责键所有权」提案(2026-09-19)——落地后将删 `list()`、`BashEnvVariable`、描述对象与仅描述性校验,贡献方声明改为**显式只读键集合**。本插件 `shellEnv.register` 的 `variables: { DSH_PATH_DIALECT: { description } }` 正是描述对象形状,**提案实施的下一版 dsh 升级必须同步改贡献形状**(register/collect/所有权冲突/未声明拒绝语义不变)。
- 相关:[dsh v0.2.1-alpha.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)、[shell-env 提案(中文)](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/proposed/simplification/2026-09-19-shell-env-key-declarations.zh.md)。

## v0.33.1 — 2026-10-02

**类型**:docs(issue #14:README「保留官方沙箱语义」与 Windows 受限模式的实际行为不一致)

> 报告者 **SenkjM** 的五条观察(enforcement 元数据、完整性级别 Low→Medium、shell 越界写成功而文件工具被拒、一次性提示、README 关键词计数)**全部与设计一致**;他指出的是文档缺口——行为在代码层有如实标注(§1 红线「绝不静默假成功」守住的是结果元数据与运行期提示),但 README 层面除了「保留官方沙箱语义」这句误导性概括外零披露。本版补齐,并顺带修正 README 里残留的物化时代描述。

- **README.md / README_EN.md 新增「安全语义:Windows 上的受限模式」章节**(置于「它做了什么」之后):POSIX 完整保留 / Windows 受限模式 shell 走 unconfined 的根因(MSYS2 vs restricted-token,OS 层冲突无插件内解)与取舍理由、如何标注(结果元数据 `enforcement: "unconfined"` + 每进程一次性日志)、**文件工具不受影响**(fs 沙箱另一层,边界不一致如实写明)、可观察对照(完整性级别不再压低 Low→Medium、TEMP 不再隔离)、以及「需要 shell 也被硬拦 ⇒ 本插件在 Windows 上不适合你,卸载即回 pwsh-sandbox,没有中间态」的明确选择提示;「它解决什么」的「保留官方沙箱语义」改为指向该章节。
- **顺带清理 README 的物化时代残留描述**(行为未变,纯文档对齐 v0.32.0+ 现状):「它做了什么」第 3 条改为声明式注册(`ctx.agentPresets.register`,行集为已提交 JS 数据,不再物化目录,旧物化树按 marker 单向清理);删除「dsh 版本双适配」「dsh 0.1.6 适配」两个过时段落(era 机制已随 v0.32.0 删除),替换为「宿主要求与 preset 对齐」(下限 >=0.1.7-rc + smoke 锁对齐 + preset id 不变);「配置」/「ptc 联动」/「去重开关」段的「物化」措辞与旧宿主(≤0.1.6)双时代描述同步更新。
- docs-only:src/ 零改动,冒烟 99 项不变(README 内容无 smoke 断言)。发 patch 版本而非仅推文档,是因为 README 随 npm 包分发——安全披露应让 `npm view` / 插件管理页看到的 README 同步更新。

- 相关:issue #14(<https://github.com/KannaKuron/dsh-gitbash-shell/issues/14>)、CHANGELOG v0.13.2(取舍的完整分析)。

## v0.33.0 — 2026-10-01

**类型**:fix(issue #13:Scoop 安装 Git 时 `bashPath` 配置正确但每次启动仍报 could NOT be resolved 并弹引导框)+ feat(解析链新增 `git --exec-path` 与 GitForWindows 注册表两级发现)

> 报告者 **ID-izlq-Github** 的定位是准确的:装配期冻结、两个读取器在 apply 时刻读空、自动链对 shim 布局盲区,三条全部成立。本条目按他的分析与建议落地(建议 1/2/3/4 全采纳)。

### 修复一:显式层懒化,不再在装配期冻结(`src/index.js`)

- **冻结点**(issue 引用的 `index.js:1813`):apply() 时 `effectiveConfiguredBashPath(executorConfiguredBashPath(ctx), settingsBashPath(ctx))` 算一次就定死。那一刻 `ctx.loader.resolve('gitbash-executor')` 因行未进 store 而 throw → 被吞成 `''`;settings 服务也可能尚未注入(0.1.7+ 只有 describe()/update())。两者皆空 ⇒ 误判「未配置」⇒ 跑自动链。执行器(`shell.js` 的 `get bashPath()` 懒解析)却正常 —— **同一次启动、两条路径、相反结论**,这正是 issue 的内核。
- **修法**:冻结值换成两个读取器 `readConfiguredBashPath()` / `readBashResolution()`,**全部消费点逐次重读**:① `gitBash` capability 改 getter(bashPath/ok/source/configured/tried;ptc 侧只读静态 `active`,不受影响);② status 路由实时重读(弹窗因此不再误报 —— 行挂载完成后 `configured` 非空,解析成功,`ok:true`,弹窗根本不出现);③ pathmap 路由与 tools/execute / post-execute 的 `buildTranslateEnv`;④ 官方侧栏终端接管每次尝试重读;⑤ better-sidebar 接管改挂 settle 通知。
- **settings 绕行退役**:`gitbash-shell` 行的 `bashPath` 直接从 apply() 的 `config` 参数读(新 `rowBashPath(config)`:volatile ref / 普通值 / 缺席三态,绝不抛)—— 这就是同一行的值,比绕 `settings.describe()` 更直接,且 volatile 意味着用户改设置下一读即生效。宿主半不再 import `settingsBashPath`(shell.js 侧保留:executor 行运行时读 describe() 实测正常)。
- **启动日志 settle 化**:boot 打印一次;「失败且显式层为空」(行可能还在挂载)时轮询 250ms×20(仅 win32,5 秒封顶),显式层出现或解析翻转后补打 `(settled)` 段;成功或显式值被拒为最终态,不轮询。terminal 接管通过 `onBashSettled` 通知(better-sidebar 在 boot 失败→settled 成功时也能接管,无需重启)。

### 修复一·续:executor 行读取在 0.2.0-rc.2 上恒断,不只是时序(`src/bash-path.js`)

- **真机实测(隔离实例 + 探针插件,报告场景复现)**:dsh 0.2.0-rc.2 上 bundle-patch insert 的行(`gitbash-executor`)挂在**所属插件的 subtree** 里,`loader.resolve('gitbash-executor')` 从 root 树查找**恒 throw**(探针 apply 时刻与 12 秒后各 7 次采样全部 throw)——报告者以为的「启动时序问题」在这台宿主上实际是**永远读不到**。旧代码把 throw 吞成 `''` ⇒ 显式层整个失效:patch 写 `gitbash-executor.config.bashPath` 的用户(issue #11 起推荐、#13 报告者的实际配置方式)在 0.2.0 上 boot/status/翻译层全部看不到该值,而执行器自己读 `this.config.bashPath` 正常 —— 「命令能用但每次启动报错+弹框」的另一半根因。**并连带违反 §4h 契约**:显式值(哪怕被拒)不得被自动链顶替 —— 实测坏值 `Q:/nope/bin/bash.exe` 被自动链的 default 层「顶替成功」,boot 谎报 resolved。
- **修法**:`executorConfiguredBashPath` 二段式 —— `resolve('gitbash-executor')` 先试(旧宿主行在 root 树,命中即返回,空串也是真实答案=自动链);throw 则 `loader.entries()` 迭代(**含 subtree**)按行自身 `options.id` 匹配(0.2.0 实测稳定可读,`bashPath` 值全程不变)。防回归用例锁死三种 loader 形状(root 命中 / subtree+entries / 行缺失)。
- **修复后 A/B 真机读数**(隔离实例,patch 写 `gitbash-executor.config.bashPath`):
  - 坏值 `Q:/nope/...`:boot `bashPath is set to "Q:/nope/bin/bash.exe" and that value was rejected; nothing else is substituted`(fail-loud、无轮询、default 层不再顶替);status `ok:false, configured:"Q:/nope/bin/bash.exe", tried[0]={source:'configured',code:'missing'}` —— boot/status/执行器三方一致;
  - 好值:boot `Git Bash resolved from the configured source`;status `ok:true, source:"configured"` —— 弹窗不出现。

### 修复二:解析链补 shim 布局的发现方式(`src/bash-path.js`)

- **新 source `exec-path`**(位置:PATH 反推之后、注册表 PATH 之前):对 PATH 上第一个 `git.exe` 跑 `git --exec-path`(Scoop/choco 的 **shim 也能启动真身**,真身报告自己的家),从输出向上最多 5 级找「同时含 `cmd/git.exe` 与 `usr/bin/bash.exe`」的目录,产出 `<root>/bin/bash.exe`。纯函数 `execPathBashCandidates(execPath, exists)` 可测;`ucrt64`/`mingw64`/旧 flat `libexec` 三种布局全覆盖,MSYS2(`usr/libexec/git-core`,根上没有 `cmd/git.exe`)天然不产出候选。
- **GitForWindows 注册表兜底**:`HKLM\SOFTWARE\GitForWindows`、`HKLM\SOFTWARE\WOW6432Node\GitForWindows`、`HKCU\Software\GitForWindows` 的 `InstallPath`(官方安装器写的;Scoop/便携通常没有,故排在 exec-path 之后),同样走 `exec-path` source。
- **候选仍过全套判据**(黑名单 → 形状 → `cmd/git.exe`/`usr/bin/bash.exe` → mingw64/msys-2.0.dll → `.windows.` 版本指纹 → `uname -s` 一票否决):§4h 两条硬边界不变 —— 永不回退、只认 Git for Windows 的 bash。冒烟新增「WSL bash 经 exec-path 到达仍被拒」用例。
- **顺带**:`defaultIo().run` 从 execFileSync 换 spawnSync(piped stdio)—— execFileSync 的同步家族在子进程失败时把 stderr 直接泄漏到宿主日志(reg 的 GBK 错误文本 = 乱码),v0.28.0 起每次失败探测都在漏;spawnSync 捕获进 result 由 catch 丢弃。本机实测乱码消除、探测结果不变(exec-path 层产出 `C:/Program Files/Git/bin/bash.exe`,mingw64 布局反推正确,全链仍 `source=default` 先命中,新层是后备)。

### 冒烟与真机

- 新增三组用例:①「exec-path covers Scoop layouts」(纯函数三布局 + MSYS2 不命中 + 全链 Scoop 场景 + WSL 否决);②「explicit tier is LAZY」(冻结模式防回归:断言 `const configuredBashPath = effectiveConfiguredBashPath(` 与 `const bashResolution = resolveGitBashCached(` 不得再现;懒读取器/status 实时重读/settle 通知必须存在;`rowBashPath` 三态);③「executor row lookup survives the subtree layout change」(loader 三形状:root 命中 / subtree+entries / 行缺失,空串=真实答案)。
- **顺手修掉存量失败**(0.32.1 在 win32 上 latent):「full apply() mount on a stub ctx」的 settings stub 还停在 `settings.get(ns)` 时代,readShell 自 v0.25.1 起只认 `describe()` ⇒ stub 恒 null ⇒ 轮询 12×1500ms 后断言必挂。stub 补 `describe()`,与现役读法对齐。
- 99 项全绿(96 存量 + 3 新增;toolchain PATH 用例的平台误判 v0.32.1 已修,本次全平台绿)。
- **真机验证**(隔离 `DSH_HOME`(Temp 目录)+ profile 副本 `cp -rL` 解引用 + 插件目录换本仓源码 + 探针插件采 loader 形状;全程独占 3080 —— 用户实例当时未运行,验证后实例已杀、410M 副本与探针已删净,`~/.dsh` 零触碰):默认场景 boot `resolved from the default source`、status `ok:true`;坏值/好值 A/B 见上文「修复一·续」;官方侧栏终端接管懒读路径正常(`already uses this Git Bash ... (nothing written)` 幂等);ptc 联动正常(cordis-gitbash 去重、对方注册 Git Bash rows —— capability getter 无碍);spawnSync 改造后启动日志**零乱码**。**未覆盖**:settle 轮询分支的翻转真机时序(0.2.0-rc.2 上 entries() 在 apply 时刻即稳定可读,轮询多数情况下不触发;接线由源码断言锁定,行为留待真实慢宿主检验)。

- 相关:issue #13(<https://github.com/KannaKuron/dsh-gitbash-shell/issues/13>)、issue #11(解析链的由来)、AGENTS.md §4h(顺序契约更新)。

## v0.32.1 — 2026-09-28

**类型**:chore(清掉 v0.32.0 遗留的 legacy settings 死代码)+ fix(冒烟里 mac 平台误判的 toolchain 路径用例)

- **legacy settings 面整体删除**(v0.32.0 识别的死代码,当时保守留了一手):宿主 settings 服务自 0.1.7 起只有 describe()/update()(packages/settings/settings/src/index.ts 方法面核对),没有 register(SettingsScope)也没有 get(ns) ⇒ 全部探测分支不可达。删除:① host 半的 legacy settings namespace 注册块(legacySettings 探测 + ctx.inject(['settings']) 注册 schema + scope.watch 接线);② makeLiveReader 的 era 探测(legacy 恒 false,"legacy || !hasConfig" 收敛为 !hasConfig 的等价 fallback);③ 四个 settings.get(ns) 读取器(readPosixPaths / readDialectSettings / readAdoptSidebar / readSuppressPeerCordis,生产调用全在死分支里)与 SETTINGS_NAMESPACE 常量;④ sidebarScope(唯一赋值点在死代码里)及其 polling watch 挂钩;⑤ adoptSidebarShell.readShell 的 get(ns) 死分支(describe 分支保留,0.1.7 上在用);⑥ shell.js dialectSettings() 的同款 get(ns) 分支;⑦ client 半的 settingsScope 注入段与 settings.plugin.item 旧座位(设置卡只剩 plugins.bundle.config 详情页座位)。行数:src/index.js 2549 → 约 2470 行。
- **行为不变**:所有被删分支在 >=0.1.7-rc 宿主上均不可达;每个消费点的现役路径(describe() 读取 / 行 Config volatile 读取)逐字未动。冒烟 96 项全绿,新增防复活守卫(源码不得再出现 settings.register / SETTINGS_NAMESPACE)。
- **fix(tests):toolchain PATH 扫描用例在非 Windows 平台误判**——实现永远以 Windows 反斜杠拼接(该扫描只在 win32 跑,行为正确),期望却用 process.platform 的 sep 构造,mac/Linux 上必挂。期望改为字面量反斜杠;该用例从 v0.32.0 起的既有的平台失败就此消除。
- 同步:AGENTS.md 条目 0(死代码段改为「已整体删除」)、4b(SERVICE READ RULE 更新为 makeLiveReader)、§4e/§4g/§4i 的双时代措辞收敛;验证清单与发布 checklist 更新(含 minimumReleaseAge 冷却提示)。

## v0.32.0 — 2026-09-28

**类型**:chore(宿主下限提高到 >= 0.1.7-rc:删除 0.1.6 以前的全部兼容路径,插件瘦身六分之一)

- **删除物化路径**:dsh 0.1.7 移除目录预设机制后,声明式注册(registerVariant + src/compositions.js)是唯一生效路径,物化分支在所有受支持宿主上都是死代码。整体删除:era 探测(detectBuiltInEra / baseForRoster / eraSuffix,0.1.1→0.1.2 code→ptc 改名)、persona text/split 双形态(0.1.3-alpha.2)、present 探测注入(0.1.5-alpha.2)、行形态对齐(0.1.6-alpha.1)、materialize / pickComposition / syncDecision / firstUserRoot / detectPeerCoverage(仅旧 era 调用;声明式路径的 peer 信号走 PEER_CAPABILITY inject 链)与 apply 的物化分支。src/index.js 3099 → 2549 行。
- **资产目录删除**:assets/<variant>/ 是物化专用源(声明式数据在 src/compositions.js),随路径一并删除;package.json 的 files 同步去掉 assets。
- **保留**:声明式四变体注册与 volatile 重注册、PEER_CAPABILITY 去重链(preset id 永不变,含 code-gitbash 历史名)、路径方言(POSIX 翻译/虚拟挂载/run_code 内路径)、终端工具清单、inspect-registry shim、marker 守卫的旧物化残留清理(升级路径)。
- **宿主下限**:engines.dsh 与 peer @deepseek-ai/dsh → >=0.1.7-rc。smoke 123 项 → 98 项(物化 / era / persona / present / rows 断言随实现删除);已知无关失败保留:toolchain 的 PATH 顺序用例在 macOS 上因分隔符断言失败(HEAD 既有,Windows 专用)。

## v0.31.1 — 2026-09-27

**类型**:fix(issue #12:0.29.1 在 DSH 0.1.7-rc.2 上仍解析到 profile 里的 schemastery 3.18.2,每次 shell 调用报
`TypeError: config.timeoutMs.get is not a function`)

> 报告者 **tkhs101** 的分析是准确的(根因、复现步骤、建议方向都对)。本条目按他的复现步骤逐条核对后落地。

### 结论:是「我们解析到哪一份 schemastery」的问题,不是用户的配置问题

`@deepseek-ai/schemastery` 在本插件里是 **peer**,由环境提供 —— Node 从**插件文件向上**找 `node_modules`,
在 hoisted profile 里会先撞上**被其他依赖提升到 profile 根**的旧副本(报告者机器实测:3.18.2,**没有 `volatile()`**),
而宿主 dsh 自己用的是安装目录里与 shell 包放在一起的 3.18.4(有)。

**用户什么都没做错**:hoisted 布局是 pnpm 的正常产物,旧副本被提升也是其他依赖的正常行为,不需要改任何配置。

### 影响

插件把 `pwsh-sandbox` 关掉、把 `ctx.shell` 换成 Git Bash 之后,它的 Config 因为探测不到 `volatile()`
退化成普通值,基类随即在 `.get()` 上抛错:

```
TypeError: config.timeoutMs.get is not a function
```

**每一次 shell 调用都失败**(包括 `echo hi`),等于 agent 完全没有命令行能力;而**宿主日志全绿**
(插件行加载成功),报错信息也指不到插件 —— 只能靠卸载插件来确认。卸载即恢复。

### 根因链(每层都有代码位置)

1. `src/shell.js:46` 静态 `import z from '@deepseek-ai/schemastery'` —— 自 v0.24.4 起**一字未改**,
   所以 **0.29.1 与 0.31.0 带的是同一个缺陷**(报告者不是"版本旧",升级插件修不了)。
2. Node 解析 → 插件所在 profile 的 `node_modules/@deepseek-ai/schemastery` = **3.18.2**。
3. `live(schema)` 的判据是 `typeof schema.volatile === 'function'` → 3.18.2 没有 → 返回普通 schema。
4. 宿主 dsh 0.1.7 的 `LocalBashExecutor` 把这六个字段声明为 `.volatile()`
   (`packages/shell/bash-local/src/index.ts:100-107`),并在 `assertServiceableBashConfig`(line 80)
   与 `resolve`(line 124/132)里调 `.get()`。
5. ⇒ 崩。

**v0.24.4(issue #6)的探测只在「我们碰巧解析到的那份恰好有 `volatile()`」时有效** —— 报告者指出的正是这个软肋。

### 修复

新增 **`src/schemastery.js`**:不再让解析顺序决定用哪份,而是**问宿主**。

- **`hostWantsVolatileRefs(ParentConfig)`** —— 直接调用**宿主自己**的 `SandboxBashExecutor.Config({})`,
  看 `timeoutMs` 解析成 `{ get() }` 还是普通值。这正是"这个宿主会不会调 `.get()`"的直接读数
  (0.1.7+ → `true`;≤0.1.6 → `false`),读的是**行为**,不碰任何私有 schema 结构。
- **候选顺序**:shell 包自己的解析域(权威,与执行器同源)→ 插件自身域。
- **`chooseCopy` 纯函数**(可测)的判定:
  - 宿主要 volatile 且**自己的副本能服务** → 保持自己那份(**能服务就不换**)。
  - 宿主要 volatile 而自己的副本**不能** → **重定向到 shell 包那份**(#12 的修法),并打一行日志说明取自哪里。
  - 宿主读普通值(≤0.1.6)→ 保持自己那份,**绝不**递一个它不会 `.get()` 的 ref(#12 的镜像错误)。
  - 宿主答不上来 → 保持 v0.31.0 行为(逐字段探测),**不替宿主猜**。
  - 宿主明确要而哪儿都没有 → 保留自己那份(**不改变其它行为**)但**大声说明原因**,
    不再留一个与插件看不出关系的神秘 TypeError。
- **两个消费点共用同一份缓存解析**(`src/shell.js` 的执行器 Config ↔ `src/index.js` 的行 Config 与旧时代
  settings 命名空间)—— 否则两处可能拿到不同的 schemastery,设置项与执行器就会各说各话。
- **静态 peer import 全部消除**(它会让一行加载失败静默杀掉整行 —— v0.24.3 的教训),改由
  `src/schemastery.js` 内**动态**加载。

### 验证

- `npm test` **123/123**(新增 5 项):宿主行为的三种回答(`true`/`false`/无法判定)、`hasVolatile` 的边界
  (含抛错的 getter)、`chooseCopy` 的完整矩阵(含"能服务就不换"与"顺序不决定结果")、共享加载器的
  缓存一致性、两个半都不得静态 import peer。
- **临时拓扑复现 + 修复对照**(插件域真装 `@deepseek-ai/schemastery@3.18.2`,shell 包域真装 `3.18.4`,
  且 shell 包用真的 `.volatile()` 声明 Config —— 与 issue 描述逐条对应):

  | 场景 | 修复前 v0.31.0 | 修复后 |
  |---|---|---|
  | 新宿主 + 根目录被提升的旧副本(**#12 原场景**) | `timeoutMs = 120000`、`.get` 不存在 → **DISAGREE**(即报告者的崩溃) | `timeoutMs = {}`、`.get` 是函数 → **AGREE**;日志 `schemastery taken from the shell packages instead of this plugin's own resolution (host-volatile-redirected)` |
  | 旧宿主 ≤0.1.6(读普通值) | — | 两边都是普通值 → **AGREE**(即使 shell 包那份 capable,也**没有被误用**) |

  **判据是「插件与宿主的解析结果是否一致」,不是「有没有 `.get()`」** —— 后者在旧宿主上会给出反向的错误结论
  (旧宿主拿到 ref 同样是崩)。
- **第三种组合(宿主要 volatile 而两边都没有)在现实中不可达**:宿主能正常跑,就说明它自己解析到了配套副本,
  而"shell 包域"正是宿主的域。该分支仍保留 fail-loud 日志作为防御,并由单元测试覆盖。

### 相关

- issue #12(报告者 tkhs101,含完整复现步骤与修复建议)
- issue #6 / v0.24.4:同一崩溃的**另一方向**(当时是完全没有 volatile 探测)

## v0.31.0 — 2026-09-27

**类型**:fix + feat(用户报告:点开对话里的文件链接,原生右侧栏显示「文件不存在,可能已被移动或删除」)

> 用户原话:**"dsh原生的右侧边栏不支持这种/c/ 路径? 让我们的gitbash插件能不能修复一下这个bug?"**
> 截图里 tab 标题是 `/c/Users/kanna/sandbox/dsh-remote-app/AGENTS.md`,内容区是那句 not-found。

### 结论:不是 dsh 的 bug,是本插件引入的方言在 UI 侧没有闭环

dsh **设计上只有两种路径拼写**(POSIX 与 Windows 盘符/UNC,见 `dsh-util-workspace-path` 的
`isAbsoluteWorkspacePath`);MSYS 盘根是本插件教会模型与工具的东西,**官方核心不认识它**。
修的责任因此在本插件这边 —— 而且这是本插件第一次把方言边界延伸到**浏览器 UI**。

### 根因链(逐层定位,每一层都有代码位置)

1. 右侧栏是官方包 `ui-sidebar-documentpreview`,它的失败文案按错误码 `workspace-file/not-found`
   映射(locales.ts:27,与截图逐字一致)。
2. 读文件的宿主实现在 `packages/api/workspace-files/src/index.ts`:所有路径都经
   `this.ctx.fs.resolve(path, { cwd: workspaceRoot })` / `fs.lstat(path, { cwd })`。
3. `packages/fs/fs-local/src/fsio.ts:148-150` 在 win32 上就是 **`node:path.resolve(cwd, path)`**。
4. `/c/Users/...` **不是** node 眼中的绝对路径(`isAbsolute` 只认 `C:\`、`\\server`、posix 根),
   于是它被解析成 **`<当前盘符>:\c\Users\...`** —— 一个不存在的路径 ⇒ not-found。
5. 那个 `/c/...` 是从哪来的:对话里的文件链接文本来自 **shell 输出**,而本插件让 shell 说 MSYS 方言。
   链接打开走 `ui-chat` 的 `openFile` → `fileAddressFor(sessionId, cwd, path)`
   (`packages/util/workspace-path`):它用 `cwd` 前缀判断"工作区内→转相对路径"。本机实测 session 目录名是
   `--C-Users-kanna-sandbox--`,即 **cwd 是 Windows 拼写**(`C:/Users/kanna/sandbox`),而链接文本是
   `/c/Users/kanna/sandbox/...` —— 前缀不匹配 ⇒ 原样保留绝对 MSYS 拼写 ⇒ 第 4 步必然失败。

### 改动

**宿主半(`src/index.js`)**:新增只读路由 `GET /dsh-gitbash-shell/api/pathmap`,返回
`{ platform, home, tmpDir, gitRoot, mounts }` —— 就是既有翻译层 `buildTranslateEnv()` 的同一份事实
(挂载表直接从 `GIT_MOUNTS` 生成,不另抄一份),加 `process.platform` 供客户端判断。与工具链路由同款
loopback + same-origin fence(`fenceToolRequest`;GET 只需 loopback),因为 web 服务器可能绑在 `0.0.0.0`,
而这个路由会报出账号自己的目录。

**客户端半(`src/client.js`)**:包装 `ctx.sidebarRight` 的 `openResource` 与 `openResourceIn` ——
官方文档写明**"每一种进入右侧栏的方式都是这两者之一的调用"**(对话文件链接、工具行行号引用、
文件树的每一行),所以一个包装点覆盖全部入口,**不碰任何 dsh 源码**。

- 地址语法按官方 `file-address.ts` 实现:解析 `dsh-resource://file/{session/<id>|<absolute>}/<path>`
  (逐段 `encodeURIComponent`、`:` 保留、UNC 空首段),改写后按同一编码规则重建,`?`/`#` 后缀原样保留。
- **未改变即原样转发原字符串**(不是"重建后看起来一样"),所以没有翻译过的地址绝不会被 URL 往返改动。
- 转换语义与宿主 `translateMsysPath` 逐例对齐(盘根 → `X:/`、`~` → home、`/tmp` → 用户 TEMP、
  `/dev/null` → `\\.\NUL`、`/usr` 系 → Git 根);**不实现宿主的 `$VAR` 展开** —— 对话里的路径是文本不是 shell 词。
- **门是宿主的事实,不是猜测**:`pathRescueActive()` 要求 `/api/pathmap` 已应答且 `platform === 'win32'`。
  macOS/Linux 宿主**永不**翻译(客户端的 user agent 说明不了路径属于谁的文件系统);fact 未到时也不翻译
  (退化为打补丁前的行为,而不是赌一把)。
- **可选注入**:`ctx.inject(["sidebarRight"], …)` 而非写进 `exports.inject` —— 硬注入一个本插件不拥有的服务
  会让 fiber 在缺该服务的宿主上永久 PENDING(v0.24.0 的 settingsScope 教训)。
- 包装挂在服务实例上,经 `sctx.effect` 随插件 fiber 卸载并还原原方法。

### 验证

- `npm test` **118/118 全绿**(新增 6 项):
  - 驱动**真实 bundle**(fake cordis ctx + fake `sidebarRight` 记录收到的地址)覆盖地址语法:
    盘根 / `~` / `/tmp` / `/usr` / `/etc`、absolute scope、`?line=12` 后缀、UNC 原样、非 file 地址原样、
    非法转义原样、边界不误伤(`/tmpfoo`、`/usrx`、`/Tmp`、`/ab/c`)、已是 Windows 拼写原样、相对路径原样。
  - **宿主事实门**:`platform: 'linux'` 与"fetch 未应答"两种情况下地址逐字节原样。
  - **可逆性**:disposer 还原原方法;`exports.inject` 不得含 `sidebarRight`(静态断言)。
  - **浏览器镜像与宿主翻译器逐例比对**:23 个输入跑 `_internal.translateMsysPath` 与客户端实现,结果必须相同
    —— 锁死两边语义漂移。
  - **真实文件系统实测(win32)**:用本仓库 `package.json` 造 `/c/...` 形式,断言
    `path.resolve(cwd, msys)` 指向**不存在**的路径(这就是用户看到的 not-found),而救回后的
    `C:/...` **existsSync 为真** —— bug 与修复都在真文件上量了一遍。
  - **路由实测**:驱动真实 `apply()`,断言路由注册为 `prefix`、loopback GET 返回 200 且
    `platform` 等于 `process.platform`、mounts 键序与客户端遍历序一致、非 loopback 返回 403 `not-loopback`。
- **真机验证(隔离实例,未碰用户正在运行的实例)**:把用户 web profile 复制到一个独立 `DSH_HOME`
  (Windows 上 `cp -rL` 解引用 pnpm 链接,97M → 366M,5 秒),把插件目录换成**本仓源码**,独立端口起
  `dsh web`,然后:
  - 宿主侧:`GET /dsh-gitbash-shell/api/pathmap` 实测 **HTTP 200**,返回
    `{"platform":"win32","home":"C:/Users/kanna","tmpDir":"C:/Users/kanna/AppData/Local/Temp",
    "gitRoot":"c:/program files/git","mounts":{…7 项,键序与客户端遍历序一致}}`
    —— 启动日志出现 `MSYS path map route active at /dsh-gitbash-shell/api/pathmap`。
  - 客户端侧:首页 `window.__DSH_BOOT__` 里 `dsh-gitbash-shell` 出现 5 次(启动图含本插件);
    `curl` 它实际会取的 combo URL(`/plugins/??dsh-gitbash-shell/client.js&rev=…`)返回 **200**,
    内容含完整新代码段且**语法有效**。
  - **真实浏览器(CDP 驱动 driver 自己的隔离 Chromium,不动用户的浏览器)控制台实测出现**
    `[gitbash-shell/client] right-sidebar path rescue armed (host spelling restored on open)`
    —— 这一行在 `ctx.inject(["sidebarRight"], …)` 的回调内部,所以它同时证明:client 半在真实浏览器
    里 apply、**`sidebarRight` 客户端服务可见、inject 回调被调用、`openResource` 是函数且已被包装**。
  - 宿主日志随后出现 `path map read by <loopback>` —— **浏览器真的拉到了那份宿主事实**,
    即 `pathRescueActive()` 在生产链路里会返回 true。
  - 路由新增一行访问日志(`path map read by <addr>`),既是诊断手段,也是上面这条验证的观测点。
- **仍未覆盖**:真实 UI 里"点击 `/c/...` 链接 → tab 显示出文件内容"这最后一跳(需要先构造一个带
  MSYS 路径的会话)。这一跳的两端都被验证过 —— 地址重写(单元矩阵)与宿主可读性(真实文件
  `existsSync`);用户在重启客户端后即可实测确认。

### 已知边界(如实记录)

- 只有"整体就是一条路径"的链接能被救:`/c/Users/x` 成立;而 shell 输出里**被文本截断/拼接**的路径、
  以及 `/c` 之外的 MSYS 虚拟根(若宿主探测不到 Git 根,tmpDir/gitRoot 为 null)保持原样 ——
  退化行为与修复前一致,**不会**产生错误路径。
- `/dev/null` 这类设备路径即使被点开也没有可读内容(与文件工具一致,EINVAL 如实报错)。

## v0.30.1 — 2026-09-26

**类型**:fix(用户实测反馈 v0.30.0 的工具列表:点了按钮看不到进度、看不到在装哪一个、看不到报错、还能连点)

> 用户原话:**"我这点击升级了都不知道进度,有没有在升级,也看不到报错,你优化一下,可能看到目前按安装还是更新那个,进度条什么的放在那个列表里。然后不让我连点,开始了就不用再点。"**

### 根因(两个都是真缺陷,不是用法问题)

1. **busy 的生命周期错了**:`runTools()` 在 POST 收到 202 时就 `setToolBusy(false)`,而任务在**宿主侧继续跑**
   —— 于是按钮在批次刚开始时就恢复可点。这正是"能连点"的来源:后端的单任务闸门确实会返回 409,
   但用户看到的是一个**亮着的按钮**,自然会再点。
2. **进度放在了一个没人看的地方**:进度只渲染在按钮下方的一块区域,**不在工具列表行内**;
   每行也不显示自己的状态,失败原因混在一个游离的结果列表里,既不显眼也不对应行。

### 改动(`src/client.js`)

- **busy 从「请求在飞」改为「任务在跑」**:新增派生状态 `jobRunning = toolJob && toolJob.finished !== true`
  与 `busyNow = toolBusy || jobRunning`;安装 / 刷新 / 全选三个按钮与**所有复选框**在整个批次期间禁用,
  主按钮文案变为「处理中」。开始之后不必也**不能**再点。
- **进度搬进列表行**:正在处理的那一行高亮,行内依次显示 spinner + **「安装中…」/「更新中…」**
  (按该行 `state` 判断是装还是升,不靠猜)+ 一条扫动进度条;已完成的行保留 ✓/✗ 判定。
- **错误就地可见**:失败的行**正下方**用红字打印「安装中 — 失败: <winget 原文>」,不用再去别处找日志。
- **整体进度**:任务运行时显示 spinner + `当前工具 · 处理中: n / m` + 按完成数计算的进度条(宽度随 done/total 增长)。
- 移除原先那个游离的结果列表 —— 信息已全部进入对应行。
- 新增样式:行高亮、运行态徽章、行内扫动条、整体进度条、失败行、spinner,以及 `gb-spin` / `gb-slide` 两条 keyframes。
- 词典 **21 语言各补 2 键**(`tools.installing` / `tools.updating`),现共 **65 键**,键对齐由冒烟强制。

### 验证

- `npm test` **112/112 全绿**(词典键对齐断言覆盖新键)。
- 静态校验:65 个词典键**全部**被代码引用,零悬空引用。
- ⚠️ 仍未做:浏览器端真机点击验证(需重启客户端后自测)。
- 版本号 `0.30.0` → **`0.30.1`**。

### 附:一次误操作与回滚(如实记录)

本次最初**误把第三方插件 `dshmarket` 当成了目标**,对
`~/.dsh/profiles/desktop/node_modules/dshmarket/client/client.js` 打了一处本地补丁(让自我更新时
dshmarket 自己出现在「已安装」列表里,以显示行内进度)。用户澄清后**已完整回滚**:
与 npm 上的 `dshmarket@1.66.2` 逐字节 `cmp` 一致,零残留。
(该补丁对应的确实是一个真实缺陷 —— 自我更新按钮 `onClick` 会 `setTab("installed")` 想看进度,
但列表又 `filter` 掉了 `selfName` —— 留作后续,未在本仓库处理。)

## v0.30.0 — 2026-09-26

**类型**:feat(新能力 —— 设置卡里一键安装/升级一份**固定的终端工具清单**,全部经 winget 官方源)

> 用户需求原话:**"所有缺的工具,能不能在插件的设置里增加一个按钮,可以选择自己一次性安装升级到最新,用winget,或者可以自定义选择一部分安装升级"**
> 追加的硬要求:**"绝对要保证是下载的正确的源,你这些工具id都要查清楚"**
> 以及**"只要人家已经有了已经安装过了就不需要安装"** / **"有的人的电脑可能安装过llvm 之类的…这种情况下我们不需要帮忙winget安装,要跳过,也不帮忙升级"**。

### 清单(`src/toolchain.js`,22 项,闭合集合)

- **基础补全(4)**:`make`(ezwinports.make)、`wget`(JernejSimoncic.Wget)、`yq`(MikeFarah.yq)、`xtree`(Excelano.xtree,现代 tree 替代)。
- **现代 CLI(13)**:bat、fzf、delta、zoxide、dust、procs、xh、just、shellcheck、hexyl、tldr、jj、gdu。
- **纳入版本管理(3)**:jq、ripgrep、fd(本机已有,交给插件统一升级)。
- **需要管理员(2)**:7-Zip、经典 tree —— manifest 写 `Scope: machine`,winget 必须提权,会弹 UAC。
- 每项自带 `publisher` + 安装器域名(`source`),**卡片上渲染出来**,让来源可核对而不是口头保证。

### 源核实(逐包查证,三重证据)

- **源**:全部来自 `winget` 官方源(`cdn.winget.microsoft.com/cache`),本机未添加任何第三方源;`--source winget` 写死在 argv 里,msstore 与第三方源永不参与。
- **定义**:22 个包的 manifest 全部在 **microsoft/winget-pkgs** 官方仓库,逐个读取核对(发布者字段与真实项目作者一致:sharkdp→David Peter、BurntSushi、Casey Rodarmor、Vidar Holen…)。
- **完整性**:22/22 均有 `InstallerSha256`,winget 安装时强制校验;18 个安装器指向 `github.com/<官方项目>/releases`,其余指向官方站
  (ezwinports→sourceforge、7-Zip→www.7-zip.org、wget→eternallybored.org —— 后者是 GNU wget 官方认可的 Windows 构建站)。

### 实测发现(全部真机复现,并已固化为冒烟断言)

1. **同一个工具存在多个 winget 包 ID**:本机装的 ripgrep 是 **`BurntSushi.ripgrep.GNU`**,而 MSVC 构建是**另一个包**。只认一个 ID 会导致"再装一份"。
   ⇒ 清单支持 `ids[]` 变体:**识别**用任一变体,**升级**用 `winget export` 报出的**实际那个**,只有全新安装才用首选。
2. **已装 ≠ 命令在 PATH**:本机 7-Zip 由 winget 装好,但 MSI 没有把目录加进 PATH,`7z` 命令根本不存在。按"命令是否存在"判断会把它当缺失并重复安装。
   ⇒ 判定**以 winget 自己的库存为准**(`winget export` 的 JSON),命令存在性只用来识别"外部提供"。
3. **两个"无事可做"的退出码都是非零,其中一个曾被误判**:实测 `winget upgrade` 对已最新的包返回 `0x8A15002B`("找不到可用的升级"),对未安装的包返回 `0x8A150014`。
   Node 收到的是**完整 HRESULT**(Git Bash 里只显示低位 20)。初版把 `0x8A15002B` 错归为"需要管理员",会让**每台健康的机器在升级轮里误报失败** ——
   现按**码结构化判定**(辅以 21 语言文案兜底),并把两条断言锁进冒烟。`0x8A150014`(低位 0x14)与 `0x8A15002B`(低位 0x2B)不会互相误伤。
4. **"外部提供"必须只读**:本机 `fd` 来自 kimi-code(`~/.kimi-code/bin`)、`tree` 来自 Windows 自带的 `C:\WINDOWS\system32\tree.com` ——
   两者都判为 `external`:**不安装、不升级、复选框不可勾**,只显示来源。LLVM/WinLibs 提供的工具链同理,永远不会被本插件动到。
5. **只读探测也能拿到权威清单**:`winget export -o <file> --include-versions` 输出 **JSON**(`list` 的表格是本地化的、宽 ID 会被截断),
   是本插件唯一采信的库存来源;传给它的必须是 **Windows 路径**(原生程序不认 MSYS 的 `/tmp/...`)。

### 安全边界

- **路由有副作用 ⇒ 有围栏**:`/dsh-gitbash-shell/api/tools` 只接受 **loopback** 调用,且**改动类请求必须带同源 `Origin`/`Referer`**;
  用户只是访问过的网页因此无法让他的机器装软件(跨站请求在 origin 检查处被拒)。
- **请求只能命名清单内的条目**:请求体里的 id 先映射到 `src/toolchain.js` 的闭合集合,未知 id 直接丢弃;`install`/`upgrade` 的 argv 一律带
  **`--exact` + `--source winget`**,并且只由服务端拼装(`execFile` + argv 数组,永不拼 shell 字符串)。
- **无自由文本包 ID 输入框**(用户明确选择"固定清单就好"),所以不存在"用户填错 ID 装错包"的路径。
- 一次只跑一个 job(并发安装正是"半个清单已应用"的来源);进度经 `?job=1` 轻量轮询,不重复跑三个 winget 命令。

### 验证

- `npm test`:**102 → 112 全绿**。新增 10 个用例覆盖:清单结构与来源字段齐备、argv 三重锁定、变体 ID 的安装/升级取向、PATH 扫描(首个命中优先/坏目录不致命)、
  四态状态机(`missing`/`external`/`managed`/`current`,含"winget 有而命令不在 PATH"、"外部提供即使有命令也不可动")、export JSON 只认 winget 源、
  两个实测退出码的分类、CSRF 围栏五态、请求 ID 闭合性、`auto` 模式的装/升分流、路由接线守卫。
- **真机读数**(本机):22 项判定为 `missing 16 / current 4 / external 2`,其中 `rg` 正确识别为 `BurntSushi.ripgrep.GNU 15.2.0`、`7z` 识别为 `7zip.7zip 26.03`(命令不在 PATH 也判对)、
  `fd`/`tree` 如实标为外部提供。
- ⚠️ **尚未做**:设置卡 UI 的浏览器端真机点击验证(需重启 DSH 或起隔离实例);本次未替用户重启其运行中的实例。
- 版本号 `0.29.2` → **`0.30.0`**(`package.json` 与 `dsh.plugin.json` 一致)。
- 顺带修复:本仓库此前**从未跑过 `npm install`**(无 `node_modules`),导致 peer 依赖 `@deepseek-ai/schemastery` 不可解析、`Config` 导出缺失而有一条测试恒失败;
  已补装 devDependencies 并生成 `package-lock.json`。

## v0.29.2 — 2026-09-26

**类型**:docs(纯文档 patch —— 更正复验判据:原先写成 `uname -r`,实为 `uname -s`;无任何代码/行为变更)

> 用户在 Windows 上按 README 的"三步复验清单"跑 `uname -r`,得到 `3.6.9-b4195d69.x86_64` —— 按我们文档里写的判据
> ("应出现 `MINGW64_NT-…`")会被**误判为失败**,实际它就是 Git Bash。事实:`MINGW64_NT-10.0-<build>` 是 **`uname -s`**
> (system name)的输出;**`uname -r`**(release)在 Git Bash / MSYS2 下是 **MSYS 运行时版本**(形如 `3.6.9-<hash>.x86_64`),
> 而 **WSL 的 `uname -r`** 才是 `6.x.y.z-microsoft-standard-WSL2`。两个都不能单独用来判定。

- **README.md 三步复验第 ② 条**:判据改为 **`uname -s` ⇒ `MINGW64_NT-10.0-<build>`**(最硬)或 **`echo $MSYSTEM` ⇒ `MINGW64`**(最简),
  并补一句"⚠️ 不要用 `uname -r` 判定"(附上两种 `uname -r` 的真实形态)。
- **README_EN.md**:原文没有侧栏终端一节(英文 README 尚未跟进 v0.29.x),本次补上该节并把**同样更正过的**三步复验清单写进去,
  使中英两处判据一致。
- **AGENTS.md 验证清单第 10 条**:同一处错判据更正为 `uname -s`/`$MSYSTEM`,并写明为什么 `uname -r` 不能单独用;
  同时明确**代码里的"一票否决"用的是 `bash -c "uname -s"`(`MINGW(32|64)_NT-*`),那一直是对的,未改动**。
- **历史条目加指路**:v0.29.0 条目里留下的 `uname -r` 判据加"(判据有误,见 v0.29.2 更正)",不改写历史叙事。
- **grep 复核**:全仓 `uname -r` 仅出现在 CHANGELOG 的历史条目(已加指路);`src/` 里只有 `uname -s`(`src/bash-path.js`
  的一票否决与 `src/terminal-shell.js` 的注释),设置卡 21 语言文案与启动日志均未使用该判据。
- 版本号 `0.29.1` → **`0.29.2`**(`package.json` 与 `dsh.plugin.json` 一致);`npm test` 101→102 全绿不受影响(纯文档)。

## v0.29.1 — 2026-09-26

**类型**:fix(用户实测:官方「新建终端」下拉里出现**两条 `bash`** —— 一条是 v0.29.0 写入的 Git Bash,另一条是官方 `shellCandidates` 解析到的 WSL,用户分不清)

> 用户原话:**"改一下,新增的gitbash显示名称得是gitbash,不然回合wsl的混了,你反正自动检查说gitbash的给改名为gitbash,别叫bash"**
> (现象:v0.29.0 写 `name: 'bash'`;官方 `shellCandidates` 那条 `bash` 在 PATH 命中 `C:\Windows\System32\bash.exe` 的机器上解析到 WSL)

- **显示名改为 `Git Bash`**(`TERMINAL_SHELL_NAME`):`name` 只是 `TerminalShell.name` 这个**用户可见 profile 名**,解析与执行看 `path`/`args`
  ⇒ 改它**不改变任何行为**,只让菜单里两项可区分;`args: ['-i']` 保留(官方 `profile()` 对 bash 的默认)。
- **只迁移我们自己写的旧默认名**:`name` 恰为 `'bash'`(v0.29.0 的默认值)⇒ 新增 `rename` 动作,**只改 `name`**
  (path/args 原样保留),同样**写回后读回校验**(路径与名字都对才成功),不符 ⇒ `write-failed` + fail-loud;
  迁移后**再跑一次仍 `unchanged`**(幂等,patch md5 不变)。
- **用户自起的名字绝不动(验收收窄,Lead 裁决)**:path 是我们的 Git Bash 但 `name` 是别的(`My Bash`/`Git`/空)
  ⇒ 新状态 **`kept-user-name`,零写入**——用户显式起的名就是用户选择,而且自定义名本来也不会与 WSL 候选混淆。
- **异值仍绝不覆盖**:path 指向别处(例如 WSL)⇒ 维持 `kept-user-choice`,只记日志。**`shellCandidates` 不动**
  (与用户确认过的口径:改名即可区分;那条 WSL 候选仍会出现在菜单里,被区分开的是名字)。
- 文案:README 的写入形状示例与 AGENTS §4i 同步为 `name: 'Git Bash'`;21 语言卡片文案无需改动(未提名字)。
- **验证**:`npm test` **102/102**(新增「历史 `bash` 标签迁移 + 迁移后幂等 + 名字没落盘 ⇒ `write-failed [name mismatch]`」
  与「用户自起名字 ⇒ `kept-user-name`、零写入、patch 不变(含 `My Bash`/`Git`/空名三态)」,
  并把既有断言从 `name: 'bash'` 更新为 `name: 'Git Bash'`);`align-official` 四变体仍逐字节对齐。
  真机(隔离 DSH_HOME + 副本强制 win32 门 + 伪装已解析 Git Bash):新建写入 ⇒ `--dump-config` 读出
  `terminal-controller.config.shell.name = Git Bash`;预置历史 `name: bash` 的 patch ⇒ 日志 `renamed to "Git Bash"` 且
  **只改这一行 name**、用户手写行与注释原样保留;二次启动 ⇒ patch **md5 未变**。
- **未在 Windows 验证**:菜单里实际显示成 `Git Bash`(需用户复验;本次只验证到配置层的 `name` 与迁移行为)。

## v0.29.0 — 2026-09-26

**类型**:feat(用户实测需求 —— DSH 原生「新建终端」落到 **WSL**,插件只接管了 agent 的 shell 工具,没有接管官方侧栏终端)

> 用户原话:**"能不能让我的gitbash插件自动检测是不是没这个,然后帮忙补上一个 gitbash可以用,反正就自动的。"**
> 现象证据(用户自备):PATH 里 `bash` 只命中 `C:\WINDOWS\system32\bash.EXE`(Microsoft Bash Launcher)与
> `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.EXE`,跑起来 `WSL_DISTRO_NAME=Ubuntu-20.04`;`C:\Program Files\Git\cmd`
> 虽在 PATH 但没有 `bash.exe`。本插件旧有的 `adoptSidebarShell` 写的是 **dsh-better-sidebar** 的命名空间,用户装的是
> dsh-better-workspace,那条通道被 skip。

### 一、调研结论(全部实测,装置见下)
1. **官方 settings 服务写不了 `terminal.shell`** —— 任务书设想的"正路"在当前 dsh 0.1.7-rc.2 上**不存在**:
   `SettingsService.write()` 要求写入路径必须是 **volatile** 字段(`volatileForm(schema)` 为 `undefined` ⇒
   `Plugin entry "…" has no volatile fields`),而 `TerminalController.Config` 的 `shell` 是普通字段;
   隔离实例探针实测 `settings.update('terminal', {shell})` 直接抛
   `No configurable plugin entry "terminal"`(`describe()` 里也没有 `terminal` 这一行)。
2. **可行且官方的通道是 `configEditor.edit()`** —— 官方设置 UI 持久化时用的同一个 API(注释:
   "ordinary fields keep normal lifecycle rules")。探针写入后,**运行中的** `ctx.terminalController.config.shell`
   立刻读到新值 ⇒ **无需重启**;落盘到 profile 的 patch 层,由官方 YAML 编辑器**保留文件头注释**、按 `id` 合并该行。
3. **`args: ['-i']` 有官方依据**:`shells.ts` 的 `profile()` 对非 cmd/pwsh 的 shell 一律给 `['-i']` —— 我们与官方一致,不是自创。
4. **配置的 shell 恒排首位**(`discoverShells()` 先 `resolveShell(configured)` 再解析 candidates,按 path 去重),
   所以只需配 `shell`,**不动 `shellCandidates`**。另注意:菜单里仍可能出现一条候选 `bash`(在那些机器上解析到 WSL);
   默认项是我们写入的 Git Bash。
5. **写错路径会直接把「新建终端」弄坏**:`resolveShell` 用 `subprocess.resolveExecutable()` 验证配置路径,
   失败即抛 `SubprocessExecutableNotFoundError`,**没有回退** ⇒ 只允许写 `src/bash-path.js` 已通过四项判据的 Git Bash。

### 二、实现
- 新模块 `src/terminal-shell.js`:纯决策 `planTerminalAdopt()` + 执行器 `adoptTerminalShell()`,六态
  `skip-platform` / `skip-disabled` / `skip-unresolved` / `skip-row-absent` / `unchanged` / `kept-user-choice` / `adopted` / `write-failed`。
- **只写"空"的**:该行没有自己的 shell ⇒ 写 `{path: <Git Bash>, name: 'bash', args: ['-i']}`;已是同一个(大小写/分隔符无关)⇒ 不写;
  已指向别处 ⇒ **绝不覆盖**,日志说明"这是你的显式选择"以及如何交还给 Git Bash。
- **写入后读回校验**(`configuration()` 的 `override`/`inherited`):`edit()` resolve 不等于值落进去了,不符 ⇒ `write-failed` 并 fail-loud
  (延续 v0.28.0 的"绝不假成功")。
- 新开关 `autoTerminalShell`(volatile,**默认开**;旧宿主 settings 命名空间同名字段,缺键 = 开)+ 21 语言卡片文案
  (`term.label`/`term.hint`);保留原 `dsh-better-sidebar` 通道(两条通道各自独立探测);不碰官方包、不手写用户 patch 文件。
- README 新增该节 + **用户三步复验清单**(开关与日志 → 终端里 `uname -r` 判 `MINGW64_NT-*` → 回退办法)。
  **(判据有误,见 v0.29.2 更正:Git Bash 的 `uname -r` 是 MSYS 运行时版本,应看 `uname -s` / `$MSYSTEM`。)**
  **回退语义写明**:关掉开关**只阻止以后的自动写入**,**不会**删除已经写进配置的 `shell` 字段;要彻底恢复原样需删掉
  profile patch 里 `terminal-controller` 行的 `shell` 字段并重启(21 语言卡片 hint 同步写上这一句)。
  **菜单如实说明**:未改 `shellCandidates` ⇒ 选择菜单里**仍可能列出**解析到 WSL 的候选 `bash`,被改的是**默认项/首项**。

### 三、验证
- `npm test` **99/99**(新增 5 条:空→写且形状为官方 `profile()` 约定 + 无关字段保留 / 同值→不写 + 异值→不写且日志含怎么交还 / 开关关·非 Windows·未解析·无该行→全只读 / 写入被拒或**未落盘**→ `write-failed` 不假成功 / 宿主侧只走 `configEditor` 且绝不调用 `settings.update('terminal')`);`align-official.mjs` 四变体仍逐字节对齐。
- **隔离实例真机(macOS,副本强制 win32 门 + 伪装已解析 Git Bash)**:
  - 空值 ⇒ 日志 `switched to Git Bash: Q:/Git/bin/bash.exe (name bash, args -i) …`;
    profile patch 里用户手写行与注释**原样保留**、新增 `- id: terminal-controller … shell {path,name,args}`;
    `--dump-config` 读到 `terminal-controller.config.shell.path = Q:/Git/bin/bash.exe`;
  - 第二次启动 ⇒ `already uses this Git Bash … (nothing written)`,patch **md5 未变**(幂等);
  - 用户显式指向 `C:/Windows/System32/bash.exe` ⇒ `NOT adopted … an explicit choice is never overwritten`,patch **未变**;
  - `autoTerminalShell: false` ⇒ `adoption is off …`,patch **未变**;
  - 无头浏览器零 pageerror。
- **未在 Windows 验证**:真实 PATH/注册表命中、菜单里 shell 项、新终端里 `uname -r` 是否 `MINGW64_NT-*`(判据有误,见 v0.29.2);
  设置卡新增开关行的截图级渲染(该行复用既有开关写法,21 语言键由冒烟 parity 覆盖)。需用户按 README 三步复验。
- 相关:issue #11 后续(同一用户的 Windows 实测反馈)

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
