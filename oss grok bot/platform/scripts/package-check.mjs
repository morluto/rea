import asar from '@electron/asar';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, normalize, join } from 'node:path';
import { version } from '../packages/host/src/version.mjs';
const archive = resolve('.local/releases/win-unpacked/resources/app.asar');
const files = asar.listPackage(archive).map((p) => p.replaceAll('\\', '/'));
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
assert.equal(pkg.name, 'bot-workshop');
assert.equal(pkg.main, 'apps/desktop/main.mjs');
assert.equal(pkg.version, version, 'Packaged version must match current source');
let runtimeFilesChecked = 0;
function compareRuntime(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (['node_modules', '__pycache__', '.local'].includes(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) compareRuntime(path);
    else if (entry.isFile()) {
      assert.ok(
        asar.extractFile(archive, path).equals(readFileSync(path)),
        `Packaged runtime differs from source: ${path}`,
      );
      runtimeFilesChecked++;
    } else assert.fail(`Unsupported runtime entry: ${path}`);
  }
}
for (const folder of [
  'apps/desktop',
  'apps/workspace',
  'packages/host',
  'computer',
  'device',
  'node_modules/@novnc/novnc/core',
  'node_modules/@novnc/novnc/vendor',
])
  compareRuntime(folder);
for (const file of [
  'apps/desktop/main.mjs',
  'apps/desktop/preload.cjs',
  'apps/desktop/artifact-permissions.mjs',
  'apps/workspace/app.js',
  'packages/host/src/server.mjs',
  'packages/host/src/prompts.json',
  'packages/host/src/plugin-catalog.json',
  'packages/host/src/plugins.mjs',
  'packages/host/src/model-signin.mjs',
  'packages/host/src/reminders.mjs',
  'packages/host/src/coding.mjs',
  'packages/host/src/learning.mjs',
  'packages/host/src/personal-vault.mjs',
  'packages/host/src/library-search.mjs',
  'apps/workspace/coding.js',
  'apps/workspace/learning.js',
  'apps/workspace/personal-vault.js',
  'apps/workspace/policies.js',
  'apps/workspace/library-search.js',
  'apps/workspace/model-signin.js',
  'packages/host/src/mcp-oauth.mjs',
  'apps/workspace/plugins.js',
  'apps/workspace/plugin-signin.js',
  'apps/workspace/transcript.js',
  'packages/host/src/computer-image.mjs',
  'computer/Dockerfile',
  'computer/transport.py',
  'node_modules/@earendil-works/pi-coding-agent/package.json',
  'node_modules/marked/package.json',
  'node_modules/@novnc/novnc/core/rfb.js',
])
  assert.ok(files.includes('/' + file), `Missing packaged owner: ${file}`);
for (const file of files) {
  assert.ok(
    !file.split('/').some((p) => ['.local', '.git', 'backups', 'computer-snapshots'].includes(p)),
    `Private/local tree entered package: ${file}`,
  );
  assert.ok(
    !file.endsWith('/vault.key') && !file.endsWith('/product.sqlite'),
    `Runtime bytes entered package: ${file}`,
  );
}
assert.ok(
  asar.extractFile(archive, normalize(pkg.main)).length > 0,
  'Packaged entrypoint is empty',
);
console.log(
  JSON.stringify({
    archive,
    version: pkg.version,
    files: files.length,
    runtimeFilesChecked,
    localStateIncluded: false,
    entrypoint: pkg.main,
  }),
);
