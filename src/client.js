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
 *     first so locale / settingsScope / slots exist when this applies.
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

		var TAG = "[gitbash-shell/client]";
		/** Dictionary namespace (the plugin's own t seat). */
		var NS = "gitbashShell";
		/** The settings namespace the HOST half serves. */
		var SETTINGS_NAMESPACE = "gitbash-shell";

		// ── dictionaries (zh/en MUST stay key-aligned; smoke-enforced) ─────────

		var zh = {
			"title": "Git Bash 路径方言",
			"cardDesc": "所有工具统一 /c/ POSIX 路径形式(默认关闭)",
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
			"cardDesc": "One /c/ POSIX path style for every tool (off by default)",
			"state.label": "Current state",
			"state.on": "Enabled",
			"state.off": "Disabled",
			"switch.on": "Enable",
			"switch.off": "Disable",
			"error": "write failed",
			"hint": "Enabled: every tool (bash commands and workdir, read/write/edit/read_image/glob/grep path arguments) uses MSYS drive-root POSIX paths (/c/Users/...); the host translates path fields for the file tools automatically. Disabled restores dsh-native behavior (Windows paths for file tools). Bash is always Git Bash while the plugin is installed; this switch only governs the cross-tool path dialect.",
		};

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

		// ── settings card (module-level component) ───────────────────────────────

		/**
		 * The Settings → Plugins card. t arrives through the registration's
		 * locale field; scope arrives as a PLAIN prop from the inject factory.
		 * Snapshots are read per render; each write bumps a local tick so the
		 * card re-reads without an external-store hook adapter.
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

			ctx.effect(function () {
				var disposers = [ensureStyles()];
				try {
					var disposeDict = ctx.locale.register(NS, { zh: zh, en: en });
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
				slots.inject("settings.plugin.item",
					{
						name: "settings.plugin.item",
						key: SETTINGS_NAMESPACE,
						locale: NS,
						inject: function () { return { scope: scope }; },
					},
					function (props) {
						return E(QuietBoundary, null, E(GitBashCard, props));
				},
				);
			} catch (error) {
				console.warn(TAG + " settings card registration failed:", error && error.message ? error.message : error);
			}
		};
	},
});
