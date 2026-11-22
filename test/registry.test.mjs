import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadPackage } from '../docs/lib/registry.mjs';

// Deterministic USTAR gzip containing just package/package.json for @atlas/tiny@1.2.3.
const tiny = Buffer.from('H4sIAAAAAAACCu3NvQrCMBSG4cxehZxZ0iTWDk7eykGC1J+0NFUQ8d6NOgjOIoLvs7yHbzm9rne6iVX/rN3mLpkPc0VT148W73Vu4V/3ffe+CcFMnfmCYx51KO/Nf7pI0kOUpax03GuuxjadZSanOOS2S2X3Nti5XCcGAAAAAAAAAAAAAAAAAPBLbtUp14UAKAAA', 'base64');
const tarball = 'https://registry.npmjs.org/@atlas/tiny/-/tiny-1.2.3.tgz';
const integrity = 'sha512-' + createHash('sha512').update(tiny).digest('base64');
const metadata = { name: '@atlas/tiny', version: '1.2.3', dist: { tarball, integrity } };

test('a scoped dist-tag resolves to verified package bytes without sending credentials', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return url === tarball ? new Response(tiny) : Response.json(metadata);
  });
  const result = await loadPackage('@atlas/tiny');
  assert.equal(result.name, '@atlas/tiny');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.packedSize, tiny.length);
  assert.deepEqual(result.files.map(file => file.path), ['package.json']);
  assert.deepEqual(calls, ['https://registry.npmjs.org/%40atlas%2Ftiny/latest', tarball]);
});

test('URLs, git specs, ranges and overlong input fail before any request', async t => {
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
  for (const spec of ['https://example.org/p.tgz', 'git+https://example.org/x', 'preact@^10', 'preact@1.2', 'preact@*', 'preact@x', 'name?private=1', 'x'.repeat(513)]) {
    await assert.rejects(loadPackage(spec), /Enter|exact version/);
  }
  assert.equal(network.mock.callCount(), 0);
});

test('unrelated tarball hosts and embedded credentials are refused before download', async t => {
  for (const source of ['https://example.org/kit.tgz', 'https://someone@registry.npmjs.org/kit.tgz']) {
    const network = t.mock.method(globalThis, 'fetch', () => Response.json({ ...metadata, dist: { tarball: source } }));
    await assert.rejects(loadPackage('@atlas/tiny@1.2.3'), /public npm registry/);
    assert.equal(network.mock.callCount(), 1);
    network.mock.restore();
  }
});

test('the registry digest is checked before archive inspection', async t => {
  t.mock.method(globalThis, 'fetch', url => url === tarball
    ? new Response(tiny)
    : Response.json({ ...metadata, dist: { tarball, integrity: 'sha512-wrong' } }));
  await assert.rejects(loadPackage('@atlas/tiny@next'), /integrity digest/);
});

test('registry version and embedded manifest must match the requested package', async t => {
  t.mock.method(globalThis, 'fetch', url => url === tarball ? new Response(tiny) : Response.json(metadata));
  await assert.rejects(loadPackage('@atlas/tiny@9.9.9'), /unexpected package metadata/);
  globalThis.fetch.mock.mockImplementation(url => url === tarball
    ? new Response(tiny) : Response.json({ ...metadata, name: 'another' }));
  await assert.rejects(loadPackage('another@1.2.3'), /package.json/);
});

test('download limits and missing releases report actionable errors', async t => {
  t.mock.method(globalThis, 'fetch', () => new Response(null, { status: 404 }));
  await assert.rejects(loadPackage('preact@does-not-exist'), /npm could not find preact@does-not-exist/);
  globalThis.fetch.mock.mockImplementation(() => new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
  await assert.rejects(loadPackage('preact'), /4 MiB/);
  globalThis.fetch.mock.mockImplementation(url => url === tarball
    ? new Response('tiny', { headers: { 'content-length': '999999999' } }) : Response.json(metadata));
  await assert.rejects(loadPackage('@atlas/tiny'), /64 MiB/);
});
