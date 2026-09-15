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
			"hint": "启用后:所有工具(bash 命令与 workdir、read/write/edit/read_image/glob/grep 的路径参数)统一使用 MSYS 盘根 POSIX 路径(/c/Users/...);文件工具的路径参数由宿主自动翻译,模型无感。停用后恢复 dsh 原生行为(文件工具用 Windows 路径)。bash 始终是 Git Bash,不受此开关影响。",
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
			"hint": "Enabled: every tool (bash commands and workdir, read/write/edit/read_image/glob/grep path arguments) uses MSYS drive-root POSIX paths (/c/Users/...); the host translates path fields for the file tools automatically. Disabled restores dsh-native behavior (Windows paths for file tools). Bash is always Git Bash while the plugin is installed; this switch only governs the cross-tool path dialect.",
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
				"hint": "عند التفعيل: تستخدم كل الأدوات (أوامر bash و workdir، ومعاملات المسار في read/write/edit/read_image/glob/grep) مسارات POSIX من جذر قرص MSYS (/c/Users/...)؛ ويتولّى المضيف ترجمة حقول المسار لأدوات الملفات تلقائيًا. عند التعطيل يعود السلوك الأصلي لـ dsh (مسارات Windows لأدوات الملفات). يبقى bash دائمًا Git Bash ما دامت الإضافة مثبَّتة؛ هذا المفتاح لا يحكم سوى لهجة المسارات بين الأدوات.",
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
				"hint": "Aktiviert: Alle Tools (bash-Befehle und workdir sowie Pfadargumente von read/write/edit/read_image/glob/grep) verwenden POSIX-Pfade ab der MSYS-Laufwerkswurzel (/c/Users/...); der Host übersetzt die Pfadfelder der Dateitools automatisch. Deaktiviert stellt das dsh-native Verhalten wieder her (Windows-Pfade für Dateitools). Bash ist bei installiertem Plugin immer Git Bash; dieser Schalter steuert nur den Pfaddialekt zwischen den Tools.",
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
				"hint": "Activé : tous les outils (commandes bash et workdir, arguments de chemin de read/write/edit/read_image/glob/grep) utilisent des chemins POSIX à racine de lecteur MSYS (/c/Users/...) ; l'hôte traduit automatiquement les champs de chemin des outils de fichiers. Désactivé rétablit le comportement natif de dsh (chemins Windows pour les outils de fichiers). Bash reste toujours Git Bash tant que le plugin est installé ; ce commutateur ne régit que le dialecte de chemins entre outils.",
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
				"hint": "सक्षम होने पर: सभी टूल (bash कमांड और workdir, तथा read/write/edit/read_image/glob/grep के पथ तर्क) MSYS ड्राइव-रूट POSIX पथ (/c/Users/...) का उपयोग करते हैं; फ़ाइल टूल के पथ फ़ील्ड होस्ट स्वतः अनुवादित करता है। अक्षम करने पर dsh का मूल व्यवहार बहाल होता है (फ़ाइल टूल के लिए Windows पथ)। जब तक प्लगइन इंस्टॉल है bash हमेशा Git Bash रहता है; यह स्विच केवल टूल के बीच पथ शैली नियंत्रित करता है।",
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
				"hint": "Saat aktif: semua alat (perintah bash dan workdir, serta argumen path read/write/edit/read_image/glob/grep) memakai path POSIX berakar drive MSYS (/c/Users/...); host menerjemahkan bidang path untuk alat berkas secara otomatis. Saat nonaktif, perilaku asli dsh dipulihkan (path Windows untuk alat berkas). Bash selalu Git Bash selama plugin terpasang; sakelar ini hanya mengatur dialek path antaralat.",
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
				"hint": "Attivato: tutti gli strumenti (comandi bash e workdir, argomenti di percorso di read/write/edit/read_image/glob/grep) usano percorsi POSIX con radice di unità MSYS (/c/Users/...); l'host traduce automaticamente i campi di percorso degli strumenti per i file. Disattivato ripristina il comportamento nativo di dsh (percorsi Windows per gli strumenti per i file). Bash resta sempre Git Bash finché il plugin è installato; questo interruttore governa solo il dialetto dei percorsi tra gli strumenti.",
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
				"hint": "有効にすると、すべてのツール(bash コマンドと workdir、read/write/edit/read_image/glob/grep のパス引数)が MSYS ドライブルートの POSIX パス(/c/Users/...)を使います。ファイルツールのパスフィールドはホストが自動的に変換します。無効にすると dsh 本来の動作(ファイルツールは Windows パス)に戻ります。bash はプラグインがインストールされている限り常に Git Bash で、このスイッチの影響を受けません。",
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
				"hint": "켜면 모든 도구(bash 명령과 workdir, read/write/edit/read_image/glob/grep의 경로 인수)가 MSYS 드라이브 루트 POSIX 경로(/c/Users/...)를 사용합니다. 파일 도구의 경로 필드는 호스트가 자동으로 변환합니다. 끄면 dsh 기본 동작(파일 도구에 Windows 경로 사용)으로 돌아갑니다. 플러그인이 설치되어 있는 동안 bash는 항상 Git Bash이며 이 스위치의 영향을 받지 않습니다.",
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
				"hint": "Ingeschakeld: alle tools (bash-opdrachten en workdir, padargumenten van read/write/edit/read_image/glob/grep) gebruiken POSIX-paden vanaf de MSYS-schijfwortel (/c/Users/...); de host vertaalt de padvelden voor de bestandstools automatisch. Uitgeschakeld herstelt het oorspronkelijke dsh-gedrag (Windows-paden voor bestandstools). Bash is altijd Git Bash zolang de plugin is geïnstalleerd; deze schakelaar bepaalt alleen het paddialect tussen de tools.",
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
				"hint": "Po włączeniu: wszystkie narzędzia (polecenia bash i workdir oraz argumenty ścieżek w read/write/edit/read_image/glob/grep) używają ścieżek POSIX od korzenia dysku MSYS (/c/Users/...); host automatycznie tłumaczy pola ścieżek narzędzi plikowych. Wyłączenie przywraca natywne zachowanie dsh (ścieżki Windows dla narzędzi plikowych). Bash jest zawsze Git Bash, dopóki wtyczka jest zainstalowana; ten przełącznik reguluje wyłącznie dialekt ścieżek między narzędziami.",
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
				"hint": "Ativada: todas as ferramentas (comandos bash e workdir, argumentos de caminho de read/write/edit/read_image/glob/grep) usam caminhos POSIX a partir da raiz da unidade MSYS (/c/Users/...); o host traduz automaticamente os campos de caminho das ferramentas de arquivo. Desativada restaura o comportamento nativo do dsh (caminhos Windows para as ferramentas de arquivo). O bash é sempre Git Bash enquanto o plugin estiver instalado; este interruptor rege apenas o dialeto de caminhos entre ferramentas.",
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
				"hint": "Включено: все инструменты (команды bash и workdir, аргументы путей read/write/edit/read_image/glob/grep) используют POSIX-пути от корня диска MSYS (/c/Users/...); хост автоматически преобразует поля путей для файловых инструментов. Выключение возвращает исходное поведение dsh (пути Windows для файловых инструментов). Пока плагин установлен, bash всегда остаётся Git Bash; этот переключатель управляет только диалектом путей между инструментами.",
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
				"hint": "Aktiverad: alla verktyg (bash-kommandon och workdir, sökvägsargument för read/write/edit/read_image/glob/grep) använder POSIX-sökvägar från MSYS-enhetsroten (/c/Users/...); värden översätter sökvägsfälten för filverktygen automatiskt. Inaktiverad återställer dsh:s ursprungliga beteende (Windows-sökvägar för filverktyg). Bash är alltid Git Bash så länge insticksprogrammet är installerat; den här växeln styr bara sökvägsdialekten mellan verktygen.",
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
				"hint": "เมื่อเปิดใช้งาน: เครื่องมือทั้งหมด (คำสั่ง bash และ workdir รวมถึงอาร์กิวเมนต์พาธของ read/write/edit/read_image/glob/grep) ใช้พาธ POSIX จากรากไดรฟ์ของ MSYS (/c/Users/...) โฮสต์จะแปลฟิลด์พาธของเครื่องมือจัดการไฟล์ให้อัตโนมัติ เมื่อปิดใช้งานจะกลับสู่พฤติกรรมดั้งเดิมของ dsh (เครื่องมือจัดการไฟล์ใช้พาธ Windows) bash เป็น Git Bash เสมอเมื่อติดตั้งปลั๊กอินนี้ สวิตช์นี้ควบคุมเฉพาะรูปแบบพาธระหว่างเครื่องมือเท่านั้น",
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
				"hint": "Etkinleştirildiğinde: tüm araçlar (bash komutları ve workdir ile read/write/edit/read_image/glob/grep yol bağımsız değişkenleri) MSYS sürücü kökünden POSIX yolları (/c/Users/...) kullanır; ana süreç dosya araçlarının yol alanlarını otomatik olarak çevirir. Devre dışı bırakıldığında dsh yerel davranışına döner (dosya araçları için Windows yolları). Eklenti kurulu olduğu sürece bash her zaman Git Bash olarak kalır; bu anahtar yalnızca araçlar arası yol lehçesini yönetir.",
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
				"hint": "Khi bật: mọi công cụ (lệnh bash và workdir, tham số đường dẫn của read/write/edit/read_image/glob/grep) dùng đường dẫn POSIX từ gốc ổ đĩa MSYS (/c/Users/...); máy chủ tự động chuyển đổi trường đường dẫn cho các công cụ tệp. Khi tắt, hành vi gốc của dsh được khôi phục (công cụ tệp dùng đường dẫn Windows). bash luôn là Git Bash khi plugin được cài đặt; công tắc này chỉ điều khiển phương ngữ đường dẫn giữa các công cụ.",
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
				"hint": "啟用後:所有工具(bash 指令同 workdir、read/write/edit/read_image/glob/grep 嘅路徑參數)統一使用 MSYS 磁碟根 POSIX 路徑(/c/Users/...);檔案工具嘅路徑參數由宿主自動翻譯,模型無感。停用後回復 dsh 原生行為(檔案工具用 Windows 路徑)。bash 永遠係 Git Bash,唔受呢個開關影響。",
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
				"hint": "啟用後:所有工具(bash 指令同 workdir、read/write/edit/read_image/glob/grep 嘅路徑參數)統一使用 MSYS 磁碟根 POSIX 路徑(/c/Users/...);檔案工具嘅路徑參數由宿主自動翻譯,模型無感。停用後回復 dsh 原生行為(檔案工具用 Windows 路徑)。bash 永遠係 Git Bash,唔受呢個開關影響。",
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
				"hint": "啟用後:所有工具(bash 指令與 workdir,以及 read/write/edit/read_image/glob/grep 的路徑參數)統一使用 MSYS 磁碟根 POSIX 路徑(/c/Users/...);檔案工具的路徑參數由宿主自動轉譯,模型無感。停用後恢復 dsh 原生行為(檔案工具使用 Windows 路徑)。bash 一律是 Git Bash,不受此開關影響。",
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

			var scope = props.scope;

			var snap = { status: "unavailable" };
			try {
				if (scope && typeof scope.getSnapshot === "function") snap = scope.getSnapshot();
			} catch (error_) { /* keep unavailable */ }

			if (snap.status !== "ready") return null;

			var value = snap.value || {};
			var enabled = value.posixPaths === true;

			function write(next) {
				setError("");
				scope.set("posixPaths", next)
					.then(function () { bumpTick(function (n) { return n + 1; }); })
					.catch(function (err) {
						bumpTick(function (n) { return n + 1; });
						setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
					});
			}

			var Chevron = icon("IconChevronDownOutline14");

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
				open ? E("div", { className: "gb-body" },
					E("div", { className: "gb-row" },
						E("span", { className: "gb-rowLabel" }, t("state.label") + ":"),
						E("span", { className: "gb-rowValue" }, enabled ? t("state.on") : t("state.off")),
					),
					E("div", { className: "gb-seg" },
						E("button", {
							type: "button",
							className: "gb-segBtn" + (enabled ? " gb-segActive" : ""),
							onClick: function () { if (!enabled) write(true); },
						}, t("switch.on")),
						E("button", {
							type: "button",
							className: "gb-segBtn" + (!enabled ? " gb-segActive" : ""),
							onClick: function () { if (enabled) write(false); },
						}, t("switch.off")),
					),
					error ? E("p", { className: "gb-error" }, error) : null,
					E("p", { className: "gb-hint" }, t("hint")),
				) : null,
			);
		}

		// ── plugin ────────────────────────────────────────────────────────────

		exports.name = "dsh-gitbash-shell/client";

		/** Required client services: locale runtime, settings scopes, slots. */
		exports.inject = ["locale", "settingsScope", "slots"];

		exports.apply = function (ctx) {
			var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
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
				slots.inject("settings.plugin.item", function () {
					return slots.register({
						name: "settings.plugin.item",
						key: SETTINGS_NAMESPACE,
						locale: NS,
						// The inject factory's returned members become the component's
						// props: the bound settings scope rides here as a PLAIN member
						// (top-level options fields do NOT reach the component).
						inject: function () { return { scope: scope }; },
					}, function CardWithLocale(props) {
						/* The registration's locale field also hands out the framework's own
						   t seat; the plugin's lookup wins (21 locale tags against the catalog's
						   zh/en), passed last so no prop merge order can override it. */
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
