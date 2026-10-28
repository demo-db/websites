// libs/datatug/embed/src/exact-decimal.ts
function e(e) {
	let t = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(e);
	if (!t) return null;
	let n = (t[2] ?? "0").replace(/^0+/, "") || "0", r = (t[3] ?? t[4] ?? "").replace(/0+$/, "");
	return {
		integer: n,
		fraction: r,
		negative: t[1] === "-" && (n !== "0" || r !== "")
	};
}
function t(t, n) {
	let r = e(t), i = e(n);
	if (!r || !i) return t.localeCompare(n);
	if (r.negative !== i.negative) return r.negative ? -1 : 1;
	let a = r.negative ? -1 : 1;
	if (r.integer.length !== i.integer.length) return (r.integer.length < i.integer.length ? -1 : 1) * a;
	let o = r.integer < i.integer ? -1 : +(r.integer > i.integer);
	if (o) return o * a;
	let s = Math.max(r.fraction.length, i.fraction.length), c = r.fraction.padEnd(s, "0"), l = i.fraction.padEnd(s, "0");
	return (c < l ? -1 : +(c > l)) * a;
}
function n(n, r) {
	let i = n == null ? null : String(n), a = r == null ? null : String(r);
	if (i === null || a === null) return i === a ? 0 : i === null ? -1 : 1;
	let o = e(i) !== null;
	return o === (e(a) !== null) ? o ? t(i, a) : i.localeCompare(a) : o ? -1 : 1;
}
// libs/datatug/embed/src/grid-state.ts
var r = () => ({
	q: "",
	sort: "",
	desc: !1,
	page: 0,
	filter: {}
}), i = (e) => e === null || typeof e == "string" && e.length <= 1024 || typeof e == "boolean" || typeof e == "number" && Number.isFinite(e);
function a(e, t) {
	if (!e || typeof e != "object" || Array.isArray(e) || Object.keys(e).length > 128) throw Error("Invalid table filter.");
	if (!Object.entries(e).every(([e, n]) => t.includes(e) && i(n))) throw Error("This table link names an unavailable field or value.");
	return e;
}
function o(e, t, n) {
	let i = new URLSearchParams(e).get(t);
	if (i === null) return r();
	if (i.length > 4096) throw Error("This table link is too large.");
	let o = JSON.parse(i);
	if (!o || typeof o != "object" || Array.isArray(o)) throw Error("Invalid table link.");
	let s = o;
	if (Object.keys(s).some((e) => ![
		"q",
		"sort",
		"desc",
		"page",
		"filter",
		"record"
	].includes(e))) throw Error("This table link uses unsupported filters.");
	if (s.q !== void 0 && (typeof s.q != "string" || s.q.length > 256)) throw Error("Invalid row search.");
	if (s.sort !== void 0 && (typeof s.sort != "string" || s.sort !== "" && !n.includes(s.sort))) throw Error("Invalid sort column.");
	if (s.desc !== void 0 && typeof s.desc != "boolean") throw Error("Invalid sort direction.");
	if (s.page !== void 0 && (typeof s.page != "number" || !Number.isInteger(s.page) || s.page < 0 || s.page > 1e6)) throw Error("Invalid table page.");
	return {
		q: s.q ?? "",
		sort: s.sort ?? "",
		desc: s.desc ?? !1,
		page: s.page ?? 0,
		filter: s.filter === void 0 ? {} : a(s.filter, n),
		...s.record === void 0 ? {} : { record: a(s.record, n) }
	};
}
function s(e, t) {
	return Object.entries(t).every(([t, n]) => Object.hasOwn(e, t) && e[t] === n);
}
function c(e, t) {
	if (!t.length || t.length > 16 || t.some((e) => e.length > 256) || !t.every((t) => Object.hasOwn(e, t) && e[t] !== null && i(e[t]) && (typeof e[t] != "number" || Number.isSafeInteger(e[t])))) return;
	let n = Object.fromEntries(t.map((t) => [t, e[t]]));
	return JSON.stringify(n).length <= 2048 ? n : void 0;
}
function l(e, t, n, r) {
	let a = n.find((e) => e.bindings.some((e) => e.local === t));
	if (!a?.bindings.length || a.bindings.some((t) => !Object.hasOwn(e, t.local) || e[t.local] === null || !i(e[t.local]) || typeof e[t.local] == "number" && !Number.isSafeInteger(e[t.local]))) return null;
	let o, s;
	try {
		o = new URL(a.href, r), s = new URL(r);
	} catch {
		return null;
	}
	if (o.origin !== s.origin || o.username || o.password || !o.pathname.startsWith("/tables/")) return null;
	let c = Object.fromEntries(a.bindings.map((t) => [t.remote, e[t.local]])), l = JSON.stringify({ filter: c });
	return l.length > 4096 ? null : (o.searchParams.set("rows", l), o.hash = "data", o.href);
}
// libs/datatug/embed/src/data.ts
function u(e, t) {
	let n = new URL(e, t);
	if (!["http:", "https:"].includes(n.protocol) || n.username || n.password) throw Error("Source URL must be HTTP(S) without embedded credentials.");
	return n;
}
function d(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function f(e) {
	let t = d(e) ? e : void 0, n = Array.isArray(e) ? e : t?.records ?? t?.rows ?? t?.data;
	if (!Array.isArray(n)) throw Error("JSON source must be a row array or contain records, rows, or data.");
	let r = [], i = [];
	for (let e of n) {
		if (!d(e)) throw Error("Every JSON row must be an object.");
		d(e.data) && typeof e.key == "string" ? (r.push(e.data), i.push(e.key)) : r.push(e);
	}
	return {
		rows: r,
		columns: Array.isArray(t?.columns) && t.columns.every((e) => typeof e == "string") ? t.columns : [...new Set(r.flatMap((e) => Object.keys(e)))],
		keys: i.length === r.length ? i : void 0,
		metadata: t
	};
}
function p(e) {
	let t = [], n = [], r = "", i = !1, a = e.replace(/^\uFEFF/, "");
	for (let e = 0; e < a.length; e++) {
		let o = a[e];
		if (i) o === "\"" && a[e + 1] === "\"" ? (r += "\"", e++) : o === "\"" ? i = !1 : r += o;
		else if (o === "\"") {
			if (r) throw Error("Malformed CSV quote.");
			i = !0;
		} else o === "," ? (n.push(r), r = "") : o === "\n" || o === "\r" ? (o === "\r" && a[e + 1] === "\n" && e++, n.push(r), t.push(n), n = [], r = "") : r += o;
	}
	if (i) throw Error("Unclosed CSV quote.");
	if ((r || n.length) && (n.push(r), t.push(n)), !t.length) return {
		rows: [],
		columns: []
	};
	let o = t.shift() ?? [];
	if (o.some((e) => !e) || new Set(o).size !== o.length) throw Error("CSV header columns must be nonempty and unique.");
	return {
		columns: o,
		rows: t.map((e) => {
			if (e.length !== o.length) throw Error("CSV row has a different number of columns than its header.");
			return Object.fromEntries(o.map((t, n) => [t, e[n]]));
		})
	};
}
function m(e, t, n) {
	let r = e?.split(";", 1)[0]?.trim().toLowerCase();
	if (r === "application/json" || r?.endsWith("+json")) return "json";
	if (r === "text/csv" || r === "application/csv") return "csv";
	let i = t.pathname.toLowerCase();
	if (i.endsWith(".json")) return "json";
	if (i.endsWith(".csv")) return "csv";
	if (n === "json" || n === "csv") return n;
	throw Error("Cannot detect data format. Set format=\"json\" or format=\"csv\".");
}
async function h(e, t) {
	if (e.ok) return e;
	let n = "";
	try {
		let t = await e.json();
		if (d(t)) {
			let e = t.error, r = t.message ?? (d(e) ? e.message : e);
			typeof r == "string" && (n = r);
		}
	} catch {}
	throw Error(`${t} failed (${e.status})${n ? `: ${n}` : ""}.`);
}
async function g(e, t, n) {
	let r = u(e, document.baseURI), i = await h(await fetch(r, {
		signal: n,
		credentials: "same-origin",
		headers: { Accept: "application/json, text/csv;q=0.9" }
	}), "Data request");
	return m(i.headers.get("Content-Type"), r, t) === "json" ? f(await i.json()) : p(await i.text());
}
async function _(e, t, n, r) {
	let i = u(e, document.baseURI), a = new URL("/.well-known/openvaultdb", i.origin), o = (await (await h(await fetch(a, {
		signal: r,
		credentials: "same-origin",
		headers: { Accept: "application/json" }
	}), "OVDB discovery")).json()).databases?.find((e) => {
		if (!e.url) return !1;
		try {
			return u(e.url, a.href).href.replace(/\/$/, "") === i.href.replace(/\/$/, "");
		} catch {
			return !1;
		}
	});
	if (!o?.apiUrl) throw Error("OVDB discovery does not list this database connection URL.");
	let s = u(o.apiUrl, a.href), c = await (await h(await fetch(s, {
		signal: r,
		credentials: "same-origin",
		headers: { Accept: "application/json" }
	}), "OVDB database metadata")).json(), l = c.capabilities ?? o.capabilities, p = Array.isArray(l) ? l.includes("tugql") : d(l) && l.tugql === !0, m = c.endpoints?.tugql;
	if (!p || !m) throw Error("This OVDB database does not advertise TugQL queries.");
	let g = u(m, s.href), _ = c.queryFormat, v, y;
	if (_ === "tugql-yaml+json") v = JSON.stringify({
		query: t,
		parameters: n
	}), y = "application/json";
	else if (_ === "tugql-yaml") {
		if (Object.keys(n).length) throw Error("This OVDB endpoint does not support bound TugQL parameters.");
		v = t, y = "application/yaml";
	} else throw Error(`Unsupported OVDB query format: ${_ ?? "missing"}.`);
	return f(await (await h(await fetch(g, {
		method: "POST",
		signal: r,
		credentials: "same-origin",
		headers: {
			"Content-Type": y,
			Accept: "application/json"
		},
		body: v
	}), "TugQL query")).json());
}
// libs/datatug/embed/src/index.ts
var v = "\n:host{display:block;box-sizing:border-box;color:var(--datatug-fg,#18304a);font:var(--datatug-font,14px/1.45 system-ui,sans-serif);background:var(--datatug-bg,#fff);border:1px solid var(--datatug-border,#dce5ee);border-radius:var(--datatug-radius,10px);overflow:hidden;min-width:0}\na{color:var(--datatug-accent,#126b78);display:inline-flex;align-items:center;min-width:44px;min-height:44px;text-decoration:underline}a:focus-visible{outline:3px solid var(--datatug-accent,#126b78);outline-offset:2px}*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{min-height:44px;cursor:pointer;background:var(--datatug-button-bg,#f5f8fb);border:1px solid var(--datatug-control-border,#74859a);border-radius:5px;padding:.25rem .55rem}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,th button:focus-visible{outline:2px solid var(--datatug-accent,#2879b9);outline-offset:2px}\n.toolbar{display:flex;align-items:center;justify-content:space-between;gap:.65rem;padding:.7rem .85rem;border-bottom:1px solid var(--datatug-border,#dce5ee);flex-wrap:wrap}.brand{font-weight:700;letter-spacing:.01em}.tools{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}.tools input{max-width:13rem;min-width:7rem;border:1px solid var(--datatug-control-border,#74859a);border-radius:5px;padding:.26rem .45rem;min-height:44px}.status{padding:.8rem;color:var(--datatug-muted,#587087)}.error{color:var(--datatug-error,#ab2e39)}.scroller{overflow:auto;max-height:var(--datatug-max-height,32rem)}table{border-collapse:collapse;min-width:100%;font-variant-numeric:tabular-nums}th,td{height:44px;text-align:left;padding:.46rem .7rem;border-bottom:1px solid var(--datatug-border,#dce5ee);vertical-align:top;white-space:nowrap;max-width:32rem;overflow:hidden;text-overflow:ellipsis}th{position:sticky;top:0;background:var(--datatug-header-bg,#f4f8fb);color:var(--datatug-muted,#587087);font-size:.84em;font-weight:650}th button{border:0;background:none;padding:0;font-weight:inherit;color:inherit}tbody tr:hover{background:var(--datatug-hover,#f5f9fc)}tbody tr[aria-selected=true]{background:var(--datatug-selected,#e7f3fc)}.footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem;padding:.55rem .85rem;color:var(--datatug-muted,#587087);font-size:.85em}.pager{display:flex;gap:.35rem;align-items:center}.chart{padding:.8rem}.bar{display:grid;grid-template-columns:minmax(5rem, 30%) 1fr auto;gap:.6rem;align-items:center;margin:.38rem 0}.track{height:.8rem;border-radius:3px;background:var(--datatug-header-bg,#f4f8fb);overflow:hidden}.fill{height:100%;background:var(--datatug-accent,#2879b9)}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n";
function y(e, t) {
	let n = document.createElement(e);
	return t !== void 0 && (n.textContent = t), n;
}
function b(e) {
	return e == null ? "—" : typeof e == "object" ? JSON.stringify(e) : String(e);
}
function x(e, t) {
	if (t === "string" || !t) return e;
	if (t === "number") {
		if (!e.trim() || !Number.isFinite(Number(e))) throw Error("Invalid number parameter.");
		return Number(e);
	}
	if (t === "boolean") {
		if (e !== "true" && e !== "false") throw Error("Boolean parameter must be true or false.");
		return e === "true";
	}
	if (t === "null") return null;
	throw Error(`Unsupported TugQL parameter type: ${t}.`);
}
var S = class extends HTMLElement {
	connectedCallback() {
		this.style.display = "none", this.observer = new MutationObserver(() => this.notify()), this.observer.observe(this, {
			childList: !0,
			characterData: !0,
			subtree: !0
		});
	}
	disconnectedCallback() {
		this.observer?.disconnect();
	}
	notify() {
		this.dispatchEvent(new Event("tugql-change", { bubbles: !0 }));
	}
}, C = class extends HTMLElement {
	constructor(...e) {
		super(...e), this.propertySet = !1;
	}
	static get observedAttributes() {
		return [
			"name",
			"value",
			"type"
		];
	}
	get value() {
		return this.propertySet ? this.propertyValue : x(this.getAttribute("value") ?? "", this.getAttribute("type"));
	}
	set value(e) {
		if (e !== null && ![
			"string",
			"number",
			"boolean"
		].includes(typeof e)) throw TypeError("TugQL parameter value must be a JSON scalar.");
		this.propertySet = !0, this.propertyValue = e, this.notify();
	}
	attributeChangedCallback(e) {
		(e === "value" || e === "type") && (this.propertySet = !1), this.notify();
	}
	connectedCallback() {
		this.style.display = "none", this.notify();
	}
	notify() {
		this.dispatchEvent(new Event("tugql-change", { bubbles: !0 }));
	}
}, w = class extends HTMLElement {
	static get observedAttributes() {
		return [
			"connection",
			"data-url",
			"format",
			"type",
			"page-size"
		];
	}
	constructor() {
		super(), this.root = this.attachShadow({ mode: "open" }), this.state = "loading", this.message = "", this.scheduled = !1, this.revision = 0, this.onChildChange = () => this.schedule(), this.root.append(y("style", v));
	}
	connectedCallback() {
		this.addEventListener("tugql-change", this.onChildChange), this.observer = new MutationObserver(() => this.schedule()), this.observer.observe(this, {
			childList: !0,
			subtree: !1
		}), this.schedule();
	}
	disconnectedCallback() {
		this.removeEventListener("tugql-change", this.onChildChange), this.observer?.disconnect(), this.controller?.abort(), this.revision++;
	}
	attributeChangedCallback() {
		this.schedule();
	}
	schedule() {
		this.isConnected && !this.scheduled && (this.scheduled = !0, queueMicrotask(() => {
			this.scheduled = !1, this.isConnected && this.refresh();
		}));
	}
	async refresh() {
		this.controller?.abort();
		let e = new AbortController();
		this.controller = e;
		let t = ++this.revision;
		this.state = "loading", this.message = "Loading data…", this.render();
		try {
			let n = this.getAttribute("connection"), r = this.getAttribute("data-url"), i = [...this.children].filter((e) => e.localName === "tugql-query"), a = i[0], o = [...this.children].filter((e) => e.localName === "tugql-param");
			if (!!n == !!r) throw Error("Set exactly one of connection or data-url.");
			if (r && (i.length || o.length)) throw Error("data-url cannot be combined with TugQL query or parameters.");
			if (n && (i.length !== 1 || !a?.textContent?.trim())) throw Error("A connection requires one nonempty <tugql-query>.");
			let s = Object.create(null);
			for (let e of o) {
				let t = e.getAttribute("name");
				if (!t || Object.hasOwn(s, t)) throw Error("Every <tugql-param> needs a unique nonempty name.");
				s[t] = e.value;
			}
			if (!r && (!n || !a?.textContent)) throw Error("A connection requires one nonempty <tugql-query>.");
			let c = r ? await g(r, this.getAttribute("format"), e.signal) : await _(n, a?.textContent?.trim() ?? "", s, e.signal);
			if (e.signal.aborted || t !== this.revision) return;
			this.validateData(c), this.data = c, this.state = c.rows.length ? "ready" : "empty", this.message = c.rows.length ? "" : "No rows found.", this.render(), this.dispatchEvent(new CustomEvent("datatug-data-loaded", {
				detail: {
					rows: c.rows.length,
					columns: c.columns,
					metadata: c.metadata
				},
				bubbles: !0
			}));
		} catch (n) {
			if (e.signal.aborted || t !== this.revision) return;
			this.data = void 0, this.state = "error", this.message = n instanceof Error ? n.message : "Could not load data.", this.render(), this.dispatchEvent(new CustomEvent("datatug-error", {
				detail: { message: this.message },
				bubbles: !0
			}));
		}
	}
	reload() {
		return this.refresh();
	}
	validateData(e) {
		if (!Array.isArray(e.rows)) throw Error("The source did not return rows.");
	}
	shell(e) {
		this.setAttribute("data-load-state", this.state), [...this.root.children].filter((e) => e.localName !== "style").forEach((e) => e.remove());
		let t = y("div"), n = y("div");
		n.className = "toolbar";
		let r = y("span", e);
		return r.className = "brand", n.append(r), t.append(n), this.root.append(t), t;
	}
	statusNode(e) {
		if (this.state === "ready") return !1;
		let t = y("div", this.message);
		return t.className = `status ${this.state === "error" ? "error" : ""}`, t.setAttribute("role", this.state === "error" ? "alert" : "status"), e.append(t), !0;
	}
}, T = class extends w {
	constructor(...e) {
		super(...e), this.search = "", this.sortDesc = !1, this.page = 0, this.locationRead = !1, this.renderGeneration = 0, this.linkState = r(), this.linkError = "", this.recordMissing = !1, this.onLocationChange = () => {
			this.locationRead = !1, this.render();
		};
	}
	connectedCallback() {
		super.connectedCallback(), this.hasAttribute("data-state-key") && window.addEventListener("popstate", this.onLocationChange);
	}
	disconnectedCallback() {
		super.disconnectedCallback(), window.removeEventListener("popstate", this.onLocationChange);
	}
	persist() {
		let e = this.getAttribute("data-state-key");
		if (!e || !/^[a-z][a-z0-9-]{0,40}$/.test(e) || this.linkError) return;
		let t = {
			...this.linkState,
			q: this.search,
			sort: this.sortColumn ?? "",
			desc: this.sortDesc,
			page: this.page
		}, n = new URL(location.href);
		!t.q && !t.sort && !t.page && !Object.keys(t.filter).length && !t.record ? n.searchParams.delete(e) : n.searchParams.set(e, JSON.stringify(t)), history.replaceState(null, "", n), this.dispatchEvent(new CustomEvent("datatug-state-change", {
			detail: t,
			bubbles: !0
		}));
	}
	render() {
		let e = this.root.activeElement?.dataset.focus, t = ++this.renderGeneration;
		if (this.data && (!this.locationRead || this.data !== this.renderedData)) {
			this.renderedData = this.data, this.locationRead = !0, this.linkError = "", this.selected = void 0, this.recordMissing = !1;
			try {
				this.linkState = this.hasAttribute("data-state-key") ? o(location.search, this.getAttribute("data-state-key") ?? "rows", this.data.columns) : r();
			} catch {
				this.linkState = r(), this.linkError = "This table link contains invalid or unavailable filters.";
			}
			this.search = this.linkState.q, this.sortColumn = this.linkState.sort || void 0, this.sortDesc = this.linkState.desc, this.page = this.linkState.page;
			let e = this.linkState.record;
			if (e) {
				let t = this.data.rows.findIndex((t) => s(t, e));
				t >= 0 ? this.selected = t : this.recordMissing = !0;
			}
		}
		let i = this.shell("DataTug"), a = i.firstElementChild, u = y("div");
		u.className = "tools";
		let d = y("input");
		d.type = "search", d.maxLength = 256, d.placeholder = "Search rows", d.setAttribute("aria-label", "Search rows"), d.value = this.search;
		let f = () => {
			let e = d.selectionStart, t = d.selectionEnd;
			this.search = d.value, this.page = 0, this.render();
			let n = this.root.querySelector("input");
			n?.focus(), e !== null && t !== null && n?.setSelectionRange(e, t);
		};
		d.addEventListener("input", (e) => {
			e.isComposing || f();
		}), d.addEventListener("compositionend", f);
		let p = y("button", "Refresh");
		if (p.type = "button", p.addEventListener("click", () => void this.refresh()), u.append(d, p), Object.keys(this.linkState.filter).length || this.linkState.record) {
			let e = y("button", "Clear linked filters");
			e.type = "button", e.addEventListener("click", () => {
				this.linkState.filter = {}, delete this.linkState.record, this.selected = void 0, this.recordMissing = !1, this.page = 0, this.render();
			}), u.append(e);
		}
		if (a.append(u), (this.state !== "ready" || this.selected === void 0) && this.dispatchEvent(new CustomEvent("datatug-selection-cleared", { bubbles: !0 })), this.statusNode(i)) return;
		let m = this.data;
		if (!m) return;
		if (this.linkError) {
			let e = y("p", this.linkError);
			e.setAttribute("role", "alert");
			let t = y("button", "Clear invalid table link");
			t.type = "button", t.addEventListener("click", () => {
				let e = new URL(location.href);
				e.searchParams.delete(this.getAttribute("data-state-key") ?? "rows"), history.replaceState(null, "", e), this.locationRead = !1, this.render();
			}), i.append(e, t);
			return;
		}
		if (this.recordMissing) {
			let e = y("p", "The linked record is not present in this copy. Clear linked filters to continue browsing.");
			e.setAttribute("role", "status"), i.append(e);
		}
		let h = this.search.toLocaleLowerCase(), g = m.rows.map((e, t) => ({
			row: e,
			index: t
		})).filter(({ row: e }) => s(e, this.linkState.filter) && (!h || m.columns.some((t) => b(e[t]).toLocaleLowerCase().includes(h))));
		if (this.sortColumn) {
			let e = this.sortColumn, t = /* @__PURE__ */ new Set();
			try {
				t = new Set(JSON.parse(this.getAttribute("data-decimal-columns") ?? "[]"));
			} catch {}
			g.sort((r, i) => {
				let a = r.row[e], o = i.row[e], s = t.has(e) ? n(a, o) : typeof a == "number" && typeof o == "number" ? a - o : b(a).localeCompare(b(o), void 0, { numeric: !0 });
				return (this.sortDesc ? -s : s) || r.index - i.index;
			});
		}
		let _ = Number(this.getAttribute("page-size")), v = Number.isInteger(_) && _ > 0 ? Math.min(_, 500) : 50, x = Math.max(1, Math.ceil(g.length / v));
		this.page = Math.min(this.page, x - 1);
		let S = g.slice(this.page * v, (this.page + 1) * v), C = y("div");
		C.className = "scroller", C.tabIndex = 0, C.setAttribute("role", "region"), C.setAttribute("aria-label", "Table rows. Scroll horizontally to see all columns.");
		let w = y("table"), T = y("thead"), E = y("tr");
		for (let e of m.columns) {
			let t = y("th");
			t.scope = "col", t.setAttribute("aria-sort", this.sortColumn === e ? this.sortDesc ? "descending" : "ascending" : "none");
			let n = y("button", `${e}${this.sortColumn === e ? this.sortDesc ? " ↓" : " ↑" : ""}`);
			n.type = "button", n.dataset.focus = `sort:${e}`, n.addEventListener("click", () => {
				this.sortDesc = this.sortColumn === e && !this.sortDesc, this.sortColumn = e, this.page = 0, this.render();
			}), t.append(n), E.append(t);
		}
		T.append(E), w.append(T);
		let D = y("tbody");
		for (let { row: e, index: t } of S) {
			let n = y("tr");
			n.tabIndex = 0, n.setAttribute("aria-selected", String(this.selected === t));
			let r = () => {
				this.selected = t;
				let r = [];
				try {
					r = JSON.parse(this.getAttribute("data-primary-key") ?? "[]");
				} catch {}
				this.linkState.record = c(e, r), this.persist(), D.querySelectorAll("tr").forEach((e) => e.setAttribute("aria-selected", String(e === n))), this.dispatchEvent(new CustomEvent("datatug-select", {
					detail: {
						row: e,
						index: t,
						key: m.keys?.[t]
					},
					bubbles: !0
				}));
			};
			n.addEventListener("click", (e) => {
				e.target.closest("a") || r();
			}), n.addEventListener("keydown", (e) => {
				e.target.closest("a") || e.key !== "Enter" && e.key !== " " || (e.preventDefault(), r());
			});
			let i = [];
			try {
				let e = JSON.parse(this.getAttribute("data-relations") ?? "[]");
				Array.isArray(e) && e.every((e) => e && typeof e.href == "string" && Array.isArray(e.bindings) && e.bindings.every((e) => typeof e.local == "string" && typeof e.remote == "string")) && (i = e);
			} catch {}
			for (let t of m.columns) {
				let r = y("td"), a = l(e, t, i, document.baseURI);
				if (a) {
					let n = y("a", b(e[t]));
					n.href = a, n.setAttribute("aria-label", `${b(e[t])}: open the related record`), r.append(n);
				} else r.textContent = b(e[t]);
				n.append(r);
			}
			D.append(n);
		}
		w.append(D), C.append(w), i.append(C);
		let O = y("div");
		O.className = "footer", O.append(y("span", `${g.length ? this.page * v + 1 : 0}–${Math.min((this.page + 1) * v, g.length)} of ${g.length} matching rows · ${m.rows.length} total`));
		let k = y("div");
		k.className = "pager";
		let A = y("button", "Previous");
		A.type = "button", A.dataset.focus = "previous", A.disabled = this.page === 0, A.addEventListener("click", () => {
			this.page--, this.render();
		});
		let j = y("button", "Next");
		j.type = "button", j.dataset.focus = "next", j.disabled = this.page >= x - 1, j.addEventListener("click", () => {
			this.page++, this.render();
		}), k.append(A, y("span", `${this.page + 1} / ${x}`), j), O.append(k), i.append(O), this.persist(), e && ([...this.root.querySelectorAll("[data-focus]")].find((t) => t.dataset.focus === e && !t.hasAttribute("disabled")) ?? this.root.querySelector(".scroller"))?.focus(), this.selected !== void 0 && this.linkState.record && queueMicrotask(() => {
			this.isConnected && t === this.renderGeneration && m === this.data && this.selected !== void 0 && this.dispatchEvent(new CustomEvent("datatug-select", {
				detail: {
					row: m.rows[this.selected],
					index: this.selected,
					key: m.keys?.[this.selected]
				},
				bubbles: !0
			}));
		});
	}
}, E = class extends w {
	validateData(e) {
		let t = this.getAttribute("type") ?? "auto";
		if (t !== "auto" && t !== "bar") throw Error(`Unsupported chart type: ${t}.`);
		if (!e.rows.length) return;
		let n = e.columns.find((t) => e.rows.some((e) => typeof e[t] == "number")), r = e.columns.find((e) => e !== n);
		if (!n || !r) throw Error("Chart needs one numeric and one label column.");
	}
	render() {
		let e = this.shell("DataTug chart");
		if (this.statusNode(e)) return;
		let t = this.data;
		if (!t) return;
		let n = t.columns.find((e) => t.rows.some((t) => typeof t[e] == "number")), r = t.columns.find((e) => e !== n);
		if (!n || !r) return;
		let i = t.rows.slice(0, 20), a = Math.max(0, ...i.map((e) => Number(e[n]) || 0)), o = y("div");
		o.className = "chart", o.setAttribute("role", "img"), o.setAttribute("aria-label", `Bar chart of ${n} by ${r}`);
		for (let e of i) {
			let t = Number(e[n]) || 0, i = y("div");
			i.className = "bar";
			let s = y("span", b(e[r]));
			s.className = "label";
			let c = y("div");
			c.className = "track";
			let l = y("div");
			l.className = "fill", l.style.width = `${Math.max(0, a ? t / a * 100 : 0)}%`, c.append(l), i.append(s, c, y("span", b(t))), o.append(i);
		}
		e.append(o);
	}
};
customElements.get("tugql-query") || customElements.define("tugql-query", S), customElements.get("tugql-param") || customElements.define("tugql-param", C), customElements.get("datatug-grid") || customElements.define("datatug-grid", T), customElements.get("datatug-chart") || customElements.define("datatug-chart", E);
export { E as DataTugChart, T as DataTugGrid, C as TugqlParam, S as TugqlQuery };

//# sourceMappingURL=datatug.js.map