/**
 * dsh-gitbash-shell — browser half (hand-written ModuleLoader bundle).
 *
 * ONE job: the Settings → Plugins card that gates the unified POSIX path
 * dialect. The Plugins tab dispatches the intersection of Host-served
 * namespaces and registered cards, so the card appears only when the host
 * half (src/index.js) has registered the 'gitbash-shell' settings namespace.
 *
 * The card flips one boolean — posixPaths — through a bound settingsScope:
 *   on  → the host injects the order-126 directive (every tool takes MSYS
 *         drive roots /c/...) and the tools/execute wrapper translates
 *         path-argument fields (/x/ → X:/) for the Node-backed file tools;
 *   off → directive text is empty (dropped at assembly, zero prompt noise)
 *         and the wrapper passes calls through untouched (dsh-native).
 * Bash itself is always Git Bash while the plugin is installed; the switch
 * only governs the cross-tool path dialect.
 *
 * Hand-written bundle rules (no build step in this repo):
 *   - ONE window.__ModuleLoader__.load({...}) call, id = package name;
 *   - require restricted to the client-module BASELINE whitelist
 *     (react and @deepseek-ai/dsh-client-ui-primitives only, smoke-enforced);
 *   - plain React.createElement, no JSX/TS; components at module level;
 *   - dsh.client.inject in package.json lists the packages that must load
 *     first so locale / settingsScope / slots exist when this applies;
 *   - copy ships in three layers: zh/en inline, one LOCALES entry per third
 *     language (each preceded by a locale marker line), every dictionary
 *     key-aligned with zh (smoke-enforced) and read through a live lookup —
 *     DSH's language preference switches without a page reload.
 */
window.__ModuleLoader__.load({
	id: "dsh-gitbash-shell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var ui = require("@deepseek-ai/dsh-client-ui-primitives");

		var E = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;

		var TAG = "[gitbash-shell/client]";
		/** Dictionary namespace (the plugin's own t seat). */
		var NS = "gitbashShell";
		/** The settings namespace the HOST half serves. */
		var SETTINGS_NAMESPACE = "gitbash-shell";
		/** The PEER row this card mirrors: dsh-ptc-cordis-preset's own entry. Only
		   its existence is read here — the switch value itself lives on THIS
		   plugin's row (the single authoritative copy the peer card binds too) —
		   and the section is drawn only while that entry is actually served. */
		var PEER_NS = "ptc-cordis";
		/** The peer's authoritative experimental-CPython field on that SAME row:
		   both cards read and write this one form field, so either side changes
		   both. Absent on a peer that predates the switch ⇒ no row is drawn. */
		var PEER_PYTHON_FIELD = "pythonRuntime";
		/** The peer's EFFECTIVE backend on the same snapshot ('python' | 'node'),
		   when its version reports one: 'node' while the intent is on means the
		   preflight failed (package missing / interpreter too old / Windows), so
		   the card shows the degraded state instead of claiming Python. */
		var PEER_PYTHON_BACKEND_FIELD = "pythonBackend";

		// ── dictionaries ────────────────────────────────────────────────────────
		// zh/en stay inline; the third languages live in LOCALES below, one entry
		// per language behind a locale marker line. EVERY shipped dictionary MUST
		// carry zh's exact key set: a missing key falls back to English at lookup
		// time, which reads as a half-translated card (smoke-enforced).

		var zh = {
			"title": "Git Bash 路径方言",
			"cardDesc": "所有工具统一 /c/ POSIX 路径形式(默认开启)",
			"state.label": "当前状态",
			"state.on": "已启用",
			"state.off": "已关闭",
			"switch.on": "启用",
			"switch.off": "停用",
			"error": "写入失败",
			"hint": "启用后:所有工具(bash 命令与 workdir、read/write/edit/read_image/glob/grep 与 present 的路径参数)统一使用 MSYS 盘根 POSIX 路径(/c/Users/...);bash 的原生习惯——~ 家目录、/tmp 临时目录、/dev/null、/usr 等——在所有工具中同样有效(与 Git Bash 挂载表一致),路径参数由宿主自动翻译,模型无感。停用后恢复 dsh 原生行为(文件工具用 Windows 路径)。bash 始终是 Git Bash,不受此开关影响。",
			"sec.dialect": "路径方言",
			"sec.terminal": "侧栏终端",
			"mnts.label": "虚拟路径挂载",
			"mnts.hint": "bash 的原生路径习惯——~ 家目录、/tmp、/usr 等——按 Git Bash 挂载表在所有工具解析;关闭则仅 /c/ 盘根形式。",
			"errs.label": "报错路径翻译",
			"errs.hint": "文件工具与 run_code 报错里的 Windows 路径翻回 /c/ 形式(含程序里捕获到的错误消息)并附设备路径引导;关闭则保留原文(便于排障复制)。",
			"split.label": "glob 绝对路径拆分",
			"split.hint": "glob 的绝对 pattern(/c/.../*.md)自动拆为 path + 相对 pattern;关闭则原样传递。",
			"code.label": "run_code 程序内路径",
			"code.hint": "run_code 程序里写的 /c/... 等路径字面量在执行前按同一张挂载表翻译;注释、插值模板、$VAR 与非路径字符串不动,扫描有任何不确定就整份不改。 并给程序补 TEMP/TMP:空 env 下 Windows 的 os.tmpdir() 会得到 undefined\\temp,程序会静默写错地方。",
			"bashmiss.title": "找不到 Git Bash —— 命令无法执行",
			"bashmiss.body": "本插件只用 Git for Windows 自带的 bash(不接受 WSL、MSYS2、Cygwin 的 bash),也不会回退到 PowerShell/cmd —— 所以这里只报错,不偷偷换一个能跑的顶上。请在下面填写 bash.exe 的完整路径,或先安装 Git for Windows。",
			"bashmiss.tried": "按顺序探测过这些位置(都被拒绝):",
			"bashmiss.download": "去下载 Git for Windows",
			"bashmiss.where": "也可以稍后到「设置 → 插件 → dsh-gitbash-shell」的「Git Bash 路径」里填写;host 启动日志里有同一份探测清单。",
			"bashmiss.close": "关闭",
			"sub.label": "子代理/队员使用 Git Bash",
			"sub.hint": "默认开启:子代理与团队队员(含嵌套子代理)的提示词方言、路径参数翻译、结果回显与 DSH_PATH_DIALECT 环境事实与主代理一致。关闭后这些只对主代理生效,子代理按官方 shell 语义运行(提示词不改写、路径参数不翻译);注意 dsh 每个进程只有一个 shell 执行器,所以 Git Bash 二进制本身仍是全局的,此开关管的是方言/翻译层。",
			"term.label": "自动接管侧栏终端",
			"term.hint": "默认开启:Windows 上把官方「新建终端」的 shell 自动设成探测到的 Git Bash(写进官方 terminal-controller 行的配置,由官方配置编辑器落盘)——没有这一项时,dsh 会按环境默认 shell 启动终端,而 PATH 里的 bash 常常是 WSL 启动器,于是新终端跑的是 Ubuntu。只在该行**没有**自己的 shell 时才写;你已经手动指定过别的 shell 就绝不覆盖,只会在宿主日志里提示。新终端立即生效,已打开的终端保持原样。",
			"eol.label": "Git 行尾(与 Linux 一致)",
			"eol.hint": "模型跑的 git 命令按 Linux 行为:core.autocrlf=input、core.eol=lf。你自己终端的 git 与仓库里的 .gitattributes 都不受影响。",
			"bash.label": "Git Bash 路径",
			"bash.hint": "自定义 bash.exe 完整路径,用于 /usr 等挂载的 Git 根解析;留空自动探测默认安装与 PATH。",
			"bash.saveFailed": "保存未生效:宿主拒绝了这次写入 —— 确认路径存在且是 Git for Windows 的 bash,或查看宿主日志",
			"bash.save": "保存",
			"bash.saved": "已保存",
			"adopt.label": "接管侧栏终端",
			"adopt.hint": "开启时把 dsh-better-sidebar 的终端 shell 写成 Git Bash(默认开启);关闭后恢复接管前的值,已手动改过的终端设置不会被碰。模型侧的 bash 工具不受此开关影响——那由插件本体提供。",
			"sec.dedupe": "与 PTC 创造模式去重",
			"dedupe.label": "「创造模式 · Git Bash」重复项",
			"dedupe.hint": "dsh-ptc-cordis-preset 同装时,它的「PTC 创造模式」在联动下已是 Git Bash 版,与本插件的「创造模式 · Git Bash」指向同一件事。开启去重后本插件不再注册那一条(名录少一项);默认关闭,保持四个变体不变。此开关就是对方设置卡上的同一个开关——两侧共享同一份状态,任一侧改动另一侧立即同步。仅在已安装 dsh-ptc-cordis-preset 时显示。",
			"sec.python": "run_code 后端(实验性 Python)",
			"python.label": "run_code 后端",
			"python.on": "Python(实验性)",
			"python.off": "Node / TypeScript(默认)",
			"python.hint": "默认关闭时 run_code 用官方 Node/TypeScript 后端,与官方 ptc 组合逐字节一致;开启后改用 dsh 实验性 CPython 后端(@deepseek-ai/dsh-experimental-ptc-runtime-python),run_code 的语言、生成的 SDK 提示词与工具呈现随之切到 Python。要求 POSIX 平台与 CPython ≥ 3.10(Windows 不可用);与 workflow 工具互斥——官方 Python 组合同样禁用 workflow,因此开启期间本插件四个变体的 workflow 侧强制关闭(你的工作流设置值保留,关掉后恢复)。改动需重启 dsh 后生效;此开关就是 dsh-ptc-cordis-preset 设置卡上的同一个开关——两侧共享同一份状态,任一侧改动两侧同步。仅在已安装 dsh-ptc-cordis-preset 时显示。若置为开启后未生效,原因见宿主启动日志。",
			"python.degraded": "后端不可用,当前仍为 Node(原因见宿主启动日志)",
			"python.blocked": "本机是 Windows:实验性 Python 后端仅支持 POSIX,此开关不可用。",
		};

		var en = {
			"title": "Git Bash path dialect",
			"cardDesc": "One /c/ POSIX path style for every tool (on by default)",
			"state.label": "Current state",
			"state.on": "Enabled",
			"state.off": "Disabled",
			"switch.on": "Enable",
			"switch.off": "Disable",
			"error": "write failed",
			"hint": "Enabled: every tool (bash commands and workdir, read/write/edit/read_image/glob/grep and present path arguments) uses MSYS drive-root POSIX paths (/c/Users/...); bash-native habits — the ~ home shorthand, /tmp, /dev/null, /usr — resolve in every tool exactly as bash itself resolves them, and the host translates the path fields automatically. Disabled restores dsh-native behavior (Windows paths for file tools). Bash is always Git Bash while the plugin is installed; this switch only governs the cross-tool path dialect.",
			"sec.dialect": "Path dialect",
			"sec.terminal": "Sidebar terminal",
			"mnts.label": "Virtual path mounts",
			"mnts.hint": "Bash-native habits — ~ home, /tmp, /usr — resolve through the Git Bash mount table in every tool; off = /c/ drive roots only.",
			"errs.label": "Error-path translation",
			"errs.hint": "Windows paths in file-tool and run_code failures rewrite back to /c/ — including the message a run_code program catches — with NUL guidance; off keeps raw text (easier to copy while debugging).",
			"split.label": "Glob absolute-pattern split",
			"split.hint": "An absolute glob pattern (/c/.../*.md) splits into path + relative pattern; off passes it through verbatim.",
			"code.label": "run_code program paths",
			"code.hint": "Path literals inside a run_code program are translated through the same mount table before it runs; comments, interpolated templates, $VARs and non-path strings stay untouched, and any uncertainty leaves the whole program as written. It also seeds TEMP/TMP for the program: with an empty env Windows' os.tmpdir() returns undefined\\temp and writes land in a bogus folder.",
			"bashmiss.title": "Git Bash not found — commands cannot run",
			"bashmiss.body": "This plugin only accepts the bash shipped with Git for Windows (WSL, MSYS2 and Cygwin bash are refused) and never falls back to PowerShell/cmd — so it reports the failure instead of quietly swapping in something runnable. Enter the full path to bash.exe below, or install Git for Windows first.",
			"bashmiss.tried": "Probed these locations in order (all rejected):",
			"bashmiss.download": "Download Git for Windows",
			"bashmiss.where": "You can also fill this in later under Settings → Plugins → dsh-gitbash-shell → “Git Bash path”; the host startup log carries the same probe list.",
			"bashmiss.close": "Close",
			"sub.label": "Subagents/teammates use Git Bash",
			"sub.hint": "On (default): subagents and team members — nested ones included — get the same prompt dialect, path-argument translation, result echo and DSH_PATH_DIALECT fact as the main agent. Off: those apply to the main agent only, and delegated agents run with the official shell semantics (no prompt rewrite, no path translation). Note that dsh has exactly one shell executor per process, so the Git Bash binary stays global; this switch governs the dialect/translation layers.",
			"term.label": "Adopt the sidebar terminal",
			"term.hint": "On by default: on Windows the official “new terminal” shell is set to the detected Git Bash (written into the official terminal-controller row through the official config editor). Without it dsh starts the terminal with the environment default shell, and PATH's bash is often the WSL launcher — so the new terminal runs Ubuntu. It only writes when that row has NO shell of its own; an explicit choice is never overwritten, it just gets a host-log line. New terminals pick it up immediately, already-open ones keep their shell.",
			"eol.label": "Git line endings (Linux match)",
			"eol.hint": "Git commands the model runs behave like Linux: core.autocrlf=input, core.eol=lf. Your own terminal's git and a repository's .gitattributes are unaffected.",
			"bash.label": "Git Bash path",
			"bash.hint": "Full path of a custom bash.exe for resolving /usr mounts; empty = auto-detect the default install and PATH.",
			"bash.saveFailed": "The save did not take effect: the host refused the write — check that the path exists and points at Git for Windows’ bash, or read the host log",
			"bash.save": "Save",
			"bash.saved": "Saved",
			"adopt.label": "Adopt sidebar terminal",
			"adopt.hint": "On (default) writes Git Bash into dsh-better-sidebar's terminal shell; turning it off restores the pre-adoption value and never touches a manually chosen one. The model-side bash tool is unaffected — the plugin itself provides that.",
			"sec.dedupe": "Dedupe with PTC creation mode",
			"dedupe.label": "\"Creation mode · Git Bash\" duplicate",
			"dedupe.hint": "With dsh-ptc-cordis-preset installed alongside, its \"PTC creation mode\" is already the Git Bash variant under the link-up, so it and this plugin's \"creation mode · Git Bash\" point at the same thing. With dedupe on, this plugin stops registering that entry (one fewer in the roster); off by default, which keeps the four variants unchanged. This switch is the very same switch on the peer's settings card — both sides share one state, so a change on either side syncs to the other immediately. Shown only while dsh-ptc-cordis-preset is installed.",
			"sec.python": "run_code backend (experimental Python)",
			"python.label": "run_code backend",
			"python.on": "Python (experimental)",
			"python.off": "Node / TypeScript (default)",
			"python.hint": "While off (default) run_code uses the official Node/TypeScript backend, byte-identical to the shipped ptc composition; turning it on switches to dsh's experimental CPython backend (@deepseek-ai/dsh-experimental-ptc-runtime-python), which also switches run_code's language, generated SDK prompt and tool presentation to Python. Requires a POSIX platform and CPython ≥ 3.10 (unavailable on Windows) and is mutually exclusive with the workflow tool — the official Python composition disables workflow too, so the workflow side of all four variants is forced off while this is on (your workflow setting is kept and restored when you turn it back off). Takes effect after restarting dsh; this is the very same switch on dsh-ptc-cordis-preset's card — both sides share one state, so either side updates both. Shown only while dsh-ptc-cordis-preset is installed. If turning it on does not take effect, the dsh startup log states why.",
			"python.degraded": "backend unavailable, still Node (reason in the dsh startup log)",
			"python.blocked": "This host is Windows: the experimental Python backend supports POSIX only, so this switch is unavailable.",
		};

		/* Third-language dictionaries: one entry per language, each preceded
		   by a locale marker line the smoke test slices on. Adding a language is
		   one entry here and nothing else — the dictionaries also ride the
		   ctx.locale.register call below, so host-side consumers read the same
		   copy the card does. Every key set MUST equal zh's exactly: a missing
		   key falls back to English silently and the card looks half-translated.
		   zh-hk and zh-mo ship one Cantonese-flavoured copy; zh-tw carries the
		   Taiwan wording. */
		var LOCALES = {
			/* locale: ar */
			"ar": {
				"title": "لهجة مسارات Git Bash",
				"cardDesc": "صيغة مسار POSIX موحّدة /c/ لكل الأدوات (مُفعَّلة افتراضيًا)",
				"state.label": "الحالة الحالية",
				"state.on": "مُفعَّلة",
				"state.off": "مُعطَّلة",
				"switch.on": "تفعيل",
				"switch.off": "تعطيل",
				"error": "فشل الكتابة",
				"hint": "عند التفعيل: تستخدم كل الأدوات (أوامر bash و workdir، ومعاملات المسار في read/write/edit/read_image/glob/grep و present) مسارات POSIX من جذر قرص MSYS (/c/Users/...)؛ وعادات bash الأصلية — ~ للمجلد الرئيسي و /tmp و /dev/null و /usr — تعمل في كل أداة تمامًا كما تحلّها bash نفسها، ويتولّى المضيف ترجمة حقول المسار تلقائيًا. عند التعطيل يعود السلوك الأصلي لـ dsh (مسارات Windows لأدوات الملفات). يبقى bash دائمًا Git Bash ما دامت الإضافة مثبَّتة؛ هذا المفتاح لا يحكم سوى لهجة المسارات بين الأدوات.",
				"sec.dialect": "لهجة المسارات",
				"sec.terminal": "طرفية الشريط الجانبي",
				"mnts.label": "التركيبات الافتراضية للمسارات",
				"mnts.hint": "عادات bash الأصلية — ~ و /tmp و /usr — تُحل عبر جدول تحميلات Git Bash في كل أداة؛ الإيقاف يعني جذور الأقراص /c/ فقط.",
				"errs.label": "ترجمة مسارات الأخطاء",
				"errs.hint": "مسارات Windows في أخطاء أدوات الملفات و run_code تُعاد بصيغة /c/ — بما فيها الرسالة التي يلتقطها البرنامج — مع إرشاد NUL؛ الإيقاف يحتفظ بالنص الأصلي.",
				"split.label": "تقسيم نمط glob المطلق",
				"split.hint": "نمط glob المطلق يُقسم إلى path + نمط نسبي؛ الإيقاف يمرره كما هو.",
				"code.label": "مسارات برامج run_code",
				"code.hint": "تُترجم السلاسل النصية للمسارات المكتوبة داخل برنامج run_code عبر جدول التحميل نفسه قبل التشغيل؛ وتبقى التعليقات والقوالب ذات الإدراج و$VAR والسلاسل غير المسارية كما هي، وأي التباس يُبقي البرنامج كاملًا دون تغيير. وتُهيَّأ أيضًا TEMP/TMP للبرنامج: مع بيئة فارغة يعيد os.tmpdir() على ويندوز القيمة undefined\\temp فيُكتب في مكان خاطئ.",
				"bashmiss.title": "لم يُعثر على Git Bash — لا يمكن تنفيذ الأوامر",
				"bashmiss.body": "هذه الإضافة تقبل فقط bash المرفق مع Git for Windows (ولا تقبل bash الخاص بـ WSL أو MSYS2 أو Cygwin)، ولا ترجع أبدًا إلى PowerShell/cmd — لذلك تُبلغ عن الفشل بدل استبداله بصمت. أدخل المسار الكامل لـ bash.exe أدناه أو ثبّت Git for Windows أولًا.",
				"bashmiss.tried": "تم فحص هذه المواقع بالترتيب (ورُفضت جميعها):",
				"bashmiss.download": "تنزيل Git for Windows",
				"bashmiss.where": "يمكنك أيضًا تعبئة هذا لاحقًا من «الإعدادات → الإضافات → dsh-gitbash-shell → مسار Git Bash»؛ وسجل تشغيل المضيف يحمل نفس قائمة الفحص.",
				"bashmiss.close": "إغلاق",
				"sub.label": "استخدام الوكلاء الفرعيين لـ Git Bash",
				"sub.hint": "مُفعَّل (افتراضيًا): يحصل الوكلاء الفرعيون وأعضاء الفريق — بما في ذلك المتداخلون — على لهجة المطالبة وترجمة مسارات الوسائط وصدى النتائج وحقيقة DSH_PATH_DIALECT نفسها التي يحصل عليها الوكيل الرئيسي. عند الإيقاف تُطبَّق هذه على الوكيل الرئيسي فقط ويعمل الوكلاء المفوَّضون بدلالات الصدفة الرسمية (دون إعادة كتابة المطالبة أو ترجمة المسارات). لاحظ أن dsh يملك مُنفِّذ صدفة واحدًا لكل عملية، لذا يبقى ثنائي Git Bash عامًّا؛ هذا المفتاح يحكم طبقتي اللهجة والترجمة.",
				"term.label": "تبنّي طرفية الشريط الجانبي",
				"term.hint": "مُفعَّل افتراضيًا: على Windows يُضبط shell الخاص بـ«الطرفية الجديدة» الرسمية على Git Bash المكتشف (يُكتب في صف terminal-controller الرسمي عبر محرر الإعدادات الرسمي). بدونه يبدأ dsh الطرفية بالـ shell الافتراضي للبيئة، وغالبًا ما يكون bash في PATH هو مشغّل WSL فتعمل الطرفية الجديدة على Ubuntu. لا يُكتب إلا عندما لا يملك ذلك الصف shell خاصًا به؛ ولا يُستبدل اختيار صريح أبدًا، بل يُسجَّل سطر في سجل المضيف. الطرفيات الجديدة تسري فورًا، والمفتوحة تبقى كما هي.",
				"eol.label": "نهايات أسطر Git (مطابقة لينكس)",
				"eol.hint": "أوامر git التي يشغّلها النموذج تتبع سلوك لينكس: core.autocrlf=input و core.eol=lf؛ لا يتأثر طرفيتك ولا ملف .gitattributes للمستودع.",
				"bash.label": "مسار Git Bash",
				"bash.hint": "المسار الكامل لنسخة bash.exe مخصصة؛ فارغ = اكتشاف تلقائي.",
				"bash.saveFailed": "لم يُطبَّق الحفظ: رفض المضيف هذه الكتابة — تحقق من وجود المسار وأنه bash الخاص بـ Git for Windows، أو راجع سجل المضيف",
				"bash.save": "حفظ",
				"bash.saved": "تم الحفظ",
				"adopt.label": "تبنّي طرفية الشريط الجانبي",
				"adopt.hint": "عند التفعيل (افتراضي) تُكتب Git Bash كـ shell لطرفية dsh-better-sidebar؛ وعند التعطيل تُستعاد القيمة السابقة ولا تُلمس القيمة المختارة يدويًا أبدًا. أداة bash الخاصة بالنموذج لا تتأثر — الإضافة نفسها توفرها.",
				"sec.dedupe": "إزالة التكرار مع وضع PTC الإبداعي",
				"dedupe.label": "عنصر «وضع الإبداع · Git Bash» المكرر",
				"dedupe.hint": "عند تثبيت dsh-ptc-cordis-preset معًا، يكون «وضع PTC الإبداعي» لديه بالفعل نسخة Git Bash في إطار الربط، فيشير هو و«وضع الإبداع · Git Bash» في هذه الإضافة إلى الشيء نفسه. عند تفعيل إزالة التكرار تتوقف هذه الإضافة عن تسجيل ذلك العنصر (عنصر أقل في القائمة)؛ والمعطَّل افتراضيًا يُبقي المتغيّرات الأربعة كما هي. هذا المفتاح هو نفسه المفتاح الموجود على بطاقة إعدادات الطرف الآخر — الجانبان يتشاركان الحالة نفسها، وأي تغيير في أحد الجانبين يُزامَن فورًا مع الآخر. يظهر فقط عندما يكون dsh-ptc-cordis-preset مثبَّتًا.",
				"sec.python": "خلفية run_code (Python تجريبي)",
				"python.label": "خلفية run_code",
				"python.on": "Python (تجريبي)",
				"python.off": "Node / TypeScript (افتراضي)",
				"python.hint": "عند الإيقاف (افتراضيًا) يستخدم run_code الخلفية الرسمية Node/TypeScript، مطابقة تمامًا لتركيبة ptc الرسمية؛ وعند التشغيل يتحول إلى خلفية CPython التجريبية في dsh (@deepseek-ai/dsh-experimental-ptc-runtime-python)، فتتحول لغة run_code ومطالبة SDK المولَّدة وعرض الأداة إلى Python. يتطلب نظام POSIX و CPython ≥ 3.10 (غير متاح على Windows)، وهو متعارض مع أداة workflow — فالتركيبة الرسمية لـ Python تعطّل workflow أيضًا، لذا يبقى جانب workflow مُعطَّلًا في المتغيّرات الأربعة أثناء التشغيل (قيمتك محفوظة وتعود عند الإيقاف). يسري التغيير بعد إعادة تشغيل dsh؛ هذا هو المفتاح نفسه على بطاقة dsh-ptc-cordis-preset — الجانبان يتشاركان حالة واحدة. يظهر فقط عند تثبيت dsh-ptc-cordis-preset. إذا لم يسري التشغيل، فسبب ذلك مذكور في سجل تشغيل dsh.",
				"python.degraded": "الخلفية غير متاحة، لا يزال Node (السبب في سجل بدء التشغيل)",
				"python.blocked": "هذا المضيف يعمل بـ Windows: الخلفية التجريبية Python تدعم POSIX فقط، لذا لا يتوفر هذا المفتاح.",
			},
			/* locale: de */
			"de": {
				"title": "Git-Bash-Pfaddialekt",
				"cardDesc": "Eine einheitliche /c/-POSIX-Pfadform für alle Tools (standardmäßig an)",
				"state.label": "Aktueller Status",
				"state.on": "Aktiviert",
				"state.off": "Deaktiviert",
				"switch.on": "Aktivieren",
				"switch.off": "Deaktivieren",
				"error": "Schreiben fehlgeschlagen",
				"hint": "Aktiviert: Alle Tools (bash-Befehle und workdir sowie Pfadargumente von read/write/edit/read_image/glob/grep und present) verwenden POSIX-Pfade ab der MSYS-Laufwerkswurzel (/c/Users/...); bash-eigene Gewohnheiten — ~ für das Home-Verzeichnis, /tmp, /dev/null, /usr — funktionieren in jedem Tool genau so, wie bash sie selbst auflöst, und der Host übersetzt die Pfadfelder automatisch. Deaktiviert stellt das dsh-native Verhalten wieder her (Windows-Pfade für Dateitools). Bash ist bei installiertem Plugin immer Git Bash; dieser Schalter steuert nur den Pfaddialekt zwischen den Tools.",
				"sec.dialect": "Pfaddialekt",
				"sec.terminal": "Seitenleisten-Terminal",
				"mnts.label": "Virtuelle Pfad-Mounts",
				"mnts.hint": "Bash-eigene Gewohnheiten — ~ Home, /tmp, /usr — werden über die Git-Bash-Mount-Tabelle in jedem Tool aufgelöst; aus = nur /c/-Laufwerkswurzeln.",
				"errs.label": "Fehlerpfad-Übersetzung",
				"errs.hint": "Windows-Pfade in Fehlern von Dateitools und run_code werden zu /c/ zurückgeschrieben — auch die im Programm gefangene Meldung; aus erhält den Originaltext.",
				"split.label": "Glob-Absolutmuster-Split",
				"split.hint": "Ein absolutes Glob-Muster zerfällt in Pfad + relatives Muster; aus übergibt es unverändert.",
				"code.label": "Pfade in run_code-Programmen",
				"code.hint": "Pfadliterale in einem run_code-Programm werden vor dem Start über dieselbe Mount-Tabelle übersetzt; Kommentare, interpolierte Templates, $VARs und Nicht-Pfad-Strings bleiben unangetastet, und bei Unklarheit bleibt das ganze Programm unverändert. Zusätzlich werden TEMP/TMP für das Programm gesetzt: bei leerer Umgebung liefert os.tmpdir() unter Windows undefined\\temp und schreibt an einen falschen Ort.",
				"bashmiss.title": "Git Bash nicht gefunden — Befehle können nicht laufen",
				"bashmiss.body": "Dieses Plugin akzeptiert nur die mit Git for Windows gelieferte bash (WSL-, MSYS2- und Cygwin-bash werden abgelehnt) und fällt nie auf PowerShell/cmd zurück — es meldet den Fehler, statt still etwas Lauffähiges einzusetzen. Trage unten den vollständigen Pfad zu bash.exe ein oder installiere zuerst Git for Windows.",
				"bashmiss.tried": "Der Reihe nach geprüft (alle abgelehnt):",
				"bashmiss.download": "Git for Windows herunterladen",
				"bashmiss.where": "Du kannst das später auch unter „Einstellungen → Plugins → dsh-gitbash-shell → Git-Bash-Pfad“ eintragen; das Startprotokoll des Hosts enthält dieselbe Liste.",
				"bashmiss.close": "Schließen",
				"sub.label": "Subagenten/Teammitglieder nutzen Git Bash",
				"sub.hint": "An (Standard): Subagenten und Teammitglieder — auch verschachtelte — erhalten denselben Prompt-Dialekt, dieselbe Pfadargument-Übersetzung, dieselbe Ergebnisanzeige und dieselbe DSH_PATH_DIALECT-Tatsache wie der Hauptagent. Aus: Das gilt nur für den Hauptagenten, delegierte Agenten laufen mit den offiziellen Shell-Semantiken (keine Prompt-Umschreibung, keine Pfadübersetzung). Beachte: dsh hat genau einen Shell-Executor pro Prozess, das Git-Bash-Binary bleibt also global; dieser Schalter steuert die Dialekt-/Übersetzungsschichten.",
				"term.label": "Seitenleisten-Terminal übernehmen",
				"term.hint": "Standardmäßig an: Unter Windows wird die Shell des offiziellen „Neuen Terminals“ auf die erkannte Git Bash gesetzt (geschrieben in die offizielle terminal-controller-Zeile über den offiziellen Konfigurationseditor). Ohne das startet dsh das Terminal mit der Umgebungs-Standardshell, und das bash im PATH ist oft der WSL-Starter — das neue Terminal läuft dann unter Ubuntu. Geschrieben wird nur, wenn diese Zeile KEINE eigene Shell hat; eine ausdrückliche Wahl wird nie überschrieben, sondern nur im Host-Protokoll vermerkt. Neue Terminals übernehmen es sofort, bereits offene behalten ihre Shell.",
				"eol.label": "Git-Zeilenenden (Linux-gleich)",
				"eol.hint": "Vom Modell ausgeführte git-Befehle verhalten sich wie unter Linux: core.autocrlf=input, core.eol=lf. Dein eigenes Terminal und die .gitattributes eines Repos bleiben unberührt.",
				"bash.label": "Git-Bash-Pfad",
				"bash.hint": "Vollständiger Pfad einer benutzerdefinierten bash.exe; leer = automatische Erkennung.",
				"bash.saveFailed": "Speichern ohne Wirkung: Der Host hat den Schreibvorgang abgelehnt — prüfe, ob der Pfad existiert und zu Git for Windows gehört, oder lies das Host-Protokoll",
				"bash.save": "Speichern",
				"bash.saved": "Gespeichert",
				"adopt.label": "Sidebar-Terminal übernehmen",
				"adopt.hint": "Ein (Standard) schreibt Git Bash als Shell des dsh-better-sidebar-Terminals; Aus stellt den vorherigen Wert wieder her und fasst nie eine manuell gewählte Einstellung an. Das bash-Werkzeug des Modells bleibt unberührt — das liefert das Plugin selbst.",
				"sec.dedupe": "Deduplizierung mit dem PTC-Kreativmodus",
				"dedupe.label": "Doppelter Eintrag „Kreativmodus · Git Bash“",
				"dedupe.hint": "Ist dsh-ptc-cordis-preset mitinstalliert, ist dessen „PTC-Kreativmodus“ durch die Verknüpfung bereits die Git-Bash-Fassung und zeigt damit auf dasselbe wie der „Kreativmodus · Git Bash“ dieses Plugins. Mit aktiver Deduplizierung registriert dieses Plugin den eigenen Eintrag nicht mehr (ein Eintrag weniger im Verzeichnis); standardmäßig aus, die vier Varianten bleiben unverändert. Dieser Schalter ist derselbe Schalter auf der Einstellungskarte der Gegenseite — beide Seiten teilen einen Zustand, eine Änderung auf einer Seite erreicht die andere sofort. Nur sichtbar, solange dsh-ptc-cordis-preset installiert ist.",
				"sec.python": "run_code-Backend (experimentelles Python)",
				"python.label": "run_code-Backend",
				"python.on": "Python (experimentell)",
				"python.off": "Node / TypeScript (Standard)",
				"python.hint": "Aus (Standard): run_code nutzt das offizielle Node/TypeScript-Backend, byte-identisch zur ausgelieferten ptc-Komposition; an: dsh wechselt auf das experimentelle CPython-Backend (@deepseek-ai/dsh-experimental-ptc-runtime-python), womit Sprache, generierter SDK-Prompt und Darstellung von run_code auf Python umstellen. Erfordert POSIX und CPython ≥ 3.10 (unter Windows nicht verfügbar) und ist mit dem workflow-Tool unvereinbar — die offizielle Python-Komposition deaktiviert workflow ebenfalls, deshalb bleibt die workflow-Seite aller vier Varianten so lange aus (dein Workflow-Wert bleibt erhalten und kehrt nach dem Ausschalten zurück). Wirkt nach einem Neustart von dsh; dies ist derselbe Schalter auf der Karte von dsh-ptc-cordis-preset — beide Seiten teilen einen Zustand. Nur sichtbar, solange dsh-ptc-cordis-preset installiert ist. Bleibt das Einschalten ohne Wirkung, nennt das dsh-Startprotokoll den Grund.",
				"python.degraded": "Backend nicht verfügbar, weiterhin Node (Grund im dsh-Startprotokoll)",
				"python.blocked": "Dieser Host ist Windows: Das experimentelle Python-Backend unterstützt nur POSIX, der Schalter ist nicht verfügbar.",
			},
			/* locale: fr */
			"fr": {
				"title": "Dialecte de chemins Git Bash",
				"cardDesc": "Une forme de chemin POSIX /c/ unique pour tous les outils (activée par défaut)",
				"state.label": "État actuel",
				"state.on": "Activé",
				"state.off": "Désactivé",
				"switch.on": "Activer",
				"switch.off": "Désactiver",
				"error": "échec de l'écriture",
				"hint": "Activé : tous les outils (commandes bash et workdir, arguments de chemin de read/write/edit/read_image/glob/grep et de present) utilisent des chemins POSIX à racine de lecteur MSYS (/c/Users/...) ; les habitudes natives de bash — ~ pour le dossier personnel, /tmp, /dev/null, /usr — fonctionnent dans chaque outil exactement comme bash les résout lui-même, et l'hôte traduit les champs de chemin automatiquement. Désactivé rétablit le comportement natif de dsh (chemins Windows pour les outils de fichiers). Bash reste toujours Git Bash tant que le plugin est installé ; ce commutateur ne régit que le dialecte de chemins entre outils.",
				"sec.dialect": "Dialecte de chemins",
				"sec.terminal": "Terminal latéral",
				"mnts.label": "Montages de chemins virtuels",
				"mnts.hint": "Les habitudes natives de bash — ~ home, /tmp, /usr — se résolvent via la table de montages de Git Bash dans chaque outil ; désactivé = racines /c/ uniquement.",
				"errs.label": "Traduction des chemins d'erreur",
				"errs.hint": "Les chemins Windows dans les erreurs des outils fichiers et de run_code sont réécrits en /c/ — y compris le message capturé par le programme ; désactivé conserve le texte brut.",
				"split.label": "Découpage des motifs glob absolus",
				"split.hint": "Un motif glob absolu se scinde en chemin + motif relatif ; désactivé le passe tel quel.",
				"code.label": "chemins dans les programmes run_code",
				"code.hint": "Les littéraux de chemin écrits dans un programme run_code sont traduits via la même table de montage avant exécution; commentaires, gabarits interpolés, $VAR et chaînes non-chemin restent intacts, et la moindre incertitude laisse le programme tel quel. TEMP/TMP sont aussi fournis au programme : avec un env vide, os.tmpdir() sous Windows renvoie undefined\\temp et écrit au mauvais endroit.",
				"bashmiss.title": "Git Bash introuvable — les commandes ne peuvent pas s'exécuter",
				"bashmiss.body": "Ce plugin n'accepte que le bash fourni avec Git for Windows (les bash WSL, MSYS2 et Cygwin sont refusés) et ne retombe jamais sur PowerShell/cmd : il signale la panne au lieu de substituer discrètement un shell utilisable. Saisissez ci-dessous le chemin complet de bash.exe, ou installez d'abord Git for Windows.",
				"bashmiss.tried": "Emplacements testés dans l'ordre (tous refusés) :",
				"bashmiss.download": "Télécharger Git for Windows",
				"bashmiss.where": "Vous pourrez aussi le renseigner plus tard dans « Paramètres → Plugins → dsh-gitbash-shell → Chemin Git Bash » ; le journal de démarrage de l'hôte contient la même liste.",
				"bashmiss.close": "Fermer",
				"sub.label": "Les sous-agents utilisent Git Bash",
				"sub.hint": "Activé (par défaut) : les sous-agents et membres d'équipe — y compris imbriqués — reçoivent le même dialecte de prompt, la même traduction des chemins d'arguments, le même écho de résultat et le même fait DSH_PATH_DIALECT que l'agent principal. Désactivé : ces éléments ne s'appliquent qu'à l'agent principal et les agents délégués suivent les sémantiques de shell officielles (pas de réécriture du prompt, pas de traduction des chemins). À noter : dsh n'a qu'un seul exécuteur de shell par processus, le binaire Git Bash reste donc global ; cet interrupteur régit les couches de dialecte et de traduction.",
				"term.label": "Adopter le terminal latéral",
				"term.hint": "Activé par défaut : sous Windows, le shell du « nouveau terminal » officiel est réglé sur le Git Bash détecté (écrit dans la ligne officielle terminal-controller via l'éditeur de configuration officiel). Sans cela, dsh démarre le terminal avec le shell par défaut de l'environnement, et le bash du PATH est souvent le lanceur WSL — le nouveau terminal tourne alors sous Ubuntu. L'écriture n'a lieu que si cette ligne n'a AUCUN shell propre ; un choix explicite n'est jamais écrasé, seulement consigné dans le journal de l'hôte. Les nouveaux terminaux en profitent immédiatement, ceux déjà ouverts gardent leur shell.",
				"eol.label": "fins de ligne Git (comme Linux)",
				"eol.hint": "Les commandes git lancées par le modèle suivent le comportement Linux : core.autocrlf=input, core.eol=lf. Votre terminal et les .gitattributes du dépôt ne sont pas touchés.",
				"bash.label": "Chemin Git Bash",
				"bash.hint": "Chemin complet d'un bash.exe personnalisé ; vide = détection automatique.",
				"bash.saveFailed": "L’enregistrement n’a pas pris effet : l’hôte a refusé l’écriture — vérifiez que le chemin existe et correspond au bash de Git for Windows, ou consultez le journal de l’hôte",
				"bash.save": "Enregistrer",
				"bash.saved": "Enregistré",
				"adopt.label": "Adopter le terminal latéral",
				"adopt.hint": "Activé (par défaut) : écrit Git Bash comme shell du terminal dsh-better-sidebar ; désactivé : restaure la valeur davant et ne touche jamais un choix manuel. Loutil bash du modèle nest pas concerné — le plugin le fournit lui-même.",
				"sec.dedupe": "Dédoublonnage avec le mode création PTC",
				"dedupe.label": "Entrée en double « mode création · Git Bash »",
				"dedupe.hint": "Lorsque dsh-ptc-cordis-preset est installé en même temps, son « mode création PTC » est déjà la version Git Bash grâce à l'appairage : lui et le « mode création · Git Bash » de ce plugin désignent la même chose. Une fois le dédoublonnage activé, ce plugin n'enregistre plus sa propre entrée (une entrée de moins dans le catalogue) ; désactivé par défaut, ce qui laisse les quatre variantes intactes. Cet interrupteur est exactement le même que sur la carte de réglages d'en face — les deux côtés partagent un seul état, toute modification d'un côté est synchronisée immédiatement de l'autre. Affiché uniquement lorsque dsh-ptc-cordis-preset est installé.",
				"sec.python": "Backend run_code (Python expérimental)",
				"python.label": "Backend run_code",
				"python.on": "Python (expérimental)",
				"python.off": "Node / TypeScript (par défaut)",
				"python.hint": "Désactivé (par défaut), run_code utilise le backend officiel Node/TypeScript, identique octet pour octet à la composition ptc livrée ; activé, dsh bascule sur le backend CPython expérimental (@deepseek-ai/dsh-experimental-ptc-runtime-python) : la langue, l'invite SDK générée et la présentation de run_code passent en Python. Exige POSIX et CPython ≥ 3.10 (indisponible sous Windows) et est incompatible avec l'outil workflow — la composition Python officielle désactive aussi workflow, donc le côté workflow des quatre variantes reste désactivé tant que l'option est active (ta valeur est conservée et revient à la désactivation). Prend effet après un redémarrage de dsh ; c'est le même interrupteur que sur la carte de dsh-ptc-cordis-preset — les deux côtés partagent un seul état. Affiché uniquement si dsh-ptc-cordis-preset est installé. Si l'activation reste sans effet, le journal de démarrage de dsh en indique la raison.",
				"python.degraded": "backend indisponible, toujours Node (raison dans le journal de démarrage de dsh)",
				"python.blocked": "Cet hôte est sous Windows : le backend Python expérimental n'est disponible que sur POSIX, l'interrupteur est indisponible.",
			},
			/* locale: hi */
			"hi": {
				"title": "Git Bash पथ शैली",
				"cardDesc": "सभी टूल के लिए एक ही /c/ POSIX पथ रूप (डिफ़ॉल्ट रूप से सक्षम)",
				"state.label": "वर्तमान स्थिति",
				"state.on": "सक्षम",
				"state.off": "अक्षम",
				"switch.on": "सक्षम करें",
				"switch.off": "अक्षम करें",
				"error": "लिखना विफल रहा",
				"hint": "सक्षम होने पर: सभी टूल (bash कमांड और workdir, तथा read/write/edit/read_image/glob/grep और present के पथ तर्क) MSYS ड्राइव-रूट POSIX पथ (/c/Users/...) का उपयोग करते हैं; bash की मूल आदतें — होम के लिए ~, /tmp, /dev/null, /usr — हर टूल में ठीक वैसे काम करती हैं जैसे bash स्वयं उन्हें हल करता है, और होस्ट पथ फ़ील्ड स्वतः अनुवादित करता है। अक्षम करने पर dsh का मूल व्यवहार बहाल होता है (फ़ाइल टूल के लिए Windows पथ)। जब तक प्लगइन इंस्टॉल है bash हमेशा Git Bash रहता है; यह स्विच केवल टूल के बीच पथ शैली नियंत्रित करता है।",
				"sec.dialect": "पथ बोली",
				"sec.terminal": "साइडबार टर्मिनल",
				"mnts.label": "वर्चुअल पथ माउंट",
				"mnts.hint": "bash की मूल आदतें — ~ होम, /tmp, /usr — हर टूल में Git Bash माउंट तालिका से हल होती हैं; बंद = केवल /c/ ड्राइव-रूट।",
				"errs.label": "त्रुटि-पथ अनुवाद",
				"errs.hint": "फ़ाइल टूल और run_code की त्रुटियों में Windows पथ /c/ रूप में लिखे जाते हैं — प्रोग्राम में पकड़े गए संदेश सहित; बंद = मूल पाठ।",
				"split.label": "glob एब्सोल्यूट-पैटर्न विभाजन",
				"split.hint": "एब्सोल्यूट glob पैटर्न path + रिलेटिव पैटर्न में विभाजित होता है; बंद इसे वैसे ही पास करता है।",
				"code.label": "run_code प्रोग्राम पथ",
				"code.hint": "run_code प्रोग्राम में लिखे पथ लिटरल चलने से पहले उसी माउंट तालिका से अनूदित होते हैं; टिप्पणियाँ, इंटरपोलेटेड टेम्पलेट, $VAR और गैर-पथ स्ट्रिंग अछूते रहते हैं, और किसी भी अनिश्चितता पर पूरा प्रोग्राम अपरिवर्तित रहता है। साथ ही प्रोग्राम के लिए TEMP/TMP भर दिए जाते हैं: खाली env में Windows पर os.tmpdir() undefined\\temp देता है और गलत जगह लिखता है।",
				"bashmiss.title": "Git Bash नहीं मिला — कमांड नहीं चल सकतीं",
				"bashmiss.body": "यह प्लगइन केवल Git for Windows के साथ आने वाले bash को स्वीकार करता है (WSL, MSYS2 और Cygwin का bash अस्वीकार है) और कभी PowerShell/cmd पर नहीं लौटता — इसलिए यह विफलता बताता है, चुपचाप कोई चलने वाला शेल नहीं लगाता। नीचे bash.exe का पूरा पाथ भरें, या पहले Git for Windows इंस्टॉल करें।",
				"bashmiss.tried": "इन स्थानों को क्रम से जाँचा गया (सभी अस्वीकृत):",
				"bashmiss.download": "Git for Windows डाउनलोड करें",
				"bashmiss.where": "बाद में «सेटिंग्स → प्लगइन → dsh-gitbash-shell → Git Bash पाथ» में भी भर सकते हैं; होस्ट स्टार्टअप लॉग में वही सूची है।",
				"bashmiss.close": "बंद करें",
				"sub.label": "सबएजेंट/टीम सदस्य Git Bash इस्तेमाल करें",
				"sub.hint": "चालू (डिफ़ॉल्ट): सबएजेंट और टीम सदस्य — नेस्टेड सहित — मुख्य एजेंट जैसा ही प्रॉम्प्ट डायलेक्ट, पाथ आर्ग्युमेंट अनुवाद, परिणाम इको और DSH_PATH_DIALECT तथ्य पाते हैं। बंद: ये केवल मुख्य एजेंट पर लागू होते हैं और प्रतिनिधित एजेंट आधिकारिक शेल अर्थ में चलते हैं (प्रॉम्प्ट नहीं बदलता, पाथ अनुवाद नहीं होता)। ध्यान दें: dsh में प्रति प्रोसेस एक ही शेल एक्ज़ीक्यूटर होता है, इसलिए Git Bash बाइनरी वैश्विक रहती है; यह स्विच डायलेक्ट/अनुवाद परतों को नियंत्रित करता है।",
				"term.label": "साइडबार टर्मिनल अपनाएँ",
				"term.hint": "डिफ़ॉल्ट रूप से चालू: Windows पर आधिकारिक «नया टर्मिनल» का shell पहचाने गए Git Bash पर सेट होता है (आधिकारिक कॉन्फ़िग एडिटर के ज़रिए आधिकारिक terminal-controller पंक्ति में लिखा जाता है)। इसके बिना dsh टर्मिनल को पर्यावरण के डिफ़ॉल्ट shell से शुरू करता है, और PATH का bash अक्सर WSL लॉन्चर होता है — तब नया टर्मिनल Ubuntu पर चलता है। लिखा तभी जाता है जब उस पंक्ति का अपना कोई shell न हो; स्पष्ट चयन कभी अधिलेखित नहीं होता, केवल होस्ट लॉग में दर्ज होता है। नए टर्मिनल तुरंत इसे लेते हैं, खुले हुए अपना shell रखते हैं।",
				"eol.label": "Git पंक्ति-अंत (Linux जैसा)",
				"eol.hint": "मॉडल द्वारा चलाए git कमांड Linux व्यवहार अपनाते हैं: core.autocrlf=input, core.eol=lf। आपका टर्मिनल और रेपो का .gitattributes अछूते रहते हैं।",
				"bash.label": "Git Bash पथ",
				"bash.hint": "कस्टम bash.exe का पूर्ण पथ; खाली = ऑटो-डिटेक्ट।",
				"bash.saveFailed": "सहेजना लागू नहीं हुआ: होस्ट ने यह लेखन अस्वीकार किया — जाँचें कि पाथ मौजूद है और Git for Windows का bash है, या होस्ट लॉग देखें",
				"bash.save": "सहेजें",
				"bash.saved": "सहेजा गया",
				"adopt.label": "साइडबार टर्मिनल अपनाएँ",
				"adopt.hint": "चालू (डिफ़ॉल्ट) होने पर dsh-better-sidebar के टर्मिनल में Git Bash लिखा जाता है; बंद करने पर पहले वाली मान बहाल होती है और मैन्युअल चुनी गई सेटिंग कभी नहीं छुई जाती। मॉडल का bash टूल अप्रभावित रहता है — वह प्लगइन स्वयं देता है।",
				"sec.dedupe": "PTC क्रिएशन मोड के साथ डुप्लीकेट हटाना",
				"dedupe.label": "«क्रिएशन मोड · Git Bash» की डुप्लीकेट प्रविष्टि",
				"dedupe.hint": "जब dsh-ptc-cordis-preset साथ में इंस्टॉल होता है, तो लिंक-अप के कारण उसका «PTC क्रिएशन मोड» पहले से Git Bash रूप है, और वह इस प्लगइन के «क्रिएशन मोड · Git Bash» के साथ एक ही चीज़ दर्शाता है। डुप्लीकेट हटाना चालू करने पर यह प्लगइन अपनी वह प्रविष्टि पंजीकृत नहीं करता (सूची में एक कम); डिफ़ॉल्ट रूप से बंद, जिससे चारों वेरिएंट अपरिवर्तित रहते हैं। यह स्विच सामने वाले की सेटिंग कार्ड पर मौजूद ठीक वही स्विच है — दोनों ओर एक ही स्थिति साझा होती है, किसी एक ओर बदलाव तुरंत दूसरी ओर सिंक होता है। यह केवल तभी दिखता है जब dsh-ptc-cordis-preset इंस्टॉल हो।",
				"sec.python": "run_code बैकएंड (प्रयोगात्मक Python)",
				"python.label": "run_code बैकएंड",
				"python.on": "Python (प्रयोगात्मक)",
				"python.off": "Node / TypeScript (डिफ़ॉल्ट)",
				"python.hint": "बंद (डिफ़ॉल्ट) रहने पर run_code आधिकारिक Node/TypeScript बैकएंड इस्तेमाल करता है, जो भेजे गए ptc संयोजन से पूरी तरह मेल खाता है; चालू करने पर dsh का प्रयोगात्मक CPython बैकएंड (@deepseek-ai/dsh-experimental-ptc-runtime-python) चलता है और run_code की भाषा, बना SDK प्रॉम्प्ट तथा प्रस्तुति Python में बदल जाती है। इसके लिए POSIX और CPython ≥ 3.10 चाहिए (Windows पर उपलब्ध नहीं), और यह workflow टूल से परस्पर अनन्य है — आधिकारिक Python संयोजन भी workflow बंद करता है, इसलिए चालू रहने तक चारों वेरिएंट का workflow पक्ष बंद रहता है (आपकी workflow सेटिंग सुरक्षित रहती है और बंद करने पर लौट आती है)। बदलाव dsh को फिर से शुरू करने के बाद लागू होता है; यह dsh-ptc-cordis-preset के कार्ड पर मौजूद वही स्विच है — दोनों ओर एक ही स्थिति साझा होती है। यह केवल तभी दिखता है जब dsh-ptc-cordis-preset इंस्टॉल हो। चालू करने पर असर न हो तो कारण dsh के स्टार्टअप लॉग में मिलेगा।",
				"python.degraded": "बैकएंड उपलब्ध नहीं, अब भी Node (कारण dsh स्टार्टअप लॉग में)",
				"python.blocked": "यह होस्ट Windows है: प्रयोगात्मक Python बैकएंड केवल POSIX पर चलता है, इसलिए यह स्विच उपलब्ध नहीं है।",
			},
			/* locale: id */
			"id": {
				"title": "Dialek path Git Bash",
				"cardDesc": "Satu bentuk path POSIX /c/ untuk semua alat (aktif secara bawaan)",
				"state.label": "Status saat ini",
				"state.on": "Aktif",
				"state.off": "Nonaktif",
				"switch.on": "Aktifkan",
				"switch.off": "Nonaktifkan",
				"error": "gagal menulis",
				"hint": "Saat aktif: semua alat (perintah bash dan workdir, serta argumen path read/write/edit/read_image/glob/grep dan present) memakai path POSIX berakar drive MSYS (/c/Users/...); kebiasaan asli bash — ~ untuk direktori home, /tmp, /dev/null, /usr — bekerja di setiap alat persis seperti bash sendiri menyelesaikannya, dan host menerjemahkan bidang path secara otomatis. Saat nonaktif, perilaku asli dsh dipulihkan (path Windows untuk alat berkas). Bash selalu Git Bash selama plugin terpasang; sakelar ini hanya mengatur dialek path antaralat.",
				"sec.dialect": "Dialek path",
				"sec.terminal": "Terminal sidebar",
				"mnts.label": "Mount path virtual",
				"mnts.hint": "Kebiasaan asli bash — ~ home, /tmp, /usr — diselesaikan lewat tabel mount Git Bash di setiap alat; nonaktif = hanya akar drive /c/.",
				"errs.label": "Terjemahan path error",
				"errs.hint": "Path Windows di error alat berkas dan run_code ditulis balik ke /c/ — termasuk pesan yang ditangkap program; nonaktif mempertahankan teks asli.",
				"split.label": "Pemisahan pattern glob absolut",
				"split.hint": "Pattern glob absolut dipecah menjadi path + pattern relatif; nonaktif meneruskannya apa adanya.",
				"code.label": "jalur dalam program run_code",
				"code.hint": "Literal jalur yang ditulis di program run_code diterjemahkan lewat tabel mount yang sama sebelum dijalankan; komentar, template berinterpolasi, $VAR, dan string non-jalur dibiarkan, dan bila ada keraguan seluruh program tidak diubah. TEMP/TMP juga diisi untuk program: dengan env kosong, os.tmpdir() di Windows mengembalikan undefined\\temp dan menulis ke lokasi salah.",
				"bashmiss.title": "Git Bash tidak ditemukan — perintah tidak bisa jalan",
				"bashmiss.body": "Plugin ini hanya menerima bash bawaan Git for Windows (bash WSL, MSYS2 dan Cygwin ditolak) dan tidak pernah mundur ke PowerShell/cmd — jadi ia melaporkan kegagalan alih-alih diam-diam memasang shell lain. Isi path lengkap bash.exe di bawah, atau pasang Git for Windows dulu.",
				"bashmiss.tried": "Diperiksa berurutan (semua ditolak):",
				"bashmiss.download": "Unduh Git for Windows",
				"bashmiss.where": "Bisa juga diisi nanti di «Setelan → Plugin → dsh-gitbash-shell → Path Git Bash»; log mulai host memuat daftar yang sama.",
				"bashmiss.close": "Tutup",
				"sub.label": "Subagen/teman tim memakai Git Bash",
				"sub.hint": "Aktif (bawaan): subagen dan anggota tim — termasuk yang bersarang — mendapat dialek prompt, terjemahan argumen path, gema hasil, dan fakta DSH_PATH_DIALECT yang sama seperti agen utama. Nonaktif: semuanya hanya berlaku untuk agen utama dan agen yang didelegasikan berjalan dengan semantik shell resmi (prompt tidak ditulis ulang, path tidak diterjemahkan). Catatan: dsh hanya punya satu eksekutor shell per proses, jadi biner Git Bash tetap global; sakelar ini mengatur lapisan dialek/terjemahan.",
				"term.label": "Adopsi terminal sidebar",
				"term.hint": "Aktif secara bawaan: di Windows, shell «terminal baru» resmi disetel ke Git Bash yang terdeteksi (ditulis ke baris terminal-controller resmi lewat editor konfigurasi resmi). Tanpanya dsh memulai terminal dengan shell bawaan lingkungan, dan bash di PATH sering kali peluncur WSL — terminal baru pun berjalan di Ubuntu. Penulisan hanya terjadi bila baris itu TIDAK punya shell sendiri; pilihan eksplisit tidak pernah ditimpa, hanya dicatat di log host. Terminal baru langsung memakainya, yang sudah terbuka tetap seperti semula.",
				"eol.label": "akhir baris Git (sama seperti Linux)",
				"eol.hint": "Perintah git yang dijalankan model mengikuti perilaku Linux: core.autocrlf=input, core.eol=lf. Terminal Anda dan .gitattributes repo tidak terpengaruh.",
				"bash.label": "Path Git Bash",
				"bash.hint": "Path lengkap bash.exe kustom; kosong = deteksi otomatis.",
				"bash.saveFailed": "Penyimpanan tidak berlaku: host menolak penulisan ini — pastikan path ada dan menunjuk ke bash Git for Windows, atau baca log host",
				"bash.save": "Simpan",
				"bash.saved": "Tersimpan",
				"adopt.label": "Adopsi terminal sidebar",
				"adopt.hint": "Nyala (bawaan) menulis Git Bash sebagai shell terminal dsh-better-sidebar; dimatikan memulihkan nilai sebelumnya dan tidak pernah menyentuh pilihan manual. Alat bash sisi model tak terpengaruh — plugin sendiri yang menyediakannya.",
				"sec.dedupe": "Deduplikasi dengan mode kreatif PTC",
				"dedupe.label": "Entri duplikat «mode kreatif · Git Bash»",
				"dedupe.hint": "Saat dsh-ptc-cordis-preset terpasang bersama, «mode kreatif PTC» miliknya sudah menjadi versi Git Bash berkat keterkaitan, sehingga ia dan «mode kreatif · Git Bash» plugin ini menunjuk hal yang sama. Dengan deduplikasi aktif, plugin ini berhenti mendaftarkan entrinya sendiri (berkurang satu di daftar); nonaktif secara bawaan, sehingga keempat varian tetap utuh. Sakelar ini adalah sakelar yang sama di kartu setelan pihak lain — kedua sisi berbagi satu status, perubahan di salah satu sisi langsung tersinkron ke sisi lain. Hanya tampil saat dsh-ptc-cordis-preset terpasang.",
				"sec.python": "Backend run_code (Python eksperimental)",
				"python.label": "Backend run_code",
				"python.on": "Python (eksperimental)",
				"python.off": "Node / TypeScript (bawaan)",
				"python.hint": "Saat nonaktif (bawaan), run_code memakai backend resmi Node/TypeScript, identik byte demi byte dengan komposisi ptc resmi; saat aktif, dsh memakai backend CPython eksperimental (@deepseek-ai/dsh-experimental-ptc-runtime-python) sehingga bahasa run_code, prompt SDK yang dihasilkan, dan penyajiannya beralih ke Python. Memerlukan POSIX dan CPython ≥ 3.10 (tidak tersedia di Windows) serta saling eksklusif dengan alat workflow — komposisi Python resmi juga menonaktifkan workflow, jadi sisi workflow keempat varian tetap mati selama ini aktif (nilai workflow-mu dipertahankan dan kembali saat dimatikan). Berlaku setelah dsh dimulai ulang; ini sakelar yang sama di kartu dsh-ptc-cordis-preset — kedua sisi berbagi satu status. Hanya tampil saat dsh-ptc-cordis-preset terpasang. Jika diaktifkan tetapi tidak berpengaruh, alasannya ada di log mulai dsh.",
				"python.degraded": "backend tidak tersedia, masih Node (alasan di log mulai dsh)",
				"python.blocked": "Host ini Windows: backend Python eksperimental hanya mendukung POSIX, sakelar ini tidak tersedia.",
			},
			/* locale: it */
			"it": {
				"title": "Dialetto dei percorsi Git Bash",
				"cardDesc": "Un'unica forma di percorso POSIX /c/ per tutti gli strumenti (attivata per impostazione predefinita)",
				"state.label": "Stato attuale",
				"state.on": "Attivato",
				"state.off": "Disattivato",
				"switch.on": "Attiva",
				"switch.off": "Disattiva",
				"error": "scrittura non riuscita",
				"hint": "Attivato: tutti gli strumenti (comandi bash e workdir, argomenti di percorso di read/write/edit/read_image/glob/grep e di present) usano percorsi POSIX con radice di unità MSYS (/c/Users/...); le abitudini native di bash — ~ per la home, /tmp, /dev/null, /usr — funzionano in ogni strumento esattamente come le risolve bash stesso, e l'host traduce automaticamente i campi di percorso. Disattivato ripristina il comportamento nativo di dsh (percorsi Windows per gli strumenti per i file). Bash resta sempre Git Bash finché il plugin è installato; questo interruttore governa solo il dialetto dei percorsi tra gli strumenti.",
				"sec.dialect": "Dialetto dei percorsi",
				"sec.terminal": "Terminale laterale",
				"mnts.label": "Mount di percorsi virtuali",
				"mnts.hint": "Le abitudini native di bash — ~ home, /tmp, /usr — si risolvono tramite la tabella di mount di Git Bash in ogni strumento; off = solo radici /c/.",
				"errs.label": "Traduzione dei percorsi d'errore",
				"errs.hint": "I percorsi Windows negli errori degli strumenti file e di run_code tornano in /c/ — incluso il messaggio catturato dal programma; off mantiene il testo originale.",
				"split.label": "Suddivisione pattern glob assoluti",
				"split.hint": "Un pattern glob assoluto si divide in percorso + pattern relativo; off lo passa invariato.",
				"code.label": "percorsi nei programmi run_code",
				"code.hint": "I letterali di percorso scritti in un programma run_code vengono tradotti con la stessa tabella di mount prima dell'esecuzione; commenti, template interpolati, $VAR e stringhe non di percorso restano intatti e qualsiasi incertezza lascia il programma invariato. Inoltre TEMP/TMP vengono forniti al programma: con env vuoto, os.tmpdir() su Windows restituisce undefined\\temp e scrive nel posto sbagliato.",
				"bashmiss.title": "Git Bash non trovato — i comandi non possono partire",
				"bashmiss.body": "Questo plugin accetta solo la bash fornita con Git for Windows (le bash WSL, MSYS2 e Cygwin sono rifiutate) e non ripiega mai su PowerShell/cmd: segnala il guasto invece di sostituire in silenzio una shell utilizzabile. Inserisci sotto il percorso completo di bash.exe, oppure installa prima Git for Windows.",
				"bashmiss.tried": "Posizioni provate in ordine (tutte rifiutate):",
				"bashmiss.download": "Scarica Git for Windows",
				"bashmiss.where": "Puoi anche compilarlo più tardi in «Impostazioni → Plugin → dsh-gitbash-shell → Percorso Git Bash»; il log di avvio dell'host contiene lo stesso elenco.",
				"bashmiss.close": "Chiudi",
				"sub.label": "Subagenti/compagni usano Git Bash",
				"sub.hint": "Attivo (predefinito): subagenti e membri del team — anche annidati — ricevono lo stesso dialetto del prompt, la stessa traduzione dei percorsi negli argomenti, lo stesso eco dei risultati e lo stesso fatto DSH_PATH_DIALECT dell'agente principale. Disattivo: valgono solo per l'agente principale e gli agenti delegati usano le semantiche di shell ufficiali (nessuna riscrittura del prompt, nessuna traduzione dei percorsi). Nota: dsh ha un solo esecutore di shell per processo, quindi il binario Git Bash resta globale; questo interruttore governa gli strati di dialetto e traduzione.",
				"term.label": "Adotta il terminale laterale",
				"term.hint": "Attivo per impostazione predefinita: su Windows la shell del «nuovo terminale» ufficiale viene impostata sul Git Bash rilevato (scritto nella riga ufficiale terminal-controller tramite l'editor di configurazione ufficiale). Senza questo dsh avvia il terminale con la shell predefinita dell'ambiente, e il bash nel PATH è spesso l'avviatore WSL — così il nuovo terminale gira su Ubuntu. La scrittura avviene solo se quella riga NON ha una shell propria; una scelta esplicita non viene mai sovrascritta, solo annotata nel log dell'host. I nuovi terminali la usano subito, quelli già aperti mantengono la loro shell.",
				"eol.label": "fine riga Git (come Linux)",
				"eol.hint": "I comandi git eseguiti dal modello seguono il comportamento Linux: core.autocrlf=input, core.eol=lf. Il tuo terminale e i .gitattributes del repo non vengono toccati.",
				"bash.label": "Percorso Git Bash",
				"bash.hint": "Percorso completo di un bash.exe personalizzato; vuoto = rilevamento automatico.",
				"bash.saveFailed": "Salvataggio non applicato: l’host ha rifiutato la scrittura — verifica che il percorso esista e sia la bash di Git for Windows, oppure leggi il log dell’host",
				"bash.save": "Salva",
				"bash.saved": "Salvato",
				"adopt.label": "Adotta il terminale laterale",
				"adopt.hint": "Attivo (predefinito) imposta Git Bash come shell del terminale di dsh-better-sidebar; disattivo ripristina il valore precedente e non tocca mai una scelta manuale. Lo strumento bash del modello non è interessato — lo fornisce il plugin stesso.",
				"sec.dedupe": "Deduplicazione con la modalità creazione PTC",
				"dedupe.label": "Voce duplicata «modalità creazione · Git Bash»",
				"dedupe.hint": "Quando dsh-ptc-cordis-preset è installato insieme, la sua «modalità creazione PTC» è già la versione Git Bash grazie al collegamento: essa e la «modalità creazione · Git Bash» di questo plugin indicano la stessa cosa. Attivando la deduplicazione questo plugin non registra più la propria voce (una in meno nell'elenco); disattivata per impostazione predefinita, lascia intatte le quattro varianti. Questo interruttore è lo stesso presente sulla scheda impostazioni dell'altra parte — entrambe le parti condividono un unico stato, una modifica su un lato si sincronizza subito sull'altro. Visibile solo quando dsh-ptc-cordis-preset è installato.",
				"sec.python": "Backend run_code (Python sperimentale)",
				"python.label": "Backend run_code",
				"python.on": "Python (sperimentale)",
				"python.off": "Node / TypeScript (predefinito)",
				"python.hint": "Disattivato (predefinito) run_code usa il backend ufficiale Node/TypeScript, identico byte per byte alla composizione ptc distribuita; attivandolo dsh passa al backend CPython sperimentale (@deepseek-ai/dsh-experimental-ptc-runtime-python): lingua, prompt SDK generato e presentazione di run_code passano a Python. Richiede POSIX e CPython ≥ 3.10 (non disponibile su Windows) ed è incompatibile con lo strumento workflow — anche la composizione Python ufficiale disattiva workflow, quindi il lato workflow di tutte e quattro le varianti resta spento finché è attivo (il tuo valore viene conservato e torna alla disattivazione). Ha effetto dopo il riavvio di dsh; è lo stesso interruttore sulla scheda di dsh-ptc-cordis-preset — entrambi i lati condividono un unico stato. Visibile solo quando dsh-ptc-cordis-preset è installato. Se l'attivazione non ha effetto, il motivo è nel log di avvio di dsh.",
				"python.degraded": "backend non disponibile, resta Node (motivo nel log di avvio di dsh)",
				"python.blocked": "Questo host è Windows: il backend Python sperimentale supporta solo POSIX, l'interruttore non è disponibile.",
			},
			/* locale: ja */
			"ja": {
				"title": "Git Bash パス方言",
				"cardDesc": "すべてのツールで /c/ POSIX パス形式に統一(既定ではオン)",
				"state.label": "現在の状態",
				"state.on": "有効",
				"state.off": "無効",
				"switch.on": "有効にする",
				"switch.off": "無効にする",
				"error": "書き込みに失敗しました",
				"hint": "有効にすると、すべてのツール(bash コマンドと workdir、read/write/edit/read_image/glob/grep と present のパス引数)が MSYS ドライブルートの POSIX パス(/c/Users/...)を使います。bash のネイティブな習慣——ホームの ~、/tmp、/dev/null、/usr——も、bash 自身が解決するのとまったく同じようにすべてのツールで動作し、パスフィールドはホストが自動的に変換します。無効にすると dsh 本来の動作(ファイルツールは Windows パス)に戻ります。bash はプラグインがインストールされている限り常に Git Bash で、このスイッチの影響を受けません。",
				"sec.dialect": "パス方言",
				"sec.terminal": "サイドバーターミナル",
				"mnts.label": "仮想パスマウント",
				"mnts.hint": "bash 固有の習慣——~ ホーム、/tmp、/usr——は Git Bash のマウントテーブルで全ツールに解決;オフなら /c/ ドライブルートのみ。",
				"errs.label": "エラーパス翻訳",
				"errs.hint": "ファイルツールと run_code のエラー内の Windows パスを /c/ 形式に書き戻します(プログラムが捕捉したメッセージも含む);オフなら原文維持。",
				"split.label": "glob 絶対パターン分割",
				"split.hint": "絶対 glob パターンを path + 相対パターンに分割;オフならそのまま渡します。",
				"code.label": "run_code プログラム内のパス",
				"code.hint": "run_code プログラム内に書いた /c/... などのパスリテラルは実行前に同じマウント表で変換されます。コメント・補間テンプレート・$VAR・パス以外の文字列は変更せず、解析に不確かさがあればプログラム全体をそのまま実行します。 さらにプログラムに TEMP/TMP を渡します: 空の env では Windows の os.tmpdir() が undefined\\temp を返し、誤った場所に書き込みます。",
				"bashmiss.title": "Git Bash が見つかりません — コマンドを実行できません",
				"bashmiss.body": "本プラグインは Git for Windows 付属の bash のみを受け付け(WSL・MSYS2・Cygwin の bash は拒否)、PowerShell/cmd へフォールバックしません —— 動くシェルを黙って差し替えるのではなく、失敗として報告します。下に bash.exe のフルパスを入力するか、先に Git for Windows をインストールしてください。",
				"bashmiss.tried": "順に確認した場所(すべて拒否):",
				"bashmiss.download": "Git for Windows をダウンロード",
				"bashmiss.where": "後から「設定 → プラグイン → dsh-gitbash-shell → Git Bash パス」でも入力できます。host の起動ログにも同じ一覧があります。",
				"bashmiss.close": "閉じる",
				"sub.label": "サブエージェント/チームメンバーも Git Bash を使う",
				"sub.hint": "オン(既定):サブエージェントとチームメンバー(ネスト含む)は、メインエージェントと同じプロンプト方言・パス引数の翻訳・結果エコー・DSH_PATH_DIALECT の事実を受け取ります。オフ:これらはメインエージェントのみに適用され、委譲されたエージェントは公式の shell セマンティクスで動作します(プロンプト改写なし、パス翻訳なし)。なお dsh はプロセスごとに shell 実行器を 1 つだけ持つため、Git Bash バイナリ自体は常に全体共通です。このスイッチが制御するのは方言/翻訳の層です。",
				"term.label": "サイドバー端末を引き継ぐ",
				"term.hint": "既定でオン:Windows では公式の「新しいターミナル」の shell を検出した Git Bash に設定します(公式の設定エディター経由で公式 terminal-controller 行に書き込み)。これがないと dsh は環境既定の shell で端末を起動し、PATH の bash はしばしば WSL ランチャーなので新しい端末は Ubuntu で動きます。書き込むのはその行に独自の shell が**ない**ときだけです。明示的な選択は決して上書きせず、ホストログに記録するだけです。新しい端末には即時反映され、開いている端末はそのままです。",
				"eol.label": "Git の行末(Linux と同じ)",
				"eol.hint": "モデルが実行する git コマンドは Linux と同じ挙動になります: core.autocrlf=input、core.eol=lf。あなたのターミナルやリポジトリの .gitattributes は影響を受けません。",
				"bash.label": "Git Bash パス",
				"bash.hint": "カスタム bash.exe の完全パス;空欄なら自動検出。",
				"bash.saveFailed": "保存が反映されません:ホストがこの書き込みを拒否しました —— パスが存在し Git for Windows の bash か確認するか、ホストログを見てください",
				"bash.save": "保存",
				"bash.saved": "保存済み",
				"adopt.label": "サイドバーターミナルを引き継ぐ",
				"adopt.hint": "オン(既定)では dsh-better-sidebar のターミナルシェルに Git Bash を書き込みます。オフにすると以前の値へ戻し、手動で選択した設定には決して触れません。モデル側の bash ツールには影響しません——それはプラグイン本体が提供します。",
				"sec.dedupe": "PTC 創造モードとの重複排除",
				"dedupe.label": "「創造モード · Git Bash」の重複項目",
				"dedupe.hint": "dsh-ptc-cordis-preset を併用している場合、連携により相手の「PTC 創造モード」はすでに Git Bash 版であり、本プラグインの「創造モード · Git Bash」と同じものを指します。重複排除を有効にすると本プラグインは自前の項目を登録しなくなります(名簿が 1 件減ります)。既定は無効で、4 つのバリアントは変わりません。このスイッチは相手の設定カードにあるものと同一で、両側が同じ状態を共有し、どちらかで変更すればもう一方へ即座に同期されます。dsh-ptc-cordis-preset がインストールされているときだけ表示されます。",
				"sec.python": "run_code バックエンド(実験的 Python)",
				"python.label": "run_code バックエンド",
				"python.on": "Python(実験的)",
				"python.off": "Node / TypeScript(既定)",
				"python.hint": "オフ(既定)では run_code は公式の Node/TypeScript バックエンドを使い、公式 ptc 構成とバイト単位で一致します。オンにすると dsh の実験的 CPython バックエンド(@deepseek-ai/dsh-experimental-ptc-runtime-python)に切り替わり、run_code の言語・生成される SDK プロンプト・提示が Python に変わります。POSIX と CPython ≥ 3.10 が必要(Windows では利用不可)で、workflow ツールとは排他です —— 公式 Python 構成も workflow を無効化するため、オン期間中は 4 変体すべてで workflow 側が強制的にオフになります(ワークフロー設定値は保持され、オフに戻すと復帰)。変更は dsh の再起動後に有効です。これは dsh-ptc-cordis-preset のカードにある同じスイッチで、両側が同一状態を共有します。dsh-ptc-cordis-preset がインストールされているときだけ表示されます。 オンにしても効かない場合の理由は dsh の起動ログにあります。",
				"python.degraded": "バックエンド利用不可・現在も Node(理由は dsh の起動ログ)",
				"python.blocked": "このホストは Windows です。実験的 Python バックエンドは POSIX 専用のため、このスイッチは利用できません。",
			},
			/* locale: ko */
			"ko": {
				"title": "Git Bash 경로 방언",
				"cardDesc": "모든 도구에 하나의 /c/ POSIX 경로 형식 사용(기본값 켜짐)",
				"state.label": "현재 상태",
				"state.on": "사용",
				"state.off": "사용 안 함",
				"switch.on": "사용",
				"switch.off": "사용 안 함",
				"error": "쓰기 실패",
				"hint": "켜면 모든 도구(bash 명령과 workdir, read/write/edit/read_image/glob/grep 및 present의 경로 인수)가 MSYS 드라이브 루트 POSIX 경로(/c/Users/...)를 사용합니다. bash 고유 습관——홈의 ~, /tmp, /dev/null, /usr——도 bash 자신이 해석하는 그대로 모든 도구에서 작동하며 호스트가 경로 필드를 자동 변환합니다. 끄면 dsh 기본 동작(파일 도구에 Windows 경로 사용)으로 돌아갑니다. 플러그인이 설치되어 있는 동안 bash는 항상 Git Bash이며 이 스위치의 영향을 받지 않습니다.",
				"sec.dialect": "경로 방언",
				"sec.terminal": "사이드바 터미널",
				"mnts.label": "가상 경로 마운트",
				"mnts.hint": "bash 고유 습관——~ 홈, /tmp, /usr——은 Git Bash 마운트 테이블로 모든 도구에서 해석; 끄면 /c/ 드라이브 루트만.",
				"errs.label": "오류 경로 번역",
				"errs.hint": "파일 도구와 run_code 오류의 Windows 경로를 /c/ 형식으로 되돌립니다(프로그램이 잡은 메시지 포함); 끄면 원문 유지.",
				"split.label": "glob 절대 패턴 분할",
				"split.hint": "절대 glob 패턴을 path + 상대 패턴으로 분할; 끄면 그대로 전달.",
				"code.label": "run_code 프로그램 경로",
				"code.hint": "run_code 프로그램에 쓴 /c/... 경로 리터럴은 실행 전에 같은 마운트 표로 변환됩니다. 주석, 보간 템플릿, $VAR, 경로가 아닌 문자열은 그대로 두고, 스캔이 불확실하면 프로그램 전체를 그대로 둡니다. 또한 프로그램에 TEMP/TMP를 채워 줍니다: 빈 env에서 Windows의 os.tmpdir()는 undefined\\temp를 반환해 엉뚱한 곳에 씁니다.",
				"bashmiss.title": "Git Bash를 찾을 수 없음 — 명령을 실행할 수 없습니다",
				"bashmiss.body": "이 플러그인은 Git for Windows에 포함된 bash만 허용하며(WSL·MSYS2·Cygwin bash는 거부), PowerShell/cmd로 되돌아가지 않습니다 — 실행 가능한 셸을 조용히 바꿔치기하지 않고 실패를 그대로 알립니다. 아래에 bash.exe 전체 경로를 입력하거나 먼저 Git for Windows를 설치하세요.",
				"bashmiss.tried": "순서대로 확인한 위치(모두 거부):",
				"bashmiss.download": "Git for Windows 다운로드",
				"bashmiss.where": "나중에 «설정 → 플러그인 → dsh-gitbash-shell → Git Bash 경로»에서도 입력할 수 있습니다. host 시작 로그에도 같은 목록이 있습니다.",
				"bashmiss.close": "닫기",
				"sub.label": "서브에이전트/팀원도 Git Bash 사용",
				"sub.hint": "켬(기본): 서브에이전트와 팀원(중첩 포함)은 메인 에이전트와 동일한 프롬프트 방언, 경로 인자 번역, 결과 에코, DSH_PATH_DIALECT 사실을 받습니다. 끔: 이것들은 메인 에이전트에만 적용되고 위임된 에이전트는 공식 shell 의미로 동작합니다(프롬프트 재작성 없음, 경로 번역 없음). 참고로 dsh는 프로세스당 shell 실행기가 하나뿐이라 Git Bash 바이너리 자체는 항상 전역입니다. 이 스위치는 방언/번역 계층을 제어합니다.",
				"term.label": "사이드바 터미널 자동 인수",
				"term.hint": "기본 켜짐: Windows에서 공식 «새 터미널»의 shell을 감지된 Git Bash로 설정합니다(공식 구성 편집기를 통해 공식 terminal-controller 행에 기록). 이것이 없으면 dsh는 환경 기본 shell로 터미널을 시작하고, PATH의 bash는 흔히 WSL 런처라서 새 터미널이 Ubuntu로 실행됩니다. 해당 행에 자체 shell이 **없을 때만** 기록하며, 명시적 선택은 절대 덮어쓰지 않고 호스트 로그에만 남깁니다. 새 터미널에는 즉시 적용되고 이미 열린 터미널은 그대로입니다.",
				"eol.label": "Git 줄바꿈(Linux와 동일)",
				"eol.hint": "모델이 실행하는 git 명령은 Linux 동작을 따릅니다: core.autocrlf=input, core.eol=lf. 사용자의 터미널과 저장소의 .gitattributes는 영향을 받지 않습니다.",
				"bash.label": "Git Bash 경로",
				"bash.hint": "사용자 bash.exe 전체 경로; 비우면 자동 감지.",
				"bash.saveFailed": "저장이 반영되지 않았습니다: 호스트가 이 쓰기를 거부했습니다 — 경로가 존재하고 Git for Windows의 bash인지 확인하거나 호스트 로그를 보세요",
				"bash.save": "저장",
				"bash.saved": "저장됨",
				"adopt.label": "사이드바 터미널 인수",
				"adopt.hint": "켜짐(기본)이면 dsh-better-sidebar 터미널 셸에 Git Bash를 기록하고, 끄면 이전 값을 복원하며 수동으로 고른 설정은 절대 건드리지 않습니다. 모델 측 bash 도구에는 영향이 없습니다 — 플러그인이 직접 제공합니다.",
				"sec.dedupe": "PTC 창조 모드와 중복 제거",
				"dedupe.label": "«창조 모드 · Git Bash» 중복 항목",
				"dedupe.hint": "dsh-ptc-cordis-preset을 함께 설치하면 연동으로 인해 상대의 «PTC 창조 모드»가 이미 Git Bash 버전이므로, 그것과 이 플러그인의 «창조 모드 · Git Bash»는 같은 것을 가리킵니다. 중복 제거를 켜면 이 플러그인은 자기 항목을 더 이상 등록하지 않습니다(명부에서 하나 줄어듦). 기본값은 꺼짐이며 네 가지 변형은 그대로 유지됩니다. 이 스위치는 상대 설정 카드에 있는 바로 그 스위치입니다 — 양쪽이 같은 상태를 공유하므로 어느 쪽에서 바꾸든 다른 쪽에 즉시 동기화됩니다. dsh-ptc-cordis-preset이 설치되어 있을 때만 표시됩니다.",
				"sec.python": "run_code 백엔드(실험적 Python)",
				"python.label": "run_code 백엔드",
				"python.on": "Python(실험적)",
				"python.off": "Node / TypeScript(기본)",
				"python.hint": "끄면(기본) run_code는 공식 Node/TypeScript 백엔드를 사용해 공식 ptc 구성과 바이트 단위로 일치합니다. 켜면 dsh의 실험적 CPython 백엔드(@deepseek-ai/dsh-experimental-ptc-runtime-python)로 바뀌어 run_code의 언어, 생성되는 SDK 프롬프트, 도구 표시가 Python으로 전환됩니다. POSIX와 CPython ≥ 3.10이 필요하며(Windows에서는 사용 불가) workflow 도구와 상호 배타적입니다 — 공식 Python 구성도 workflow를 끄므로 켜져 있는 동안 네 변형 모두 workflow 쪽이 강제로 꺼집니다(워크플로 설정값은 유지되고 끄면 복구됩니다). 변경은 dsh 재시작 후 적용됩니다. 이 스위치는 dsh-ptc-cordis-preset 카드에 있는 바로 그 스위치이며 양쪽이 같은 상태를 공유합니다. dsh-ptc-cordis-preset이 설치되어 있을 때만 표시됩니다. 켠 뒤에도 적용되지 않으면 그 이유는 dsh 시작 로그에 있습니다.",
				"python.degraded": "백엔드 사용 불가, 여전히 Node(이유는 dsh 시작 로그)",
				"python.blocked": "이 호스트는 Windows입니다. 실험적 Python 백엔드는 POSIX만 지원하므로 이 스위치를 쓸 수 없습니다.",
			},
			/* locale: nl */
			"nl": {
				"title": "Git Bash-paddialect",
				"cardDesc": "Eén /c/ POSIX-padvorm voor alle tools (standaard aan)",
				"state.label": "Huidige status",
				"state.on": "Ingeschakeld",
				"state.off": "Uitgeschakeld",
				"switch.on": "Inschakelen",
				"switch.off": "Uitschakelen",
				"error": "schrijven mislukt",
				"hint": "Ingeschakeld: alle tools (bash-opdrachten en workdir, padargumenten van read/write/edit/read_image/glob/grep en present) gebruiken POSIX-paden vanaf de MSYS-schijfwortel (/c/Users/...); bash-eigen gewoonten — ~ voor de home-map, /tmp, /dev/null, /usr — werken in elke tool precies zoals bash ze zelf oplost, en de host vertaalt de padvelden automatisch. Uitgeschakeld herstelt het oorspronkelijke dsh-gedrag (Windows-paden voor bestandstools). Bash is altijd Git Bash zolang de plugin is geïnstalleerd; deze schakelaar bepaalt alleen het paddialect tussen de tools.",
				"sec.dialect": "Paddialect",
				"sec.terminal": "Zijbalkterminal",
				"mnts.label": "Virtuele pad-mounts",
				"mnts.hint": "Bash-eigen gewoonten — ~ home, /tmp, /usr — lossen op via de Git Bash-mount tabel in elke tool; uit = alleen /c/-schijfwortels.",
				"errs.label": "Foutpad-vertaling",
				"errs.hint": "Windows-paden in fouten van bestandstools en run_code keren terug als /c/ — ook het bericht dat een programma opvangt; uit behoudt de brontekst.",
				"split.label": "Glob absoluut-patroon-splitsing",
				"split.hint": "Een absoluut glob-patroon splitst in pad + relatief patroon; uit geeft het ongewijzigd door.",
				"code.label": "paden in run_code-programma's",
				"code.hint": "Pad-literalen in een run_code-programma worden vóór uitvoering via dezelfde mounttabel vertaald; opmerkingen, geïnterpoleerde templates, $VAR's en niet-pad-strings blijven ongemoeid, en bij twijfel blijft het hele programma ongewijzigd. Ook worden TEMP/TMP voor het programma gezet: met een lege env geeft os.tmpdir() op Windows undefined\\temp en schrijft het op de verkeerde plek.",
				"bashmiss.title": "Git Bash niet gevonden — opdrachten kunnen niet lopen",
				"bashmiss.body": "Deze plugin accepteert alleen de bash van Git for Windows (bash van WSL, MSYS2 en Cygwin wordt geweigerd) en valt nooit terug op PowerShell/cmd — hij meldt de storing in plaats van stil iets werkends in te zetten. Vul hieronder het volledige pad naar bash.exe in, of installeer eerst Git for Windows.",
				"bashmiss.tried": "In volgorde geprobeerd (alle geweigerd):",
				"bashmiss.download": "Git for Windows downloaden",
				"bashmiss.where": "Je kunt dit later ook invullen onder ‘Instellingen → Plugins → dsh-gitbash-shell → Git Bash-pad’; het opstartlogboek van de host bevat dezelfde lijst.",
				"bashmiss.close": "Sluiten",
				"sub.label": "Subagenten/teammaten gebruiken Git Bash",
				"sub.hint": "Aan (standaard): subagenten en teamleden — ook geneste — krijgen hetzelfde promptdialect, dezelfde padargument-vertaling, dezelfde resultaat-echo en hetzelfde DSH_PATH_DIALECT-feit als de hoofdagent. Uit: die gelden alleen voor de hoofdagent en gedelegeerde agenten draaien met de officiële shell-semantiek (geen promptherschrijving, geen padvertaling). Let op: dsh heeft één shell-uitvoerder per proces, dus het Git Bash-binary blijft globaal; deze schakelaar beheert de dialect-/vertaallagen.",
				"term.label": "Zijbalkterminal overnemen",
				"term.hint": "Standaard aan: op Windows wordt de shell van de officiële ‘nieuwe terminal’ gezet op de gevonden Git Bash (geschreven in de officiële terminal-controller-regel via de officiële configuratie-editor). Zonder dit start dsh de terminal met de omgevings-standaardshell, en de bash in PATH is vaak de WSL-starter — dan draait de nieuwe terminal Ubuntu. Er wordt alleen geschreven als die regel GEEN eigen shell heeft; een expliciete keuze wordt nooit overschreven, alleen in het hostlogboek vermeld. Nieuwe terminals gebruiken het direct, al geopende behouden hun shell.",
				"eol.label": "Git regeleinden (zoals Linux)",
				"eol.hint": "Git-opdrachten die het model uitvoert volgen Linux-gedrag: core.autocrlf=input, core.eol=lf. Je eigen terminal en de .gitattributes van een repo blijven onaangetast.",
				"bash.label": "Git Bash-pad",
				"bash.hint": "Volledig pad van een aangepaste bash.exe; leeg = automatisch detecteren.",
				"bash.saveFailed": "Opslaan had geen effect: de host weigerde deze schrijfactie — controleer of het pad bestaat en naar Git for Windows’ bash wijst, of lees het hostlogboek",
				"bash.save": "Opslaan",
				"bash.saved": "Opgeslagen",
				"adopt.label": "Zijbalkterminal overnemen",
				"adopt.hint": "Aan (standaard) schrijft Git Bash als shell van de dsh-better-sidebar-terminal; uit herstelt de vorige waarde en raakt nooit een handmatige keuze aan. De bash-tool van het model blijft buiten beschouwing — die levert de plugin zelf.",
				"sec.dedupe": "Deduplicatie met de PTC-creatiemodus",
				"dedupe.label": "Dubbele vermelding ‘creatiemodus · Git Bash’",
				"dedupe.hint": "Als dsh-ptc-cordis-preset meegaat, is zijn ‘PTC-creatiemodus’ door de koppeling al de Git Bash-variant, dus die en de ‘creatiemodus · Git Bash’ van deze plugin wijzen op hetzelfde. Met deduplicatie aan registreert deze plugin die eigen vermelding niet meer (één minder in de lijst); standaard uit, waardoor de vier varianten ongewijzigd blijven. Deze schakelaar is dezelfde als op de instellingenkaart van de andere kant — beide kanten delen één status, een wijziging aan één kant synct direct naar de andere. Alleen zichtbaar zolang dsh-ptc-cordis-preset is geïnstalleerd.",
				"sec.python": "run_code-backend (experimenteel Python)",
				"python.label": "run_code-backend",
				"python.on": "Python (experimenteel)",
				"python.off": "Node / TypeScript (standaard)",
				"python.hint": "Uit (standaard) gebruikt run_code de officiële Node/TypeScript-backend, byte voor byte gelijk aan de meegeleverde ptc-compositie; aan schakelt dsh over op de experimentele CPython-backend (@deepseek-ai/dsh-experimental-ptc-runtime-python), waardoor taal, gegenereerde SDK-prompt en weergave van run_code naar Python gaan. Vereist POSIX en CPython ≥ 3.10 (niet beschikbaar op Windows) en is onverenigbaar met de workflow-tool — de officiële Python-compositie schakelt workflow ook uit, dus de workflow-kant van alle vier varianten blijft uit zolang dit aan staat (je workflow-waarde blijft bewaard en keert terug als je het uitzet). Werkt na een herstart van dsh; dit is dezelfde schakelaar op de kaart van dsh-ptc-cordis-preset — beide kanten delen één status. Alleen zichtbaar zolang dsh-ptc-cordis-preset is geïnstalleerd. Werkt het aanzetten niet, dan staat de reden in het opstartlogboek van dsh.",
				"python.degraded": "backend niet beschikbaar, nog steeds Node (reden in het dsh-opstartlogboek)",
				"python.blocked": "Deze host is Windows: de experimentele Python-backend ondersteunt alleen POSIX, deze schakelaar is niet beschikbaar.",
			},
			/* locale: pl */
			"pl": {
				"title": "Dialekt ścieżek Git Bash",
				"cardDesc": "Jedna postać ścieżki POSIX /c/ dla wszystkich narzędzi (domyślnie włączone)",
				"state.label": "Bieżący stan",
				"state.on": "Włączone",
				"state.off": "Wyłączone",
				"switch.on": "Włącz",
				"switch.off": "Wyłącz",
				"error": "zapis nie powiódł się",
				"hint": "Po włączeniu: wszystkie narzędzia (polecenia bash i workdir, argumenty ścieżek w read/write/edit/read_image/glob/grep i w present) używają ścieżek POSIX od korzenia dysku MSYS (/c/Users/...); natywne nawyki basha — ~ dla katalogu domowego, /tmp, /dev/null, /usr — działają w każdym narzędziu dokładnie tak, jak rozwiązuje je sam bash, a host automatycznie tłumaczy pola ścieżek. Wyłączenie przywraca natywne zachowanie dsh (ścieżki Windows dla narzędzi plikowych). Bash jest zawsze Git Bash, dopóki wtyczka jest zainstalowana; ten przełącznik reguluje wyłącznie dialekt ścieżek między narzędziami.",
				"sec.dialect": "Dialekt ścieżek",
				"sec.terminal": "Terminal boczny",
				"mnts.label": "Wirtualne montowanie ścieżek",
				"mnts.hint": "Natywne nawyki basha — ~ home, /tmp, /usr — rozwiązują się przez tablicę montowań Git Bash w każdym narzędziu; wył. = tylko korzenie /c/.",
				"errs.label": "Tłumaczenie ścieżek błędów",
				"errs.hint": "Ścieżki Windows w błędach narzędzi plikowych i run_code wracają jako /c/ — także komunikat przechwycony przez program; wył. zachowuje oryginalny tekst.",
				"split.label": "Podział wzorców glob absolutnych",
				"split.hint": "Absolutny wzorzec glob dzieli się na ścieżkę + wzorzec względny; wył. przekazuje bez zmian.",
				"code.label": "ścieżki w programach run_code",
				"code.hint": "Literały ścieżek w programie run_code są tłumaczone przez tę samą tabelę montowania przed uruchomieniem; komentarze, szablony z interpolacją, $VAR i ciągi niebędące ścieżkami pozostają nietknięte, a każda niepewność pozostawia program bez zmian. Dodatkowo ustawiane są TEMP/TMP dla programu: przy pustym env Windows zwraca z os.tmpdir() undefined\\temp i zapisuje w złym miejscu.",
				"bashmiss.title": "Nie znaleziono Git Bash — polecenia nie mogą działać",
				"bashmiss.body": "Ta wtyczka akceptuje wyłącznie bash dołączony do Git for Windows (bash z WSL, MSYS2 i Cygwin jest odrzucany) i nigdy nie cofa się do PowerShell/cmd — zgłasza awarię zamiast po cichu podstawić działającą powłokę. Wpisz poniżej pełną ścieżkę do bash.exe albo najpierw zainstaluj Git for Windows.",
				"bashmiss.tried": "Sprawdzone po kolei (wszystkie odrzucone):",
				"bashmiss.download": "Pobierz Git for Windows",
				"bashmiss.where": "Możesz to też wpisać później w „Ustawienia → Wtyczki → dsh-gitbash-shell → Ścieżka Git Bash”; log startowy hosta zawiera tę samą listę.",
				"bashmiss.close": "Zamknij",
				"sub.label": "Subagenci/członkowie zespołu używają Git Bash",
				"sub.hint": "Wł. (domyślnie): subagenci i członkowie zespołu — także zagnieżdżeni — otrzymują ten sam dialekt podpowiedzi, tłumaczenie argumentów ścieżek, echo wyników i fakt DSH_PATH_DIALECT co agent główny. Wył.: dotyczy to tylko agenta głównego, a agenci delegowani działają według oficjalnej semantyki powłoki (bez przepisywania podpowiedzi i tłumaczenia ścieżek). Uwaga: dsh ma jeden executor powłoki na proces, więc binarka Git Bash pozostaje globalna; ten przełącznik steruje warstwami dialektu i tłumaczenia.",
				"term.label": "Przejmij terminal boczny",
				"term.hint": "Domyślnie włączone: w Windows shell oficjalnego „nowego terminala“ jest ustawiany na wykryty Git Bash (zapis do oficjalnego wiersza terminal-controller przez oficjalny edytor konfiguracji). Bez tego dsh uruchamia terminal z domyślnym shellem środowiska, a bash w PATH to często launcher WSL — nowy terminal działa wtedy w Ubuntu. Zapis następuje tylko wtedy, gdy ten wiersz NIE ma własnego shella; wyraźny wybór nigdy nie jest nadpisywany, trafia jedynie do logu hosta. Nowe terminale korzystają od razu, otwarte zachowują swój shell.",
				"eol.label": "końce linii Git (jak w Linuksie)",
				"eol.hint": "Polecenia git uruchamiane przez model działają jak w Linuksie: core.autocrlf=input, core.eol=lf. Twój terminal i .gitattributes repozytorium pozostają nietknięte.",
				"bash.label": "Ścieżka Git Bash",
				"bash.hint": "Pełna ścieżka własnego bash.exe; puste = autodetekcja.",
				"bash.saveFailed": "Zapis nie został zastosowany: host odrzucił ten zapis — sprawdź, czy ścieżka istnieje i wskazuje bash Git for Windows, albo przeczytaj log hosta",
				"bash.save": "Zapisz",
				"bash.saved": "Zapisano",
				"adopt.label": "Przejmij terminal boczny",
				"adopt.hint": "Włączony (domyślnie) zapisuje Git Bash jako shell terminala dsh-better-sidebar; wyłączony przywraca poprzednią wartość i nigdy nie narusza ręcznie wybranego ustawienia. Narzędzie bash po stronie modelu jest nietknięte — zapewnia je sama wtyczka.",
				"sec.dedupe": "Deduplikacja z trybem tworzenia PTC",
				"dedupe.label": "Zduplikowany wpis „tryb tworzenia · Git Bash”",
				"dedupe.hint": "Gdy dsh-ptc-cordis-preset jest zainstalowany razem, jego „tryb tworzenia PTC” jest już dzięki powiązaniu wersją Git Bash, więc on i „tryb tworzenia · Git Bash” tej wtyczki oznaczają to samo. Po włączeniu deduplikacji ta wtyczka nie rejestruje już własnego wpisu (o jeden mniej w wykazie); domyślnie wyłączona, dzięki czemu cztery warianty pozostają bez zmian. Ten przełącznik to ten sam przełącznik na karcie ustawień drugiej strony — obie strony dzielą jeden stan, zmiana po jednej stronie natychmiast synchronizuje się z drugą. Widoczny tylko, gdy dsh-ptc-cordis-preset jest zainstalowany.",
				"sec.python": "Backend run_code (eksperymentalny Python)",
				"python.label": "Backend run_code",
				"python.on": "Python (eksperymentalny)",
				"python.off": "Node / TypeScript (domyślnie)",
				"python.hint": "Wyłączony (domyślnie) run_code używa oficjalnego backendu Node/TypeScript, identycznego co do bajtu z dostarczaną kompozycją ptc; włączenie przełącza dsh na eksperymentalny backend CPython (@deepseek-ai/dsh-experimental-ptc-runtime-python), więc język, generowany prompt SDK i prezentacja run_code przechodzą na Python. Wymaga POSIX i CPython ≥ 3.10 (niedostępny w Windows) i jest wykluczający z narzędziem workflow — oficjalna kompozycja Python również wyłącza workflow, więc strona workflow wszystkich czterech wariantów pozostaje wyłączona, dopóki to jest włączone (twoje ustawienie workflow jest zachowane i wraca po wyłączeniu). Zmiana działa po restarcie dsh; to ten sam przełącznik na karcie dsh-ptc-cordis-preset — obie strony dzielą jeden stan. Widoczny tylko, gdy dsh-ptc-cordis-preset jest zainstalowany. Jeśli włączenie nie przyniesie skutku, powód znajdziesz w logu startowym dsh.",
				"python.degraded": "backend niedostępny, nadal Node (powód w logu startowym dsh)",
				"python.blocked": "Ten host to Windows: eksperymentalny backend Python obsługuje tylko POSIX, przełącznik jest niedostępny.",
			},
			/* locale: pt */
			"pt": {
				"title": "Dialeto de caminhos do Git Bash",
				"cardDesc": "Uma única forma de caminho POSIX /c/ para todas as ferramentas (ativada por padrão)",
				"state.label": "Estado atual",
				"state.on": "Ativada",
				"state.off": "Desativada",
				"switch.on": "Ativar",
				"switch.off": "Desativar",
				"error": "falha ao gravar",
				"hint": "Ativada: todas as ferramentas (comandos bash e workdir, argumentos de caminho de read/write/edit/read_image/glob/grep e de present) usam caminhos POSIX a partir da raiz da unidade MSYS (/c/Users/...); os hábitos nativos do bash — ~ para a pasta pessoal, /tmp, /dev/null, /usr — funcionam em cada ferramenta exatamente como o próprio bash os resolve, e o host traduz os campos de caminho automaticamente. Desativada restaura o comportamento nativo do dsh (caminhos Windows para as ferramentas de arquivo). O bash é sempre Git Bash enquanto o plugin estiver instalado; este interruptor rege apenas o dialeto de caminhos entre ferramentas.",
				"sec.dialect": "Dialeto de caminhos",
				"sec.terminal": "Terminal lateral",
				"mnts.label": "Montagens de caminhos virtuais",
				"mnts.hint": "Hábitos nativos do bash — ~ home, /tmp, /usr — resolvem pela tabela de montagens do Git Bash em cada ferramenta; desligado = só raízes /c/.",
				"errs.label": "Tradução de caminhos de erro",
				"errs.hint": "Caminhos Windows nos erros das ferramentas e do run_code voltam como /c/ — incluindo a mensagem capturada pelo programa; desligado mantém o texto original.",
				"split.label": "Divisão de padrão glob absoluto",
				"split.hint": "Um padrão glob absoluto divide em caminho + padrão relativo; desligado passa-o inalterado.",
				"code.label": "caminhos em programas run_code",
				"code.hint": "Literais de caminho escritos num programa run_code são traduzidos pela mesma tabela de montagem antes da execução; comentários, modelos interpolados, $VAR e strings que não são caminhos ficam intactos, e qualquer incerteza deixa o programa como está. Também são definidos TEMP/TMP para o programa: com env vazio, os.tmpdir() no Windows devolve undefined\\temp e grava no lugar errado.",
				"bashmiss.title": "Git Bash não encontrado — os comandos não podem correr",
				"bashmiss.body": "Este plugin só aceita o bash incluído no Git for Windows (bash do WSL, MSYS2 e Cygwin são recusados) e nunca recorre ao PowerShell/cmd — reporta a falha em vez de substituir silenciosamente por algo executável. Introduza abaixo o caminho completo do bash.exe, ou instale primeiro o Git for Windows.",
				"bashmiss.tried": "Locais testados por ordem (todos recusados):",
				"bashmiss.download": "Transferir o Git for Windows",
				"bashmiss.where": "Também pode preencher mais tarde em «Definições → Plugins → dsh-gitbash-shell → Caminho do Git Bash»; o registo de arranque do host tem a mesma lista.",
				"bashmiss.close": "Fechar",
				"sub.label": "Subagentes/membros da equipa usam Git Bash",
				"sub.hint": "Ligado (padrão): subagentes e membros da equipa — incluindo aninhados — recebem o mesmo dialeto de prompt, tradução de caminhos nos argumentos, eco de resultados e o mesmo facto DSH_PATH_DIALECT que o agente principal. Desligado: isso aplica-se apenas ao agente principal e os agentes delegados correm com a semântica oficial da shell (sem reescrita do prompt nem tradução de caminhos). Nota: o dsh tem um único executor de shell por processo, pelo que o binário Git Bash continua global; este interruptor governa as camadas de dialeto e tradução.",
				"term.label": "Adotar o terminal lateral",
				"term.hint": "Ativado por predefinição: no Windows, o shell do «novo terminal» oficial é definido para o Git Bash detetado (escrito na linha oficial terminal-controller através do editor de configuração oficial). Sem isto, o dsh inicia o terminal com o shell predefinido do ambiente, e o bash no PATH é muitas vezes o lançador WSL — o novo terminal corre então em Ubuntu. Só escreve quando essa linha NÃO tem shell próprio; uma escolha explícita nunca é substituída, apenas registada no log do anfitrião. Os novos terminais usam-no de imediato, os já abertos mantêm o seu shell.",
				"eol.label": "fins de linha do Git (como no Linux)",
				"eol.hint": "Os comandos git executados pelo modelo seguem o comportamento do Linux: core.autocrlf=input, core.eol=lf. O seu terminal e os .gitattributes do repositório não são afetados.",
				"bash.label": "Caminho do Git Bash",
				"bash.hint": "Caminho completo de um bash.exe personalizado; vazio = detecção automática.",
				"bash.saveFailed": "A gravação não teve efeito: o anfitrião recusou esta escrita — confirme que o caminho existe e é o bash do Git for Windows, ou veja o registo do anfitrião",
				"bash.save": "Salvar",
				"bash.saved": "Salvo",
				"adopt.label": "Adotar o terminal lateral",
				"adopt.hint": "Ligado (padrão) grava o Git Bash como shell do terminal do dsh-better-sidebar; desligado restaura o valor anterior e nunca altera uma escolha manual. A ferramenta bash do modelo não é afetada — o próprio plug-in a fornece.",
				"sec.dedupe": "Desduplicação com o modo de criação PTC",
				"dedupe.label": "Entrada duplicada «modo de criação · Git Bash»",
				"dedupe.hint": "Quando o dsh-ptc-cordis-preset está instalado em conjunto, o «modo de criação PTC» dele já é a versão Git Bash graças à integração, então ele e o «modo de criação · Git Bash» deste plugin apontam para a mesma coisa. Com a desduplicação ligada, este plugin deixa de registar a sua própria entrada (uma a menos na lista); desligada por padrão, mantendo as quatro variantes inalteradas. Este interruptor é o mesmo do cartão de definições do outro lado — os dois lados partilham um único estado, e uma alteração de um lado sincroniza imediatamente com o outro. Só aparece quando o dsh-ptc-cordis-preset está instalado.",
				"sec.python": "Backend run_code (Python experimental)",
				"python.label": "Backend run_code",
				"python.on": "Python (experimental)",
				"python.off": "Node / TypeScript (padrão)",
				"python.hint": "Desligado (padrão), o run_code usa o backend oficial Node/TypeScript, idêntico byte a byte à composição ptc distribuída; ligado, o dsh passa para o backend CPython experimental (@deepseek-ai/dsh-experimental-ptc-runtime-python), e a linguagem, o prompt SDK gerado e a apresentação do run_code passam para Python. Exige POSIX e CPython ≥ 3.10 (indisponível no Windows) e é incompatível com a ferramenta workflow — a composição Python oficial também desativa workflow, pelo que o lado workflow das quatro variantes fica desligado enquanto isto estiver ligado (o teu valor é mantido e regressa ao desligar). Produz efeito após reiniciar o dsh; é o mesmo interruptor no cartão do dsh-ptc-cordis-preset — os dois lados partilham um único estado. Só aparece quando o dsh-ptc-cordis-preset está instalado. Se ligar não tiver efeito, o motivo está no registo de arranque do dsh.",
				"python.degraded": "backend indisponível, continua Node (motivo no registo de arranque do dsh)",
				"python.blocked": "Este anfitrião é Windows: o backend Python experimental só suporta POSIX, pelo que este interruptor não está disponível.",
			},
			/* locale: ru */
			"ru": {
				"title": "Диалект путей Git Bash",
				"cardDesc": "Единый POSIX-формат путей /c/ для всех инструментов (по умолчанию включено)",
				"state.label": "Текущее состояние",
				"state.on": "Включено",
				"state.off": "Выключено",
				"switch.on": "Включить",
				"switch.off": "Выключить",
				"error": "не удалось записать",
				"hint": "Включено: все инструменты (команды bash и workdir, аргументы путей read/write/edit/read_image/glob/grep и present) используют POSIX-пути от корня диска MSYS (/c/Users/...); собственные привычки bash — ~ для домашнего каталога, /tmp, /dev/null, /usr — работают в каждом инструменте ровно так, как их разрешает сам bash, а хост автоматически преобразует поля путей. Выключение возвращает исходное поведение dsh (пути Windows для файловых инструментов). Пока плагин установлен, bash всегда остаётся Git Bash; этот переключатель управляет только диалектом путей между инструментами.",
				"sec.dialect": "Диалект путей",
				"sec.terminal": "Терминал боковой панели",
				"mnts.label": "Виртуальные монтирования путей",
				"mnts.hint": "Собственные привычки bash — ~ домашний, /tmp, /usr — разрешаются через таблицу монтирований Git Bash в каждом инструменте; выкл = только корни /c/.",
				"errs.label": "Перевод путей в ошибках",
				"errs.hint": "Пути Windows в ошибках файловых инструментов и run_code возвращаются как /c/ — включая сообщение, перехваченное программой; выкл сохраняет исходный текст.",
				"split.label": "Разбор абсолютного glob-шаблона",
				"split.hint": "Абсолютный glob-шаблон разбивается на path + относительный шаблон; выкл передаёт как есть.",
				"code.label": "пути в программах run_code",
				"code.hint": "Строковые литералы путей в программе run_code переводятся по той же таблице монтирования до запуска; комментарии, шаблоны с интерполяцией, $VAR и строки-не-пути не трогаются, а при любой неопределённости программа остаётся без изменений. Также программе задаются TEMP/TMP: при пустом env в Windows os.tmpdir() возвращает undefined\\temp и запись идёт не туда.",
				"bashmiss.title": "Git Bash не найден — команды не выполняются",
				"bashmiss.body": "Плагин принимает только bash из состава Git for Windows (bash из WSL, MSYS2 и Cygwin отклоняется) и никогда не откатывается к PowerShell/cmd — он сообщает об ошибке, а не подменяет оболочку молча. Укажите ниже полный путь к bash.exe или сначала установите Git for Windows.",
				"bashmiss.tried": "Проверены по порядку (все отклонены):",
				"bashmiss.download": "Скачать Git for Windows",
				"bashmiss.where": "Это же можно заполнить позже в «Настройки → Плагины → dsh-gitbash-shell → Путь Git Bash»; тот же список есть в журнале запуска хоста.",
				"bashmiss.close": "Закрыть",
				"sub.label": "Субагенты и участники команды используют Git Bash",
				"sub.hint": "Вкл. (по умолчанию): субагенты и участники команды — включая вложенных — получают тот же диалект подсказки, перевод путей в аргументах, эхо результатов и факт DSH_PATH_DIALECT, что и главный агент. Выкл.: это применяется только к главному агенту, а делегированные агенты работают с официальной семантикой оболочки (без перезаписи подсказки и перевода путей). Учтите: в dsh один исполнитель оболочки на процесс, поэтому сам бинарник Git Bash остаётся общим; этот переключатель управляет слоями диалекта и перевода.",
				"term.label": "Перенимать боковой терминал",
				"term.hint": "Включено по умолчанию: в Windows shell официального «нового терминала» выставляется в найденный Git Bash (запись в официальную строку terminal-controller через официальный редактор конфигурации). Без этого dsh запускает терминал с shell по умолчанию из окружения, а bash в PATH часто оказывается лаунчером WSL — тогда новый терминал работает в Ubuntu. Запись происходит только если у этой строки НЕТ собственного shell; явный выбор никогда не перезаписывается, о нём лишь сообщается в журнале хоста. Новые терминалы подхватывают сразу, уже открытые сохраняют свой shell.",
				"eol.label": "переводы строк Git (как в Linux)",
				"eol.hint": "Команды git, запускаемые моделью, ведут себя как в Linux: core.autocrlf=input, core.eol=lf. Ваш терминал и .gitattributes репозитория не затрагиваются.",
				"bash.label": "Путь Git Bash",
				"bash.hint": "Полный путь кастомного bash.exe; пусто = автоопределение.",
				"bash.saveFailed": "Сохранение не применилось: хост отклонил эту запись — проверьте, что путь существует и указывает на bash из Git for Windows, или посмотрите журнал хоста",
				"bash.save": "Сохранить",
				"bash.saved": "Сохранено",
				"adopt.label": "Перехватывать терминал боковой панели",
				"adopt.hint": "Включено (по умолчанию): Git Bash записывается как shell терминала dsh-better-sidebar; выключено — восстанавливается прежнее значение, вручную выбранные настройки не трогаются. Инструмент bash у модели не затронут — его предоставляет сам плагин.",
				"sec.dedupe": "Удаление дубликата с творческим режимом PTC",
				"dedupe.label": "Дублирующая запись «творческий режим · Git Bash»",
				"dedupe.hint": "Если dsh-ptc-cordis-preset установлен вместе, его «творческий режим PTC» благодаря связке уже является версией Git Bash, поэтому он и «творческий режим · Git Bash» этого плагина указывают на одно и то же. При включённом удалении дубликатов плагин больше не регистрирует свою запись (в списке на одну меньше); по умолчанию выключено, четыре варианта остаются без изменений. Этот переключатель — тот же самый на карточке настроек у второй стороны: обе стороны делят одно состояние, изменение с любой стороны сразу синхронизируется с другой. Показывается только когда установлен dsh-ptc-cordis-preset.",
				"sec.python": "Бэкенд run_code (экспериментальный Python)",
				"python.label": "Бэкенд run_code",
				"python.on": "Python (экспериментальный)",
				"python.off": "Node / TypeScript (по умолчанию)",
				"python.hint": "Выключено (по умолчанию) — run_code использует официальный бэкенд Node/TypeScript, побайтово совпадающий с поставляемой композицией ptc; при включении dsh переходит на экспериментальный бэкенд CPython (@deepseek-ai/dsh-experimental-ptc-runtime-python), и язык, сгенерированная подсказка SDK и представление run_code переключаются на Python. Требуются POSIX и CPython ≥ 3.10 (в Windows недоступно), и это несовместимо с инструментом workflow — официальная композиция Python тоже отключает workflow, поэтому сторона workflow всех четырёх вариантов остаётся выключенной, пока это включено (ваша настройка workflow сохраняется и возвращается после выключения). Изменение действует после перезапуска dsh; это тот же переключатель на карточке dsh-ptc-cordis-preset — обе стороны делят одно состояние. Показывается только когда установлен dsh-ptc-cordis-preset. Если включение не подействовало, причина указана в журнале запуска dsh.",
				"python.degraded": "бэкенд недоступен, по-прежнему Node (причина в журнале запуска dsh)",
				"python.blocked": "Этот хост — Windows: экспериментальный бэкенд Python поддерживает только POSIX, переключатель недоступен.",
			},
			/* locale: sv */
			"sv": {
				"title": "Git Bash-sökvägsdialekt",
				"cardDesc": "En /c/ POSIX-sökvägsform för alla verktyg (på som standard)",
				"state.label": "Aktuell status",
				"state.on": "Aktiverad",
				"state.off": "Inaktiverad",
				"switch.on": "Aktivera",
				"switch.off": "Inaktivera",
				"error": "skrivning misslyckades",
				"hint": "Aktiverad: alla verktyg (bash-kommandon och workdir, sökvägsargument för read/write/edit/read_image/glob/grep och present) använder POSIX-sökvägar från MSYS-enhetsroten (/c/Users/...); bash egna vanor — ~ för hemkatalogen, /tmp, /dev/null, /usr — fungerar i varje verktyg exakt som bash själv löser dem, och värden översätter sökvägsfälten automatiskt. Inaktiverad återställer dsh:s ursprungliga beteende (Windows-sökvägar för filverktygen). Bash är alltid Git Bash så länge insticksprogrammet är installerat; den här växeln styr bara sökvägsdialekten mellan verktygen.",
				"sec.dialect": "Sökvägsdialekt",
				"sec.terminal": "Sidopanelsterminal",
				"mnts.label": "Virtuella sökvägsmonteringar",
				"mnts.hint": "Bash egna vanor — ~ hem, /tmp, /usr — löses via Git Bash monteringstabell i varje verktyg; av = endast /c/-enhetsrötter.",
				"errs.label": "Felsökvägsöversättning",
				"errs.hint": "Windows-sökvägar i fel från filverktyg och run_code skrivs tillbaka som /c/ — även meddelandet som ett program fångar; av behåller originaltexten.",
				"split.label": "Glob absolut mönsterdelning",
				"split.hint": "Ett absolut glob-mönster delas i sökväg + relativt mönster; av skickar det oförändrat.",
				"code.label": "sökvägar i run_code-program",
				"code.hint": "Sökvägslitteraler i ett run_code-program översätts via samma monteringstabell före körning; kommentarer, interpolerade mallar, $VAR och strängar som inte är sökvägar lämnas orörda, och vid minsta osäkerhet lämnas hela programmet oförändrat. Dessutom sätts TEMP/TMP för programmet: med tom env ger os.tmpdir() i Windows undefined\\temp och skriver på fel ställe.",
				"bashmiss.title": "Git Bash hittades inte — kommandon kan inte köras",
				"bashmiss.body": "Insticksmodulen accepterar bara bash som följer med Git for Windows (bash från WSL, MSYS2 och Cygwin avvisas) och faller aldrig tillbaka på PowerShell/cmd — den rapporterar felet i stället för att tyst byta in något körbart. Ange hela sökvägen till bash.exe nedan, eller installera Git for Windows först.",
				"bashmiss.tried": "Provat i ordning (alla avvisade):",
				"bashmiss.download": "Hämta Git for Windows",
				"bashmiss.where": "Du kan också fylla i detta senare under ”Inställningar → Insticksmoduler → dsh-gitbash-shell → Git Bash-sökväg”; världens startlogg har samma lista.",
				"bashmiss.close": "Stäng",
				"sub.label": "Subagenter/teammedlemmar använder Git Bash",
				"sub.hint": "På (standard): subagenter och teammedlemmar — även nästlade — får samma promptdialekt, samma sökvägsöversättning i argument, samma resultat-eko och samma DSH_PATH_DIALECT-faktum som huvudagenten. Av: detta gäller bara huvudagenten och delegerade agenter kör med officiell shell-semantik (ingen promptomskrivning, ingen sökvägsöversättning). Obs: dsh har en enda shell-exekutor per process, så Git Bash-binären är fortfarande global; den här växeln styr dialekt-/översättningslagren.",
				"term.label": "Ta över sidofältsterminalen",
				"term.hint": "På som standard: i Windows sätts det officiella ”nya terminalens” shell till den hittade Git Bash (skrivs till den officiella terminal-controller-raden via den officiella konfigurationsredigeraren). Utan detta startar dsh terminalen med miljöns standardshell, och bash i PATH är ofta WSL-startaren — då kör den nya terminalen Ubuntu. Det skrivs bara när raden INTE har ett eget shell; ett uttryckligt val skrivs aldrig över, det loggas bara hos värden. Nya terminaler tar det direkt, redan öppna behåller sitt shell.",
				"eol.label": "Git radslut (som Linux)",
				"eol.hint": "Git-kommandon som modellen kör följer Linux-beteende: core.autocrlf=input, core.eol=lf. Din egen terminal och repots .gitattributes påverkas inte.",
				"bash.label": "Git Bash-sökväg",
				"bash.hint": "Fullständig sökväg till egen bash.exe; tom = automatisk detektering.",
				"bash.saveFailed": "Sparandet slog inte igenom: värden avvisade skrivningen — kontrollera att sökvägen finns och är Git for Windows bash, eller läs värdens logg",
				"bash.save": "Spara",
				"bash.saved": "Sparat",
				"adopt.label": "Överta sidolistterminal",
				"adopt.hint": "På (standard) skriver Git Bash som terminal-shell i dsh-better-sidebar; av återställer det tidigare värdet och rör aldrig ett manuellt val. Modellens bash-verktyg påverkas inte — det tillhandahålls av pluginet självt.",
				"sec.dedupe": "Deduplicering med PTC-skaparläget",
				"dedupe.label": "Dubblerad post ”skaparläge · Git Bash”",
				"dedupe.hint": "När dsh-ptc-cordis-preset är installerat samtidigt är dess ”PTC-skaparläge” redan Git Bash-versionen tack vare kopplingen, så det och det här pluginets ”skaparläge · Git Bash” pekar på samma sak. Med deduplicering på registrerar pluginet inte längre sin egen post (en färre i listan); av som standard, vilket lämnar de fyra varianterna oförändrade. Den här växeln är samma växel som på motpartens inställningskort — båda sidor delar ett tillstånd, en ändring på ena sidan synkas direkt till den andra. Visas bara när dsh-ptc-cordis-preset är installerat.",
				"sec.python": "run_code-backend (experimentell Python)",
				"python.label": "run_code-backend",
				"python.on": "Python (experimentell)",
				"python.off": "Node / TypeScript (standard)",
				"python.hint": "Av (standard) använder run_code den officiella Node/TypeScript-backenden, byte för byte identisk med den medföljande ptc-kompositionen; på växlar dsh till den experimentella CPython-backenden (@deepseek-ai/dsh-experimental-ptc-runtime-python), vilket även byter run_codes språk, genererade SDK-prompt och presentation till Python. Kräver POSIX och CPython ≥ 3.10 (ej tillgängligt i Windows) och utesluter workflow-verktyget — den officiella Python-kompositionen stänger också av workflow, så workflow-sidan i alla fyra varianter hålls avstängd medan detta är på (ditt workflow-värde behålls och återställs när du stänger av). Gäller efter omstart av dsh; detta är samma växel på dsh-ptc-cordis-presets kort — båda sidor delar ett tillstånd. Visas bara när dsh-ptc-cordis-preset är installerat. Om påslaget inte får effekt står orsaken i dsh:s startlogg.",
				"python.degraded": "backend otillgänglig, fortfarande Node (orsak i dsh-startloggen)",
				"python.blocked": "Den här värden är Windows: den experimentella Python-backenden stöder bara POSIX, så växeln är otillgänglig.",
			},
			/* locale: th */
			"th": {
				"title": "รูปแบบพาธของ Git Bash",
				"cardDesc": "ใช้รูปแบบพาธ POSIX /c/ แบบเดียวกันกับทุกเครื่องมือ (เปิดไว้เป็นค่าเริ่มต้น)",
				"state.label": "สถานะปัจจุบัน",
				"state.on": "เปิดใช้งาน",
				"state.off": "ปิดใช้งาน",
				"switch.on": "เปิดใช้งาน",
				"switch.off": "ปิดใช้งาน",
				"error": "เขียนไม่สำเร็จ",
				"hint": "เมื่อเปิดใช้งาน: เครื่องมือทั้งหมด (คำสั่ง bash และ workdir รวมถึงอาร์กิวเมนต์พาธของ read/write/edit/read_image/glob/grep และ present) ใช้พาธ POSIX จากรากไดรฟ์ของ MSYS (/c/Users/...); พฤติกรรมดั้งเดิมของ bash — ~ สำหรับโฮม, /tmp, /dev/null, /usr — ทำงานในทุกเครื่องมือเหมือนที่ bash แก้เองพอดี และโฮสต์แปลฟิลด์พาธให้อัตโนมัติ เมื่อปิดใช้งานจะกลับสู่พฤติกรรมดั้งเดิมของ dsh (เครื่องมือจัดการไฟล์ใช้พาธ Windows) bash เป็น Git Bash เสมอเมื่อติดตั้งปลั๊กอินนี้ สวิตช์นี้ควบคุมเฉพาะรูปแบบพาธระหว่างเครื่องมือเท่านั้น",
				"sec.dialect": "ภาษาถิ่นเส้นทาง",
				"sec.terminal": "เทอร์มินัลแถบข้าง",
				"mnts.label": "จุดเมานต์เส้นทางเสมือน",
				"mnts.hint": "พฤติกรรมดั้งเดิมของ bash — ~ โฮม, /tmp, /usr — แก้ผ่านตารางเมานต์ของ Git Bash ในทุกเครื่องมือ; ปิด = เฉพาะรากไดรฟ์ /c/",
				"errs.label": "การแปลเส้นทางในข้อผิดพลาด",
				"errs.hint": "เส้นทาง Windows ในข้อผิดพลาดของเครื่องมือไฟล์และ run_code เขียนกลับเป็น /c/ — รวมถึงข้อความที่โปรแกรมจับได้; ปิดแล้วคงข้อความเดิม",
				"split.label": "การแยก pattern glob แบบสัมบูรณ์",
				"split.hint": "pattern glob สัมบูรณ์แยกเป็น path + pattern สัมพัทธ์; ปิดส่งต่อตามเดิม",
				"code.label": "พาธในโปรแกรม run_code",
				"code.hint": "สตริงพาธที่เขียนในโปรแกรม run_code จะถูกแปลผ่านตาราง mount เดียวกันก่อนรัน ความคิดเห็น เทมเพลตที่มีการแทรก $VAR และสตริงที่ไม่ใช่พาธจะไม่ถูกแตะ และหากไม่แน่ใจทั้งโปรแกรมจะไม่ถูกแก้ไข และเติม TEMP/TMP ให้โปรแกรมด้วย: เมื่อ env ว่าง os.tmpdir() บน Windows จะคืน undefined\\temp แล้วเขียนผิดที่",
				"bashmiss.title": "ไม่พบ Git Bash — คำสั่งรันไม่ได้",
				"bashmiss.body": "ปลั๊กอินนี้รับเฉพาะ bash ที่มากับ Git for Windows (ไม่รับ bash ของ WSL, MSYS2 และ Cygwin) และไม่ถอยไปใช้ PowerShell/cmd — จึงรายงานความล้มเหลวแทนการสลับเชลล์ที่รันได้อย่างเงียบ ๆ กรอกพาธเต็มของ bash.exe ด้านล่าง หรือติดตั้ง Git for Windows ก่อน",
				"bashmiss.tried": "ตรวจตามลำดับแล้ว (ถูกปฏิเสธทั้งหมด):",
				"bashmiss.download": "ดาวน์โหลด Git for Windows",
				"bashmiss.where": "กรอกภายหลังได้ที่ «การตั้งค่า → ปลั๊กอิน → dsh-gitbash-shell → พาธ Git Bash» และบันทึกเริ่มต้นของโฮสต์มีรายการเดียวกัน",
				"bashmiss.close": "ปิด",
				"sub.label": "ซับเอเจนต์/สมาชิกทีมใช้ Git Bash",
				"sub.hint": "เปิด (ค่าเริ่มต้น): ซับเอเจนต์และสมาชิกทีม — รวมถึงแบบซ้อน — ได้รับไดอาเลกต์พรอมป์ต์ การแปลพาธในอาร์กิวเมนต์ การสะท้อนผลลัพธ์ และข้อเท็จจริง DSH_PATH_DIALECT เหมือนเอเจนต์หลัก ปิด: สิ่งเหล่านี้มีผลกับเอเจนต์หลักเท่านั้น และเอเจนต์ที่ถูกมอบหมายทำงานด้วยความหมาย shell อย่างเป็นทางการ (ไม่เขียนพรอมป์ต์ใหม่ ไม่แปลพาธ) หมายเหตุ dsh มีตัวรัน shell เดียวต่อโปรเซส ไบนารี Git Bash จึงยังเป็นส่วนกลาง สวิตช์นี้ควบคุมชั้นไดอาเลกต์/การแปล",
				"term.label": "รับช่วงเทอร์มินัลแถบข้าง",
				"term.hint": "เปิดโดยค่าเริ่มต้น: บน Windows shell ของ «เทอร์มินัลใหม่» อย่างเป็นทางการจะถูกตั้งเป็น Git Bash ที่ตรวจพบ (เขียนลงแถว terminal-controller อย่างเป็นทางการผ่านตัวแก้ไขการตั้งค่าอย่างเป็นทางการ) หากไม่มีสิ่งนี้ dsh จะเริ่มเทอร์มินัลด้วย shell เริ่มต้นของสภาพแวดล้อม และ bash ใน PATH มักเป็นตัวเรียก WSL เทอร์มินัลใหม่จึงรันเป็น Ubuntu จะเขียนก็ต่อเมื่อแถวนั้นไม่มี shell ของตัวเองเท่านั้น การเลือกที่ผู้ใช้ระบุไว้จะไม่ถูกเขียนทับ เพียงบันทึกในบันทึกของโฮสต์ เทอร์มินัลใหม่ใช้ทันที ส่วนที่เปิดอยู่แล้วคงเดิม",
				"eol.label": "อักขระขึ้นบรรทัด Git (เหมือน Linux)",
				"eol.hint": "คำสั่ง git ที่โมเดลรันจะใช้พฤติกรรมแบบ Linux: core.autocrlf=input, core.eol=lf เทอร์มินัลของคุณและ .gitattributes ของ repo ไม่ได้รับผลกระทบ",
				"bash.label": "เส้นทาง Git Bash",
				"bash.hint": "เส้นทางเต็มของ bash.exe แบบกำหนดเอง; ว่าง = ตรวจจับอัตโนมัติ",
				"bash.saveFailed": "การบันทึกไม่เกิดผล: โฮสต์ปฏิเสธการเขียนนี้ — ตรวจสอบว่าพาธมีอยู่และเป็น bash ของ Git for Windows หรือดูบันทึกของโฮสต์",
				"bash.save": "บันทึก",
				"bash.saved": "บันทึกแล้ว",
				"adopt.label": "รับช่วงเทอร์มินัลแถบข้าง",
				"adopt.hint": "เปิด (ค่าเริ่มต้น) จะเขียน Git Bash เป็น shell ของเทอร์มินัล dsh-better-sidebar; ปิดแล้วคืนค่าเดิมและไม่แตะการตั้งค่าที่เลือกเอง เครื่องมือ bash ของโมเดลไม่กระทบ — ปลั๊กอินจัดหาเอง",
				"sec.dedupe": "ตัดรายการซ้ำกับโหมดสร้างสรรค์ PTC",
				"dedupe.label": "รายการซ้ำ «โหมดสร้างสรรค์ · Git Bash»",
				"dedupe.hint": "เมื่อติดตั้ง dsh-ptc-cordis-preset ควบคู่กัน «โหมดสร้างสรรค์ PTC» ของมันเป็นเวอร์ชัน Git Bash อยู่แล้วจากการเชื่อมโยง จึงชี้ไปที่สิ่งเดียวกันกับ «โหมดสร้างสรรค์ · Git Bash» ของปลั๊กอินนี้ เมื่อเปิดการตัดรายการซ้ำ ปลั๊กอินนี้จะไม่ลงทะเบียนรายการของตัวเองอีก (รายการในสารบบลดลงหนึ่งรายการ); ปิดไว้เป็นค่าเริ่มต้น จึงคงสี่รูปแบบไว้เหมือนเดิม สวิตช์นี้คือสวิตช์เดียวกันกับบนการ์ดตั้งค่าของอีกฝ่าย — ทั้งสองฝั่งใช้สถานะเดียวกัน แก้ที่ฝั่งใดอีกฝั่งจะซิงก์ทันที แสดงเฉพาะเมื่อติดตั้ง dsh-ptc-cordis-preset แล้วเท่านั้น",
				"sec.python": "แบ็กเอนด์ run_code (Python ทดลอง)",
				"python.label": "แบ็กเอนด์ run_code",
				"python.on": "Python (ทดลอง)",
				"python.off": "Node / TypeScript (ค่าเริ่มต้น)",
				"python.hint": "เมื่อปิด (ค่าเริ่มต้น) run_code จะใช้แบ็กเอนด์ Node/TypeScript อย่างเป็นทางการ ซึ่งเหมือนกับคอมโพซิชัน ptc ที่จัดส่งทุกไบต์; เมื่อเปิด dsh จะเปลี่ยนไปใช้แบ็กเอนด์ CPython ทดลอง (@deepseek-ai/dsh-experimental-ptc-runtime-python) ภาษา พรอมป์ต์ SDK ที่สร้างขึ้น และการนำเสนอของ run_code จะเปลี่ยนเป็น Python ต้องใช้ POSIX และ CPython ≥ 3.10 (ใช้ไม่ได้บน Windows) และใช้ร่วมกับเครื่องมือ workflow ไม่ได้ — คอมโพซิชัน Python อย่างเป็นทางการก็ปิด workflow เช่นกัน ฝั่ง workflow ของทั้งสี่รูปแบบจึงถูกปิดขณะเปิดอยู่ (ค่าที่คุณตั้งไว้จะถูกเก็บและกลับมาเมื่อปิด) การเปลี่ยนแปลงมีผลหลังรีสตาร์ต dsh; นี่คือสวิตช์เดียวกันบนการ์ดของ dsh-ptc-cordis-preset — ทั้งสองฝั่งใช้สถานะเดียวกัน แสดงเฉพาะเมื่อติดตั้ง dsh-ptc-cordis-preset แล้วเท่านั้น หากเปิดแล้วไม่เกิดผล เหตุผลอยู่ในบันทึกการเริ่มต้นของ dsh",
				"python.degraded": "แบ็กเอนด์ใช้ไม่ได้ ยังเป็น Node (เหตุผลในบันทึกเริ่มต้นของ dsh)",
				"python.blocked": "โฮสต์นี้เป็น Windows: แบ็กเอนด์ Python ทดลองรองรับเฉพาะ POSIX สวิตช์นี้จึงใช้ไม่ได้",
			},
			/* locale: tr */
			"tr": {
				"title": "Git Bash yol lehçesi",
				"cardDesc": "Tüm araçlar için tek /c/ POSIX yol biçimi (varsayılan olarak açık)",
				"state.label": "Geçerli durum",
				"state.on": "Etkin",
				"state.off": "Devre dışı",
				"switch.on": "Etkinleştir",
				"switch.off": "Devre dışı bırak",
				"error": "yazma başarısız",
				"hint": "Etkinleştirildiğinde: tüm araçlar (bash komutları ve workdir ile read/write/edit/read_image/glob/grep ve present yol bağımsız değişkenleri) MSYS sürücü kökünden POSIX yolları (/c/Users/...) kullanır; bash'e özgü alışkanlıklar — ev için ~, /tmp, /dev/null, /usr — her araçta tam bash'in kendisinin çözdüğü gibi çalışır ve ana süreç yol alanlarını otomatik olarak çevirir. Devre dışı bırakıldığında dsh yerel davranışına döner (dosya araçları için Windows yolları). Eklenti kurulu olduğu sürece bash her zaman Git Bash olarak kalır; bu anahtar yalnızca araçlar arası yol lehçesini yönetir.",
				"sec.dialect": "Yol lehçesi",
				"sec.terminal": "Kenar çubuğu terminali",
				"mnts.label": "Sanal yol bağlamaları",
				"mnts.hint": "Bash'e özgü alışkanlıklar — ~ ev, /tmp, /usr — her araçta Git Bash bağlama tablosuyla çözülür; kapalı = yalnızca /c/ sürücü kökleri.",
				"errs.label": "Hata yolu çevirisi",
				"errs.hint": "Dosya aracı ve run_code hatalarındaki Windows yolları /c/ olarak geri yazılır — programın yakaladığı ileti dahil; kapalı özgün metni korur.",
				"split.label": "Glob mutlak örüntü ayrıştırma",
				"split.hint": "Mutlak glob örüntüsü path + göreli örüntüye ayrılır; kapalı olduğu gibi geçirir.",
				"code.label": "run_code program yolları",
				"code.hint": "Bir run_code programında yazılan yol dizeleri çalıştırılmadan önce aynı bağlama tablosuyla çevrilir; yorumlar, enterpolasyonlu şablonlar, $VAR ve yol olmayan dizeler olduğu gibi kalır, herhangi bir belirsizlikte programın tamamı değişmeden bırakılır. Ayrıca programa TEMP/TMP verilir: boş env ile Windows'ta os.tmpdir() undefined\\temp döner ve yanlış yere yazar.",
				"bashmiss.title": "Git Bash bulunamadı — komutlar çalışamaz",
				"bashmiss.body": "Bu eklenti yalnızca Git for Windows ile gelen bash'i kabul eder (WSL, MSYS2 ve Cygwin bash'i reddedilir) ve asla PowerShell/cmd'ye dönmez — çalışan bir kabuğu sessizce koymak yerine hatayı bildirir. Aşağıya bash.exe'nin tam yolunu yazın veya önce Git for Windows'u kurun.",
				"bashmiss.tried": "Sırayla denenen konumlar (hepsi reddedildi):",
				"bashmiss.download": "Git for Windows indir",
				"bashmiss.where": "Bunu daha sonra «Ayarlar → Eklentiler → dsh-gitbash-shell → Git Bash yolu» altında da girebilirsiniz; host başlangıç günlüğünde aynı liste var.",
				"bashmiss.close": "Kapat",
				"sub.label": "Alt ajanlar/ekip üyeleri Git Bash kullansın",
				"sub.hint": "Açık (varsayılan): alt ajanlar ve ekip üyeleri — iç içe olanlar dahil — ana ajanla aynı istem lehçesini, yol argümanı çevirisini, sonuç yankısını ve DSH_PATH_DIALECT gerçeğini alır. Kapalı: bunlar yalnızca ana ajan için geçerlidir ve devredilen ajanlar resmî shell semantiğiyle çalışır (istem yeniden yazılmaz, yollar çevrilmez). Not: dsh'de süreç başına tek bir shell yürütücüsü vardır, bu yüzden Git Bash ikilisi genele aittir; bu anahtar lehçe/çeviri katmanlarını yönetir.",
				"term.label": "Kenar çubuğu terminalini devral",
				"term.hint": "Varsayılan olarak açık: Windows'ta resmî «yeni terminal»in shell'i algılanan Git Bash olarak ayarlanır (resmî yapılandırma düzenleyicisi üzerinden resmî terminal-controller satırına yazılır). Bu olmadan dsh terminali ortamın varsayılan shell'iyle başlatır ve PATH'teki bash çoğu zaman WSL başlatıcısıdır — yeni terminal Ubuntu'da çalışır. Yalnızca o satırın KENDİ shell'i yoksa yazılır; açık bir seçim asla üzerine yazılmaz, sadece host günlüğüne düşer. Yeni terminaller anında kullanır, açık olanlar kendi shell'ini korur.",
				"eol.label": "Git satır sonları (Linux gibi)",
				"eol.hint": "Modelin çalıştırdığı git komutları Linux davranışını izler: core.autocrlf=input, core.eol=lf. Kendi terminaliniz ve deponun .gitattributes dosyası etkilenmez.",
				"bash.label": "Git Bash yolu",
				"bash.hint": "Özel bash.exe tam yolu; boş = otomatik algılama.",
				"bash.saveFailed": "Kaydetme etkili olmadı: ana makine bu yazmayı reddetti — yolun var olduğunu ve Git for Windows bash’i olduğunu doğrulayın ya da host günlüğüne bakın",
				"bash.save": "Kaydet",
				"bash.saved": "Kaydedildi",
				"adopt.label": "Kenar çubuğu terminalini devral",
				"adopt.hint": "Açık (varsayılan) Git Bashi dsh-better-sidebar terminalinin shelli olarak yazar; kapalı önceki değeri geri getirir ve elle seçilmiş bir ayara asla dokunmaz. Model tarafındaki bash aracı etkilenmez — onu eklentinin kendisi sağlar.",
				"sec.dedupe": "PTC yaratma moduyla yinelenen kaydı kaldırma",
				"dedupe.label": "«Yaratma modu · Git Bash» yinelenen kaydı",
				"dedupe.hint": "dsh-ptc-cordis-preset birlikte kuruluysa, bağlantı sayesinde onun «PTC yaratma modu» zaten Git Bash sürümüdür; dolayısıyla o ve bu eklentinin «Yaratma modu · Git Bash» kaydı aynı şeyi gösterir. Yinelenen kaydı kaldırma açıkken bu eklenti kendi kaydını artık kaydetmez (listede bir eksik); varsayılan olarak kapalıdır ve dört varyant değişmeden kalır. Bu anahtar, karşı tarafın ayar kartındaki anahtarın ta kendisidir — iki taraf aynı durumu paylaşır, bir taraftaki değişiklik anında diğerine eşitlenir. Yalnızca dsh-ptc-cordis-preset kurulu olduğunda görünür.",
				"sec.python": "run_code arka ucu (deneysel Python)",
				"python.label": "run_code arka ucu",
				"python.on": "Python (deneysel)",
				"python.off": "Node / TypeScript (varsayılan)",
				"python.hint": "Kapalıyken (varsayılan) run_code resmî Node/TypeScript arka ucunu kullanır ve gönderilen ptc bileşimiyle bayt bayt aynıdır; açıldığında dsh deneysel CPython arka ucuna (@deepseek-ai/dsh-experimental-ptc-runtime-python) geçer; run_code dil, üretilen SDK istemi ve sunum Python'a döner. POSIX ve CPython ≥ 3.10 gerektirir (Windows'ta kullanılamaz) ve workflow aracıyla birbirini dışlar — resmî Python bileşimi de workflow'u kapatır, bu yüzden bu açıkken dört varyantın workflow tarafı kapalı kalır (workflow ayarın korunur ve kapatınca geri gelir). Değişiklik dsh yeniden başlatıldıktan sonra geçerli olur; bu, dsh-ptc-cordis-preset kartındaki aynı anahtardır — iki taraf tek durumu paylaşır. Yalnızca dsh-ptc-cordis-preset kurulu olduğunda görünür. Açmak etkili olmazsa nedeni dsh başlangıç günlüğünde yazar.",
				"python.degraded": "arka uç kullanılamıyor, hâlâ Node (neden dsh başlangıç günlüğünde)",
				"python.blocked": "Bu ana makine Windows: deneysel Python arka ucu yalnızca POSIX destekler, bu anahtar kullanılamaz.",
			},
			/* locale: vi */
			"vi": {
				"title": "Phương ngữ đường dẫn Git Bash",
				"cardDesc": "Một dạng đường dẫn POSIX /c/ thống nhất cho mọi công cụ (mặc định bật)",
				"state.label": "Trạng thái hiện tại",
				"state.on": "Đã bật",
				"state.off": "Đã tắt",
				"switch.on": "Bật",
				"switch.off": "Tắt",
				"error": "ghi thất bại",
				"hint": "Khi bật: mọi công cụ (lệnh bash và workdir, tham số đường dẫn của read/write/edit/read_image/glob/grep và present) dùng đường dẫn POSIX từ gốc ổ đĩa MSYS (/c/Users/...); thói quen gốc của bash — ~ cho thư mục home, /tmp, /dev/null, /usr — hoạt động trong mọi công cụ đúng như chính bash giải quyết chúng, và máy chủ tự động chuyển đổi trường đường dẫn. Khi tắt, hành vi gốc của dsh được khôi phục (công cụ tệp dùng đường dẫn Windows). bash luôn là Git Bash khi plugin được cài đặt; công tắc này chỉ điều khiển phương ngữ đường dẫn giữa các công cụ.",
				"sec.dialect": "Phương ngữ đường dẫn",
				"sec.terminal": "Terminal thanh bên",
				"mnts.label": "Gán đường dẫn ảo",
				"mnts.hint": "Thói quen gốc của bash — ~ home, /tmp, /usr — được giải qua bảng gán của Git Bash trong mọi công cụ; tắt = chỉ gốc ổ /c/.",
				"errs.label": "Dịch đường dẫn lỗi",
				"errs.hint": "Đường dẫn Windows trong lỗi công cụ tệp và run_code viết lại thành /c/ — kể cả thông báo mà chương trình bắt được; tắt giữ nguyên văn bản gốc.",
				"split.label": "Tách pattern glob tuyệt đối",
				"split.hint": "Pattern glob tuyệt đối tách thành path + pattern tương đối; tắt truyền nguyên văn.",
				"code.label": "đường dẫn trong chương trình run_code",
				"code.hint": "Chuỗi đường dẫn viết trong chương trình run_code được dịch qua cùng bảng mount trước khi chạy; chú thích, template nội suy, $VAR và chuỗi không phải đường dẫn được giữ nguyên, và mọi điểm không chắc chắn sẽ khiến cả chương trình không bị sửa. Đồng thời nạp TEMP/TMP cho chương trình: với env rỗng, os.tmpdir() trên Windows trả về undefined\\temp và ghi sai chỗ.",
				"bashmiss.title": "Không tìm thấy Git Bash — không thể chạy lệnh",
				"bashmiss.body": "Plugin này chỉ chấp nhận bash đi kèm Git for Windows (bash của WSL, MSYS2 và Cygwin bị từ chối) và không bao giờ lùi về PowerShell/cmd — nó báo lỗi thay vì âm thầm thay bằng shell chạy được. Hãy nhập đường dẫn đầy đủ tới bash.exe bên dưới, hoặc cài Git for Windows trước.",
				"bashmiss.tried": "Đã dò theo thứ tự (tất cả bị từ chối):",
				"bashmiss.download": "Tải Git for Windows",
				"bashmiss.where": "Cũng có thể điền sau tại «Cài đặt → Plugin → dsh-gitbash-shell → Đường dẫn Git Bash»; nhật ký khởi động host có cùng danh sách.",
				"bashmiss.close": "Đóng",
				"sub.label": "Subagent/thành viên nhóm dùng Git Bash",
				"sub.hint": "Bật (mặc định): subagent và thành viên nhóm — kể cả lồng nhau — nhận cùng phương ngữ prompt, cách dịch đường dẫn trong tham số, tiếng vọng kết quả và sự thật DSH_PATH_DIALECT như agent chính. Tắt: những thứ này chỉ áp dụng cho agent chính, còn agent được ủy quyền chạy theo ngữ nghĩa shell chính thức (không viết lại prompt, không dịch đường dẫn). Lưu ý dsh chỉ có một bộ thực thi shell mỗi tiến trình, nên tệp nhị phân Git Bash vẫn là toàn cục; công tắc này điều khiển tầng phương ngữ/dịch.",
				"term.label": "Tiếp quản terminal thanh bên",
				"term.hint": "Bật theo mặc định: trên Windows, shell của «terminal mới» chính thức được đặt thành Git Bash đã phát hiện (ghi vào dòng terminal-controller chính thức qua trình sửa cấu hình chính thức). Không có nó, dsh khởi động terminal bằng shell mặc định của môi trường, và bash trong PATH thường là trình khởi chạy WSL — terminal mới sẽ chạy Ubuntu. Chỉ ghi khi dòng đó KHÔNG có shell riêng; lựa chọn rõ ràng không bao giờ bị ghi đè, chỉ ghi vào nhật ký máy chủ. Terminal mới dùng ngay, terminal đang mở giữ nguyên.",
				"eol.label": "kết thúc dòng Git (giống Linux)",
				"eol.hint": "Các lệnh git do mô hình chạy theo hành vi Linux: core.autocrlf=input, core.eol=lf. Terminal của bạn và .gitattributes của repo không bị ảnh hưởng.",
				"bash.label": "Đường dẫn Git Bash",
				"bash.hint": "Đường dẫn đầy đủ của bash.exe tùy chỉnh; để trống = tự dò tìm.",
				"bash.saveFailed": "Lưu không có hiệu lực: máy chủ đã từ chối lần ghi này — kiểm tra đường dẫn tồn tại và là bash của Git for Windows, hoặc xem nhật ký máy chủ",
				"bash.save": "Lưu",
				"bash.saved": "Đã lưu",
				"adopt.label": "Tiếp nhận terminal thanh bên",
				"adopt.hint": "Bật (mặc định) ghi Git Bash làm shell terminal của dsh-better-sidebar; tắt khôi phục giá trị trước đó và không bao giờ đụng tới lựa chọn thủ công. Công cụ bash phía mô hình không bị ảnh hưởng — chính plugin cung cấp nó.",
				"sec.dedupe": "Loại bỏ trùng lặp với chế độ sáng tạo PTC",
				"dedupe.label": "Mục trùng lặp «chế độ sáng tạo · Git Bash»",
				"dedupe.hint": "Khi cài chung dsh-ptc-cordis-preset, nhờ liên kết mà «chế độ sáng tạo PTC» của nó đã là bản Git Bash, nên nó và «chế độ sáng tạo · Git Bash» của plugin này cùng chỉ một thứ. Khi bật loại bỏ trùng lặp, plugin này không đăng ký mục của riêng nó nữa (danh mục bớt một mục); mặc định tắt, giữ nguyên bốn biến thể. Công tắc này chính là công tắc trên thẻ cài đặt của bên kia — hai bên dùng chung một trạng thái, thay đổi ở bên nào cũng đồng bộ ngay sang bên kia. Chỉ hiện khi đã cài dsh-ptc-cordis-preset.",
				"sec.python": "Backend run_code (Python thử nghiệm)",
				"python.label": "Backend run_code",
				"python.on": "Python (thử nghiệm)",
				"python.off": "Node / TypeScript (mặc định)",
				"python.hint": "Khi tắt (mặc định), run_code dùng backend Node/TypeScript chính thức, giống từng byte với tổ hợp ptc được phát hành; khi bật, dsh chuyển sang backend CPython thử nghiệm (@deepseek-ai/dsh-experimental-ptc-runtime-python), kéo theo ngôn ngữ, prompt SDK được sinh và cách trình bày của run_code chuyển sang Python. Yêu cầu POSIX và CPython ≥ 3.10 (không dùng được trên Windows) và loại trừ lẫn nhau với công cụ workflow — tổ hợp Python chính thức cũng tắt workflow, nên phía workflow của cả bốn biến thể bị tắt trong lúc bật (giá trị workflow của bạn được giữ và trở lại khi tắt). Thay đổi có hiệu lực sau khi khởi động lại dsh; đây chính là công tắc trên thẻ của dsh-ptc-cordis-preset — hai bên dùng chung một trạng thái. Chỉ hiện khi đã cài dsh-ptc-cordis-preset. Nếu bật mà không có hiệu lực, lý do nằm trong nhật ký khởi động dsh.",
				"python.degraded": "backend không khả dụng, vẫn là Node (lý do trong nhật ký khởi động dsh)",
				"python.blocked": "Máy chủ này là Windows: backend Python thử nghiệm chỉ hỗ trợ POSIX, nên công tắc này không dùng được.",
			},
			/* locale: zh-hk */
			"zh-hk": {
				"title": "Git Bash 路徑方言",
				"cardDesc": "所有工具統一用 /c/ POSIX 路徑格式(預設開啟)",
				"state.label": "目前狀態",
				"state.on": "已啟用",
				"state.off": "已關閉",
				"switch.on": "啟用",
				"switch.off": "停用",
				"error": "寫入失敗",
				"hint": "啟用後:所有工具(bash 指令同 workdir、read/write/edit/read_image/glob/grep 同 present 嘅路徑參數)統一使用 MSYS 磁碟根 POSIX 路徑(/c/Users/...);bash 原生習慣——~ 家目錄、/tmp、/dev/null、/usr——喺所有工具一樣有效(同 Git Bash 掛載表一致),路徑參數由宿主自動翻譯,模型無感。停用後回復 dsh 原生行為(檔案工具用 Windows 路徑)。bash 永遠係 Git Bash,唔受呢個開關影響。",
				"sec.dialect": "路徑方言",
				"sec.terminal": "側欄終端",
				"mnts.label": "虛擬路徑掛載",
				"mnts.hint": "bash 原生習慣——~ 家目錄、/tmp、/usr——按 Git Bash 掛載表喺所有工具解析;關閉就只剩 /c/ 磁碟根。",
				"errs.label": "報錯路徑翻譯",
				"errs.hint": "檔案工具同 run_code 報錯入面嘅 Windows 路徑翻回 /c/ 形式(包括程式捉到嘅錯誤訊息);關閉就保留原文。",
				"split.label": "glob 絕對路徑拆分",
				"split.hint": "glob 嘅絕對 pattern 自動拆做 path + 相對 pattern;關閉就原樣傳遞。",
				"code.label": "run_code 程式內路徑",
				"code.hint": "run_code 程式內寫的 /c/... 路徑字面量會在執行前按同一張掛載表翻譯;註解、插值模板、$VAR 與非路徑字串不動,掃描有任何不確定就整份不改。 並為程式補上 TEMP/TMP:空 env 下 Windows 的 os.tmpdir() 會得到 undefined\\temp,程式會靜默寫錯位置。",
				"bashmiss.title": "搵唔到 Git Bash —— 命令行唔到",
				"bashmiss.body": "本插件淨係用 Git for Windows 跟機嘅 bash(WSL、MSYS2、Cygwin 嘅 bash 一律唔收),亦都唔會退返去 PowerShell/cmd —— 所以呢度只會報錯,唔會偷偷換個行得嘅頂上。喺下面填 bash.exe 嘅完整路徑,或者先裝 Git for Windows。",
				"bashmiss.tried": "按次序探過呢啲位置(全部拒絕):",
				"bashmiss.download": "去下載 Git for Windows",
				"bashmiss.where": "之後都可以喺「設定 → 插件 → dsh-gitbash-shell」嘅「Git Bash 路徑」填;host 啟動日誌有同一份清單。",
				"bashmiss.close": "閂咗佢",
				"sub.label": "子代理/隊員用 Git Bash",
				"sub.hint": "預設開啟:子代理同團隊隊員(連嵌套)嘅提示詞方言、路徑參數翻譯、結果回顯同 DSH_PATH_DIALECT 環境事實都同主代理一致。閂咗就淨係主代理有,子代理跟官方 shell 語義行(提示詞唔改寫、路徑參數唔翻譯);留意 dsh 每個進程只有一個 shell 執行器,所以 Git Bash 本身仍然係全局嘅,呢個開關管嘅係方言/翻譯層。",
				"term.label": "自動接管側欄終端",
				"term.hint": "預設開啟:Windows 上會將官方「開新終端」嘅 shell 自動設成探測到嘅 Git Bash(寫入官方 terminal-controller 行嘅設定,經官方設定編輯器落盤)。冇呢一項時,dsh 會用環境預設 shell 開終端,而 PATH 嘅 bash 好多時係 WSL 啟動器,於是新終端跑嘅係 Ubuntu。只喺該行**冇**自己嘅 shell 時才寫;你已經手動指定過其他 shell 就絕對唔會覆蓋,淨係喺宿主日誌提你一句。新終端即時生效,已開嘅終端保持原狀。",
				"eol.label": "Git 行尾(與 Linux 一致)",
				"eol.hint": "模型執行的 git 指令採 Linux 行為:core.autocrlf=input、core.eol=lf。你自己終端的 git 與倉庫的 .gitattributes 都不受影響。",
				"bash.label": "Git Bash 路徑",
				"bash.hint": "自訂 bash.exe 完整路徑;留空自動探測。",
				"bash.saveFailed": "保存未生效:宿主拒絕咗今次寫入 —— 確認路徑存在而且係 Git for Windows 嘅 bash,或者睇宿主日誌",
				"bash.save": "儲存",
				"bash.saved": "已儲存",
				"adopt.label": "接管側欄終端",
				"adopt.hint": "開啟(預設)會把 dsh-better-sidebar 的終端 shell 寫成 Git Bash;關閉後還原接管前的值,手動改過的設定永不被碰。模型側的 bash 工具不受影響——由插件本身提供。",
				"sec.dedupe": "與 PTC 創造模式去重",
				"dedupe.label": "「創造模式 · Git Bash」重複項",
				"dedupe.hint": "裝埋 dsh-ptc-cordis-preset 嗰陣,佢嘅「PTC 創造模式」喺聯動下已經係 Git Bash 版,同本插件嘅「創造模式 · Git Bash」指向同一件事。開咗去重之後本插件唔再註冊嗰一條(名錄少一項);預設關閉,保持四個變體不變。呢個開關就係對方設定卡上面同一個開關——兩邊共享同一份狀態,任一邊改動另一邊即刻同步。只喺已安裝 dsh-ptc-cordis-preset 時顯示。",
				"sec.python": "run_code 後端(實驗性 Python)",
				"python.label": "run_code 後端",
				"python.on": "Python(實驗性)",
				"python.off": "Node / TypeScript(預設)",
				"python.hint": "閂咗(預設)嗰陣 run_code 用官方 Node/TypeScript 後端,同官方 ptc 組合逐位元組一致;開咗就轉用 dsh 實驗性 CPython 後端(@deepseek-ai/dsh-experimental-ptc-runtime-python),run_code 嘅語言、生成嘅 SDK 提示詞同工具呈現都會轉去 Python。需要 POSIX 平台同 CPython ≥ 3.10(Windows 用唔到),而且同 workflow 工具互斥——官方 Python 組合同樣停用 workflow,所以開住嗰陣本插件四個變體嘅 workflow 側會強制關閉(你嘅工作流設定值會保留,閂咗之後恢復)。改動要重啟 dsh 先生效;呢個開關就係 dsh-ptc-cordis-preset 設定卡上面同一個開關——兩邊共享同一份狀態。只喺已安裝 dsh-ptc-cordis-preset 時顯示。開咗之後唔生效,原因喺 dsh 啟動日誌度。",
				"python.degraded": "後端用唔到,暫時仍然係 Node(原因喺 dsh 啟動日誌)",
				"python.blocked": "呢部主機係 Windows:實驗性 Python 後端淨係支援 POSIX,所以呢個開關用唔到。",
			},
			/* locale: zh-mo */
			"zh-mo": {
				"title": "Git Bash 路徑方言",
				"cardDesc": "所有工具統一用 /c/ POSIX 路徑格式(預設開啟)",
				"state.label": "目前狀態",
				"state.on": "已啟用",
				"state.off": "已關閉",
				"switch.on": "啟用",
				"switch.off": "停用",
				"error": "寫入失敗",
				"hint": "啟用後:所有工具(bash 指令同 workdir、read/write/edit/read_image/glob/grep 同 present 嘅路徑參數)統一使用 MSYS 磁碟根 POSIX 路徑(/c/Users/...);bash 原生習慣——~ 家目錄、/tmp、/dev/null、/usr——喺所有工具一樣有效(同 Git Bash 掛載表一致),路徑參數由宿主自動翻譯,模型無感。停用後回復 dsh 原生行為(檔案工具用 Windows 路徑)。bash 永遠係 Git Bash,唔受呢個開關影響。",
				"sec.dialect": "路徑方言",
				"sec.terminal": "側欄終端",
				"mnts.label": "虛擬路徑掛載",
				"mnts.hint": "bash 原生習慣——~ 家目錄、/tmp、/usr——按 Git Bash 掛載表喺所有工具解析;關閉就只剩 /c/ 磁碟根。",
				"errs.label": "報錯路徑翻譯",
				"errs.hint": "檔案工具同 run_code 報錯入面嘅 Windows 路徑翻回 /c/ 形式(包括程式捉到嘅錯誤訊息);關閉就保留原文。",
				"split.label": "glob 絕對路徑拆分",
				"split.hint": "glob 嘅絕對 pattern 自動拆做 path + 相對 pattern;關閉就原樣傳遞。",
				"code.label": "run_code 程式內路徑",
				"code.hint": "run_code 程式內寫的 /c/... 路徑字面量會在執行前按同一張掛載表翻譯;註解、插值模板、$VAR 與非路徑字串不動,掃描有任何不確定就整份不改。 並為程式補上 TEMP/TMP:空 env 下 Windows 的 os.tmpdir() 會得到 undefined\\temp,程式會靜默寫錯位置。",
				"bashmiss.title": "搵唔到 Git Bash —— 命令行唔到",
				"bashmiss.body": "本插件淨係用 Git for Windows 跟機嘅 bash(WSL、MSYS2、Cygwin 嘅 bash 一律唔收),亦都唔會退返去 PowerShell/cmd —— 所以呢度只會報錯,唔會偷偷換個行得嘅頂上。喺下面填 bash.exe 嘅完整路徑,或者先裝 Git for Windows。",
				"bashmiss.tried": "按次序探過呢啲位置(全部拒絕):",
				"bashmiss.download": "去下載 Git for Windows",
				"bashmiss.where": "之後都可以喺「設定 → 插件 → dsh-gitbash-shell」嘅「Git Bash 路徑」填;host 啟動日誌有同一份清單。",
				"bashmiss.close": "閂咗佢",
				"sub.label": "子代理/隊員用 Git Bash",
				"sub.hint": "預設開啟:子代理同團隊隊員(連嵌套)嘅提示詞方言、路徑參數翻譯、結果回顯同 DSH_PATH_DIALECT 環境事實都同主代理一致。閂咗就淨係主代理有,子代理跟官方 shell 語義行(提示詞唔改寫、路徑參數唔翻譯);留意 dsh 每個進程只有一個 shell 執行器,所以 Git Bash 本身仍然係全局嘅,呢個開關管嘅係方言/翻譯層。",
				"term.label": "自動接管側欄終端",
				"term.hint": "預設開啟:Windows 上會將官方「開新終端」嘅 shell 自動設成探測到嘅 Git Bash(寫入官方 terminal-controller 行嘅設定,經官方設定編輯器落盤)。冇呢一項時,dsh 會用環境預設 shell 開終端,而 PATH 嘅 bash 好多時係 WSL 啟動器,於是新終端跑嘅係 Ubuntu。只喺該行**冇**自己嘅 shell 時才寫;你已經手動指定過其他 shell 就絕對唔會覆蓋,淨係喺宿主日誌提你一句。新終端即時生效,已開嘅終端保持原狀。",
				"eol.label": "Git 行尾(與 Linux 一致)",
				"eol.hint": "模型執行的 git 指令採 Linux 行為:core.autocrlf=input、core.eol=lf。你自己終端的 git 與倉庫的 .gitattributes 都不受影響。",
				"bash.label": "Git Bash 路徑",
				"bash.hint": "自訂 bash.exe 完整路徑;留空自動探測。",
				"bash.saveFailed": "保存未生效:宿主拒絕咗今次寫入 —— 確認路徑存在而且係 Git for Windows 嘅 bash,或者睇宿主日誌",
				"bash.save": "儲存",
				"bash.saved": "已儲存",
				"adopt.label": "接管側欄終端",
				"adopt.hint": "開啟(預設)會把 dsh-better-sidebar 的終端 shell 寫成 Git Bash;關閉後還原接管前的值,手動改過的設定永不被碰。模型側的 bash 工具不受影響——由插件本身提供。",
				"sec.dedupe": "與 PTC 創造模式去重",
				"dedupe.label": "「創造模式 · Git Bash」重複項",
				"dedupe.hint": "裝埋 dsh-ptc-cordis-preset 嗰陣,佢嘅「PTC 創造模式」喺聯動下已經係 Git Bash 版,同本插件嘅「創造模式 · Git Bash」指向同一件事。開咗去重之後本插件唔再註冊嗰一條(名錄少一項);預設關閉,保持四個變體不變。呢個開關就係對方設定卡上面同一個開關——兩邊共享同一份狀態,任一邊改動另一邊即刻同步。只喺已安裝 dsh-ptc-cordis-preset 時顯示。",
				"sec.python": "run_code 後端(實驗性 Python)",
				"python.label": "run_code 後端",
				"python.on": "Python(實驗性)",
				"python.off": "Node / TypeScript(預設)",
				"python.hint": "閂咗(預設)嗰陣 run_code 用官方 Node/TypeScript 後端,同官方 ptc 組合逐位元組一致;開咗就轉用 dsh 實驗性 CPython 後端(@deepseek-ai/dsh-experimental-ptc-runtime-python),run_code 嘅語言、生成嘅 SDK 提示詞同工具呈現都會轉去 Python。需要 POSIX 平台同 CPython ≥ 3.10(Windows 用唔到),而且同 workflow 工具互斥——官方 Python 組合同樣停用 workflow,所以開住嗰陣本插件四個變體嘅 workflow 側會強制關閉(你嘅工作流設定值會保留,閂咗之後恢復)。改動要重啟 dsh 先生效;呢個開關就係 dsh-ptc-cordis-preset 設定卡上面同一個開關——兩邊共享同一份狀態。只喺已安裝 dsh-ptc-cordis-preset 時顯示。開咗之後唔生效,原因喺 dsh 啟動日誌度。",
				"python.degraded": "後端用唔到,暫時仍然係 Node(原因喺 dsh 啟動日誌)",
				"python.blocked": "呢部主機係 Windows:實驗性 Python 後端淨係支援 POSIX,所以呢個開關用唔到。",
			},
			/* locale: zh-tw */
			"zh-tw": {
				"title": "Git Bash 路徑方言",
				"cardDesc": "所有工具統一採用 /c/ POSIX 路徑格式(預設開啟)",
				"state.label": "目前狀態",
				"state.on": "已啟用",
				"state.off": "已關閉",
				"switch.on": "啟用",
				"switch.off": "停用",
				"error": "寫入失敗",
				"hint": "啟用後:所有工具(bash 指令與 workdir,以及 read/write/edit/read_image/glob/grep 與 present 的路徑參數)統一使用 MSYS 磁碟根 POSIX 路徑(/c/Users/...);bash 原生習慣——~ 家目錄、/tmp、/dev/null、/usr——在所有工具同樣有效(與 Git Bash 掛載表一致),路徑參數由宿主自動轉譯,模型無感。停用後恢復 dsh 原生行為(檔案工具使用 Windows 路徑)。bash 一律是 Git Bash,不受此開關影響。",
				"sec.dialect": "路徑方言",
				"sec.terminal": "側欄終端機",
				"mnts.label": "虛擬路徑掛載",
				"mnts.hint": "bash 原生習慣——~ 家目錄、/tmp、/usr——按 Git Bash 掛載表在所有工具解析;關閉則僅 /c/ 磁碟根。",
				"errs.label": "報錯路徑翻譯",
				"errs.hint": "檔案工具與 run_code 報錯裡的 Windows 路徑翻回 /c/ 形式(含程式捕捉到的錯誤訊息);關閉則保留原文。",
				"split.label": "glob 絕對路徑拆分",
				"split.hint": "glob 的絕對 pattern 自動拆為 path + 相對 pattern;關閉則原樣傳遞。",
				"code.label": "run_code 程式內路徑",
				"code.hint": "run_code 程式內寫的 /c/... 路徑字面量會在執行前按同一張掛載表翻譯;註解、插值模板、$VAR 與非路徑字串不動,掃描有任何不確定就整份不改。 並為程式補上 TEMP/TMP:空 env 下 Windows 的 os.tmpdir() 會得到 undefined\\temp,程式會靜默寫錯位置。",
				"bashmiss.title": "找不到 Git Bash —— 命令無法執行",
				"bashmiss.body": "本外掛只採用 Git for Windows 隨附的 bash(不接受 WSL、MSYS2、Cygwin 的 bash),也不會退回 PowerShell/cmd —— 因此這裡只回報錯誤,不會偷偷換一個能跑的頂上。請在下方填寫 bash.exe 的完整路徑,或先安裝 Git for Windows。",
				"bashmiss.tried": "已依序探測這些位置(全部拒絕):",
				"bashmiss.download": "下載 Git for Windows",
				"bashmiss.where": "也可以稍後到「設定 → 外掛 → dsh-gitbash-shell」的「Git Bash 路徑」填寫;host 啟動日誌有同一份清單。",
				"bashmiss.close": "關閉",
				"sub.label": "子代理/隊員使用 Git Bash",
				"sub.hint": "預設開啟:子代理與團隊隊員(含巢狀)的提示詞方言、路徑參數翻譯、結果回顯與 DSH_PATH_DIALECT 環境事實都與主代理一致。關閉後僅對主代理生效,子代理依官方 shell 語意執行(提示詞不改寫、路徑參數不翻譯);請注意 dsh 每個行程只有一個 shell 執行器,因此 Git Bash 本身仍是全域的,這個開關管的是方言/翻譯層。",
				"term.label": "自動接管側邊終端",
				"term.hint": "預設開啟:Windows 上會把官方「新增終端」的 shell 自動設為探測到的 Git Bash(寫入官方 terminal-controller 列的設定,由官方設定編輯器落盤)。沒有這一項時,dsh 會以環境預設 shell 啟動終端,而 PATH 裡的 bash 往往是 WSL 啟動器,於是新終端跑的是 Ubuntu。只在該列**沒有**自己的 shell 時才寫入;你已手動指定其他 shell 就絕不覆蓋,僅在宿主日誌提示。新終端立即生效,已開啟的終端維持原狀。",
				"eol.label": "Git 行尾(與 Linux 一致)",
				"eol.hint": "模型執行的 git 指令採 Linux 行為:core.autocrlf=input、core.eol=lf。你自己終端的 git 與倉庫的 .gitattributes 都不受影響。",
				"bash.label": "Git Bash 路徑",
				"bash.hint": "自訂 bash.exe 完整路徑;留空自動探測。",
				"bash.saveFailed": "儲存未生效:宿主拒絕了這次寫入 —— 確認路徑存在且為 Git for Windows 的 bash,或查看宿主日誌",
				"bash.save": "儲存",
				"bash.saved": "已儲存",
				"adopt.label": "接管側欄終端機",
				"adopt.hint": "開啟(預設)會把 dsh-better-sidebar 的終端機 shell 寫成 Git Bash;關閉後還原接管前的值,手動改過的設定永不被碰。模型側的 bash 工具不受影響——由插件本身提供。",
				"sec.dedupe": "與 PTC 創造模式去重",
				"dedupe.label": "「創造模式 · Git Bash」重複項目",
				"dedupe.hint": "同時安裝 dsh-ptc-cordis-preset 時,它的「PTC 創造模式」在聯動下已是 Git Bash 版,與本插件的「創造模式 · Git Bash」指向同一件事。開啟去重後本插件不再註冊那一條(清單少一項);預設關閉,保持四個變體不變。這個開關就是對方設定卡上的同一個開關——兩側共享同一份狀態,任一側改動另一側立即同步。僅在已安裝 dsh-ptc-cordis-preset 時顯示。",
				"sec.python": "run_code 後端(實驗性 Python)",
				"python.label": "run_code 後端",
				"python.on": "Python(實驗性)",
				"python.off": "Node / TypeScript(預設)",
				"python.hint": "關閉(預設)時 run_code 使用官方 Node/TypeScript 後端,與官方 ptc 組合逐位元組一致;開啟後改用 dsh 實驗性 CPython 後端(@deepseek-ai/dsh-experimental-ptc-runtime-python),run_code 的語言、產生的 SDK 提示詞與工具呈現都會切換到 Python。需要 POSIX 平台與 CPython ≥ 3.10(Windows 無法使用),且與 workflow 工具互斥——官方 Python 組合同樣會停用 workflow,因此開啟期間本外掛四個變體的 workflow 側強制關閉(你的工作流設定值會保留,關閉後恢復)。變更需重新啟動 dsh 後生效;這個開關就是 dsh-ptc-cordis-preset 設定卡上的同一個開關——兩側共用同一份狀態。僅在已安裝 dsh-ptc-cordis-preset 時顯示。若設為開啟後未生效,原因見 dsh 啟動日誌。",
				"python.degraded": "後端無法使用,目前仍為 Node(原因見 dsh 啟動日誌)",
				"python.blocked": "此主機是 Windows:實驗性 Python 後端僅支援 POSIX,因此這個開關無法使用。",
			},
		};

		// ── locale resolution (live: read per lookup, cached per tag) ───────────

		function hasOwnKey(bag, key) {
			return Object.prototype.hasOwnProperty.call(bag, key);
		}

		/* Resolve one locale tag against what this plugin ships: the exact tag,
		   then the primary subtag, then English. Chinese is special-cased because
		   the traditional variants are shipped while a bare zh-Hant-* is not
		   spelled out. */
		function dictionaryFor(active) {
			var raw = active === undefined || active === null || active === "" ? "en" : String(active);
			var tag = raw.toLowerCase().replace(/_/g, "-");
			var primary = tag.split("-")[0];
			if (primary === "zh") {
				if (hasOwnKey(LOCALES, tag)) return LOCALES[tag];
				if (tag.indexOf("hant") >= 0 || tag === "zh-hk" || tag === "zh-mo" || tag === "zh-tw") {
					return hasOwnKey(LOCALES, "zh-hk") ? LOCALES["zh-hk"] : zh;
				}
				return zh;
			}
			if (hasOwnKey(LOCALES, primary)) return LOCALES[primary];
			return en;
		}

		/* The active locale tag, read fresh every time: DSH's language preference
		   switches live, so a value captured once at activation would keep answering
		   in the language that happened to be active when the card loaded. The
		   host-backed preference wins; the browser is the fallback. */
		function activeLocaleOf(ctx) {
			var active = "";
			try {
				var locale = ctx.get("locale");
				if (locale !== undefined && typeof locale.getSnapshot === "function") {
					var snapshot = locale.getSnapshot();
					if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.active === "string") active = snapshot.active;
				}
			} catch (error) { /* fall through to the browser */ }
			if (active === "" && typeof navigator === "object" && navigator !== null && typeof navigator.language === "string") active = navigator.language;
			return active;
		}

		/* A live lookup: the dictionary is picked per call and cached under the tag
		   it was picked for, so a language switch costs one string compare per
		   string. Falling back to EN — kept key-complete on purpose — means an
		   unsupported language shows English, never a raw key. */
		function translatorOf(ctx) {
			var cachedTag = null;
			var cachedDict = null;
			return function (key) {
				var tag = activeLocaleOf(ctx);
				if (tag !== cachedTag) { cachedTag = tag; cachedDict = dictionaryFor(tag); }
				if (hasOwnKey(cachedDict, key)) return cachedDict[key];
				return hasOwnKey(en, key) ? en[key] : key;
			};
		}

		// ── styles (gb- prefixed; tokens mirror PluginCard.module.css) ─────────

		var STYLE_ID = "dsh-gitbash-shell-style";

		var CSS = [
			".gb-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}",
			".gb-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".gb-card.gb-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".gb-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}",
			".gb-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".gb-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
			".gb-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
			".gb-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".gb-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}",
			".gb-chevron.gb-chevronOpen{transform:rotate(180deg)}",
			".gb-body{display:flex;flex-direction:column;gap:12px;padding:4px 16px 16px;max-width:640px}",
			".gb-pageCard{max-width:640px}",
			".gb-headerFlat{cursor:default}",
			".gb-pageBody{display:flex;flex-direction:column;gap:12px;padding:0 0 8px}",
			".gb-row{display:flex;align-items:baseline;gap:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
			".gb-rowLabel{flex:none;color:var(--dsw-alias-label-tertiary)}",
			".gb-rowValue{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}",
			".gb-seg{display:flex;gap:8px;flex-wrap:wrap}",
			".gb-segBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;transition:border-color .16s,color .16s}",
			".gb-segBtn:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".gb-segBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".gb-segBtn.gb-segActive{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}",
			".gb-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
			".gb-error{margin:0;font-size:12px;color:var(--dsw-alias-status-danger, #e5484d)}",
			".gb-card{-webkit-backdrop-filter:var(--dsh-any-blur-card-panels,blur(12px) saturate(1.15));backdrop-filter:var(--dsh-any-blur-card-panels,blur(12px) saturate(1.15))}",
			".gb-section+.gb-section{border-top:1px solid var(--dsw-alias-border-l2)}",
			/* Missing-Git-Bash popup (v0.28.0): a root-level modal, because the
			   user may never be on the settings page when their shell dies. */
			".gb-modalBackdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}",
			".gb-modal{width:min(560px,92vw);max-height:80vh;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:18px;border-radius:12px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 48px rgba(0,0,0,.28)}",
			".gb-modalTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".gb-modalList{margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
			".gb-input{flex:1;min-width:0;padding:6px 8px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary)}",
			".gb-sectionTitle{font-size:12.5px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}",
			".gb-input{flex:1;min-width:0;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;outline:none}",
			".gb-input:focus{border-color:var(--dsw-alias-brand-primary)}",
			".gb-saveBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;transition:border-color .16s,color .16s}",
			".gb-saveBtn:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".gb-saveBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".gb-saveBtn.gb-saved{border-color:var(--dsw-alias-state-success-primary,#3fb950);color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".gb-stack{display:flex;flex-direction:column;gap:8px}",
		].join("\n");

		function ensureStyles() {
			try {
				if (typeof document === "undefined" || typeof document.getElementById !== "function") return function () {};
				if (document.getElementById(STYLE_ID)) return function () {};
				var style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () {
					try {
						if (style.parentNode) style.parentNode.removeChild(style);
					} catch (error) { /* best effort */ }
				};
			} catch (error) {
				return function () {};
			}
		}

		/** Defensive primitives lookup: an unknown icon name degrades to a text chevron. */
		function icon(name) {
			try {
				var component = ui && ui[name];
				return typeof component === "function" ? component : null;
			} catch (error) {
				return null;
			}
		}

		// ── error boundary (the dsh-better-workspace QuietBoundary pattern) ──────

		/** A render failure degrades THIS card, never the settings page. */
		function QuietBoundary(props) {}
		QuietBoundary.prototype = Object.create(React.Component.prototype);
		QuietBoundary.prototype.constructor = QuietBoundary;
		QuietBoundary.state = { failed: false };
		QuietBoundary.getDerivedStateFromError = function () { return { failed: true }; };
		QuietBoundary.prototype.componentDidCatch = function (error) {
			console.warn(TAG + " settings card render failed:", error && error.message ? error.message : error);
		};
		QuietBoundary.prototype.render = function () {
			if (this.state && this.state.failed) return null;
			return this.props.children;
		};

		// ── live locale (repaint the card on a language switch) ─────────────────

		/**
		 * Wraps the card so a language switch repaints it instead of waiting for a
		 * page load. DSH's own components re-render on the locale snapshot, but this
		 * card belongs to a plugin: it subscribes for itself, and it hands the card
		 * THIS plugin's live lookup (translatorOf) — whose resolution covers the
		 * third languages the DSH catalog does not carry. The card stays inside the
		 * same quiet boundary as before.
		 */
		function LocaleLive(props) {
			var tickState = useState(0);
			var tick = tickState[0];
			var setTick = tickState[1];
			void tick;

			useEffect(function () {
				var locale = props.ctx && typeof props.ctx.get === "function" ? props.ctx.get("locale") : undefined;
				if (locale === undefined || typeof locale.subscribe !== "function") return undefined;
				var unsubscribe = locale.subscribe(function () { setTick(function (value) { return value + 1; }); });
				return typeof unsubscribe === "function" ? unsubscribe : undefined;
			}, []);

			if (props.popup === true) {
				return E(QuietBoundary, null, E(MissingBashPopup, Object.assign({}, props.cardProps, { t: props.t })));
			}
			return E(QuietBoundary, null, E(GitBashCard, Object.assign({}, props.cardProps, { t: props.t })));
		}

		// ── settings card (module-level component) ───────────────────────────────

		/**
		 * The Settings → Plugins card. t arrives from LocaleLive (the plugin's own
		 * live lookup, keyed on the active locale at call time); scope arrives as a
		 * PLAIN prop from the inject factory. Snapshots are read per render; each
		 * write bumps a local tick so the card re-reads without an external-store
		 * hook adapter.
		 */
		function GitBashCard(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };

			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];

			var errorState = useState("");
			var error = errorState[0];
			var setError = errorState[1];

			var tickState = useState(0);
			var tick = tickState[0];
			var bumpTick = tickState[1];
			void tick;

			/* The dedupe row mirrors the PEER's row: it is drawn only where
			   dsh-ptc-cordis-preset is installed and its entry has reached the
			   configForms mirror (dsh >= 0.1.7). Absent on old hosts (no
			   configForms), while the peer is not installed, or before its entry
			   appears; every step is defensive, and the form's own subscribe
			   bumps the tick so a late-arriving peer row still shows up. */
			var peerState = useState(null);
			var peer = peerState[0];
			var setPeer = peerState[1];

			useEffect(function () {
				var forms;
				try {
					forms = props.ctx === undefined || props.ctx === null ? undefined : props.ctx.get("configForms");
				} catch (error_) { forms = undefined; }
				if (forms === undefined || forms === null || typeof forms.get !== "function") return undefined;
				var form;
				try { form = forms.get(PEER_NS); } catch (error_) { return undefined; }
				if (form === undefined || form === null || typeof form.getSnapshot !== "function") return undefined;
				setPeer(form);
				if (typeof form.subscribe !== "function") return undefined;
				var unsubscribe = form.subscribe(function () { bumpTick(function (n) { return n + 1; }); });
				return typeof unsubscribe === "function" ? unsubscribe : undefined;
			}, []);

			/* The experimental Python backend refuses to load on Windows
			   (packages/experimental/ptc-runtime-python: POSIX rlimits, fd-3
			   stdio, process-group signals), and a browser cannot see the host
			   OS. The one host fact this card can read is the remote face's
			   reported home: a drive-letter path means a Windows host, which is
			   exactly where that backend cannot run. Absent or unreadable keeps
			   the switch usable — the host side still rejects an impossible
			   write. */
			var winState = useState(false);
			var winHost = winState[0];
			var setWinHost = winState[1];
			useEffect(function () {
				try {
					var remote = props.ctx === undefined || props.ctx === null ? undefined : props.ctx.get("remote");
					var host = remote && remote.$host ? remote.$host.home : undefined;
					if (typeof host === "string" && /^[A-Za-z]:[\\/]/.test(host)) setWinHost(true);
				} catch (error_) { /* keep the switch usable */ }
			}, []);

		var bashState = useState("");
		var bashDraft = bashState[0];
		var setBashDraft = bashState[1];
		var bashSavedState = useState(false);
		var bashSaved = bashSavedState[0];
		var setBashSaved = bashSavedState[1];
		useEffect(function () {
			try {
				var s0 = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
				if (s0 && s0.value && typeof s0.value.bashPath === "string") setBashDraft(s0.value.bashPath)
			} catch (e) { /* keep empty draft */ }
		}, []);

			var scope = props.scope;

			var snap = { status: "unavailable" };
			try {
				if (scope && typeof scope.getSnapshot === "function") snap = scope.getSnapshot();
			} catch (error_) { /* keep unavailable */ }

			if (snap.status !== "ready") return null;

			var value = snap.value || {};
			var enabled = value.posixPaths === true;
			var adopt = value.adoptSidebar !== false;

			/* `ConfigForm.set` resolves with WHETHER THE HOST ACCEPTED the write
			   (dsh ui-settings config-form.ts), so a `false` is a refusal, not a
			   success: claiming "saved" on it would be exactly the silent
			   false-success this plugin forbids (AGENTS §4h). Returns the verdict
			   so each caller can render its own success/failure state. */
			function writeField(key, next) {
				setError("");
				if (!scope || typeof scope.set !== "function") {
					setError(t("error") + ": " + t("bash.saveFailed"));
					return Promise.resolve(false);
				}
				try {
					return Promise.resolve(scope.set(key, next)).then(
						function (accepted) {
							bumpTick(function (n) { return n + 1; });
							if (accepted !== true) {
								setError(t("error") + ": " + t("bash.saveFailed"));
								return false;
							}
							return true;
						},
						function (err) {
							bumpTick(function (n) { return n + 1; });
							setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
							return false;
						},
					);
				} catch (err) {
					bumpTick(function (n) { return n + 1; });
					setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
					return Promise.resolve(false);
				}
			}

			var Chevron = icon("IconChevronDownOutline14");

			// dsh 0.1.6-alpha.2: the Plugins page renders this card through the
			// `plugins.bundle.config` slot with view="page" — the page draws the
			// title itself, so the collapsible shell is only for the legacy seat.
			var pageView = props.view === "page";

			var mounts = snap.value.virtualMounts !== false;
			var errs = snap.value.errorDialect !== false;
			var splits = snap.value.globSplit !== false;
			var codes = snap.value.codePaths !== false;
			// v0.27.0: delegated agents (subagents / team members / nested
			// children) participate in the dialect unless this is switched off.
			var subagents = snap.value.subagentDialect !== false;
			var winshell = snap.value.autoTerminalShell !== false;
			var eolOn = snap.value.gitAutocrlf !== false;
			var dedupe = snap.value.suppressPeerCordis === true;

			var dialectSection = E("div", { className: "gb-section" },
				E("div", { className: "gb-sectionTitle" }, t("sec.dialect")),
				E("div", { className: "gb-stack" },
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("state.label") + ":"),
					E("span", { className: "gb-rowValue" }, enabled ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (enabled ? " gb-segActive" : ""), onClick: function () { if (!enabled) writeField("posixPaths", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!enabled ? " gb-segActive" : ""), onClick: function () { if (enabled) writeField("posixPaths", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("mnts.label") + ":"),
					E("span", { className: "gb-rowValue" }, mounts ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (mounts ? " gb-segActive" : ""), onClick: function () { if (!mounts) writeField("virtualMounts", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!mounts ? " gb-segActive" : ""), onClick: function () { if (mounts) writeField("virtualMounts", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("mnts.hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("errs.label") + ":"),
					E("span", { className: "gb-rowValue" }, errs ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (errs ? " gb-segActive" : ""), onClick: function () { if (!errs) writeField("errorDialect", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!errs ? " gb-segActive" : ""), onClick: function () { if (errs) writeField("errorDialect", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("errs.hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("split.label") + ":"),
					E("span", { className: "gb-rowValue" }, splits ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (splits ? " gb-segActive" : ""), onClick: function () { if (!splits) writeField("globSplit", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!splits ? " gb-segActive" : ""), onClick: function () { if (splits) writeField("globSplit", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("split.hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("code.label") + ":"),
					E("span", { className: "gb-rowValue" }, codes ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (codes ? " gb-segActive" : ""), onClick: function () { if (!codes) writeField("codePaths", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!codes ? " gb-segActive" : ""), onClick: function () { if (codes) writeField("codePaths", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("code.hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("sub.label") + ":"),
					E("span", { className: "gb-rowValue" }, subagents ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (subagents ? " gb-segActive" : ""), onClick: function () { if (!subagents) writeField("subagentDialect", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!subagents ? " gb-segActive" : ""), onClick: function () { if (subagents) writeField("subagentDialect", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("sub.hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("term.label") + ":"),
					E("span", { className: "gb-rowValue" }, winshell ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (winshell ? " gb-segActive" : ""), onClick: function () { if (!winshell) writeField("autoTerminalShell", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!winshell ? " gb-segActive" : ""), onClick: function () { if (winshell) writeField("autoTerminalShell", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("term.hint")),
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("eol.label") + ":"),
					E("span", { className: "gb-rowValue" }, eolOn ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (eolOn ? " gb-segActive" : ""), onClick: function () { if (!eolOn) writeField("gitAutocrlf", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!eolOn ? " gb-segActive" : ""), onClick: function () { if (eolOn) writeField("gitAutocrlf", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("eol.hint")),
					E("div", { className: "gb-row" },
						E("span", { className: "gb-rowLabel" }, t("bash.label") + ":"),
					),
					E("div", { className: "gb-seg" },
						E("input", { className: "gb-input", type: "text", spellCheck: false, placeholder: "C:/Program Files/Git/bin/bash.exe", value: bashDraft, onChange: function (e) { setBashDraft(e.target.value); setBashSaved(false); } }),
						E("button", {
							type: "button",
							className: "gb-saveBtn" + (bashSaved ? " gb-saved" : ""),
							onClick: function () {
								setBashSaved(false);
								writeField("bashPath", bashDraft.trim()).then(function (accepted) { setBashSaved(accepted === true); });
							},
						}, bashSaved ? t("bash.saved") : t("bash.save")),
					),
				E("p", { className: "gb-hint" }, t("bash.hint")),
				),
			);

			var terminalSection = E("div", { className: "gb-section" },
				E("div", { className: "gb-sectionTitle" }, t("sec.terminal")),
				E("div", { className: "gb-stack" },
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("adopt.label") + ":"),
					E("span", { className: "gb-rowValue" }, adopt ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (adopt ? " gb-segActive" : ""), onClick: function () { if (!adopt) writeField("adoptSidebar", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!adopt ? " gb-segActive" : ""), onClick: function () { if (adopt) writeField("adoptSidebar", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("adopt.hint")),
				),
			);

			/* Peer-gated section: rendered only while dsh-ptc-cordis-preset serves
			   its own row. The value stays on THIS row — the peer card binds the
			   same field through configForms — so the buttons write through
			   writeField exactly like every other row on this card. */
			var peerSnap = { status: "unavailable" };
			try {
				if (peer && typeof peer.getSnapshot === "function") peerSnap = peer.getSnapshot();
			} catch (error_) { /* keep unavailable */ }

			var dedupeSection = peerSnap.status === "ready" ? E("div", { className: "gb-section" },
				E("div", { className: "gb-sectionTitle" }, t("sec.dedupe")),
				E("div", { className: "gb-stack" },
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("dedupe.label") + ":"),
					E("span", { className: "gb-rowValue" }, dedupe ? t("state.on") : t("state.off")),
				),
				E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (dedupe ? " gb-segActive" : ""), onClick: function () { if (!dedupe) writeField("suppressPeerCordis", true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!dedupe ? " gb-segActive" : ""), onClick: function () { if (dedupe) writeField("suppressPeerCordis", false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("dedupe.hint")),
				),
			) : null;

			/* Python row (v0.26.0): the SECOND seat of the PEER's switch. Unlike
			   the dedupe row above, the value does NOT live on our row — the
			   experimental run_code backend replaces a profile-level row, so its
			   authoritative state is dsh-ptc-cordis-preset's own `pythonRuntime`
			   field and BOTH cards read/write that one form. Drawn only when the
			   peer's snapshot actually carries the field (an older peer without
			   the switch draws nothing), and the buttons write through the peer
			   form so either side syncs the other immediately. On a Windows host
			   the switch is inert — the CPython backend refuses to load there —
			   so the buttons give way to that reason. */
			var pythonOffered = peerSnap.status === "ready" && peerSnap.value !== null
				&& typeof peerSnap.value === "object"
				&& Object.prototype.hasOwnProperty.call(peerSnap.value, PEER_PYTHON_FIELD);
			var pythonOn = pythonOffered && peerSnap.value[PEER_PYTHON_FIELD] === true;
			var peerPythonBackend = "";
			if (pythonOffered && typeof peerSnap.value[PEER_PYTHON_BACKEND_FIELD] === "string") {
				peerPythonBackend = peerSnap.value[PEER_PYTHON_BACKEND_FIELD];
			}
			/* Intent on + effective node = the user asked for Python and the host
			   is still running Node behind the official rows. */
			var pythonDegraded = pythonOn && peerPythonBackend === "node";
			function writePython(next) {
				setError("");
				if (peer === null || typeof peer.set !== "function") return;
				try {
					Promise.resolve(peer.set(PEER_PYTHON_FIELD, next)).then(
						function () { bumpTick(function (n) { return n + 1; }); },
						function (err) {
							bumpTick(function (n) { return n + 1; });
							setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
						},
					);
				} catch (err) {
					bumpTick(function (n) { return n + 1; });
					setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
				}
			}

			var pythonSection = pythonOffered ? E("div", { className: "gb-section" },
				E("div", { className: "gb-sectionTitle" }, t("sec.python")),
				E("div", { className: "gb-stack" },
				E("div", { className: "gb-row" },
					E("span", { className: "gb-rowLabel" }, t("python.label") + ":"),
					E("span", { className: "gb-rowValue" }, pythonOn
						? (pythonDegraded ? t("python.on") + " · " + t("python.degraded") : t("python.on"))
						: t("python.off")),
				),
				winHost ? null : E("div", { className: "gb-seg" },
					E("button", { type: "button", className: "gb-segBtn" + (pythonOn ? " gb-segActive" : ""), onClick: function () { if (!pythonOn) writePython(true); } }, t("switch.on")),
					E("button", { type: "button", className: "gb-segBtn" + (!pythonOn ? " gb-segActive" : ""), onClick: function () { if (pythonOn) writePython(false); } }, t("switch.off")),
				),
				E("p", { className: "gb-hint" }, t("python.hint")),
				winHost ? E("p", { className: "gb-error" }, t("python.blocked")) : null,
				pythonDegraded ? E("p", { className: "gb-error" }, t("python.degraded")) : null,
				),
			) : null;

			var bodyContent = E("div", { className: "gb-body" },
				dialectSection,
				terminalSection,
				dedupeSection,
				pythonSection,
				error ? E("p", { className: "gb-error" }, error) : null,
			);

			if (pageView) return E("div", { className: "gb-card gb-pageCard" },
				E("div", { className: "gb-header gb-headerFlat" },
					E("span", { className: "gb-headText" },
						E("span", { className: "gb-name" }, t("title")),
						E("span", { className: "gb-desc" }, t("cardDesc")),
					),
				),
				bodyContent,
			);

			return E("li", { className: "gb-card" + (open ? " gb-open" : "") },
				E("button", {
					type: "button",
					className: "gb-header",
					"aria-expanded": open,
					onClick: function () { setOpen(!open); },
				},
					E("span", { className: "gb-headText" },
						E("span", { className: "gb-name" }, t("title")),
						E("span", { className: "gb-desc" }, t("cardDesc")),
					),
					Chevron
						? E(Chevron, { className: "gb-chevron" + (open ? " gb-chevronOpen" : "") })
						: E("span", { className: "gb-chevron" + (open ? " gb-chevronOpen" : "") }, "▾"),
				),
				open ? bodyContent : null,
			);
		}

		// ── missing-Git-Bash popup (v0.28.0, issue #11) ────────────────────────
		//
		// When no Git for Windows bash resolves, the host cannot run ANY command
		// (this plugin withdraws pwsh-sandbox and dsh allows one shell per
		// process) — so the user must not be left staring at `spawn ... ENOENT`.
		// The host prints the full report to its log and serves the same verdict
		// at /dsh-gitbash-shell/api/status; this overlay turns it into the two
		// actions the user asked for: edit the path right here, or go download
		// Git for Windows. Deliberately NO "keep something runnable" fallback:
		// an unresolved bash stays unresolved, visibly.
		var API_PATH = "dsh-gitbash-shell/api/status";
		var DISMISS_KEY = "dsh-gitbash-shell:bash-missing-dismissed";
		/** Once per client boot; sessionStorage survives a re-render, not a restart. */
		var bashPopupShown = false;

		function readDismissed() {
			try { return window.sessionStorage.getItem(DISMISS_KEY) === "1" } catch (error_) { return false }
		}
		function rememberDismissed() {
			try { window.sessionStorage.setItem(DISMISS_KEY, "1") } catch (error_) { /* private mode */ }
		}

		function MissingBashPopup(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var dialectState = useState(null);
			var status = dialectState[0];
			var setStatus = dialectState[1];
			var draftState = useState("");
			var draft = draftState[0];
			var setDraft = draftState[1];
			var savedState = useState(false);
			var saved = savedState[0];
			var setSaved = savedState[1];
			var saveErrorState = useState("");
			var saveError = saveErrorState[0];
			var setSaveError = saveErrorState[1];
			var hiddenState = useState(readDismissed());
			var hidden = hiddenState[0];
			var setHidden = hiddenState[1];
			/* "Once per boot" is DECIDED in an effect, never during render: a
			   render-time flag check would make the modal vanish on the very next
			   re-render (the flag it just set). Local state owns this mount's
			   decision; the module flag stops a second mount from repeating it. */
			var decidedState = useState(false);
			var decided = decidedState[0];
			var setDecided = decidedState[1];

			useEffect(function () {
				var alive = true;
				/* Mount-relative on purpose (same discipline as dsh-ide-git): the
				   host serves the shell with <base href="./">, so a path without a
				   leading slash lands on the plugin route at the origin root AND
				   behind a prefix-stripping proxy. */
				try {
					Promise.resolve(fetch(API_PATH, { headers: { accept: "application/json" } }))
						.then(function (response) { return response.ok ? response.json() : null })
						.then(function (data) {
							if (!alive || !data || data.platform !== "win32" || data.ok !== false) return;
							if (bashPopupShown || readDismissed()) return;
							bashPopupShown = true;
							setStatus(data);
							setDecided(true);
							if (typeof data.configured === "string" && data.configured !== "") setDraft(data.configured);
						})
						.catch(function () { /* the host may be older; no popup then */ });
				} catch (error_) { /* keep silent */ }
				return function () { alive = false; };
			}, []);

			if (hidden || !decided || status === null) return null;

			var rows = Array.isArray(status.tried) ? status.tried : [];
			var close = function () { rememberDismissed(); setHidden(true); };
			var save = function () {
				setSaved(false);
				setSaveError("");
				var forms;
				try {
					var c = props.ctx;
					forms = c === undefined || c === null ? undefined : c.get("configForms");
				} catch (error_) { forms = undefined; }
				var form;
				try { form = forms && typeof forms.get === "function" ? forms.get(SETTINGS_NAMESPACE) : undefined; } catch (error_) { form = undefined; }
				if (!form || typeof form.set !== "function") {
					/* No form seat: say so instead of pretending the save landed. */
					setSaveError(t("error") + ": " + t("bash.saveFailed"));
					return;
				}
				try {
					/* The verdict is the HOST's: `accepted === false` is a refusal and
					   must NOT read as "saved" (AGENTS §4h, silent false success). */
					Promise.resolve(form.set("bashPath", draft.trim())).then(
						function (accepted) {
							if (accepted === true) { setSaved(true); return; }
							setSaved(false);
							setSaveError(t("error") + ": " + t("bash.saveFailed"));
						},
						function (err) {
							setSaved(false);
							setSaveError(t("error") + ": " + (err && err.message ? err.message : String(err)));
						},
					);
				} catch (err) {
					setSaved(false);
					setSaveError(t("error") + ": " + (err && err.message ? err.message : String(err)));
				}
			};

			return E("div", { className: "gb-modalBackdrop", role: "dialog", "aria-modal": "true" },
				E("div", { className: "gb-modal" },
					E("div", { className: "gb-modalTitle" }, t("bashmiss.title")),
					E("p", { className: "gb-hint" }, t("bashmiss.body")),
					rows.length > 0 ? E("div", null,
						E("div", { className: "gb-rowLabel" }, t("bashmiss.tried")),
						E("ul", { className: "gb-modalList" }, rows.slice(0, 12).map(function (row, index) {
							return E("li", { key: String(index) }, (row && row.path ? row.path : "?") + " — " + (row && row.detail ? row.detail : row && row.code ? row.code : ""));
						})),
					) : null,
					E("div", { className: "gb-row" },
						E("span", { className: "gb-rowLabel" }, t("bash.label") + ":"),
						E("input", {
							className: "gb-input",
							type: "text",
							value: draft,
							placeholder: "Q:/Git/bin/bash.exe",
							onChange: function (event) { setDraft(event.target.value); setSaved(false); },
						}),
					),
					E("div", { className: "gb-seg" },
						E("button", { type: "button", className: "gb-segBtn", onClick: save }, t("bash.save")),
						saved ? E("span", { className: "gb-rowValue" }, t("bash.saved")) : null,
					),
					saveError !== "" ? E("p", { className: "gb-error" }, saveError) : null,
					E("p", { className: "gb-hint" }, t("bashmiss.where")),
					E("div", { className: "gb-seg" },
						E("button", {
							type: "button",
							className: "gb-segBtn gb-segActive",
							onClick: function () { try { window.open(status.downloadUrl || "https://git-scm.com/download/win", "_blank", "noopener") } catch (error_) { /* blocked */ } },
						}, t("bashmiss.download")),
						E("button", { type: "button", className: "gb-segBtn", onClick: close }, t("bashmiss.close")),
					),
				),
			);
		}

		// ── plugin ────────────────────────────────────────────────────────────

		exports.name = "dsh-gitbash-shell/client";

		/**
		 * Required client services: only era-guaranteed ones are hard-injected;
		 * the settings face is acquired OPTIONALLY (dsh 0.1.7 removed the
		 * settingsScope service and a hard inject would leave this fiber PENDING
		 * forever, taking the card down with it).
		 */
		exports.inject = ["locale", "slots"];

		exports.apply = function (ctx) {
			// Era-split settings face (same contract both eras: getSnapshot/set/unset).
			var scope = null;

			// OLD era (dsh <= 0.1.6): bound settings scope.
			try {
				ctx.inject(["settingsScope"], function (sctx) {
					try {
						var svc = sctx && sctx.settingsScope;
						if (svc && typeof svc.bind === "function") scope = svc.bind({ namespace: SETTINGS_NAMESPACE });
					} catch (error) {
						console.warn(TAG + " settingsScope acquisition failed:", error && error.message ? error.message : error);
					}
				});
			} catch (error) {
				console.warn(TAG + " settingsScope wiring failed:", error && error.message ? error.message : error);
			}

			// NEW era (dsh >= 0.1.7): one ConfigForm per live profile entry; the form
			// key is the row id "gitbash-shell" (same string as the old namespace).
			try {
				ctx.inject(["configForms"], function (fctx) {
					try {
						var forms = fctx && fctx.configForms;
						if (forms && typeof forms.get === "function") scope = forms.get(SETTINGS_NAMESPACE);
					} catch (error) {
						console.warn(TAG + " configForms acquisition failed:", error && error.message ? error.message : error);
					}
				});
			} catch (error) {
				console.warn(TAG + " configForms wiring failed:", error && error.message ? error.message : error);
			}
			/* The card's only copy entry point: a live lookup, never a captured
			   dictionary — the language preference switches without a reload. */
			var t = translatorOf(ctx);

			ctx.effect(function () {
				var disposers = [ensureStyles()];
				try {
					/* Every shipped dictionary rides the DSH locale registry, so host-side
					   consumers read the same copy the card does; a missing service simply
					   means the card is the only reader. */
					var disposeDict = ctx.locale.register(NS, Object.assign({ zh: zh, en: en }, LOCALES));
					if (typeof disposeDict === "function") disposers.push(disposeDict);
				} catch (error) {
					console.warn(TAG + " dictionary registration failed:", error && error.message ? error.message : error);
				}
				return function () {
					for (var i = 0; i < disposers.length; i++) {
						try {
							if (typeof disposers[i] === "function") disposers[i]();
						} catch (error) { /* best effort */ }
					}
				};
			}, "dsh-gitbash-shell: styles, dictionaries");

			// Guarded registration (the dsh-better-workspace pattern): a thrown
			// register degrades this one seat, never the plugin fiber.
			try {
				var slots = ctx.slots;
				if (!slots || typeof slots.inject !== "function") {
					console.warn(TAG + " slots service unavailable; settings card idle");
					return;
				}
				var injected = function () {
					// The inject factory's returned members become the component's
					// props: the bound settings scope AND the ctx (used to reach
					// configForms for the peer-gated dedupe row) ride here as PLAIN
					// members (top-level options fields do NOT reach the component).
					return { scope: scope, ctx: ctx };
				};
				// Legacy seat (dsh <= 0.1.6-alpha.1): Settings → Plugins card.
				slots.inject("settings.plugin.item", function () {
					return slots.register({
						name: "settings.plugin.item",
						key: SETTINGS_NAMESPACE,
						locale: NS,
						inject: injected,
					}, function CardWithLocale(props) {
						/* The registration's locale field also hands out the framework's own
						   t seat; the plugin's lookup wins (21 locale tags against the catalog's
						   zh/en), passed last so no prop merge order can override it. */
						return E(LocaleLive, { ctx: ctx, t: t, cardProps: props });
					});
				});
				// dsh 0.1.6-alpha.2+: the Plugins page's bundle configuration seat,
				// keyed by the PACKAGE name. Each inject waits for its own slot
				// declaration, so exactly one seat is live on any host version.
				/* Root-level popup seat: rendered regardless of which page is open,
				   which is the point — the user may never open settings. */
				slots.inject("shell.overlay", function () {
					return slots.register({
						name: "shell.overlay",
						id: "gitbash-shell:bash-missing",
						locale: NS,
						inject: injected,
					}, function MissingBashPopupWithLocale(props) {
						return E(LocaleLive, { ctx: ctx, t: t, cardProps: props, popup: true });
					});
				});
				slots.inject("plugins.bundle.config", function () {
					return slots.register({
						name: "plugins.bundle.config",
						key: "dsh-gitbash-shell",
						locale: NS,
						inject: injected,
					}, function BundleConfigWithBoundary(props) {
						/* Same LocaleLive wrap as the legacy seat: the plugin's 21-tag
						   dictionary wins over the catalog's zh/en t seat. */
						return E(LocaleLive, { ctx: ctx, t: t, cardProps: props });
					});
				});
			} catch (error) {
				console.warn(TAG + " settings card registration failed:", error && error.message ? error.message : error);
			}
		};

		return module.exports;
	},
});
