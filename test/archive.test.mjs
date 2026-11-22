import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readTarball } from '../docs/lib/archive.mjs';

function entry(path, contents = '', options = {}) {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write((options.size ?? data.length).toString(8).padStart(11, '0'), 124, 11);
  header.fill(32, 148, 156);
  header.write(options.type || '0', 156);
  header.write('ustar\0', 257);
  if (options.prefix) header.write(options.prefix, 345, 155);
  const sum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const pkg = entry('package/package.json', '{"name":"@demo/example","version":"2.0.0"}');
const tail = Buffer.alloc(1024);
const tgz = (...entries) => gzipSync(Buffer.concat([...entries, tail]));
const hash = data => createHash('sha256').update(data).digest('hex');

function pax(key, value) {
  const body = ' ' + key + '=' + value + '\n';
  let length = Buffer.byteLength(body) + 1;
  while (length !== Buffer.byteLength(body) + String(length).length) length = Buffer.byteLength(body) + String(length).length;
  return String(length) + body;
}

test('reads npm tar bytes, reports actual hashes and compressed size, and supports ustar prefixes', async () => {
  const binary = Buffer.from(Array.from({ length: 93_000 }, (_, n) => n % 256));
  const tarball = tgz(entry('package/', '', { type: '5' }), pkg, entry('binary.dat', binary, { prefix: 'package/lib' }), entry('./package/empty'));
  const manifest = await readTarball(tarball);
  assert.deepEqual([manifest.name, manifest.version, manifest.packedSize, manifest.tracked], ['@demo/example', '2.0.0', tarball.length, null]);
  assert.deepEqual(manifest.files.slice(0, 2), [
    { path: 'empty', size: 0, hash: hash('') },
    { path: 'lib/binary.dat', size: binary.length, hash: hash(binary) },
  ]);
});

test('PAX records use byte lengths; GNU long names and PAX sizes apply only to their next file', async () => {
  const p = 'package/' + 'a'.repeat(110) + '/한글.js';
  const g = 'package/' + 'b'.repeat(125) + '/b.js';
  const tarball = tgz(pkg, entry('pax', pax('path', p) + pax('size', '3'), { type: 'x' }),
    entry('package/truncated-name', 'abc', { size: 0 }), entry('extension', g + '\0', { type: 'L' }),
    entry('package/another-truncated-name', 'z'), entry('package/index.js', 'ok'));
  const { files } = await readTarball(tarball);
  assert.ok(files.some(f => f.path === p.slice(8) && f.hash === hash('abc')));
  assert.ok(files.some(f => f.path === g.slice(8) && f.hash === hash('z')));
  assert.ok(files.some(f => f.path === 'index.js' && f.size === 2));
});

test('rejects invalid gzip, missing metadata, traversal, links, oversized bodies and duplicate paths', async () => {
  await assert.rejects(readTarball(Buffer.from('not compressed')), /gzip/);
  await assert.rejects(readTarball(tgz(entry('package/index.js'))), /package.json/);
  await assert.rejects(readTarball(tgz(entry('package/package.json', '{'))), /Tarball/);
  await assert.rejects(readTarball(tgz(pkg, entry('../package/a'))), /relative/);
  await assert.rejects(readTarball(tgz(pkg, entry('another/a'))), /share a package directory/);
  await assert.rejects(readTarball(tgz(pkg, entry('package/../a'))), /relative/);
  await assert.rejects(readTarball(tgz(pkg, entry('package/link', '', { type: '2' }))), /Unsupported/);
  await assert.rejects(readTarball(tgz(pkg, pkg)), /Duplicate/);
  await assert.rejects(readTarball(tgz(entry('package/big', '', { size: 100 * 1024 * 1024 }))), /96 MiB/);
  await assert.rejects(readTarball(tgz(entry('pax', '999 path=x\n', { type: 'x' }))), /PAX/);
});

test('strips a single legacy package directory using npm installation semantics', async () => {
  const tarball = tgz(entry('release-2010/', '', { type: '5' }), entry('release-2010/package.json', '{"name":"old","version":"1.1.0"}'));
  assert.equal((await readTarball(tarball)).files[0].path, 'package.json');
});

test('rejects archive and transport corruption even after package.json is available', async () => {
  const damaged = Buffer.from(pkg);
  damaged[0] ^= 1;
  await assert.rejects(readTarball(tgz(damaged)), /checksum/);
  await assert.rejects(readTarball(gzipSync(pkg)), /end/);
  await assert.rejects(readTarball(gzipSync(Buffer.concat([pkg, tail, Buffer.from('trailing data')]))), /after end/);
  const badGzip = tgz(pkg);
  badGzip[badGzip.length - 8] ^= 1;
  await assert.rejects(readTarball(badGzip));
});
