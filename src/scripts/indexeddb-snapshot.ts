type NativeColumn = { name: string; primaryKey?: boolean; primaryKeyPosition?: number | null };
type NativeForeignKey = { column: string; table: string; referencedColumn: string; constraint?: number; position?: number };
export type NativeTable = {
  name: string;
  kind: 'table' | 'view';
  rowCount: number | null;
  columns: NativeColumn[];
  foreignKeys: NativeForeignKey[];
};
export type TableExport = {
  table: string;
  url: string;
  bytes: number | null;
  sha256: string | null;
  compression?: 'gzip' | null;
  decodedBytes?: number | null;
  decodedSha256?: string | null;
};
export type ImportConfiguration = {
  id: string;
  sourceCommit: string | null;
  tables: NativeTable[];
  exports: TableExport[];
};
export type ImportProgress = { table: string; tableIndex: number; tableTotal: number; rows: number; rowTotal: number | null; bytes: number; byteTotal: number | null };

const DB_PREFIX = 'demodb-snapshot-';
export const stagingImportKey = (id: string) => `demodb-import-staging:${id}`;
const activeKey = (id: string) => `demodb-import-active:${id}`;
const BATCH_ROWS = 150;

export async function estimateImportBytes(configuration: ImportConfiguration): Promise<{ required: number; available: number | null }> {
  const required = configuration.exports.reduce((sum, file) => sum + (file.decodedBytes ?? file.bytes ?? 0), 0);
  const storage = await navigator.storage?.estimate?.();
  const available = storage?.quota == null ? null : Math.max(0, storage.quota - (storage.usage ?? 0));
  return { required: Math.ceil(required * 1.25), available };
}

export async function importSnapshot(configuration: ImportConfiguration, onProgress: (progress: ImportProgress) => void, signal: AbortSignal): Promise<void> {
  const exportsByTable = new Map(configuration.exports.map((file) => [file.table, file]));
  const physicalTables = configuration.tables.filter((table) => table.kind === 'table');
  if (!physicalTables.length || physicalTables.some((table) => !exportsByTable.has(table.name))) throw new Error('Every physical table needs a declared JSON export before browser import is available.');

  const fingerprint = await stableFingerprint(configuration);
  let staging = sessionStorage.getItem(stagingImportKey(configuration.id));
  if (!staging) {
    staging = crypto.randomUUID();
    sessionStorage.setItem(stagingImportKey(configuration.id), staging);
  }
  const dbName = `${DB_PREFIX}${configuration.id}-${staging}`;
  const db = await openSnapshot(dbName, physicalTables);
  try {
    const state = await readState(db);
    if (state?.fingerprint && state.fingerprint !== fingerprint) throw new Error('A partial import belongs to a different provider revision. Reset it before importing this version.');
    await writeState(db, { name: 'state', fingerprint, sourceCommit: configuration.sourceCommit });

    for (let tableIndex = 0; tableIndex < physicalTables.length; tableIndex++) {
      if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
      const table = physicalTables[tableIndex];
      const file = exportsByTable.get(table.name)!;
      const expectedBytes = file.decodedBytes ?? file.bytes;
      const expectedHash = file.decodedSha256 ?? file.sha256;
      if (!expectedHash) throw new Error(`${table.name}: provider did not publish a decoded checksum; this export cannot be imported safely.`);
      const checkpoint = await readState(db, `table:${table.name}`);
      if (isVerifiedTableCheckpoint(checkpoint, expectedHash, table.rowCount)) {
        onProgress({ table: table.name, tableIndex, tableTotal: physicalTables.length, rows: checkpoint.count, rowTotal: table.rowCount, bytes: expectedBytes ?? 0, byteTotal: expectedBytes ?? null });
        continue;
      }
      const response = await fetch(file.url, { signal, headers: { Accept: 'application/json' } });
      if (!response.ok || !response.body) throw new Error(`${table.name}: export request failed (${response.status}).`);
      let rowCount = 0;
      let bytesRead = 0;
      const hash = new IncrementalSha256();
      const storeName = storeNameFor(physicalTables, table.name);
      if (checkpoint) await clearTableCheckpoint(db, storeName, table.name);
      let pending: { row: Record<string, unknown>; ordinal: number }[] = [];
      const flush = async () => {
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction([storeName, '__state'], 'readwrite');
          const store = transaction.objectStore(storeName);
          for (const item of batch) {
            if (store.keyPath == null) store.put(item.row, item.ordinal);
            else store.put(item.row);
          }
          transaction.objectStore('__state').put({ name: `table:${table.name}`, count: batch[batch.length - 1].ordinal + 1 });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed.'));
          transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write was aborted.'));
        });
      };
      await parseJsonArray(response.body, async (row) => {
        if (expectedBytes != null && bytesRead > expectedBytes) throw new Error(`${table.name}: decoded export exceeds its declared size.`);
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${table.name}: JSON export contains a non-record value.`);
        pending.push({ row: row as Record<string, unknown>, ordinal: rowCount });
        if (pending.length >= BATCH_ROWS) await flush();
        rowCount++;
        onProgress({ table: table.name, tableIndex, tableTotal: physicalTables.length, rows: rowCount, rowTotal: table.rowCount, bytes: bytesRead, byteTotal: expectedBytes ?? null });
        if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
      }, (bytes) => hash.update(bytes), (bytes) => { bytesRead += bytes; });
      await flush();
      if (expectedBytes != null && bytesRead !== expectedBytes) throw new Error(`${table.name}: decoded export size mismatch (${bytesRead} of ${expectedBytes} bytes).`);
      const actualHash = hash.hexDigest();
      if (expectedHash && actualHash !== expectedHash) throw new Error(`${table.name}: decoded export checksum mismatch.`);
      if (table.rowCount != null && rowCount !== table.rowCount) throw new Error(`${table.name}: row count mismatch (${rowCount} of ${table.rowCount}).`);
      await writeState(db, { name: `table:${table.name}`, count: rowCount, sha256: actualHash, complete: true });
    }

    await writeState(db, { name: 'complete', fingerprint, sourceCommit: configuration.sourceCommit, completedAt: new Date().toISOString() });
    db.close();
    const previous = localStorage.getItem(activeKey(configuration.id));
    localStorage.setItem(activeKey(configuration.id), dbName);
    sessionStorage.removeItem(stagingImportKey(configuration.id));
    if (previous && previous !== dbName) void deleteDatabase(previous);
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function cancelStagingImport(configuration: ImportConfiguration): Promise<void> {
  const staging = sessionStorage.getItem(stagingImportKey(configuration.id));
  if (!staging) return;
  sessionStorage.removeItem(stagingImportKey(configuration.id));
  await deleteDatabase(`${DB_PREFIX}${configuration.id}-${staging}`);
}

export async function clearActiveSnapshot(configuration: ImportConfiguration): Promise<void> {
  const active = localStorage.getItem(activeKey(configuration.id));
  localStorage.removeItem(activeKey(configuration.id));
  if (active) await deleteDatabase(active);
}

export async function activeSnapshot(configuration: ImportConfiguration): Promise<IDBDatabase | null> {
  const name = localStorage.getItem(activeKey(configuration.id));
  if (!name) return null;
  const db = await openExistingSnapshot(name);
  if (!db) return null;
  const complete = await readState(db, 'complete');
  const fingerprint = await stableFingerprint(configuration);
  if (!complete || complete.fingerprint !== fingerprint) {
    db.close();
    return null;
  }
  return db;
}

export async function getNativeRecord(db: IDBDatabase, tables: NativeTable[], tableName: string, key: IDBValidKey): Promise<Record<string, unknown> | undefined> {
  const table = tables.find((item) => item.name === tableName && item.kind === 'table');
  if (!table) throw new Error(`Unknown physical table: ${tableName}`);
  const storeName = storeNameFor(tables.filter((item) => item.kind === 'table'), tableName);
  return request<Record<string, unknown> | undefined>(db.transaction(storeName).objectStore(storeName).get(key));
}

export async function followNativeForeignKey(db: IDBDatabase, tables: NativeTable[], fromTable: string, row: Record<string, unknown>, foreignKey: NativeForeignKey): Promise<Record<string, unknown> | undefined> {
  const sourceTable = tables.find((item) => item.name === fromTable);
  const targetTable = tables.find((item) => item.name === foreignKey.table && item.kind === 'table');
  if (!sourceTable || !targetTable) return undefined;
  const group = foreignKeyGroup(sourceTable.foreignKeys).find((items) => items.includes(foreignKey)) ?? [foreignKey];
  const ordered = [...group].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const targetColumns = ordered.map((item) => item.referencedColumn);
  const keyParts = ordered.map((item) => row[item.column]);
  if (keyParts.some((value) => value === undefined || value === null)) return undefined;
  if (sameColumns(targetColumns, primaryKey(targetTable))) {
    return getNativeRecord(db, tables, targetTable.name, keyParts.length === 1 ? keyParts[0] as IDBValidKey : keyParts as IDBValidKey[]);
  }
  const storeName = storeNameFor(tables.filter((item) => item.kind === 'table'), targetTable.name);
  const store = db.transaction(storeName).objectStore(storeName);
  const matches = await request<Record<string, unknown>[]>(store.index(referenceIndexName(targetColumns)).getAll(keyParts.length === 1 ? keyParts[0] as IDBValidKey : keyParts as IDBValidKey[], 2));
  if (matches.length > 1) throw new Error(`The native foreign key target ${targetTable.name} is not unique in the imported data.`);
  return matches[0];
}

export async function findNativeReferences(db: IDBDatabase, tables: NativeTable[], targetTableName: string, targetRow: Record<string, unknown>, sourceTableName: string, constraint: number): Promise<Record<string, unknown>[]> {
  const target = tables.find((item) => item.name === targetTableName);
  const source = tables.find((item) => item.name === sourceTableName && item.kind === 'table');
  if (!target || !source) return [];
  const group = foreignKeyGroup(source.foreignKeys).find((items) => (items[0].constraint ?? 0) === constraint && items[0].table === targetTableName);
  if (!group) return [];
  const ordered = [...group].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const keyParts = ordered.map((item) => targetRow[item.referencedColumn]);
  if (keyParts.some((value) => value === undefined || value === null)) return [];
  const indexName = indexNameFor(sourceTableName, ordered);
  const storeName = storeNameFor(tables.filter((item) => item.kind === 'table'), sourceTableName);
  const store = db.transaction(storeName).objectStore(storeName);
  const index = store.index(indexName);
  const queryKey = keyParts.length === 1 ? keyParts[0] as IDBValidKey : keyParts as IDBValidKey[];
  return request<Record<string, unknown>[]>(index.getAll(queryKey, 100));
}

export function isVerifiedTableCheckpoint(checkpoint: Record<string, any> | undefined, expectedHash: string, expectedRows: number | null): checkpoint is Record<string, any> & { complete: true; count: number; sha256: string } {
  return checkpoint?.complete === true
    && checkpoint.sha256 === expectedHash
    && Number.isSafeInteger(checkpoint.count)
    && checkpoint.count >= 0
    && (expectedRows == null || checkpoint.count === expectedRows);
}

function openSnapshot(name: string, tables: NativeTable[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore('__state', { keyPath: 'name' });
      const physical = tables.filter((table) => table.kind === 'table');
      for (const table of physical) {
        const keys = primaryKey(table);
        const store = db.createObjectStore(storeNameFor(physical, table.name), keys.length ? { keyPath: keys.length === 1 ? keys[0] : keys } : undefined);
        for (const group of foreignKeyGroup(table.foreignKeys)) {
          const name = indexNameFor(table.name, group);
          const paths = group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((item) => item.column);
          store.createIndex(name, paths.length === 1 ? paths[0] : paths, { unique: false });
        }
      }
      for (const source of physical) {
        for (const group of foreignKeyGroup(source.foreignKeys)) {
          const target = physical.find((table) => table.name === group[0].table);
          if (!target) continue;
          const columns = group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((item) => item.referencedColumn);
          const store = opening.transaction!.objectStore(storeNameFor(physical, target.name));
          if (!store.indexNames.contains(referenceIndexName(columns))) store.createIndex(referenceIndexName(columns), columns.length === 1 ? columns[0] : columns, { unique: false });
        }
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('Could not open local database.'));
    opening.onblocked = () => reject(new Error('Another tab is using this snapshot. Close it and retry.'));
  });
}

function openExistingSnapshot(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name);
    opening.onupgradeneeded = () => { opening.transaction?.abort(); resolve(null); };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('Could not open local database.'));
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed.'));
  });
}

function readState(db: IDBDatabase, name = 'state'): Promise<Record<string, any> | undefined> {
  return request(db.transaction('__state').objectStore('__state').get(name));
}

function writeState(db: IDBDatabase, value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('__state', 'readwrite');
    transaction.objectStore('__state').put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save import progress.'));
  });
}

function clearTableCheckpoint(db: IDBDatabase, storeName: string, tableName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName, '__state'], 'readwrite');
    transaction.objectStore(storeName).clear();
    transaction.objectStore('__state').delete(`table:${tableName}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not restart an incomplete table import.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Could not restart an incomplete table import.'));
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error ?? new Error('Could not remove local database.'));
    deletion.onblocked = () => reject(new Error('Close other tabs using this database before removing it.'));
  });
}

function primaryKey(table: NativeTable): string[] {
  return table.columns.filter((column) => column.primaryKey).sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0)).map((column) => column.name);
}

function foreignKeyGroup(keys: NativeForeignKey[]): NativeForeignKey[][] {
  const groups = new Map<string, NativeForeignKey[]>();
  for (const key of keys) {
    const groupId = `${key.constraint ?? `column:${key.column}`}\u0000${key.table}`;
    groups.set(groupId, [...(groups.get(groupId) ?? []), key]);
  }
  return [...groups.values()];
}

function storeNameFor(tables: NativeTable[], name: string): string {
  const index = tables.findIndex((table) => table.name === name);
  if (index < 0) throw new Error(`Unknown table ${name}`);
  return `recordset-${index}`;
}

function indexNameFor(_tableName: string, group: NativeForeignKey[]): string {
  const constraint = group[0]?.constraint;
  const position = group.map((key) => key.position ?? 0).sort((a, b) => a - b).join('-');
  return `fk-${constraint ?? group.map((key) => key.column).join('_')}-${position}`;
}

function referenceIndexName(columns: string[]): string {
  return `reference-${columns.map((column) => `${column.length}_${column}`).join('_')}`;
}

function sameColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

async function stableFingerprint(configuration: ImportConfiguration): Promise<string> {
  const descriptor = JSON.stringify({
    id: configuration.id,
    sourceCommit: configuration.sourceCommit,
    exports: configuration.exports.map(({ table, sha256, decodedSha256 }) => ({ table, sha256, decodedSha256 })),
    tables: configuration.tables.map(({ name, kind, rowCount, columns, foreignKeys }) => ({ name, kind, rowCount, columns, foreignKeys })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(descriptor));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function parseJsonArray(body: ReadableStream<Uint8Array>, onRecord: (row: unknown) => Promise<void>, onHashBytes: (bytes: Uint8Array) => void, onByteLength: (bytes: number) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let started = false;
  let ended = false;
  let collecting = false;
  let value = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let separatorNeeded = false;
  let commaSeen = false;
  const emptyBytes = new Uint8Array(0);
  const consume = async (chunk: string, originalBytes: Uint8Array) => {
    onHashBytes(originalBytes);
    onByteLength(originalBytes.byteLength);
    text += chunk;
    let cursor = 0;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (!started) {
        if (/\s/.test(character)) continue;
        if (character !== '[') throw new Error('Table export must be a JSON array.');
        started = true;
        continue;
      }
      if (ended) {
        if (!/\s/.test(character)) throw new Error('Unexpected content after table export array.');
        continue;
      }
      if (!collecting) {
        if (/\s/.test(character)) continue;
        if (separatorNeeded && character === ',') { separatorNeeded = false; commaSeen = true; continue; }
        if (character === ']') {
          if (commaSeen) throw new Error('Table export has a trailing comma.');
          ended = true;
          continue;
        }
        if (separatorNeeded) throw new Error('Table export rows must be separated by commas.');
        if (character !== '{') throw new Error('Table export rows must be JSON objects.');
        collecting = true;
        commaSeen = false;
        value = character;
        depth = 1;
        continue;
      }
      value += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === '{' || character === '[') depth++;
      if (character === '}' || character === ']') depth--;
      if (depth === 0) {
        await onRecord(JSON.parse(value));
        value = '';
        collecting = false;
        separatorNeeded = true;
      }
    }
    text = '';
  };
  while (true) {
    const { done, value: bytes } = await reader.read();
    if (done) break;
    await consume(decoder.decode(bytes, { stream: true }), bytes);
  }
  const finalText = decoder.decode();
  if (finalText) await consume(finalText, emptyBytes);
  if (!started || !ended || collecting || inString) throw new Error('Table export ended before its JSON array was complete.');
}

export class IncrementalSha256 {
  private readonly state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private byteLength = 0;
  private finished = false;
  update(input: Uint8Array): void {
    if (this.finished) throw new Error('Hash was already finalized.');
    this.byteLength += input.length;
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(64 - this.blockLength, input.length - offset);
      this.block.set(input.subarray(offset, offset + count), this.blockLength);
      this.blockLength += count;
      offset += count;
      if (this.blockLength === 64) { this.compress(this.block); this.blockLength = 0; }
    }
  }
  hexDigest(): string {
    if (!this.finished) {
      const bitLength = BigInt(this.byteLength) * 8n;
      this.block[this.blockLength++] = 0x80;
      if (this.blockLength > 56) { this.block.fill(0, this.blockLength); this.compress(this.block); this.blockLength = 0; }
      this.block.fill(0, this.blockLength, 56);
      for (let index = 0; index < 8; index++) this.block[63 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
      this.compress(this.block);
      this.finished = true;
    }
    return [...this.state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }
  private compress(block: Uint8Array): void {
    const k = SHA256_K;
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index++) words[index] = (block[index * 4] << 24) | (block[index * 4 + 1] << 16) | (block[index * 4 + 2] << 8) | block[index * 4 + 3];
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]; const b = words[index - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + k[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0; this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0; this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0; this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0; this.state[7] = (this.state[7] + h) >>> 0;
  }
}

function rotate(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }
const SHA256_K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
