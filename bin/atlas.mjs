#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compare, normalizeManifest } from '../docs/lib/model.mjs';
import { readInput } from './input.mjs';

const help = `Tarball Atlas — see what ships in an npm package

Usage
  tarball-atlas scan [dir] [--json] [--require path] [--forbid glob] [--max-unpacked bytes]
  tarball-atlas diff before after [--json] [--html report.html]

scan reads npm's local dry run with package scripts disabled. Run your build
before scanning if it generates release files. --json writes a snapshot.
Repeat --require for exact paths and --forbid for root-relative patterns.
* and ? match within a path segment. ** matches zero or more segments.
Quote glob patterns so your shell passes them through unchanged.

Projects with a prepare hook require npm 11+ to scan with scripts disabled.
diff accepts JSON snapshots, npm pack JSON, local .tgz files, and npm:name@version.
Example: tarball-atlas diff npm:preact@10.24.1 ./preact-10.24.2.tgz --html report.html
--html writes a self-contained interactive report to a new file.
Exit codes: 0 success, 1 release gate failed, 2 input or tool error.`;

function terminalText(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char =>
    '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function parseArgs(args) {
  const [command, ...tokens] = args;
  if (command !== 'scan' && command !== 'diff') throw new Error('Expected scan or diff. Use --help for examples.');
  const options = { command, positional: [], json: false, required: [], forbidden: [], maxBytes: null, html: null };
  let positionalOnly = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (positionalOnly || !token.startsWith('-')) {
      options.positional.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (command === 'diff' && token === '--html') {
      const filename = tokens[++i];
      if (options.html || !filename || filename.startsWith('--')) throw new Error('--html expects one output filename.');
      options.html = filename;
      continue;
    }
    if (command !== 'scan' || !['--require', '--forbid', '--max-unpacked'].includes(token)) {
      throw new Error('Unknown option ' + token);
    }
    const value = tokens[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + token);
    if (token === '--max-unpacked') {
      if (options.maxBytes !== null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--max-unpacked expects one non-negative integer in bytes.');
      }
      options.maxBytes = Number(value);
    } else {
      if (value.includes('\\') || /^[A-Za-z]:/.test(value) ||
          value.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error(token + ' expects a package-relative path using forward slashes.');
      }
      (token === '--require' ? options.required : options.forbidden).push(value);
    }
  }
  if (command === 'scan' && options.positional.length > 1) throw new Error('scan expects at most one package directory.');
  if (command === 'diff' && options.positional.length !== 2) throw new Error('diff expects two package inputs.');
  return options;
}

// Launch npm directly where possible so Node can deny child process creation.
// This also avoids cmd.exe parsing package paths on Windows.
function npmCommand() {
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  const candidates = [];
  const currentNpm = process.env.npm_execpath;
  if (currentNpm && path.isAbsolute(currentNpm) && path.basename(currentNpm) === 'npm-cli.js') candidates.push(currentNpm);
  for (const dir of dirs.filter(dir => path.isAbsolute(dir))) {
    if (process.platform === 'win32') {
      candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    } else {
      const executable = path.join(dir, 'npm');
      if (!existsSync(executable)) continue;
      const resolved = realpathSync(executable);
      if (path.basename(resolved) === 'npm-cli.js') candidates.push(resolved);
    }
  }
  const cli = candidates.find(file => existsSync(file));
  if (!cli) {
    if (process.platform !== 'win32') return ['npm'];
    throw new Error('Could not locate npm-cli.js. Install npm alongside Node and ensure npm is on PATH.');
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  const stable = major >= 24 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
  const permission = stable ? '--permission' : '--experimental-permission';
  return [process.execPath, permission, '--allow-fs-read=*', '--allow-fs-write=*', cli];
}

function run(argv, cwd, env = process.env) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...env, NO_UPDATE_NOTIFIER: '1' },
  });
}

async function sourceHash(root, entry) {
  const filename = path.resolve(root, entry.path);
  const relative = path.relative(root, filename);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.size !== entry.size || (await realpath(filename)) !== filename) return;
    const handle = await open(filename, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== entry.size) return;
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await handle.stat();
      if (after.size === before.size && after.mtimeMs === before.mtimeMs) return hash.digest('hex');
    } finally {
      await handle.close();
    }
  } catch {
    // Files may have been transformed, moved, or become unreadable since pack.
    // An absent digest keeps same-size comparisons explicitly unverified.
  }
}

async function scan(directory) {
  const root = await realpath(directory);
  if (!(await lstat(path.join(root, 'package.json'))).isFile()) throw new Error('Expected a package.json file in ' + root);
  const sourceManifest = JSON.parse((await readFile(path.join(root, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const npm = npmCommand();
  const npmEnvironment = { ...process.env, NODE_OPTIONS: '' };
  if (sourceManifest.scripts?.prepare || npm.length === 1) {
    // npm 10's pacote runs prepare even with --ignore-scripts and --dry-run.
    // Check before pack, since detecting mixed stdout would be too late.
    const version = run([...npm, '--version'], root, npmEnvironment);
    const match = /^(\d+)\.\d+\.\d+$/.exec(version.stdout?.trim());
    if (version.status !== 0 || !match || Number(match[1]) < 11) {
      if (sourceManifest.scripts?.prepare) {
        throw new Error('Scanning a package with a prepare script requires npm 11 or newer. Older npm versions may execute prepare even during a dry run.');
      }
      throw new Error('This npm launcher requires npm 11 or newer. Install npm alongside Node to use older versions.');
    }
  }
  const packed = run([...npm, 'pack', '.', '--dry-run', '--json', '--ignore-scripts', '--workspaces=false', '--offline'], root, npmEnvironment);
  if (packed.error) throw new Error('Could not run npm pack: ' + packed.error.message);
  if (packed.status !== 0) {
    const message = packed.stderr.trim() || packed.stdout.trim() || 'exit ' + packed.status;
    throw new Error('npm pack failed: ' + message.slice(0, 2000));
  }
  const manifest = normalizeManifest(JSON.parse(packed.stdout));
  // npm 12+ may reserialize package.json when stripping patchedDependencies.
  // Even an equal byte length would not prove that its on-disk digest applies.
  for (const entry of manifest.files) {
    if (entry.path === 'package.json' && Object.hasOwn(sourceManifest, 'patchedDependencies')) continue;
    const digest = await sourceHash(root, entry);
    if (digest) entry.hash = digest;
  }
  const git = run(['git', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--', '.'], root);
  const tracked = git.status === 0 ? [...new Set(git.stdout.split('\0').filter(Boolean))].sort() : null;
  return normalizeManifest({
    schema: 1, name: manifest.name, version: manifest.version, packedSize: manifest.packedSize,
    files: manifest.files, tracked,
  });
}

function segmentMatcher(pattern) {
  // Only '*' and '?' are special inside a segment. Escape all regexp syntax.
  const source = [...pattern].map(char => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return /[\\^$.*+?()[\]{}|]/.test(char) ? '\\' + char : char;
  }).join('');
  return new RegExp('^' + source + '$', 'su');
}

function pathMatcher(pattern) {
  const parts = pattern.split('/').map(part => part === '**' ? null : segmentMatcher(part));
  return filename => {
    const names = filename.split('/');
    // Each position is the number of path segments consumed. A globstar can
    // consume any suffix from the earliest reachable position, including zero.
    let positions = [0];
    for (const part of parts) {
      if (!positions.length) return false;
      if (part === null) {
        const start = positions[0];
        positions = Array.from({ length: names.length - start + 1 }, (_, offset) => start + offset);
      } else {
        positions = positions.filter(i => i < names.length && part.test(names[i])).map(i => i + 1);
      }
    }
    return positions.includes(names.length);
  };
}

function checkGates(manifest, options, bytes) {
  const paths = new Set(manifest.files.map(entry => entry.path));
  const failures = [];
  for (const required of new Set(options.required)) {
    if (!paths.has(required)) failures.push('Missing required file ' + required);
  }
  for (const pattern of new Set(options.forbidden)) {
    const matches = [...paths].filter(pathMatcher(pattern));
    if (matches.length) {
      failures.push('Forbidden pattern ' + pattern + ' matched ' + matches.slice(0, 8).join(', ') +
        (matches.length > 8 ? ' and ' + (matches.length - 8) + ' more' : ''));
    }
  }
  if (options.maxBytes !== null && bytes > options.maxBytes) {
    failures.push('Unpacked size ' + bytes + ' bytes exceeds limit ' + options.maxBytes);
  }
  return failures;
}

function scanSummary(manifest, bytes) {
  const packed = new Set(manifest.files.map(file => file.path));
  const lines = [manifest.name + '@' + manifest.version,
    packed.size + ' files | ' + bytes + ' unpacked bytes | ' + manifest.packedSize + ' packed bytes'];
  if (manifest.tracked === null) {
    lines.push('Git tracking unavailable');
  } else {
    const tracked = new Set(manifest.tracked);
    const onlyPackage = [...packed].filter(file => !tracked.has(file));
    const onlyGit = [...tracked].filter(file => !packed.has(file));
    for (const [label, files] of [['Packed, untracked', onlyPackage], ['Tracked, omitted', onlyGit]]) {
      lines.push(label + ' (' + files.length + ')');
      lines.push(...files.slice(0, 12).map(file => '  ' + file));
      if (files.length > 12) lines.push('  … ' + (files.length - 12) + ' more');
    }
  }
  return lines;
}

function diffSummary(before, after, result) {
  const { counts } = result;
  const lines = [before.name + '@' + before.version + ' → ' + after.name + '@' + after.version,
    Object.entries(counts).map(([status, count]) => count + ' ' + status).join(' | ')];
  for (const row of result.rows) {
    if (row.status === 'unchanged') continue;
    const delta = (row.delta > 0 ? '+' : '') + row.delta + ' B';
    lines.push(row.status.padEnd(7) + '  ' + row.path + '  ' + delta);
  }
  if (counts.unknown) lines.push('Unknown means equal size with no comparable content hash.');
  return lines;
}

async function main(args) {
  const helpArgs = ['--help', '-h'];
  if (!args.length || args[0] === 'help' || helpArgs.includes(args[0]) ||
      (args.length === 2 && ['scan', 'diff'].includes(args[0]) && helpArgs.includes(args[1]))) {
    console.log(help);
    return;
  }
  const options = parseArgs(args);
  if (options.command === 'diff') {
    const manifests = [];
    for (const file of options.positional) {
      try {
        manifests.push(await readInput(file));
      } catch (error) {
        throw new Error(file + ': ' + error.message);
      }
    }
    const [before, after] = manifests;
    const result = compare(before, after);
    if (options.html) {
      const { writeReport } = await import('./report.mjs');
      await writeReport(options.html, before, after);
      console.error('Wrote ' + terminalText(options.html));
    }
    console.log(options.json ? JSON.stringify(result, null, 2) : diffSummary(before, after, result).map(terminalText).join('\n'));
    return;
  }
  const manifest = await scan(options.positional[0] ?? '.');
  const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const failures = checkGates(manifest, options, bytes);
  console.log(options.json ? JSON.stringify(manifest, null, 2) : scanSummary(manifest, bytes).map(terminalText).join('\n'));
  for (const failure of failures) console.error('Gate failed: ' + terminalText(failure));
  if (failures.length) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  console.error('Tarball Atlas: ' + terminalText(error.message));
  process.exitCode = 2;
});
