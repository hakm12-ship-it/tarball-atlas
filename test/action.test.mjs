import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const action = fileURLToPath(new URL('../scripts/action.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atlas-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'checkout');
  const directory = 'packages/package with spaces';
  const pkg = path.join(workspace, directory);
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'test-action-package', version: '1.0.0', scripts: {
      prepack: 'node -e "require(\'fs\').writeFileSync(\'hook-ran\', \'yes\')"',
    },
  }));
  await writeFile(path.join(pkg, 'app.map'), '{}');
  const summary = path.join(root, 'summary.md');
  function invoke(inputs = {}) {
    return spawnSync(process.execPath, [action], {
      encoding: 'utf8', timeout: 45_000,
      env: {
        ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root,
        ATLAS_DIRECTORY: directory, ATLAS_REQUIRED: '', ATLAS_FORBIDDEN: '', ATLAS_MAX_UNPACKED: '', ...inputs,
      },
    });
  }
  return { invoke, summary, pkg };
}

test('handles a nested package and multiline gates without writing into the package', async t => {
  const { invoke, summary, pkg } = await fixture(t);
  const result = invoke({ ATLAS_REQUIRED: '\npackage.json\r\napp.map\r\n', ATLAS_FORBIDDEN: '**/.env', ATLAS_MAX_UNPACKED: '10000' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /test-action-package@1\.0\.0/);
  assert.match(await readFile(summary, 'utf8'), /Passed[\s\S]*2 files/);
  assert.deepEqual((await readdir(pkg)).sort(), ['app.map', 'package.json']);
});

test('fails with all gate reasons and keeps package-controlled text inert in the job summary', async t => {
  const { invoke, summary } = await fixture(t);
  const result = invoke({
    ATLAS_REQUIRED: 'missing.js\n<em>absent</em>', ATLAS_FORBIDDEN: '**/*.map', ATLAS_MAX_UNPACKED: '0',
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^::stop-commands::([^\r\n]+)\r?\n[\s\S]*::\1::\r?\n$/);
  const report = await readFile(summary, 'utf8');
  for (const pattern of [/Gate failed/, /Missing required file missing.js/, /matched app.map/, /exceeds limit 0/, /&lt;em&gt;/]) {
    assert.match(report, pattern);
  }
  assert.doesNotMatch(report, /<em>/);
});

test('rejects an invalid budget and an attempt to scan above the checkout', async t => {
  const { invoke } = await fixture(t);
  for (const [input, message] of [
    [{ ATLAS_MAX_UNPACKED: '2MB' }, /integer in bytes/],
    [{ ATLAS_REQUIRED: '../package.json' }, /relative path/],
    [{ ATLAS_DIRECTORY: '..' }, /inside the checkout/],
  ]) {
    const result = invoke(input);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, message);
  }
});
