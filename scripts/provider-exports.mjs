import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export async function materializeProviderExports(databaseId, exports, source, destination) {
  for (const item of exports) {
    if (item.compression === 'gzip' && item.chunks?.length) {
      const encodedChunks = [];
      for (const chunk of item.chunks) {
        const bytes = await source.read(chunk.path);
        verifyChecksum(source.checksums, chunk.path, bytes);
        if (bytes.length !== chunk.bytes || sha256(bytes) !== chunk.sha256) throw new Error(`${databaseId}: chunk ${chunk.path} disagrees with its export descriptor`);
        encodedChunks.push(bytes);
      }
      const encoded = Buffer.concat(encodedChunks, item.bytes);
      verifyEncodedExport(databaseId, item, encoded);
      for (const [index, bytes] of encodedChunks.entries()) await writeExport(destination, item.chunks[index].assetPath, bytes);
      continue;
    }

    const encodedPath = item.compression === 'gzip' ? item.encodedPath : item.path;
    const bytes = await source.read(encodedPath);
    if (source.checksums.files?.[encodedPath]) verifyChecksum(source.checksums, encodedPath, bytes);
    else if (!item.sha256 || sha256(bytes) !== item.sha256) throw new Error(`${databaseId}: export ${encodedPath} is not covered by a provider checksum or contract hash`);
    if (item.bytes != null && item.bytes !== bytes.length) throw new Error(`${databaseId}: ${encodedPath} size mismatch`);
    if (item.sha256 && item.sha256 !== sha256(bytes)) throw new Error(`${databaseId}: ${encodedPath} export hash mismatch`);
    if (item.compression === 'gzip') verifyEncodedExport(databaseId, item, bytes);
    await writeExport(destination, item.assetPath, bytes);
  }
}

async function writeExport(destination, assetPath, bytes) {
  const target = join(destination, assetPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function verifyEncodedExport(databaseId, item, encoded) {
  if (item.bytes != null && item.bytes !== encoded.length) throw new Error(`${databaseId}: ${item.path} encoded size mismatch`);
  if (!item.sha256 || item.sha256 !== sha256(encoded)) throw new Error(`${databaseId}: ${item.path} encoded checksum mismatch`);
  let decoded;
  try { decoded = gunzipSync(encoded); }
  catch (error) { throw new Error(`${databaseId}: ${item.path} is not a complete gzip stream`, { cause: error }); }
  if (item.decodedBytes != null && item.decodedBytes !== decoded.length) throw new Error(`${databaseId}: ${item.path} decoded size mismatch`);
  if (!item.decodedSha256 || item.decodedSha256 !== sha256(decoded)) throw new Error(`${databaseId}: ${item.path} decoded checksum mismatch`);
}

function verifyChecksum(checksums, path, bytes) {
  const entry = checksums.files?.[path];
  if (!entry) throw new Error(`Missing provider checksum for ${path}`);
  if (entry.bytes != null && entry.bytes !== bytes.length) throw new Error(`${path}: provider size mismatch`);
  if (entry.sha256 !== sha256(bytes)) throw new Error(`${path}: provider checksum mismatch`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
