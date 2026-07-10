import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);

test('macOS R2 updater bundles include version and architecture in object names', () => {
  assert.match(releaseWorkflow, /release_version='\$\{\{ needs\.create-release\.outputs\.tag \}\}'/);
  assert.match(releaseWorkflow, /release_version="\$\{release_version#v\}"/);
  assert.match(releaseWorkflow, /renamed="\$\{asset_name%\.app\.tar\.gz\}_\$\{release_version\}_aarch64\.app\.tar\.gz"/);
  assert.match(releaseWorkflow, /renamed="\$\{asset_name%\.app\.tar\.gz\}_\$\{release_version\}_x64\.app\.tar\.gz"/);
  assert.doesNotMatch(releaseWorkflow, /renamed="\$\{asset_name%\.app\.tar\.gz\}_aarch64\.app\.tar\.gz"/);
  assert.doesNotMatch(releaseWorkflow, /renamed="\$\{asset_name%\.app\.tar\.gz\}_x64\.app\.tar\.gz"/);
});
