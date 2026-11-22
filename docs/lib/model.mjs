const MAX_PATHS = 100_000;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function safeText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.length || value.length > maxLength || unsafeText.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function validatePath(value) {
  safeText(value, 'file path', 4096);
  if (value.includes('\\') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Expected a relative file path with forward slashes and no traversal segments');
  }
  return value;
}

function size(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function list(value, field) {
  if (!Array.isArray(value) || value.length > MAX_PATHS) {
    throw new Error(`Expected ${field} to be an array of at most ${MAX_PATHS} paths`);
  }
  return value;
}

function unpackInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Expected a snapshot or npm pack JSON');
  if (Array.isArray(input)) {
    if (input.length !== 1) throw new Error('Select a manifest for exactly one npm package');
    return { data: input[0], canonical: false };
  }
  if (Object.hasOwn(input, 'schema') && (Array.isArray(input.files) || typeof input.schema !== 'object')) {
    if (input.schema !== 1) throw new Error('Unsupported snapshot schema');
    return { data: input, canonical: true };
  }
  if (Array.isArray(input.files)) return { data: input, canonical: false };
  // npm 12+ keys pack results by package name. Earlier releases use an array.
  const entries = Object.values(input);
  if (entries.length !== 1) throw new Error('Select a manifest for exactly one npm package');
  return { data: entries[0], canonical: false };
}

export function normalizeManifest(input) {
  const { data, canonical } = unpackInput(input);
  if (!data || typeof data !== 'object') throw new Error('Invalid package manifest');
  const name = safeText(data.name, 'package name', 512);
  const version = safeText(data.version, 'package version', 512);
  const packed = canonical ? data.packedSize : data.size;
  const packedSize = packed == null ? null : size(packed, 'packed size');
  const seen = new Set();
  let total = 0;
  const files = list(data.files, 'files').map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid file entry');
    const path = validatePath(entry.path);
    if (seen.has(path)) throw new Error(`Duplicate file path: ${path}`);
    seen.add(path);
    const file = { path, size: size(entry.size, 'file size') };
    total = size(total + file.size, 'total unpacked size');
    if (entry.hash != null) {
      if (typeof entry.hash !== 'string' || !/^(?:sha256:)?[\da-f]{64}$/i.test(entry.hash)) {
        throw new Error(`Invalid SHA-256 hash for ${path}`);
      }
      file.hash = entry.hash.replace(/^sha256:/i, '').toLowerCase();
    }
    return file;
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const tracked = canonical && data.tracked != null
    ? [...new Set(list(data.tracked, 'tracked').map(validatePath))].sort()
    : null;
  return { schema: 1, name, version, packedSize, files, tracked };
}

export function compare(beforeInput, afterInput) {
  const before = normalizeManifest(beforeInput);
  const after = normalizeManifest(afterInput);
  const left = new Map(before.files.map(file => [file.path, file]));
  const right = new Map(after.files.map(file => [file.path, file]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0, unknown: 0 };
  let beforeSize = 0;
  let afterSize = 0;
  const rows = paths.map(path => {
    const a = left.get(path);
    const b = right.get(path);
    let status;
    if (!a) status = 'added';
    else if (!b) status = 'removed';
    else if (a.size !== b.size) status = 'changed';
    else if (!a.hash || !b.hash) status = 'unknown';
    else status = a.hash === b.hash ? 'unchanged' : 'changed';
    counts[status]++;
    beforeSize += a?.size ?? 0;
    afterSize += b?.size ?? 0;
    return { path, status, before: a?.size ?? null, after: b?.size ?? null, delta: (b?.size ?? 0) - (a?.size ?? 0) };
  });
  return { rows, counts, beforeSize, afterSize, delta: afterSize - beforeSize };
}
