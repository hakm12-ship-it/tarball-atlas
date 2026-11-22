import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { embedReport } from '../docs/lib/embed.mjs';
import { layout } from '../docs/lib/map.mjs';
import { writeReport } from '../bin/report.mjs';
test('preserves filenames and prevents script markup from entering the document', () => {
  const marker = '<script id="report-data" type="application/json">';
  const html = '<!doctype html>' + marker + 'null</script>';
  const base = { name: '$&', path: 'nested/</script><b>.txt' };
  const output = embedReport(html, base, {});
  assert.equal(output.split('</script>').length, 2);
  assert.deepEqual(
    JSON.parse(output.split(marker)[1].split('</script>')[0]).before,
    base,
  );
  assert.throws(() => embedReport('bad', {}, {}));
});
test('treemap preserves proportional areas, including a long tail', () => {
  const weights = [534, 100, 9, 2, 1, 1, 1, 1];
  const rects = layout(
    weights.map((weight) => ({ weight })),
    500,
    200,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  for (const rect of rects) {
    assert.ok(
      rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.w <= 500.00001 &&
        rect.y + rect.h <= 200.00001,
    );
    assert.ok(
      Math.abs((rect.w * rect.h) / 100000 - rect.weight / total) < 1e-9,
    );
  }
});
test('writes a self-contained report and refuses to overwrite it', async (t) => {
  try {
    await readFile(new URL('../offline/atlas.html', import.meta.url));
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('run npm run build first');
      return;
    }
    throw error;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'atlas-report-'));
  try {
    const before = JSON.parse(
      await readFile(new URL('../docs/examples/before.json', import.meta.url)),
    );
    const after = JSON.parse(
      await readFile(new URL('../docs/examples/after.json', import.meta.url)),
    );
    const dest = join(tmp, 'report.html');
    await writeReport(dest, before, after);
    const html = await readFile(dest, 'utf8');
    const match = html.match(
      /<script id="report-data" type="application\/json">(.*?)<\/script>/s,
    );
    assert.deepEqual(JSON.parse(match[1]), { before, after });
    assert.doesNotMatch(html, /<script[^>]+src="\.\//);
    assert.doesNotMatch(html, /href="\.\/style\.css"/);
    await assert.rejects(writeReport(dest, before, after), { code: 'EEXIST' });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
