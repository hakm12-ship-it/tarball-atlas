import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readInput } from '../bin/input.mjs';

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atlas-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('local snapshots accept PowerShell UTF-16LE and npm JSON with a UTF-8 BOM', async t => {
  const dir = await temp(t);
  const filename = path.join(dir, '릴리스.json');
  const manifest = { schema: 1, name: 'tiny', version: '1.0.0', packedSize: 100, files: [{ path: '한글.txt', size: 7 }], tracked: null };
  await writeFile(filename, '\uFEFF' + JSON.stringify(manifest), 'utf16le');
  assert.deepEqual(await readInput(filename), manifest);
  const npmData = [{ name: 'tiny', version: '1.0.0', size: 100, files: manifest.files }];
  await writeFile(filename, '\uFEFF' + JSON.stringify(npmData), 'utf8');
  assert.deepEqual(await readInput(filename), manifest);
});

test('gzip bytes are detected without requiring a .tgz extension', async t => {
  const dir = await temp(t);
  const filename = path.join(dir, 'release.bin');
  const archive = Buffer.from('H4sIAAAAAAACCu3NvQrCMBSG4cxehZxZ0iTWDk7eykGC1J+0NFUQ8d6NOgjOIoLvs7yHbzm9rne6iVX/rN3mLpkPc0VT148W73Vu4V/3ffe+CcFMnfmCYx51KO/Nf7pI0kOUpax03GuuxjadZSanOOS2S2X3Nti5XCcGAAAAAAAAAAAAAAAAAPBLbtUp14UAKAAA', 'base64');
  await writeFile(filename, archive);
  const result = await readInput(filename);
  assert.deepEqual([result.name, result.version, result.packedSize], ['@atlas/tiny', '1.2.3', archive.length]);
});

test('only explicit npm references can request a registry URL', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(url);
    return new Response(null, { status: 404 });
  });
  for (const invalid of ['https://example.com/pkg.tgz', 'file:///tmp/pkg.tgz', '//server/share/pkg', '\\\\server\\share\\pkg', 'npm:https://example.com/pkg']) {
    await assert.rejects(readInput(invalid), /local filename|public npm package/);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(readInput('npm:@scope/pkg@1.2.3'), /could not find/);
  assert.deepEqual(calls, ['https://registry.npmjs.org/%40scope%2Fpkg/1.2.3']);
});

test('large local inputs fail before buffering', async t => {
  const dir = await temp(t);
  const filename = path.join(dir, 'large.tgz');
  await writeFile(filename, '');
  await truncate(filename, 64 * 1024 * 1024 + 1);
  await assert.rejects(readInput(filename), /64 MiB/);
});
