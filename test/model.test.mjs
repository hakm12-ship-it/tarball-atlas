import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, normalizeManifest } from '../docs/lib/model.mjs';

const h1 = 'a'.repeat(64);
const h2 = 'b'.repeat(64);
const snapshot = (files, extra = {}) => ({ schema: 1, name: '@demo/library', version: '1.0.0', files, ...extra });

test('normalizes npm versions with array and keyed pack output', () => {
  const npm = { name: '@demo/library', version: '1.0.0', size: 199, files: [{ path: 'z', size: 0 }, { path: 'a', size: 20 }] };
  const result = normalizeManifest([npm]);
  assert.deepEqual(normalizeManifest({ [npm.name]: npm }), result);
  assert.deepEqual(result, snapshot([{ path: 'a', size: 20 }, { path: 'z', size: 0 }], { packedSize: 199, tracked: null }));
  assert.deepEqual(normalizeManifest(result), result);
  assert.deepEqual(npm.files.map(file => file.path), ['z', 'a']);
  for (const input of [[], [npm, npm], {}, { a: npm, b: npm }]) assert.throws(() => normalizeManifest(input), /one npm package/);
});

test('validates package-relative paths, metadata, hashes and safe integer sizes', () => {
  for (const path of ['/a', '../a', 'dir/../a', 'dir//a', './a', 'a/', 'C:/a', 'a\\b', 'a\u001bfile', 'a\u202efile']) {
    assert.throws(() => normalizeManifest(snapshot([{ path, size: 1 }])));
  }
  for (const value of [-1, 1.2, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeManifest(snapshot([{ path: 'a', size: value }])));
  }
  assert.throws(() => normalizeManifest(snapshot([{ path: 'a', size: Number.MAX_SAFE_INTEGER }, { path: 'b', size: 1 }])));
  assert.throws(() => normalizeManifest(snapshot([{ path: 'a', size: 0, hash: 'fake' }])));
  assert.throws(() => normalizeManifest(snapshot([{ path: 'a', size: 0 }, { path: 'a', size: 1 }])));
  assert.throws(() => normalizeManifest(snapshot([], { name: 'x\n' })));
  assert.throws(() => normalizeManifest(snapshot([], { schema: 2 })));
  assert.throws(() => normalizeManifest(snapshot([], { tracked: ['../private'] })));
});

test('preserves empty tracked evidence and normalizes optional digest notation', () => {
  const files = [{ path: '資料/표.js', size: 0, hash: 'SHA256:' + h1.toUpperCase() }];
  assert.equal(normalizeManifest(snapshot(files)).tracked, null);
  assert.deepEqual(normalizeManifest(snapshot(files, { tracked: [] })).tracked, []);
  assert.equal(normalizeManifest(snapshot(files)).files[0].hash, h1);
  assert.deepEqual(normalizeManifest(snapshot(files, { tracked: ['b', 'a', 'a'] })).tracked, ['a', 'b']);
});

test('reports membership, size, content-only edits, and missing hash evidence independently', () => {
  const file = (path, size, hash) => ({ path, size, hash });
  const before = snapshot([file('a', 0), file('c', 2, h1), file('d', 2, h1), file('e', 2, h1), file('f', 2)]);
  const after = snapshot([file('b', 0), file('c', 2, h2), file('d', 2, h1), file('e', 2), file('f', 4)]);
  const result = compare(before, after);
  assert.deepEqual(result.rows.map(row => row.status), ['removed', 'added', 'changed', 'unchanged', 'unknown', 'changed']);
  assert.deepEqual(result.counts, { removed: 1, added: 1, changed: 2, unchanged: 1, unknown: 1 });
  assert.deepEqual(result.rows[0], { path: 'a', status: 'removed', before: 0, after: null, delta: 0 });
  assert.deepEqual(result.rows[1], { path: 'b', status: 'added', before: null, after: 0, delta: 0 });
  assert.deepEqual([result.beforeSize, result.afterSize, result.delta], [8, 10, 2]);
});
