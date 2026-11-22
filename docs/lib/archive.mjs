import { normalizeManifest, validatePath } from './model.mjs';

const MiB = 1024 * 1024;
export const MAX_PACKED_BYTES = 64 * MiB;
const MAX_EXPANDED_BYTES = 256 * MiB;
const MAX_FILE_BYTES = 96 * MiB;
const MAX_METADATA_BYTES = MiB;
const MAX_ENTRIES = 25_000;
const BLOCK = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Consume one file at a time and bound the expanded stream, including padding.
function tarReader(stream) {
  const reader = stream.getReader();
  let buffer = new Uint8Array();
  let offset = 0;
  let total = 0;
  async function available() {
    while (offset === buffer.length) {
      const { value, done } = await reader.read();
      if (done) return false;
      total += value.length;
      if (total > MAX_EXPANDED_BYTES) throw new Error('Tarball expands beyond the 256 MiB limit');
      buffer = value;
      offset = 0;
    }
    return true;
  }
  return {
    async take(length) {
      if (length === 0) return new Uint8Array();
      if (!(await available())) throw new Error('Unexpected end of tar data');
      if (buffer.length - offset >= length) {
        const result = buffer.subarray(offset, offset + length);
        offset += length;
        return result;
      }
      const result = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        if (!(await available())) throw new Error('Unexpected end of tar data');
        const n = Math.min(buffer.length - offset, length - written);
        result.set(buffer.subarray(offset, offset + n), written);
        offset += n;
        written += n;
      }
      return result;
    },
    async finish() {
      while (await available()) {
        if (buffer.subarray(offset).some(byte => byte !== 0)) throw new Error('Data after end of tar archive');
        offset = buffer.length;
      }
      if (total % BLOCK) throw new Error('Incomplete final tar block');
    },
    close() {
      return reader.cancel().catch(() => {});
    },
  };
}

function textField(bytes) {
  const end = bytes.indexOf(0);
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(bytes) {
  const value = textField(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid numeric tar header');
  return parseInt(value, 8);
}

function checkHeader(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  if (sum !== octal(header.subarray(148, 156))) throw new Error('Invalid tar header checksum');
}

function headerPath(header) {
  const name = textField(header.subarray(0, 100));
  // Only POSIX ustar uses this area as a prefix. Old GNU headers store timestamps here.
  const prefix = header[262] === 0 && textField(header.subarray(257, 262)) === 'ustar'
    ? textField(header.subarray(345, 500)) : '';
  return prefix ? prefix + '/' + name : name;
}

function paxFields(bytes) {
  const fields = {};
  let start = 0;
  while (start < bytes.length) {
    const space = bytes.indexOf(32, start);
    if (space <= start || space - start > 9) throw new Error('Invalid PAX record length');
    const digits = utf8.decode(bytes.subarray(start, space));
    if (!/^[1-9]\d*$/.test(digits)) throw new Error('Invalid PAX record length');
    const end = start + Number(digits);
    if (end <= space + 1 || end > bytes.length || bytes[end - 1] !== 10) throw new Error('Truncated PAX record');
    const record = utf8.decode(bytes.subarray(space + 1, end - 1));
    const equal = record.indexOf('=');
    if (equal < 1) throw new Error('Invalid PAX record');
    const key = record.slice(0, equal);
    if (key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize') throw new Error('Sparse tar entries are unsupported');
    if (key === 'path' || key === 'size') fields[key] = record.slice(equal + 1);
    start = end;
  }
  return fields;
}

async function readContents(source, size) {
  const contents = await source.take(size);
  await source.take((BLOCK - size % BLOCK) % BLOCK);
  return contents;
}

async function digest(bytes) {
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(result, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function parseTar(source, packedSize) {
  const files = [];
  const seen = new Set();
  let metadata;
  let root;
  let global = {};
  let local = {};
  let extended = false;
  let count = 0;
  for (;;) {
    const header = await source.take(BLOCK);
    if (header.every(byte => byte === 0)) {
      if ((await source.take(BLOCK)).some(byte => byte !== 0)) throw new Error('Invalid tar end marker');
      if (extended) throw new Error('Tar extended header has no following entry');
      await source.finish();
      break;
    }
    if (++count > MAX_ENTRIES) throw new Error('Tarball exceeds the 25,000-entry limit');
    checkHeader(header);
    const type = String.fromCharCode(header[156] || 48);
    const headerSize = octal(header.subarray(124, 136));
    if (type === 'x' || type === 'g' || type === 'L') {
      if (headerSize > MAX_METADATA_BYTES) throw new Error('Tar extension metadata exceeds 1 MiB');
      const bytes = await readContents(source, headerSize);
      if (type === 'g') global = { ...global, ...paxFields(bytes) };
      else {
        local = { ...local, ...(type === 'L' ? { path: textField(bytes) } : paxFields(bytes)) };
        extended = true;
      }
      continue;
    }
    const fields = { ...global, ...local };
    local = {};
    extended = false;
    if (!['0', '5', '7'].includes(type)) throw new Error('Unsupported tar entry (only files and directories are accepted)');
    const directory = type === '5';
    let fullPath = (fields.path || headerPath(header)).replace(/^(?:\.\/)+/, '');
    if (directory) fullPath = fullPath.replace(/\/+$/, '');
    validatePath(fullPath);
    // npm strips the first component; some historical packages used a release-specific directory.
    const slash = fullPath.indexOf('/');
    const first = slash < 0 ? fullPath : fullPath.slice(0, slash);
    root ??= first;
    if (first !== root || (!directory && slash < 0)) throw new Error('Tar files must share a package directory');
    const path = slash < 0 ? '' : fullPath.slice(slash + 1);
    if (fields.size && !/^\d+$/.test(fields.size)) throw new Error('Invalid PAX file size');
    const size = fields.size ? Number(fields.size) : headerSize;
    if (size > MAX_FILE_BYTES) throw new Error('A file exceeds the 96 MiB limit');
    if (directory) {
      if (size !== 0) throw new Error('Invalid tar directory size');
      continue;
    }
    if (seen.has(path)) throw new Error(`Duplicate tar file: ${path}`);
    seen.add(path);
    if (path === 'package.json' && size > 4 * MiB) throw new Error('package.json exceeds 4 MiB');
    const contents = await readContents(source, size);
    if (path === 'package.json') metadata = JSON.parse(utf8.decode(contents));
    files.push({ path, size, hash: await digest(contents) });
  }
  if (!metadata || typeof metadata !== 'object') throw new Error('Missing or invalid package.json in the tarball root directory');
  return normalizeManifest({ schema: 1, name: metadata.name, version: metadata.version, packedSize, files, tracked: null });
}

export async function readTarball(bytes, label = 'Tarball') {
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected tarball bytes (Uint8Array)');
  if (bytes.byteLength > MAX_PACKED_BYTES) throw new Error('Tarball exceeds the 64 MiB compressed limit');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Expected a gzip-compressed npm tarball (.tgz)');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const source = tarReader(stream);
  try {
    return await parseTar(source, bytes.byteLength);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  } finally {
    await source.close();
  }
}
