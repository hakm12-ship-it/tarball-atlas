import { normalizeManifest, compare } from './lib/model.mjs';
import { readTarball } from './lib/archive.mjs';
import { loadPackage } from './lib/registry.mjs';
import { layout } from './lib/map.mjs';
import { embedReport } from './lib/embed.mjs';

const $ = (id) => document.getElementById(id);
const make = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
};
const home = 'https://hakm12-ship-it.github.io/tarball-atlas/';
const offline = !!document.querySelector('meta[name="atlas-offline"]');
const pristine = offline
  ? '<!doctype html>\n' + document.documentElement.outerHTML
  : null;
const embedded = JSON.parse($('report-data').textContent);
const exampleSpecs = ['moment-timezone@0.5.34', 'moment-timezone@0.5.35'];
const labels = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
  unchanged: 'Unchanged',
  unknown: 'Unverified',
};
const byteUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const formats = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
function bytes(value, signed = false) {
  if (value === null) return '—';
  const absolute = Math.abs(value);
  const index = absolute
    ? Math.min(
        byteUnits.length - 1,
        Math.floor(Math.log(absolute) / Math.log(1024)),
      )
    : 0;
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return (
    sign + formats.format(absolute / 1024 ** index) + ' ' + byteUnits[index]
  );
}
const spec = (snap) => snap.name + '@' + snap.version;
const state = {
  before: null,
  after: null,
  diff: null,
  shareable: false,
  page: 100,
  sort: 'impact',
  generation: 0,
};
const tell = (text = '', error = false) => {
  $('message').textContent = text;
  $('message').hidden = !text;
  $('message').classList.toggle('error', error);
};
function setMode(isFile) {
  $('file-mode').setAttribute('aria-pressed', String(isFile));
  $('registry-mode').setAttribute('aria-pressed', String(!isFile));
  $('registry-form').hidden = isFile;
  $('file-form').hidden = !isFile;
}
$('registry-mode').onclick = () => {
  setMode(false);
  tell();
};
$('file-mode').onclick = () => {
  setMode(true);
  tell();
};
$('baseline-source').onchange = () => {
  const published = $('baseline-source').value === 'registry';
  for (const [id, hide] of [
    ['before-file', published],
    ['published-base', !published],
  ]) {
    $(id).hidden = hide;
    $(id).disabled = hide;
    $(id).required = !hide;
  }
};

function metric(label, value, info) {
  const element = make('div', undefined, 'metric');
  element.append(
    make('span', label, 'metric-label'),
    make('strong', value, 'metric-value'),
    make('span', info, 'metric-info'),
  );
  return element;
}
function show(before, after, shareable) {
  state.before = normalizeManifest(before);
  state.after = normalizeManifest(after);
  state.diff = compare(state.before, state.after);
  state.shareable = shareable;
  state.page = 100;
  state.sort = 'impact';
  $('sort').textContent = 'Change ↓';
  $('status-filter').value = 'all';
  $('search').value = '';
  $('map-mode').value = 'after';
  const a = state.before,
    b = state.after,
    d = state.diff;
  $('report').hidden = false;
  $('report-name').textContent =
    a.name === b.name ? a.name : a.name + ' / ' + b.name;
  $('report-kind').textContent =
    shareable && spec(a) === exampleSpecs[0] && spec(b) === exampleSpecs[1]
      ? 'EXAMPLE RELEASE COMPARISON'
      : 'RELEASE COMPARISON';
  $('versions').replaceChildren(
    make('span', a.version),
    document.createTextNode(' → '),
    make('span', b.version),
  );
  const packedDelta =
    a.packedSize === null || b.packedSize === null
      ? null
      : b.packedSize - a.packedSize;
  const diffCount = d.counts.added + d.counts.removed + d.counts.changed;
  $('metrics').replaceChildren(
    metric(
      'Download size change',
      bytes(packedDelta, true),
      bytes(a.packedSize) + ' → ' + bytes(b.packedSize),
    ),
    metric(
      'Unpacked size change',
      bytes(d.delta, true),
      bytes(d.beforeSize) + ' → ' + bytes(d.afterSize),
    ),
    metric(
      'Files affected',
      String(diffCount),
      d.counts.added +
        ' added · ' +
        d.counts.changed +
        ' edited · ' +
        d.counts.removed +
        ' removed' +
        (d.counts.unknown ? ' · ' + d.counts.unknown + ' unverified' : ''),
    ),
  );
  $('share').hidden = !shareable;
  drawMap();
  drawMovers();
  drawLedger();
  drawGit();
}
function drawGit() {
  const target = state.after;
  $('git-state').hidden = !target.tracked;
  $('git-detail').replaceChildren();
  if (!target.tracked) return;
  const tracked = new Set(target.tracked);
  const packed = new Set(target.files.map((f) => f.path));
  for (const [title, paths] of [
    ['Packed, outside Git', [...packed].filter((p) => !tracked.has(p))],
    ['Tracked, outside package', target.tracked.filter((p) => !packed.has(p))],
  ]) {
    const info = make('section');
    info.append(
      make('h4', title + ' (' + paths.length + ')'),
      make('pre', paths.slice(0, 250).join('\n') || 'None'),
    );
    if (paths.length > 250)
      info.append(make('p', 'Showing the first 250 paths.'));
    $('git-detail').append(info);
  }
}
function detail(path) {
  const row = state.diff.rows.find((r) => r.path === path);
  if (!row) return;
  $('detail-path').textContent = path;
  const list = make('dl');
  for (const [key, value] of [
    ['Status', labels[row.status]],
    [
      'Baseline',
      row.before === null
        ? 'Absent'
        : row.before.toLocaleString('en-US') + ' bytes',
    ],
    [
      'Candidate',
      row.after === null
        ? 'Absent'
        : row.after.toLocaleString('en-US') + ' bytes',
    ],
    ['Change', bytes(row.delta, true)],
    [
      'Baseline SHA-256',
      state.before.files.find((f) => f.path === path)?.hash || 'Unavailable',
    ],
    [
      'Candidate SHA-256',
      state.after.files.find((f) => f.path === path)?.hash || 'Unavailable',
    ],
  ])
    list.append(make('dt', key), make('dd', value));
  $('detail-stats').replaceChildren(list);
  if (row.status === 'unknown')
    $('detail-stats').append(
      make(
        'p',
        'Both sizes match. Content comparison needs a SHA-256 digest for each file.',
      ),
    );
  $('details').showModal();
}
$('close-details').onclick = () => $('details').close();
$('details').onclick = (event) => {
  if (event.target !== $('details')) return;
  const r = $('details').getBoundingClientRect();
  if (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  )
    $('details').close();
};
const palette = {
  added: ['#d5ef7b', '#bedb75', '#e1ed9c'],
  changed: ['#81bca3', '#a8cdb7', '#68aa92', '#c3d7aa', '#98c3a0'],
  removed: ['#d9ae92', '#e1bb9f'],
  other: ['#b5c7c3', '#a7bbaf', '#c7d4ca'],
};
function drawMap() {
  if (!state.diff) return;
  const root = $('map'),
    mode = $('map-mode').value;
  const positive = state.diff.rows
    .map((row) => ({
      row,
      weight: mode === 'delta' ? Math.abs(row.delta) : (row[mode] ?? 0),
    }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const items = positive.slice(0, 63);
  if (positive.length > 63)
    items.push({
      group: positive.length - 63,
      weight: positive.slice(63).reduce((s, i) => s + i.weight, 0),
    });
  root.replaceChildren();
  if (!items.length) {
    root.append(make('p', 'No nonzero file sizes in this view.', 'empty'));
    $('map-caption').textContent = '';
    return;
  }
  const cells = layout(items, root.clientWidth, root.clientHeight);
  for (const [i, tile] of cells.entries()) {
    const row = tile.row;
    const path = row?.path ?? 'Other ' + tile.group + ' files';
    const t = make(row ? 'button' : 'div', undefined, 'block');
    const group = palette[row?.status] || palette.other;
    t.style.setProperty('--tile', group[i % group.length]);
    Object.assign(t.style, {
      left: tile.x + 'px',
      top: tile.y + 'px',
      width: tile.w + 'px',
      height: tile.h + 'px',
    });
    t.title =
      path +
      ' · ' +
      bytes(tile.weight) +
      (row ? ' · ' + labels[row.status] : '');
    t.setAttribute('aria-label', t.title);
    const inside = make('span');
    if (tile.w > 62 && tile.h > 27) {
      inside.append(make('strong', path.split('/').pop()));
      if (tile.h > 54) inside.append(make('small', bytes(tile.weight)));
    }
    t.append(inside);
    if (row) t.onclick = () => detail(row.path);
    root.append(t);
  }
  $('map-caption').textContent = positive.length + ' files by area';
}
new ResizeObserver(drawMap).observe($('map'));
$('map-mode').onchange = drawMap;
function drawMovers() {
  const root = $('movers');
  root.replaceChildren();
  const ranked = state.diff.rows
    .filter((r) => r.delta)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);
  if (!ranked.length) {
    root.append(make('p', 'No file changed in byte length.', 'empty'));
    return;
  }
  for (const row of ranked) {
    const button = make('button', undefined, 'mover');
    button.title = row.path;
    const track = make('span', undefined, 'bar-track'),
      bar = make('span', undefined, 'bar-fill');
    bar.style.width = Math.abs(row.delta / ranked[0].delta) * 100 + '%';
    track.append(bar);
    button.append(
      make('span', row.path, 'mover-path'),
      make('strong', bytes(row.delta, true), 'mover-value'),
      track,
    );
    button.onclick = () => detail(row.path);
    root.append(button);
  }
}
function drawLedger() {
  const search = $('search').value.toLowerCase(),
    filter = $('status-filter').value;
  const rows = state.diff.rows.filter(
    (row) =>
      row.path.toLowerCase().includes(search) &&
      (filter === 'all' || row.status === filter),
  );
  if (state.sort === 'impact')
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (state.sort === 'signed') rows.sort((a, b) => a.delta - b.delta);
  const fragment = document.createDocumentFragment();
  for (const r of rows.slice(0, state.page)) {
    const tr = make('tr'),
      name = make('td'),
      status = make('td'),
      button = make('button', r.path);
    button.onclick = () => detail(r.path);
    name.append(button);
    status.append(make('span', labels[r.status], 'pill ' + r.status));
    tr.append(
      name,
      status,
      make('td', bytes(r.before)),
      make('td', bytes(r.after)),
      make('td', bytes(r.delta, true)),
    );
    fragment.append(tr);
  }
  $('ledger').replaceChildren(fragment);
  $('row-count').textContent = rows.length
    ? 'Showing ' +
      Math.min(state.page, rows.length) +
      ' of ' +
      rows.length +
      ' files'
    : 'No paths match these filters.';
  $('more').hidden = rows.length <= state.page;
}
$('sort').onclick = () => {
  state.sort = state.sort === 'impact' ? 'signed' : 'impact';
  $('sort').textContent = state.sort === 'impact' ? 'Change ↓' : 'Change ↑';
  drawLedger();
};
for (const id of ['search', 'status-filter'])
  $(id).oninput = () => {
    state.page = 100;
    drawLedger();
  };
$('more').onclick = () => {
  state.page += 100;
  drawLedger();
};
async function run(getPair, shareable, message) {
  const generation = ++state.generation;
  tell(message);
  try {
    const [before, after] = await getPair();
    if (generation !== state.generation) return;
    show(before, after, shareable);
    tell();
    if (!offline) {
      const url = new URL(location.href);
      url.search = '';
      url.hash = '';
      if (
        shareable &&
        (spec(before) !== exampleSpecs[0] || spec(after) !== exampleSpecs[1])
      ) {
        url.searchParams.set('from', spec(before));
        url.searchParams.set('to', spec(after));
      }
      history.replaceState(null, '', url);
    }
  } catch (e) {
    if (generation === state.generation)
      tell(e.message || 'Comparison failed.', true);
  }
}
async function readFile(file) {
  if (!file) throw new Error('Choose both files to compare.');
  if (file.size > 64 * 1024 * 1024)
    throw new Error('Choose a file smaller than 64 MiB.');
  const raw = new Uint8Array(await file.arrayBuffer());
  if (raw[0] === 0x1f && raw[1] === 0x8b) return readTarball(raw, file.name);
  const encoding =
    raw[0] === 0xff && raw[1] === 0xfe
      ? 'utf-16le'
      : raw[0] === 0xfe && raw[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    return normalizeManifest(JSON.parse(new TextDecoder(encoding).decode(raw)));
  } catch (e) {
    throw new Error(file.name + ' · ' + e.message);
  }
}
$('file-form').onsubmit = (e) => {
  e.preventDefault();
  const published = $('baseline-source').value === 'registry';
  run(
    () =>
      Promise.all([
        published
          ? loadPackage($('published-base').value.trim())
          : readFile($('before-file').files[0]),
        readFile($('after-file').files[0]),
      ]),
    false,
    published
      ? 'Fetching the baseline from npm and reading the local candidate…'
      : 'Reading local files…',
  );
};
function registryPair() {
  const specs = [$('before-spec').value.trim(), $('after-spec').value.trim()];
  return run(
    () => Promise.all(specs.map((s) => loadPackage(s))),
    true,
    'Fetching package metadata and tarballs from npm…',
  );
}
$('registry-form').onsubmit = (e) => {
  e.preventDefault();
  registryPair();
};
async function example() {
  setMode(false);
  [$('before-spec').value, $('after-spec').value] = exampleSpecs;
  await run(
    async () => {
      if (globalThis.ATLAS_EXAMPLE) return globalThis.ATLAS_EXAMPLE;
      return Promise.all(
        ['before', 'after'].map(async (key) => {
          const r = await fetch('./examples/' + key + '.json');
          if (!r.ok) throw new Error('Could not load example files.');
          return r.json();
        }),
      );
    },
    true,
    'Loading example…',
  );
}
$('example').onclick = example;
$('share').onclick = async () => {
  const url = new URL(home);
  url.searchParams.set('from', spec(state.before));
  url.searchParams.set('to', spec(state.after));
  try {
    await navigator.clipboard.writeText(url.href);
    tell('Comparison link copied.');
  } catch {
    tell('Comparison link: ' + url.href);
  }
};
$('export').onclick = async () => {
  $('export').disabled = true;
  const before = state.before,
    after = state.after;
  try {
    const template =
      pristine ??
      (await fetch('./atlas.html').then((r) => {
        if (!r.ok) throw new Error('Could not load the offline viewer.');
        return r.text();
      }));
    const blob = new Blob([embedReport(template, before, after)], {
      type: 'text/html',
    });
    const url = URL.createObjectURL(blob),
      a = make('a');
    a.href = url;
    a.download = 'tarball-atlas-report.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    tell(
      'Exported an offline HTML report with paths, sizes, and available hashes.',
    );
  } catch (e) {
    tell(e.message, true);
  } finally {
    $('export').disabled = false;
  }
};
const params = new URL(location.href).searchParams;
if (embedded) {
  setMode(true);
  show(embedded.before, embedded.after, false);
} else if (params.has('from') && params.has('to')) {
  $('before-spec').value = params.get('from');
  $('after-spec').value = params.get('to');
  registryPair();
} else {
  example();
}
