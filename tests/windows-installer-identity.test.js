import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const windowsConfig = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.windows.conf.json', import.meta.url), 'utf8'),
);
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);

test('Windows releases use one NSIS installer identity for install and update', () => {
  assert.deepEqual(windowsConfig.bundle?.targets, ['nsis']);
  assert.match(releaseWorkflow, /bundle\/nsis[^\n]+\*-setup\.exe/);
  assert.doesNotMatch(releaseWorkflow, /bundle\/msi/);
});
