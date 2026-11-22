import { build } from 'esbuild';
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const docs = join(root, 'docs');
const site = join(root, 'dist/site');
const offline = join(root, 'offline');
await Promise.all([
  mkdir(site, { recursive: true }),
  mkdir(offline, { recursive: true }),
]);
await cp(docs, site, { recursive: true });

const read = (file) => readFile(join(docs, file), 'utf8');
const css = await read('style.css');
const fontData = {};
for (const font of ['sans', 'mono']) {
  fontData[font] =
    'data:font/woff2;base64,' +
    (await readFile(join(docs, 'fonts/' + font + '.woff2'))).toString('base64');
}
const inlineCSS = css
  .replaceAll('./fonts/sans.woff2', fontData.sans)
  .replaceAll('./fonts/mono.woff2', fontData.mono);
const result = await build({
  entryPoints: [join(docs, 'app.mjs')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  platform: 'browser',
  write: false,
  legalComments: 'inline',
  supported: { 'inline-script': false },
});
const bundle = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const demo = JSON.stringify(
  await Promise.all(
    ['before', 'after'].map(async (part) =>
      JSON.parse(await read('examples/' + part + '.json')),
    ),
  ),
).replace(/</g, '\\u003c');
const icon =
  'data:image/svg+xml;base64,' +
  (await readFile(join(docs, 'icon.svg'))).toString('base64');
const license = await Promise.all(
  ['DM-Sans-LICENSE', 'IBM-Plex-Mono-LICENSE'].map((name) =>
    read('fonts/' + name + '.txt'),
  ),
);
// Keep the captured viewer template complete when it runs from a downloaded file.
const html = (await read('index.html'))
  .replace(
    '<meta charset="utf-8">',
    '<meta charset="utf-8">\n<meta name="atlas-offline" content="true"><meta name="robots" content="noindex">',
  )
  .replaceAll('./icon.svg', icon)
  .replace(
    '<link rel="stylesheet" href="./style.css">',
    () => '<style>' + inlineCSS + '</style>',
  )
  .replace(
    '<script type="module" src="./app.mjs"></script>',
    () =>
      '<script>globalThis.ATLAS_EXAMPLE=' +
      demo +
      ';</script>\n<script>' +
      bundle +
      '</script>',
  )
  .replace(
    '</head>',
    () =>
      '<script type="text/plain" id="font-licenses">' +
      license.join('\n\n') +
      '</script>\n</head>',
  );
await Promise.all([
  writeFile(join(site, 'atlas.html'), html),
  writeFile(join(offline, 'atlas.html'), html),
]);
console.log(
  'Built the website and offline viewer (' +
    Buffer.byteLength(html).toLocaleString('en-US') +
    ' bytes).',
);
