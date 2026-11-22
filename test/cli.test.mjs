import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/atlas.mjs', import.meta.url));

function invoke(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 45_000 });
  if (result.error) throw result.error;
  return result;
}

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tarball-atlas-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('scans the intended workspace, hashes file bytes, and leaves lifecycle scripts disabled', async t => {
  const repo = await temp(t);
  const pkg = path.join(repo, 'packages', 'a package & tools');
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*'] }));
  const hook = 'node -e "require(\'fs\').writeFileSync(\'ran-hook\', \'yes\')"';
  const metadata = {
    name: 'atlas-fixture', version: '1.2.3', files: ['index.js', 'dist/**'],
    scripts: { prepare: hook, prepack: hook, postpack: hook },
  };
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify(metadata));
  await mkdir(path.join(pkg, 'dist'));
  await writeFile(path.join(pkg, 'src.txt'), 'tracked, not shipped');
  await writeFile(path.join(pkg, 'index.js'), 'hello');
  await writeFile(path.join(pkg, 'dist', 'entry.map'), 'generated');
  git(repo, 'init', '--quiet');
  git(repo, 'add', '--', 'package.json');
  git(pkg, 'add', '--', 'src.txt', 'package.json', 'index.js');

  const scanArgs = ['scan', pkg, '--json', '--require', 'index.js', '--max-unpacked', '12000'];
  let result = invoke(...scanArgs);
  if (result.status === 2 && result.stderr.includes('requires npm 11 or newer')) {
    // Older npm cannot safely pack a prepare hook. Verify refusal happened
    // before execution, then exercise a supported package with other hooks.
    assert.ok(!(await readdir(pkg)).includes('ran-hook'));
    assert.equal(result.stdout, '');
    delete metadata.scripts.prepare;
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify(metadata));
    result = invoke(...scanArgs);
  }
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.name, 'atlas-fixture');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.schema, 1);
  assert.ok(manifest.packedSize > 0);
  assert.deepEqual(manifest.tracked, ['index.js', 'package.json', 'src.txt']);
  assert.deepEqual(manifest.files.map(file => file.path), ['dist/entry.map', 'index.js', 'package.json']);
  assert.deepEqual(manifest.files.find(file => file.path === 'index.js'), {
    path: 'index.js', size: 5, hash: createHash('sha256').update('hello').digest('hex'),
  });
  assert.ok(!(await readdir(pkg)).some(file => file === 'ran-hook' || file.endsWith('.tgz')));

  const summary = invoke('scan', pkg);
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Packed, untracked \(1\)[\r\n]+  dist\/entry\.map/);
  assert.match(summary.stdout, /Tracked, omitted \(1\)[\r\n]+  src\.txt/);
});

test('returns every failed gate while keeping stdout valid and handling globstar at the root', async t => {
  const pkg = await temp(t);
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'atlas-gates', version: '1.0.0' }));
  await writeFile(path.join(pkg, 'root.map'), '{}');
  await mkdir(path.join(pkg, 'build'));
  await writeFile(path.join(pkg, 'build', 'one.map'), '{}');
  const result = invoke('scan', '--json', pkg, '--forbid', '**/*.map', '--forbid', 'build/???.map',
    '--require', 'missing', '--require', '-h', '--require', 'package.json', '--max-unpacked', '0');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).tracked, null);
  assert.match(result.stderr, /Missing required file missing/);
  assert.match(result.stderr, /Missing required file -h/);
  assert.match(result.stderr, /build\/one\.map, root\.map/);
  assert.match(result.stderr, /build\/\?\?\?\.map matched build\/one\.map/);
  assert.match(result.stderr, /bytes exceeds limit 0/);
  assert.doesNotMatch(result.stderr, /Missing required file package.json/);
});

test('diff reports same-size uncertainty for raw npm inputs, detects digests, accepts PowerShell redirection', async t => {
  const dir = await temp(t);
  const before = path.join(dir, 'before.json');
  const after = path.join(dir, 'after.json');
  const data = {
    name: 'atlas-fixture', version: '1.0.0', size: 100,
    files: [{ path: 'index.js', size: 4 }, { path: 'old.js', size: 1 }],
  };
  await writeFile(before, '\uFEFF' + JSON.stringify([data]), 'utf16le');
  await writeFile(after, JSON.stringify({ [data.name]: {
    ...data, version: '2.0.0', files: [{ path: 'index.js', size: 4 }, { path: 'new.js', size: 3 }],
  } }));
  const result = invoke('diff', before, after, '--json');
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.rows.map(row => [row.path, row.status]), [
    ['index.js', 'unknown'], ['new.js', 'added'], ['old.js', 'removed'],
  ]);
  assert.equal(parsed.delta, 2);
  const output = invoke('diff', before, after);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /Unknown means equal size/);
  const snapshot = { schema: 1, name: 'atlas-fixture', version: '1.0.0', tracked: null, packedSize: null,
    files: [{ path: 'a', size: 5, hash: 'a'.repeat(64) }] };
  await writeFile(before, JSON.stringify(snapshot));
  snapshot.files[0].hash = 'b'.repeat(64);
  await writeFile(after, JSON.stringify(snapshot));
  const changed = invoke('diff', before, after, '--json');
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).rows[0].status, 'changed');
});

test('input errors return exit 2 and leave stdout empty', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'bad.json');
  await writeFile(file, '{');
  for (const args of [
    ['scan', dir], ['scan', '--max-unpacked', '-1'], ['scan', '--require', '../package.json'],
    ['diff'], ['diff', file, file], ['diff', file, file, '--html'], ['scan', '--unknown'],
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Tarball Atlas/);
  }
  assert.equal(await readFile(file, 'utf8'), '{');
});
