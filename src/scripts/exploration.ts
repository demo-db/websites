const controls = (form: HTMLFormElement) => [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')];
function restore(form: HTMLFormElement) {
  const params = new URLSearchParams(location.search);
  for (const control of controls(form)) {
    const value = params.get(control.name);
    if (value !== null && (!(control instanceof HTMLSelectElement) || [...control.options].some((option) => option.value === value))) control.value = value;
    else control.value = control instanceof HTMLInputElement ? control.defaultValue : [...control.options].find((option) => option.defaultSelected)?.value ?? control.options[0]?.value ?? '';
  }
}
function persist(form: HTMLFormElement) {
  const url = new URL(location.href);
  for (const control of controls(form)) control.value ? url.searchParams.set(control.name, control.value) : url.searchParams.delete(control.name);
  history.replaceState(null, '', url);
}
for (const root of document.querySelectorAll<HTMLElement>('[data-recordset-browser]')) {
  const form = root.querySelector<HTMLFormElement>('form')!;
  const results = root.querySelector<HTMLElement>('[data-recordset-results]')!;
  const cards = [...results.querySelectorAll<HTMLElement>('[data-recordset]')];
  const update = () => {
    const data = new FormData(form), q = String(data.get('q') ?? '').trim().toLocaleLowerCase(), kind = String(data.get('kind') ?? ''), group = String(data.get('group') ?? '');
    let count = 0;
    for (const card of cards) { card.hidden = !!((q && !q.split(/\s+/).every((term) => card.dataset.search?.includes(term))) || (kind && card.dataset.kind !== kind) || (group && card.dataset.group !== group)); if (!card.hidden) count++; }
    const sort = data.get('sort');
    cards.sort((a, b) => sort === 'rows' || sort === 'links' ? Number(b.dataset[sort]) - Number(a.dataset[sort]) || String(a.dataset.name).localeCompare(String(b.dataset.name)) : String(a.dataset.name).localeCompare(String(b.dataset.name))).forEach((card) => results.append(card));
    results.classList.toggle('compact-recordsets', data.get('layout') === 'list');
    root.querySelector<HTMLElement>('[data-result-count]')!.textContent = `${count} of ${cards.length} recordsets`;
    root.querySelector<HTMLElement>('[data-empty]')!.hidden = count > 0;
  };
  restore(form); update();
  for (const event of ['input', 'change']) form.addEventListener(event, () => { update(); persist(form); });
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('reset', () => queueMicrotask(() => { update(); persist(form); }));
  window.addEventListener('popstate', () => { restore(form); update(); });
}

type CatalogueFact = { id: string; formats: string[]; engines: string[]; licence: string; size: string; purposes: string[] };
type SearchEntry = { dataset: string; label: string; database: string; href: string; text: string };
for (const root of document.querySelectorAll<HTMLElement>('[data-catalogue-explorer]')) {
  const facts = JSON.parse(root.dataset.facts ?? '[]') as CatalogueFact[];
  const entries = JSON.parse(root.dataset.searchIndex ?? '[]') as SearchEntry[];
  const form = root.querySelector<HTMLFormElement>('form')!;
  const cards = [...root.querySelectorAll<HTMLElement>('[data-dataset]')];
  const hits = root.querySelector<HTMLUListElement>('[data-search-hits]')!;
  const update = () => {
    const data = new FormData(form), q = String(data.get('q') ?? '').trim().toLocaleLowerCase();
    const matches = (text: string) => q.split(/\s+/).every((term) => text.includes(term));
    const admitted = new Set(facts.filter((fact) => (!data.get('engine') || fact.engines.includes(String(data.get('engine')))) && (!data.get('format') || fact.formats.includes(String(data.get('format')))) && (!data.get('licence') || fact.licence === data.get('licence')) && (!data.get('size') || fact.size === data.get('size')) && (!data.get('purpose') || fact.purposes.includes(String(data.get('purpose'))))).map((fact) => fact.id));
    const matching = entries.filter((entry) => admitted.has(entry.dataset) && matches(entry.text));
    let count = 0;
    for (const card of cards) { card.hidden = !admitted.has(card.dataset.dataset!) || !!(q && !matches(card.dataset.datasetSearch ?? '') && !matching.some((entry) => entry.dataset === card.dataset.dataset)); if (!card.hidden) count++; }
    hits.replaceChildren(); hits.hidden = !q || !matching.length;
    for (const entry of matching.slice(0, 24)) { const li = document.createElement('li'), a = document.createElement('a'); a.href = entry.href; a.textContent = `${entry.label} · ${entry.database}`; li.append(a); hits.append(li); }
    root.querySelector<HTMLElement>('[data-result-count]')!.textContent = `${count} datasets${q ? ` · ${matching.length} matching tables${matching.length > 24 ? ' (first 24 shown)' : ''}` : ''}`;
    root.querySelector<HTMLElement>('[data-empty]')!.hidden = count > 0;
  };
  restore(form); update();
  for (const event of ['input', 'change']) form.addEventListener(event, () => { update(); persist(form); });
  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('reset', () => queueMicrotask(() => { update(); persist(form); }));
  window.addEventListener('popstate', () => { restore(form); update(); });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-target], [data-copy-text]')) button.addEventListener('click', async () => {
  const text = button.dataset.copyText ?? document.getElementById(button.dataset.copyTarget ?? '')?.textContent;
  if (text === undefined || text === null) return;
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
  catch { button.textContent = 'Select the text to copy'; }
});

for (const root of document.querySelectorAll<HTMLElement>('[data-table-explorer]')) {
  const grid = root.querySelector<HTMLElement>('datatug-grid');
  const fallback = root.querySelector<HTMLElement>('[data-static-preview]');
  if (!grid || !fallback) {
    if (!grid && new URLSearchParams(location.search).has('rows')) {
      const notice = document.createElement('p'); notice.className = 'muted'; notice.setAttribute('role','status');
      notice.textContent = 'This native collection has a static sample here. The records below are unfiltered. The link retains row filters for supported DataTug collection handoffs.';
      root.prepend(notice);
    }
    continue;
  }
  const showFallback = () => { fallback.hidden = ['ready', 'empty'].includes(grid.getAttribute('data-load-state') ?? ''); };
  grid.addEventListener('datatug-data-loaded', showFallback);
  grid.addEventListener('datatug-error', () => { fallback.hidden = false; });
  customElements.whenDefined('datatug-grid').then(showFallback);
  new MutationObserver(showFallback).observe(grid, { attributes: true, attributeFilter: ['data-load-state'] });
  grid.addEventListener('datatug-selection-cleared', () => { root.querySelector<HTMLElement>('[data-selected-record]')!.hidden = true; });
  grid.addEventListener('datatug-select', (event) => {
    const row = (event as CustomEvent<{ row: Record<string, unknown> }>).detail.row;
    const detail = root.querySelector<HTMLElement>('[data-selected-record]')!;
    const fields = detail.querySelector<HTMLDListElement>('[data-record-fields]')!;
    fields.replaceChildren(); detail.hidden = false;
    for (const [name, value] of Object.entries(row)) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      fields.append(dt, dd);
    }
    const link = detail.querySelector<HTMLAnchorElement>('[data-record-datatug]')!;
    const target = root.querySelector<HTMLAnchorElement>('[data-handoff="datatug"]');
    const keys = JSON.parse(root.dataset.recordKeys ?? '[]') as string[];
    const valid = keys.length > 0 && keys.length <= 16 && keys.every((key) => key.length <= 256 && (typeof row[key] === 'string' && String(row[key]).length <= 1024 || typeof row[key] === 'boolean' || typeof row[key] === 'number' && Number.isSafeInteger(row[key]))) && JSON.stringify(Object.fromEntries(keys.map((key) => [key, row[key]]))).length <= 2048;
    link.hidden = !target || !valid;
    if (target && valid) { const href = new URL(target.href); href.searchParams.set('recordKey', JSON.stringify(Object.fromEntries(keys.map((key) => [key, row[key]])))); href.searchParams.set('returnTo', location.href); link.href = href.href; }
  });
}

document.addEventListener('click', (event) => {
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-handoff]');
  if (!anchor) return;
  const href = new URL(anchor.href);
  if (['datatug.app', 'codegrapher.dev', 'querydock.run'].includes(href.hostname)) {
    href.searchParams.set('returnTo', location.href);
    const state = new URLSearchParams(location.search).get('rows');
    if (state && state.length <= 4096) {
      href.searchParams.set('sourceFilter', state);
      if (href.pathname === '/demo/logs') try {
        const filter = JSON.parse(state).filter;
        if (Number.isSafeInteger(filter?.order_id)) href.searchParams.set('order', String(filter.order_id));
        if (typeof filter?.attempt_id === 'string' && filter.attempt_id.length <= 128) href.searchParams.set('attempt', filter.attempt_id);
      } catch { /* The destination reports unsupported source state. */ }
    }
    anchor.href = href.href;
  }
  // Public object identity only. Hosts may subscribe through their existing consent-aware analytics adapter.
  window.dispatchEvent(new CustomEvent('demodb-handoff', { detail: { product: anchor.dataset.handoff, dataset: anchor.dataset.dataset, object: anchor.dataset.object, stage: 'requested' } }));
});
