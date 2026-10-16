// The per-dataset x per-format coverage matrix.
//
// config/format-matrix.json declares, for every registered dataset and every format, either that a complete
// download is served (and where it comes from) or that it is not available and why. The build refuses to
// finish when the declaration and the exports actually produced disagree, and the result is published in the
// dataset metadata (generated index and corpus.json) so every page can say "Not available: <reason>" instead
// of silently omitting a format. docs/format-matrix.md is rendered from the same declaration.
export const MATRIX_FORMAT = 'demodb-format-matrix/v1';
export const STATES = ['download', 'unavailable'];
export const ORIGINS = ['provider', 'provider-artifact', 'derived', 'archive'];

// Complete-database export formats that are not part of the matrix: the SQLite-dialect dump every
// provider ships as `sql`, and per-dataset metadata.
export const EXTRA_FORMATS = ['sql', 'metadata'];


export function validateMatrix(matrix, datasetIds) {
  const problems = [];
  if (matrix?.format !== MATRIX_FORMAT) problems.push(`format must be ${MATRIX_FORMAT}`);
  const formats = matrix?.formats;
  if (!Array.isArray(formats) || formats.length === 0 || new Set(formats).size !== formats.length) problems.push('formats must be a non-empty list without duplicates');
  for (const format of formats ?? []) if (typeof matrix?.labels?.[format] !== 'string' || !matrix.labels[format]) problems.push(`format ${format} has no label`);
  const declared = Object.keys(matrix?.datasets ?? {});
  for (const id of datasetIds) if (!declared.includes(id)) problems.push(`dataset ${id} is registered but not declared`);
  for (const id of declared) if (!datasetIds.includes(id)) problems.push(`dataset ${id} is declared but not registered`);
  if (!/^[0-9a-f]{7,40}$/.test(matrix?.baseline?.commit ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(matrix?.baseline?.verifiedLive ?? '')) problems.push('baseline needs the commit and the date the initial state was verified live');
  for (const id of datasetIds) {
    for (const format of formats ?? []) if (typeof matrix?.baseline?.datasets?.[id]?.[format] !== 'string') problems.push(`baseline ${id}/${format}: missing`);
    const row = matrix?.datasets?.[id] ?? {};
    for (const format of formats ?? []) {
      const cell = row[format];
      const where = `${id}/${format}`;
      if (!cell || typeof cell !== 'object') { problems.push(`${where}: missing`); continue; }
      if (!STATES.includes(cell.state)) { problems.push(`${where}: state must be one of ${STATES.join(', ')}`); continue; }
      if (cell.state === 'download') {
        if (!ORIGINS.includes(cell.origin)) problems.push(`${where}: origin must be one of ${ORIGINS.join(', ')}`);
        if (cell.reason) problems.push(`${where}: a served format carries no reason`);
      } else {
        if (typeof cell.reason !== 'string' || cell.reason.trim().length < 30) problems.push(`${where}: an unavailable format needs a specific reason (30+ characters)`);
        if (cell.origin) problems.push(`${where}: an unavailable format has no origin`);
        if (cell.followUp != null && typeof cell.followUp !== 'string') problems.push(`${where}: followUp must be a string`);
      }
    }
    for (const format of Object.keys(row)) if (!(formats ?? []).includes(format)) problems.push(`${id}/${format}: not a declared format`);
  }
  if (problems.length) throw new Error(`config/format-matrix.json is invalid:\n  ${problems.join('\n  ')}`);
  return matrix;
}

const completeExports = (exports) => exports.filter((item) => !item.table && !EXTRA_FORMATS.includes(item.format));

// Compares the declaration for one dataset with the exports the build really produced, and returns the
// metadata the pages and corpus.json publish. Throws on any difference: a declared download that was not
// produced, a produced download that is not declared, or an unavailable format that is in fact served.
export function formatAvailability(matrix, id, exports) {
  const row = matrix.datasets[id];
  const complete = completeExports(exports);
  const problems = [];
  for (const item of complete) {
    if (!matrix.formats.includes(item.format)) problems.push(`serves a ${item.format} download that the matrix does not know`);
  }
  const availability = matrix.formats.map((format) => {
    const cell = row[format];
    const served = complete.filter((item) => item.format === format);
    if (served.length > 1) problems.push(`${format}: ${served.length} complete downloads`);
    if (cell.state === 'download' && served.length !== 1) problems.push(`${format}: declared as a download but ${served.length ? 'duplicated' : 'not produced'}`);
    if (cell.state === 'unavailable' && served.length) problems.push(`${format}: declared unavailable but ${served[0].publicPath} is served`);
    if (cell.state === 'download' && served.length === 1) {
      const derived = served[0].derived === true;
      const wantsDerived = cell.origin === 'derived' || cell.origin === 'archive' || cell.origin === 'provider-artifact';
      if (derived !== wantsDerived) problems.push(`${format}: declared origin ${cell.origin} but the export is ${derived ? 'derived' : 'a provider contract export'}`);
    }
    return cell.state === 'download'
      ? { format, label: matrix.labels[format], state: 'download', origin: cell.origin, publicPath: served[0]?.publicPath ?? null }
      : { format, label: matrix.labels[format], state: 'unavailable', reason: cell.reason, ...(cell.followUp ? { followUp: cell.followUp } : {}) };
  });
  if (problems.length) throw new Error(`${id}: the format matrix and the built exports disagree:\n  ${problems.join('\n  ')}`);
  return availability;
}
