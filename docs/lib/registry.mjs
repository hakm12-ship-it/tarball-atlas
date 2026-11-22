import { readTarball } from './archive.mjs';

const origin = 'https://registry.npmjs.org';
const maxMetadata = 4 * 1024 * 1024;
const maxArchive = 64 * 1024 * 1024;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const tag = /^[a-z][a-z\d._-]*$/i;
const nameAndSelector = /^((?:@[a-z\d~-][a-z\d._~-]*\/)?[a-z\d~-][a-z\d._~-]*)(?:@([^@]+))?$/i;

function parseSpec(spec) {
  if (typeof spec !== 'string' || spec.length > 512) {
    throw new Error('Enter an npm package name with an optional exact version or dist-tag.');
  }
  const match = nameAndSelector.exec(spec.trim());
  if (!match || match[1].length > 214) {
    throw new Error('Enter a public npm package such as preact@10.24.3 or @babel/core@latest.');
  }
  const [, name, selector = 'latest'] = match;
  if (!exactVersion.test(selector) && (!tag.test(selector) || /^x(?:\.x){0,2}$/i.test(selector))) {
    throw new Error('Use an exact version or an npm dist-tag such as latest or next.');
  }
  return { name, selector };
}

async function download(url, limit, description, accept) {
  const response = await fetch(url, {
    headers: { Accept: accept },
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new Error(`npm could not find ${description}.`);
    throw new Error(`npm returned HTTP ${response.status} for ${description}.`);
  }
  const tooLarge = () => new Error(`${description} exceeds the ${limit / (1024 * 1024)} MiB download limit.`);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) throw new Error(`npm returned an empty response for ${description}.`);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function verifyIntegrity(bytes, dist) {
  // npm publishes SHA-512 SRI for current releases and a hex SHA-1 for older releases.
  const tokens = String(dist.integrity ?? '').split(/\s+/);
  for (const bits of [512, 384, 256]) {
    const prefix = `sha${bits}-`;
    const candidates = tokens.filter(token => token.startsWith(prefix));
    if (!candidates.length) continue;
    const digest = new Uint8Array(await crypto.subtle.digest(`SHA-${bits}`, bytes));
    const encoded = btoa(String.fromCharCode(...digest));
    if (candidates.some(token => token === prefix + encoded)) return;
    throw new Error('The tarball does not match the npm registry integrity digest.');
  }
  if (dist.shasum) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== dist.shasum) throw new Error('The tarball does not match the npm registry checksum.');
  }
}

export async function loadPackage(spec) {
  const { name, selector } = parseSpec(spec);
  const label = `${name}@${selector}`;
  const endpoint = `${origin}/${encodeURIComponent(name)}/${encodeURIComponent(selector)}`;
  const metadataBytes = await download(endpoint, maxMetadata, label, 'application/json');
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
  if (metadata?.name !== name || !exactVersion.test(metadata.version)
      || (exactVersion.test(selector) && metadata.version !== selector)) {
    throw new Error(`npm returned unexpected package metadata for ${label}.`);
  }
  const { dist } = metadata;
  if (typeof dist?.tarball !== 'string' || !URL.canParse(dist.tarball)) {
    throw new Error(`npm did not provide a tarball URL for ${label}.`);
  }
  const tarball = new URL(dist.tarball);
  if (tarball.origin !== origin || tarball.username || tarball.password || !tarball.pathname.endsWith('.tgz')) {
    throw new Error('Only tarballs hosted on the public npm registry are supported.');
  }
  const resolved = `${name}@${metadata.version}`;
  const bytes = await download(tarball.href, maxArchive, resolved, 'application/octet-stream');
  await verifyIntegrity(bytes, dist);
  const snapshot = await readTarball(bytes, resolved);
  if (snapshot.name !== name || snapshot.version !== metadata.version) {
    throw new Error(`The package.json in this tarball does not match ${resolved}.`);
  }
  return snapshot;
}
