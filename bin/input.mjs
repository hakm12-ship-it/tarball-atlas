import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { MAX_PACKED_BYTES, readTarball } from '../docs/lib/archive.mjs';
import { normalizeManifest } from '../docs/lib/model.mjs';
import { loadPackage } from '../docs/lib/registry.mjs';

async function readLocalFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Expected a regular file');
    if (stat.size > MAX_PACKED_BYTES) throw new Error('Local input exceeds the 64 MiB limit');
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('File changed size while reading');
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== bytes.length) throw new Error('File changed size while reading');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readInput(reference) {
  if (typeof reference !== 'string' || !reference) throw new Error('Expected a local filename or npm:package reference');
  if (reference.startsWith('npm:')) return loadPackage(reference.slice(4));
  // A Windows drive path is local even though it starts with a letter and colon.
  const drivePath = /^[a-z]:[\\/]/i.test(reference);
  if ((!drivePath && /^[a-z][a-z\d+.-]*:/i.test(reference)) || /^[\\/]{2}/.test(reference)) {
    throw new Error('Use a local filename or an npm:package reference for a public registry release');
  }
  try {
    const bytes = await readLocalFile(reference);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await readTarball(bytes, 'Local tarball');
    // Windows PowerShell 5 redirects native stdout to UTF-16LE with a BOM.
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
    const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return normalizeManifest(JSON.parse(content));
  } catch (error) {
    throw new Error(`${reference}: ${error.message}`, { cause: error });
  }
}
