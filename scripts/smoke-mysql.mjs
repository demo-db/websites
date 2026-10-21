import { createHash } from 'node:crypto';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Pure contract check; callers own network requests and their budget.
export function checkedMysqlScript(database, pinned, bytes, config, page) {
  const declarations = database.formatAvailability.filter((entry) => entry.format === 'mysql');
  if (declarations.length !== 1) throw new Error(`${database.localId}: expected one MySQL availability declaration`);
  const declared = declarations[0];
  const exports = database.exports.filter((file) => file.format === 'mysql');
  if (declared.state !== 'download') {
    if (!['planned', 'unavailable'].includes(declared.state)) throw new Error(`${database.localId}: invalid MySQL availability`);
    if (exports.length || pinned || bytes) throw new Error(`${database.localId}: unavailable MySQL has an export, lock or received script`);
    const word = declared.state === 'planned' ? 'Planned' : 'Not available';
    const cards = [...page.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
    const labels = (html) => [...html.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/g)].map((match) => match[1].replace(/<[^>]*>/g, '').trim());
    const matching = cards.filter((card) => labels(card).includes(declared.label));
    const item = matching[0] ?? '';
    const statuses = [...item.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)];
    if (labels(page).filter((label) => label === declared.label).length !== 1 || matching.length !== 1 ||
        statuses.length !== 1 || !/<\/strong>\s*<span\b/.test(item) ||
        !statuses[0][1].trimStart().startsWith(`${word}:`) || /<a\b|\bdownload\s*=/i.test(item)) {
      throw new Error(`${database.localId}: MySQL page declaration differs from corpus`);
    }
    return 0;
  }
  if (exports.length !== 1) throw new Error(`${database.localId}: expected one advertised MySQL export`);
  const dialectConfig = config;
  const spec = config.dialects.mysql;
  if (!bytes || !pinned) throw new Error(`${database.localId}: no MySQL script in the corpus or in the lock`);
  if (bytes.length !== pinned.bytes || sha256(bytes) !== pinned.sha256) throw new Error(`${database.localId}: the served MySQL script is not the one the lock pins`);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error(`${database.localId}: MySQL script still gzip after decoding`);
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  if (lines[0] !== `-- ${dialectConfig.edition}`) throw new Error(`${database.localId}: the first line is not the contract-edition label`);
  if (!lines.slice(0, 40).includes(`-- Licence: ${database.licences.data}`)) throw new Error(`${database.localId}: the header lacks the licence ${database.licences.data}`);
  if (!lines.some((line) => line.startsWith(`CREATE TABLE \`${spec.marker}\``))) throw new Error(`${database.localId}: no marker table`);
  if (!lines.some((line) => line.startsWith(`INSERT INTO \`${spec.marker}\` VALUES ('${database.localId}', `))) throw new Error(`${database.localId}: the marker row is missing`);
  if (text.includes('\r')) throw new Error(`${database.localId}: holds a CR`);
  if (lines.filter((line) => line.length > 0).at(-1) !== '-- end of script') throw new Error(`${database.localId}: does not end with the completion comment`);
  return 1;
}
