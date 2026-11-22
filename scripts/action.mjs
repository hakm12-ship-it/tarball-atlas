import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const cli = fileURLToPath(new URL('../bin/atlas.mjs', import.meta.url));

async function scan() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Tarball Atlas requires Node.js 22 or newer.');
  const workspace = await realpath(env.GITHUB_WORKSPACE);
  const directory = env.ATLAS_DIRECTORY || '.';
  if (path.isAbsolute(directory) || path.win32.isAbsolute(directory)) throw new Error('working-directory must be workspace-relative.');
  const root = await realpath(path.resolve(workspace, directory));
  const relative = path.relative(workspace, root);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    throw new Error('working-directory must be inside the checkout.');
  }

  const args = [cli, 'scan', root];
  for (const [flag, text] of [['--require', env.ATLAS_REQUIRED], ['--forbid', env.ATLAS_FORBIDDEN]]) {
    for (const line of (text || '').split(/\r?\n/)) {
      const value = line.trim();
      if (value) args.push(flag, value);
    }
  }
  const limit = (env.ATLAS_MAX_UNPACKED || '').trim();
  if (limit) args.push('--max-unpacked', limit);

  const childEnv = { ...env, npm_config_logs_max: '0' };
  if (env.RUNNER_TEMP) childEnv.npm_config_cache = path.join(env.RUNNER_TEMP, 'tarball-atlas-npm-cache');
  const result = spawnSync(process.execPath, args, {
    cwd: workspace, env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 2,
    report: result.stdout.trim(),
    reasons: result.stderr.trim() || (result.signal ? 'Scan stopped by ' + result.signal : ''),
  };
}

function html(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const result = await scan().catch(error => ({ code: 2, report: '', reasons: error.message }));
// Package names, paths and npm diagnostics can contain runner command syntax.
const token = randomUUID();
console.log('::stop-commands::' + token);
console.log([result.report, result.reasons].filter(Boolean).join('\n'));
console.log('::' + token + '::');

if (env.GITHUB_STEP_SUMMARY) {
  const heading = result.code === 0 ? 'Passed' : result.code === 1 ? 'Gate failed' : 'Scan error';
  const output = [result.reasons, result.report].filter(Boolean).join('\n\n');
  const preview = output.length > 20_000 ? output.slice(0, 20_000) + '\n… See the step log for more.' : output;
  await appendFile(env.GITHUB_STEP_SUMMARY, '### Tarball Atlas · ' + heading + '\n\n<pre>' + html(preview) + '</pre>\n');
}
process.exitCode = result.code;
