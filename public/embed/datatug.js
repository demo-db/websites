function A(o, t) {
  const r = new URL(o, t);
  if (!["http:", "https:"].includes(r.protocol) || r.username || r.password)
    throw new Error("Source URL must be HTTP(S) without embedded credentials.");
  return r;
}
function q(o) {
  return o !== null && typeof o == "object" && !Array.isArray(o);
}
function $(o) {
  const t = q(o) ? o : void 0, r = Array.isArray(o) ? o : t?.records ?? t?.rows ?? t?.data;
  if (!Array.isArray(r)) throw new Error("JSON source must be a row array or contain records, rows, or data.");
  const e = [], s = [];
  for (const a of r) {
    if (!q(a)) throw new Error("Every JSON row must be an object.");
    q(a.data) && typeof a.key == "string" ? (e.push(a.data), s.push(a.key)) : e.push(a);
  }
  const n = Array.isArray(t?.columns) && t.columns.every((a) => typeof a == "string") ? t.columns : [...new Set(e.flatMap((a) => Object.keys(a)))];
  return { rows: e, columns: n, keys: s.length === e.length ? s : void 0, metadata: t };
}
function M(o) {
  const t = [];
  let r = [], e = "", s = !1;
  const n = o.replace(/^\uFEFF/, "");
  for (let c = 0; c < n.length; c++) {
    const i = n[c];
    if (s)
      i === '"' && n[c + 1] === '"' ? (e += '"', c++) : i === '"' ? s = !1 : e += i;
    else if (i === '"') {
      if (e) throw new Error("Malformed CSV quote.");
      s = !0;
    } else i === "," ? (r.push(e), e = "") : i === `
` || i === "\r" ? (i === "\r" && n[c + 1] === `
` && c++, r.push(e), t.push(r), r = [], e = "") : e += i;
  }
  if (s) throw new Error("Unclosed CSV quote.");
  if ((e || r.length) && (r.push(e), t.push(r)), !t.length) return { rows: [], columns: [] };
  const a = t.shift() ?? [];
  if (a.some((c) => !c) || new Set(a).size !== a.length) throw new Error("CSV header columns must be nonempty and unique.");
  return { columns: a, rows: t.map((c) => {
    if (c.length !== a.length) throw new Error("CSV row has a different number of columns than its header.");
    return Object.fromEntries(a.map((i, l) => [i, c[l]]));
  }) };
}
function V(o, t, r) {
  const e = o?.split(";", 1)[0]?.trim().toLowerCase();
  if (e === "application/json" || e?.endsWith("+json")) return "json";
  if (e === "text/csv" || e === "application/csv") return "csv";
  const s = t.pathname.toLowerCase();
  if (s.endsWith(".json")) return "json";
  if (s.endsWith(".csv")) return "csv";
  if (r === "json" || r === "csv") return r;
  throw new Error('Cannot detect data format. Set format="json" or format="csv".');
}
async function S(o, t) {
  if (o.ok) return o;
  let r = "";
  try {
    const e = await o.json();
    if (q(e)) {
      const s = e.error, n = e.message ?? (q(s) ? s.message : s);
      typeof n == "string" && (r = n);
    }
  } catch {
  }
  throw new Error(`${t} failed (${o.status})${r ? `: ${r}` : ""}.`);
}
async function R(o, t, r) {
  const e = A(o, document.baseURI), s = await S(await fetch(e, { signal: r, credentials: "same-origin", headers: { Accept: "application/json, text/csv;q=0.9" } }), "Data request");
  return V(s.headers.get("Content-Type"), e, t) === "json" ? $(await s.json()) : M(await s.text());
}
async function B(o, t, r, e) {
  const s = A(o, document.baseURI), n = new URL("/.well-known/openvaultdb", s.origin), i = (await (await S(await fetch(n, { signal: e, credentials: "same-origin", headers: { Accept: "application/json" } }), "OVDB discovery")).json()).databases?.find((E) => {
    if (!E.url) return !1;
    try {
      return A(E.url, n.href).href.replace(/\/$/, "") === s.href.replace(/\/$/, "");
    } catch {
      return !1;
    }
  });
  if (!i?.apiUrl) throw new Error("OVDB discovery does not list this database connection URL.");
  const l = A(i.apiUrl, n.href), p = await (await S(await fetch(l, { signal: e, credentials: "same-origin", headers: { Accept: "application/json" } }), "OVDB database metadata")).json(), b = p.capabilities ?? i.capabilities;
  if (!(Array.isArray(b) ? b.includes("dtql") : q(b) && b.dtql === !0) || !p.endpoints?.dtql) throw new Error("This OVDB database does not advertise DTQL queries.");
  const k = A(p.endpoints.dtql, l.href);
  let w, v;
  if (p.queryFormat === "dtql-yaml+json")
    w = JSON.stringify({ query: t, parameters: r }), v = "application/json";
  else if (p.queryFormat === "dtql-yaml") {
    if (Object.keys(r).length) throw new Error("This OVDB endpoint does not support bound DTQL parameters.");
    w = t, v = "application/yaml";
  } else throw new Error(`Unsupported OVDB query format: ${p.queryFormat ?? "missing"}.`);
  const N = await S(await fetch(k, { method: "POST", signal: e, credentials: "same-origin", headers: { "Content-Type": v, Accept: "application/json" }, body: w }), "DTQL query");
  return $(await N.json());
}
const F = `
:host{display:block;box-sizing:border-box;color:var(--datatug-fg,#18304a);font:var(--datatug-font,14px/1.45 system-ui,sans-serif);background:var(--datatug-bg,#fff);border:1px solid var(--datatug-border,#dce5ee);border-radius:var(--datatug-radius,10px);overflow:hidden;min-width:0}
*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer;background:var(--datatug-button-bg,#f5f8fb);border:1px solid var(--datatug-border,#dce5ee);border-radius:5px;padding:.25rem .55rem}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,th button:focus-visible{outline:2px solid var(--datatug-accent,#2879b9);outline-offset:2px}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:.65rem;padding:.7rem .85rem;border-bottom:1px solid var(--datatug-border,#dce5ee);flex-wrap:wrap}.brand{font-weight:700;letter-spacing:.01em}.tools{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}.tools input{max-width:13rem;min-width:7rem;border:1px solid var(--datatug-border,#dce5ee);border-radius:5px;padding:.26rem .45rem}.status{padding:.8rem;color:var(--datatug-muted,#587087)}.error{color:var(--datatug-error,#ab2e39)}.scroller{overflow:auto;max-height:var(--datatug-max-height,32rem)}table{border-collapse:collapse;min-width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:.46rem .7rem;border-bottom:1px solid var(--datatug-border,#dce5ee);vertical-align:top;white-space:nowrap;max-width:32rem;overflow:hidden;text-overflow:ellipsis}th{position:sticky;top:0;background:var(--datatug-header-bg,#f4f8fb);color:var(--datatug-muted,#587087);font-size:.84em;font-weight:650}th button{border:0;background:none;padding:0;font-weight:inherit;color:inherit}tbody tr:hover{background:var(--datatug-hover,#f5f9fc)}tbody tr[aria-selected=true]{background:var(--datatug-selected,#e7f3fc)}.footer{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.55rem .85rem;color:var(--datatug-muted,#587087);font-size:.85em}.pager{display:flex;gap:.35rem;align-items:center}.chart{padding:.8rem}.bar{display:grid;grid-template-columns:minmax(5rem, 30%) 1fr auto;gap:.6rem;align-items:center;margin:.38rem 0}.track{height:.8rem;border-radius:3px;background:var(--datatug-header-bg,#f4f8fb);overflow:hidden}.fill{height:100%;background:var(--datatug-accent,#2879b9)}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
function d(o, t) {
  const r = document.createElement(o);
  return t !== void 0 && (r.textContent = t), r;
}
function C(o) {
  return o == null ? "—" : typeof o == "object" ? JSON.stringify(o) : String(o);
}
function Q(o, t) {
  if (t === "string" || !t) return o;
  if (t === "number") {
    if (!o.trim() || !Number.isFinite(Number(o))) throw new Error("Invalid number parameter.");
    return Number(o);
  }
  if (t === "boolean") {
    if (o !== "true" && o !== "false") throw new Error("Boolean parameter must be true or false.");
    return o === "true";
  }
  if (t === "null") return null;
  throw new Error(`Unsupported DTQL parameter type: ${t}.`);
}
class z extends HTMLElement {
  connectedCallback() {
    this.style.display = "none", this.observer = new MutationObserver(() => this.notify()), this.observer.observe(this, { childList: !0, characterData: !0, subtree: !0 });
  }
  disconnectedCallback() {
    this.observer?.disconnect();
  }
  notify() {
    this.dispatchEvent(new Event("dtql-change", { bubbles: !0 }));
  }
}
class J extends HTMLElement {
  constructor() {
    super(...arguments), this.propertySet = !1;
  }
  static get observedAttributes() {
    return ["name", "value", "type"];
  }
  get value() {
    return this.propertySet ? this.propertyValue : Q(this.getAttribute("value") ?? "", this.getAttribute("type"));
  }
  set value(t) {
    if (t !== null && !["string", "number", "boolean"].includes(typeof t)) throw new TypeError("DTQL parameter value must be a JSON scalar.");
    this.propertySet = !0, this.propertyValue = t, this.notify();
  }
  attributeChangedCallback(t) {
    (t === "value" || t === "type") && (this.propertySet = !1), this.notify();
  }
  connectedCallback() {
    this.style.display = "none", this.notify();
  }
  notify() {
    this.dispatchEvent(new Event("dtql-change", { bubbles: !0 }));
  }
}
class U extends HTMLElement {
  constructor() {
    super(), this.root = this.attachShadow({ mode: "open" }), this.state = "loading", this.message = "", this.scheduled = !1, this.revision = 0, this.onChildChange = () => this.schedule(), this.root.append(d("style", F));
  }
  static get observedAttributes() {
    return ["connection", "data-url", "format", "type", "page-size"];
  }
  connectedCallback() {
    this.addEventListener("dtql-change", this.onChildChange), this.observer = new MutationObserver(() => this.schedule()), this.observer.observe(this, { childList: !0, subtree: !1 }), this.schedule();
  }
  disconnectedCallback() {
    this.removeEventListener("dtql-change", this.onChildChange), this.observer?.disconnect(), this.controller?.abort(), this.revision++;
  }
  attributeChangedCallback() {
    this.schedule();
  }
  schedule() {
    !this.isConnected || this.scheduled || (this.scheduled = !0, queueMicrotask(() => {
      this.scheduled = !1, this.isConnected && this.refresh();
    }));
  }
  async refresh() {
    this.controller?.abort();
    const t = new AbortController();
    this.controller = t;
    const r = ++this.revision;
    this.state = "loading", this.message = "Loading data…", this.render();
    try {
      const e = this.getAttribute("connection"), s = this.getAttribute("data-url"), n = [...this.children].filter((f) => f.localName === "dtql-query"), a = n[0], c = [...this.children].filter((f) => f.localName === "dtql-param");
      if (!!e == !!s) throw new Error("Set exactly one of connection or data-url.");
      if (s && (n.length || c.length)) throw new Error("data-url cannot be combined with DTQL query or parameters.");
      if (e && (n.length !== 1 || !a?.textContent?.trim())) throw new Error("A connection requires one nonempty <dtql-query>.");
      const i = /* @__PURE__ */ Object.create(null);
      for (const f of c) {
        const p = f.getAttribute("name");
        if (!p || Object.hasOwn(i, p)) throw new Error("Every <dtql-param> needs a unique nonempty name.");
        i[p] = f.value;
      }
      if (!s && (!e || !a?.textContent)) throw new Error("A connection requires one nonempty <dtql-query>.");
      const l = s ? await R(s, this.getAttribute("format"), t.signal) : await B(e, a?.textContent?.trim() ?? "", i, t.signal);
      if (t.signal.aborted || r !== this.revision) return;
      this.validateData(l), this.data = l, this.state = l.rows.length ? "ready" : "empty", this.message = l.rows.length ? "" : "No rows found.", this.render(), this.dispatchEvent(new CustomEvent("datatug-data-loaded", { detail: { rows: l.rows.length, columns: l.columns, metadata: l.metadata }, bubbles: !0 }));
    } catch (e) {
      if (t.signal.aborted || r !== this.revision) return;
      this.data = void 0, this.state = "error", this.message = e instanceof Error ? e.message : "Could not load data.", this.render(), this.dispatchEvent(new CustomEvent("datatug-error", { detail: { message: this.message }, bubbles: !0 }));
    }
  }
  reload() {
    return this.refresh();
  }
  validateData(t) {
    if (!Array.isArray(t.rows)) throw new Error("The source did not return rows.");
  }
  shell(t) {
    [...this.root.children].filter((n) => n.localName !== "style").forEach((n) => n.remove());
    const r = d("div"), e = d("div");
    e.className = "toolbar";
    const s = d("span", t);
    return s.className = "brand", e.append(s), r.append(e), this.root.append(r), r;
  }
  statusNode(t) {
    if (this.state === "ready") return !1;
    const r = d("div", this.message);
    return r.className = `status ${this.state === "error" ? "error" : ""}`, r.setAttribute("role", this.state === "error" ? "alert" : "status"), t.append(r), !0;
  }
}
class H extends U {
  constructor() {
    super(...arguments), this.search = "", this.sortDesc = !1, this.page = 0;
  }
  render() {
    const t = this.shell("DataTug"), r = t.firstElementChild, e = d("div");
    e.className = "tools";
    const s = d("input");
    s.type = "search", s.placeholder = "Search rows", s.setAttribute("aria-label", "Search rows"), s.value = this.search;
    const n = () => {
      const u = s.selectionStart, h = s.selectionEnd;
      this.search = s.value, this.page = 0, this.render();
      const m = this.root.querySelector("input");
      m?.focus(), u !== null && h !== null && m?.setSelectionRange(u, h);
    };
    s.addEventListener("input", (u) => {
      u.isComposing || n();
    }), s.addEventListener("compositionend", n);
    const a = d("button", "Refresh");
    if (a.type = "button", a.addEventListener("click", () => {
      this.refresh();
    }), e.append(s, a), r.append(e), this.statusNode(t)) return;
    const c = this.data;
    if (!c) return;
    const i = this.search.toLocaleLowerCase(), l = c.rows.map((u, h) => ({ row: u, index: h })).filter(({ row: u }) => !i || c.columns.some((h) => C(u[h]).toLocaleLowerCase().includes(i)));
    if (this.sortColumn) {
      const u = this.sortColumn;
      l.sort((h, m) => {
        const x = h.row[u], g = m.row[u], O = typeof x == "number" && typeof g == "number" ? x - g : C(x).localeCompare(C(g), void 0, { numeric: !0 });
        return (this.sortDesc ? -O : O) || h.index - m.index;
      });
    }
    const f = Number(this.getAttribute("page-size")), p = Number.isInteger(f) && f > 0 ? Math.min(f, 500) : 50, b = Math.max(1, Math.ceil(l.length / p));
    this.page = Math.min(this.page, b - 1);
    const y = l.slice(this.page * p, (this.page + 1) * p), k = d("div");
    k.className = "scroller";
    const w = d("table"), v = d("thead"), N = d("tr");
    for (const u of c.columns) {
      const h = d("th");
      h.scope = "col";
      const m = d("button", `${u}${this.sortColumn === u ? this.sortDesc ? " ↓" : " ↑" : ""}`);
      m.type = "button", m.addEventListener("click", () => {
        this.sortDesc = this.sortColumn === u && !this.sortDesc, this.sortColumn = u, this.page = 0, this.render();
      }), h.append(m), N.append(h);
    }
    v.append(N), w.append(v);
    const E = d("tbody");
    for (const { row: u, index: h } of y) {
      const m = d("tr");
      m.tabIndex = 0, m.setAttribute("aria-selected", String(this.selected === h));
      const x = () => {
        this.selected = h, E.querySelectorAll("tr").forEach((g) => g.setAttribute("aria-selected", String(g === m))), this.dispatchEvent(new CustomEvent("datatug-select", { detail: { row: u, index: h, key: c.keys?.[h] }, bubbles: !0 }));
      };
      m.addEventListener("click", x), m.addEventListener("keydown", (g) => {
        (g.key === "Enter" || g.key === " ") && (g.preventDefault(), x());
      });
      for (const g of c.columns) m.append(d("td", C(u[g])));
      E.append(m);
    }
    w.append(E), k.append(w), t.append(k);
    const L = d("div");
    L.className = "footer", L.append(d("span", `${l.length} of ${c.rows.length} rows`));
    const D = d("div");
    D.className = "pager";
    const j = d("button", "Previous");
    j.disabled = this.page === 0, j.addEventListener("click", () => {
      this.page--, this.render();
    });
    const T = d("button", "Next");
    T.disabled = this.page >= b - 1, T.addEventListener("click", () => {
      this.page++, this.render();
    }), D.append(j, d("span", `${this.page + 1} / ${b}`), T), L.append(D), t.append(L);
  }
}
class I extends U {
  validateData(t) {
    const r = this.getAttribute("type") ?? "auto";
    if (r !== "auto" && r !== "bar") throw new Error(`Unsupported chart type: ${r}.`);
    if (!t.rows.length) return;
    const e = t.columns.find((n) => t.rows.some((a) => typeof a[n] == "number")), s = t.columns.find((n) => n !== e);
    if (!e || !s) throw new Error("Chart needs one numeric and one label column.");
  }
  render() {
    const t = this.shell("DataTug chart");
    if (this.statusNode(t)) return;
    const r = this.data;
    if (!r) return;
    const e = r.columns.find((i) => r.rows.some((l) => typeof l[i] == "number")), s = r.columns.find((i) => i !== e);
    if (!e || !s) return;
    const n = r.rows.slice(0, 20), a = Math.max(0, ...n.map((i) => Number(i[e]) || 0)), c = d("div");
    c.className = "chart", c.setAttribute("role", "img"), c.setAttribute("aria-label", `Bar chart of ${e} by ${s}`);
    for (const i of n) {
      const l = Number(i[e]) || 0, f = d("div");
      f.className = "bar";
      const p = d("span", C(i[s]));
      p.className = "label";
      const b = d("div");
      b.className = "track";
      const y = d("div");
      y.className = "fill", y.style.width = `${Math.max(0, a ? l / a * 100 : 0)}%`, b.append(y), f.append(p, b, d("span", C(l))), c.append(f);
    }
    t.append(c);
  }
}
customElements.get("dtql-query") || customElements.define("dtql-query", z);
customElements.get("dtql-param") || customElements.define("dtql-param", J);
customElements.get("datatug-grid") || customElements.define("datatug-grid", H);
customElements.get("datatug-chart") || customElements.define("datatug-chart", I);
export {
  I as DataTugChart,
  H as DataTugGrid,
  J as DtqlParam,
  z as DtqlQuery
};
//# sourceMappingURL=datatug.js.map
