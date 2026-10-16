// URL inventories of the site before and after the Worker-less cutover, from build output only.
//
// "old" replays the routing of the retired src/worker.ts (commit 792ce70) over dist/: a dataset host served
// dist/_db/<id>/<path> at /<path>, a few shared assets, /schema.json and every export at its public path; the
// catalogue served dist/ minus _db, /data and /model. "new" lists the files of each dist-hosts/<host>/ bundle.
// Directory pages are written as their trailing-slash URL. Both inventories cover GET 200 responses only.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

const asUrl = (relative) => `/${relative}`.replace(/(^|\/)index\.html$/, '$1');

export async function oldInventory(root) {
  const dist = join(root, 'dist');
  const index = JSON.parse(await readFile(join(root, 'src/data/generated/index.json'), 'utf8'));
  const result = new Map();
  const catalogue = new Set();
  for (const file of await walk(dist)) {
    if (file.startsWith('_db/') || file === '404.html') continue;
    if (file.startsWith('data/') || file.startsWith('model/')) continue;
    catalogue.add(asUrl(file));
  }
  for (const extra of ['/.well-known/openvaultdb', '/robots.txt', '/sitemap.xml']) catalogue.add(extra);
  result.set('demodb.dev', catalogue);
  for (const db of index.databases) {
    const urls = new Set();
    const base = join(dist, '_db', db.id);
    for (const file of await walk(base)) urls.add(asUrl(file));
    for (const shared of ['/embed/datatug.js', '/embed/exact-decimal.js', '/theme.js', '/favicon.svg', '/build-info.json']) urls.add(shared);
    for (const file of await walk(join(dist, '_astro'))) urls.add(`/_astro/${file}`);
    for (const item of db.exports) urls.add(`/data/${item.publicPath}`);
    for (const item of db.comparisonFixtures ?? []) urls.add(`/data/${item.publicPath}`);
    for (const extra of ['/schema.json', '/.well-known/openvaultdb', '/robots.txt', '/sitemap.xml']) urls.add(extra);
    result.set(db.siteHost, urls);
  }
  return result;
}

export async function newInventory(root) {
  const output = join(root, 'dist-hosts');
  const result = new Map();
  for (const host of await readdir(output)) {
    if (!(await stat(join(output, host))).isDirectory()) continue;
    const redirects = (await readFile(join(output, host, '_redirects'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    // A path that a redirect rule matches is never served as a file.
    const shadowed = (url) => redirects.some((line) => {
      const [from] = line.split(' ');
      return from === url || (from.endsWith('/*') && url.startsWith(from.slice(0, -1)));
    });
    const urls = new Set();
    for (const file of await walk(join(output, host))) {
      if (file === '_headers' || file === '_redirects' || file === '404.html') continue;
      const url = asUrl(file);
      if (!shadowed(url)) urls.add(url);
    }
    result.set(host, urls);
  }
  return result;
}

export async function inventoryDiff(root) {
  const before = await oldInventory(root);
  const after = await newInventory(root);
  const diff = {};
  for (const host of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(host) ?? new Set();
    const b = after.get(host) ?? new Set();
    const removed = [...a].filter((url) => !b.has(url)).sort();
    const added = [...b].filter((url) => !a.has(url)).sort();
    if (removed.length || added.length) diff[host] = { removed, added };
  }
  return diff;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  console.log(JSON.stringify(await inventoryDiff(root), null, 2));
}
