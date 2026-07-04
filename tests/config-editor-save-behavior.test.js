import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const i18nJs = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const serverJs = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const configStoreJs = readFileSync(new URL('../src/lib/config-store.js', import.meta.url), 'utf8');
const tauriConfigRs = readFileSync(new URL('../src-tauri/src/config.rs', import.meta.url), 'utf8');
const tauriCodexRs = readFileSync(new URL('../src-tauri/src/codex.rs', import.meta.url), 'utf8');
const providerEvalRs = readFileSync(new URL('../src-tauri/src/provider_eval.rs', import.meta.url), 'utf8');
const providerRouterRs = readFileSync(new URL('../src-tauri/src/provider_router.rs', import.meta.url), 'utf8');
const providerRemoteUsageRs = readFileSync(new URL('../src-tauri/src/provider_remote_usage.rs', import.meta.url), 'utf8');
const providerRemoteUsageCacheRs = readFileSync(new URL('../src-tauri/src/provider_remote_usage_cache.rs', import.meta.url), 'utf8');
const codexOauthUsageRs = readFileSync(new URL('../src-tauri/src/codex_oauth_usage.rs', import.meta.url), 'utf8');
const tauriRoutesRs = readFileSync(new URL('../src-tauri/src/routes.rs', import.meta.url), 'utf8');
const toolIconPngs = ['openai.png', 'claude-code.png', 'opencode.png', 'openclaw.png']
  .map((name) => readFileSync(new URL(`../public/tool-icons/${name}`, import.meta.url)));

function sliceFunction(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf(`async function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

function sliceAnyFunction(source, name, nextName) {
  const startMatch = new RegExp(`(?:async\\s+)?function\\s+${name}\\(`).exec(source);
  assert.ok(startMatch, `${name} not found`);
  const start = startMatch.index;
  const tail = source.slice(start + startMatch[0].length);
  const endMatch = new RegExp(`(?:async\\s+)?function\\s+${nextName}\\(`).exec(tail);
  assert.ok(endMatch, `${nextName} not found after ${name}`);
  return source.slice(start, start + startMatch[0].length + endMatch.index);
}

test('config editor save/apply path does not launch tools', () => {
  const body = sliceFunction(appJs, 'applyConfigEditor', 'applyRawConfigEditor');
  assert.equal(body.includes('launchClaudeCodeOnly('), false);
  assert.equal(body.includes('launchOpenCodeOnly('), false);
  assert.equal(body.includes('launchOpenClawOnly('), false);
  assert.equal(body.includes('/api/openclaw/launch'), false);
  assert.equal(body.includes('/api/claudecode/launch'), false);
  assert.equal(body.includes('/api/opencode/launch'), false);
});

test('config editor raw saves read the live editor value', () => {
  const saveBody = sliceFunction(appJs, 'saveConfigEditor', 'saveRawConfigEditor');
  const applyBody = sliceFunction(appJs, 'applyConfigEditor', 'applyRawConfigEditor');
  for (const textareaId of ['ccCfgRawJsonTextarea', 'opCfgRawJsonTextarea', 'ocCfgRawJsonTextarea']) {
    assert.match(saveBody, new RegExp(`getRawTextareaValue\\('${textareaId}'\\)`));
    assert.match(applyBody, new RegExp(`getRawTextareaValue\\('${textareaId}'\\)`));
  }
});

test('config editor copy says save, not save-and-launch', () => {
  assert.equal(appJs.includes('保存并启动'), false);
  assert.equal(indexHtml.includes('保存并启动'), false);
  assert.equal(appJs.includes('保存并生效'), false);
  assert.equal(indexHtml.includes('保存并生效'), false);
});

test('tools catalog uses full-width detail mode without visible urls', () => {
  assert.match(indexHtml, /id="toolsContent"/);
  assert.match(indexHtml, /id="toolsDetailPanel"/);
  assert.match(stylesCss, /\.tools-page\.is-detail-mode \.tools-toolbar\s*\{[^}]*display:\s*none/);
  assert.match(stylesCss, /\.tools-content\.is-detail-open\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(stylesCss, /\.tools-page\.is-detail-mode \.tools-grid,[^}]*\.tools-page\.is-detail-mode \.tools-pagination\s*\{[^}]*display:\s*none/);
  assert.match(stylesCss, /\.tools-detail-panel\.is-open\s*\{[^}]*position:\s*static/);
  assert.match(stylesCss, /\.tools-detail-panel\.is-open\s*\{[^}]*border-left:\s*0/);

  const pageBody = sliceAnyFunction(appJs, 'renderToolsPage', 'runSimpleToolOperation');
  assert.match(pageBody, /classList\.toggle\('is-detail-mode',\s*detailOpen\)/);
  assert.match(pageBody, /grid\.innerHTML\s*=\s*''/);

  const cardBody = sliceAnyFunction(appJs, 'renderToolCatalogCard', 'findToolCatalogItemById');
  assert.match(cardBody, /getToolCatalogStatusText\(item\)/);
  assert.doesNotMatch(cardBody, /item\.version/);

  const detailBody = sliceAnyFunction(appJs, 'renderToolDetailPanel', 'renderToolsDetailPanel');
  assert.match(detailBody, /renderToolDetailMetaChips\(item,\s*info,\s*regionLabels\)/);
  assert.doesNotMatch(detailBody, /registryUrl/);
  assert.doesNotMatch(detailBody, /tarballUrl/);
  assert.doesNotMatch(detailBody, /install\./);
  assert.equal(appJs.includes('renderToolInstallCommands'), false);

  const metaChipBody = sliceAnyFunction(appJs, 'renderToolDetailMetaChips', 'getToolVersionActionLabel');
  assert.match(metaChipBody, /tool-detail-meta-chips/);
  assert.match(metaChipBody, /tool-detail-chip tool-detail-link/);
  assert.doesNotMatch(appJs, /tool-region-chips/);
  assert.doesNotMatch(appJs, /tool-detail-links/);
  assert.match(stylesCss, /\.tool-detail-meta-chips\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.doesNotMatch(stylesCss, /\.tool-region-chips/);
});

test('tools version history expands and installs exact versions', () => {
  assert.match(appJs, /toolsVersionExpandedKey:\s*''/);

  const historyBody = sliceAnyFunction(appJs, 'renderToolVersionHistory', 'renderToolDetailActionButtons');
  assert.match(historyBody, /data-tool-version-toggle/);
  assert.match(historyBody, /data-tool-version-action="install-version"/);
  assert.match(historyBody, /data-tool-version-action="install-version-domestic"/);
  assert.match(historyBody, /getToolVersionActionLabel\(item,\s*version\)/);
  assert.match(historyBody, /getToolVersionNotes\(entry,\s*info\)/);
  assert.match(historyBody, /GitHub Release/);
  assert.match(historyBody, /npm 版本页/);
  assert.match(appJs, /上游未在 npm 元数据或 GitHub Releases 中提供此版本更新日志/);
  assert.match(stylesCss, /\.tool-version-history-toggle\s*\{[^}]*background:\s*transparent\s*!important/);
  assert.match(stylesCss, /\.tool-version-history-toggle\s*\{[^}]*background-image:\s*none\s*!important/);
  assert.match(stylesCss, /\.tool-version-history-copy p\s*\{/);
  assert.match(stylesCss, /\.tool-version-history-link\s*\{[^}]*background:\s*transparent\s*!important/);

  const localExpandBody = sliceAnyFunction(appJs, 'updateToolVersionHistoryExpansion', 'renderToolDetailActionButtons');
  assert.match(localExpandBody, /history\.outerHTML\s*=\s*renderToolVersionHistory\(item,\s*info\)/);
  assert.doesNotMatch(localExpandBody, /renderToolsPage\(/);

  const bindBody = sliceAnyFunction(appJs, 'bindToolsCatalogControls', 'renderToolsPage');
  assert.match(bindBody, /data-tool-version-action/);
  assert.match(bindBody, /data-tool-version-toggle/);
  assert.match(bindBody, /toolsVersionExpandedKey/);
  assert.match(bindBody, /updateToolVersionHistoryExpansion\(toolId,\s*version\)/);
  assert.doesNotMatch(bindBody, /state\.toolsVersionExpandedKey\s*=\s*state\.toolsVersionExpandedKey === key \? '' : key;\s*renderToolsPage\(\)/);

  const versionActionBody = sliceAnyFunction(appJs, 'getToolVersionActionConfig', 'handleToolAction');
  assert.match(versionActionBody, /install-version-domestic/);
  assert.match(versionActionBody, /body:\s*\{\s*version\s*\}/);
  assert.match(versionActionBody, /\/api\/\$\{apiPrefix\}\/\$\{domestic \? 'install-version-domestic' : 'install-version'\}/);

  assert.match(appJs, /if \(config\.body !== undefined\)/);
  assert.match(serverJs, /\/api\/codex\/install-version/);
  assert.match(serverJs, /\/api\/claudecode\/install-version/);
  assert.match(serverJs, /\/api\/opencode\/install-version/);
  assert.match(serverJs, /\/api\/openclaw\/install-version/);
  assert.match(configStoreJs, /function\s+assertSafeNpmPackageVersion/);
  assert.match(configStoreJs, /async function\s+fetchGithubReleaseNotes/);
  assert.match(configStoreJs, /function\s+npmPackageVersionWebUrl/);
  assert.match(configStoreJs, /releaseNotesByVersion/);
  assert.match(configStoreJs, /export async function installCodexVersion/);
  assert.match(configStoreJs, /export async function installClaudeCodeVersion/);
  assert.match(configStoreJs, /export async function installOpenCodeVersion/);
  assert.match(configStoreJs, /export async function installOpenClawVersion/);
  assert.match(configStoreJs, /function recentNpmVersions\(metadata,\s*packageName = ''/);
  assert.match(tauriCodexRs, /fn\s+fetch_github_release_notes/);
  assert.match(tauriRoutesRs, /fn\s+read_safe_npm_version/);
  assert.match(tauriRoutesRs, /\/api\/codex\/install-version/);
  assert.match(tauriRoutesRs, /\/api\/claudecode\/install-version/);
  assert.match(tauriRoutesRs, /\/api\/opencode\/install-version/);
  assert.match(tauriRoutesRs, /\/api\/openclaw\/install-version/);
});

test('tools update strip has auto check toggle and manual refresh', () => {
  assert.match(appJs, /toolUpdatesAutoCheck:\s*true/);
  assert.match(appJs, /TOOLS_UPDATE_AUTO_CHECK_KEY\s*=\s*'easyaiconfig_tools_auto_update_check'/);
  assert.match(appJs, /TOOLS_UPDATE_CACHE_KEY\s*=\s*'easyaiconfig_tools_updates_cache_v2'/);
  assert.match(appJs, /function\s+setToolUpdatesAutoCheck\(/);

  const loadBody = sliceAnyFunction(appJs, 'loadToolUpdates', 'stopToolUpdatesTimer');
  assert.match(loadBody, /!force && !state\.toolUpdatesAutoCheck/);
  assert.match(loadBody, /readCachedToolUpdates\(\)/);

  const timerBody = sliceAnyFunction(appJs, 'startToolUpdatesTimer', 'getCatalogUpdateState');
  assert.match(timerBody, /!state\.toolUpdatesAutoCheck/);
  assert.match(timerBody, /stopToolUpdatesTimer\(\)/);

  const stripBody = sliceAnyFunction(appJs, 'renderToolsUpdateStrip', 'bindToolsCatalogControls');
  assert.match(stripBody, /toolsUpdateAutoCheckToggle/);
  assert.match(stripBody, /setToolUpdatesAutoCheck\(toggle\.checked\)/);
  assert.match(stripBody, /toolsUpdateRefreshBtn/);
  assert.match(stripBody, /force:\s*true/);

  assert.match(stylesCss, /\.tools-update-toggle/);
  assert.match(stylesCss, /\.tools-update-switch/);
});

test('tool update detection chooses the highest returned source version', () => {
  const nodeBody = sliceAnyFunction(configStoreJs, 'fetchNpmPackageInfo', 'getToolUpdatesInfo');
  assert.match(configStoreJs, /function\s+pickBestNpmMetadataResult/);
  assert.match(nodeBody, /Promise\.all\(checks\)/);
  assert.doesNotMatch(nodeBody, /Promise\.any/);
  assert.match(nodeBody, /pickBestNpmMetadataResult\(results\)/);

  const frontendBody = sliceAnyFunction(appJs, 'getCatalogUpdateState', 'getOpenCodeDesktopCatalogItem');
  assert.match(frontendBody, /compareToolVersions\(normalizedCurrent,\s*normalizedLatest\)\s*>\s*0/);
  assert.match(frontendBody, /sourceLatestVersion/);

  assert.match(tauriCodexRs, /fn\s+npm_metadata_latest_version/);
  assert.match(tauriCodexRs, /fn\s+npm_source_rank/);
  assert.match(tauriCodexRs, /successes\.sort_by/);
});

test('tools catalog includes Codex App desktop download and update card', () => {
  const codexAppBody = sliceAnyFunction(appJs, 'getCodexAppCatalogItem', 'getOpenCodeDesktopCatalogItem');
  assert.match(codexAppBody, /id:\s*'codex-app'/);
  assert.match(codexAppBody, /typeLabel:\s*'桌面端'/);
  assert.match(codexAppBody, /aliases:\s*\[[^\]]*'Codex CLI'/);
  assert.match(codexAppBody, /const installLabel = '安装'/);
  assert.match(codexAppBody, /const updateLabel = '更新'/);
  assert.match(codexAppBody, /action:\s*'update'/);
  assert.doesNotMatch(codexAppBody, /更新安装|打开商店更新|重新安装/);

  const filterBody = sliceAnyFunction(appJs, 'filterToolCatalogItems', 'compareToolCatalogSidebarItems');
  assert.match(filterBody, /\.\.\.\(item\.aliases \|\| \[\]\)/);

  const actionBody = sliceAnyFunction(appJs, 'renderToolCardActions', 'getToolCatalogStatusText');
  assert.match(actionBody, /tool-action-primary/);
  assert.doesNotMatch(actionBody, /自动重装/);

  assert.match(serverJs, /function\s+getCodexAppVersion/);
  assert.match(serverJs, /currentVersion:\s*version/);
  assert.match(tauriCodexRs, /fn\s+read_codex_app_version/);
  assert.match(tauriCodexRs, /"currentVersion": version/);
});

test('tool install and update actions expose card-level progress', () => {
  assert.match(appJs, /toolOperations:\s*\{\}/);
  assert.match(appJs, /function\s+setToolOperation\(/);
  assert.match(appJs, /function\s+renderToolOperationProgress\(/);

  const activeBody = sliceAnyFunction(appJs, 'isToolOperationActive', 'getToolOperation');
  assert.match(activeBody, /if\s*\(!operation\s*\|\|\s*!operation\.status\)\s*return false/);

  const cardBody = sliceAnyFunction(appJs, 'renderToolCatalogCard', 'findToolCatalogItemById');
  assert.match(cardBody, /renderToolOperationProgress\(item\)/);

  const detailBody = sliceAnyFunction(appJs, 'renderToolDetailPanel', 'renderToolsDetailPanel');
  assert.match(detailBody, /renderToolOperationProgress\(item,\s*\{\s*detail:\s*true\s*\}\)/);

  const simpleActionBody = sliceAnyFunction(appJs, 'runSimpleToolOperation', 'handleToolAction');
  assert.match(simpleActionBody, /startToolOperationTicker\(toolId,\s*82\)/);
  assert.match(simpleActionBody, /setToolOperation\(toolId/);

  assert.match(stylesCss, /\.tool-operation/);
  assert.match(stylesCss, /\.tool-operation-bar/);
  assert.match(stylesCss, /\.tool-operation-success/);
});

test('tools catalog uses PNG logos and scrollable secondary lists', () => {
  const sidebarBody = sliceAnyFunction(appJs, 'renderToolsSecondaryPanel', 'renderToolCardActions');
  assert.doesNotMatch(sidebarBody, /slice\(0,/);
  assert.match(sidebarBody, /installedItems\.map/);
  assert.match(sidebarBody, /pendingItems\.map/);

  const iconBody = sliceAnyFunction(appJs, 'toolIconSvg', 'updateToolSelector');
  assert.match(iconBody, /\/tool-icons\/openai\.png/);
  assert.match(iconBody, /\/tool-icons\/claude-code\.png/);
  assert.match(iconBody, /\/tool-icons\/opencode\.png/);
  assert.match(iconBody, /\/tool-icons\/openclaw\.png/);
  assert.match(iconBody, /<img class="tool-official-icon"/);
  assert.doesNotMatch(iconBody, /<svg/);
  for (const png of toolIconPngs) assert.ok(png.length > 1000);

  assert.match(stylesCss, /\.sec-group\[data-sec-for="tools"\]\s*\{[^}]*display:\s*flex/);
  assert.match(stylesCss, /#toolsInstalledList,\s*#toolsPendingList\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(stylesCss, /\.tool-official-icon\s*\{[^}]*object-fit:\s*contain/);
});

test('Codex App install supports realtime task progress in node and tauri backends', () => {
  const codexTrackedBody = sliceAnyFunction(appJs, 'runTrackedCodexAppTask', 'runOpenCodeToolAction');
  assert.match(codexTrackedBody, /\/api\/codex-app\/install\/start/);
  assert.match(codexTrackedBody, /fetchCodexAppInstallTask/);

  const codexActionBody = sliceAnyFunction(appJs, 'runCodexAppInstallAction', 'runOpenCodeDesktopInstallAction');
  assert.match(codexActionBody, /syncToolOperationFromTask\('codex-app'/);
  assert.match(codexActionBody, /isUnsupportedCodexAppTaskApi/);

  assert.match(serverJs, /CODEX_APP_TASKS/);
  assert.match(serverJs, /function\s+createCodexAppTask/);
  assert.match(serverJs, /downloadCodexAppInstaller/);
  assert.match(serverJs, /installCodexAppOnMac/);
  assert.match(serverJs, /\/api\/codex-app\/install\/start/);
  assert.match(serverJs, /\/api\/codex-app\/install\/status/);
  assert.match(serverJs, /\/api\/codex-app\/install\/cancel/);

  assert.match(tauriCodexRs, /struct\s+CodexAppInstallTask/);
  assert.match(tauriCodexRs, /fn\s+spawn_codex_app_install_task_runner/);
  assert.match(tauriCodexRs, /pub\(crate\)\s+fn\s+start_codex_app_install_task/);
  assert.match(tauriRoutesRs, /\/api\/codex-app\/install\/start/);
  assert.match(tauriRoutesRs, /\/api\/codex-app\/install\/status/);
  assert.match(tauriRoutesRs, /\/api\/codex-app\/install\/cancel/);
});

test('tool update endpoints include domestic mirror routes', () => {
  assert.match(serverJs, /\/api\/tools\/updates/);
  assert.match(serverJs, /\/api\/codex\/update-domestic/);
  assert.match(serverJs, /\/api\/claudecode\/update-domestic/);
  assert.match(serverJs, /\/api\/openclaw\/update-domestic/);
  assert.match(tauriRoutesRs, /\/api\/tools\/updates/);
  assert.match(tauriRoutesRs, /\/api\/codex\/update-domestic/);
  assert.match(tauriRoutesRs, /\/api\/claudecode\/update-domestic/);
  assert.match(tauriRoutesRs, /\/api\/openclaw\/update-domestic/);
});

test('provider detail tab clicks bypass stale render cache', () => {
  const clickBody = sliceAnyFunction(appJs, 'handleProviderDetailClick', 'ensureProviderDetailEvents');
  assert.match(clickBody, /switchProviderDetailTab\(tabBtn\.dataset\.pdTab\)/);

  const switchBody = sliceAnyFunction(appJs, 'switchProviderDetailTab', 'handleProviderDetailChange');
  assert.match(switchBody, /normalizeProviderDetailTab\(tab\)/);
  assert.match(switchBody, /pdLastRenderSig\s*=\s*''/);
  assert.match(switchBody, /renderProviderDetail\(\{\s*force:\s*true\s*\}\)/);

  const captureBody = sliceAnyFunction(appJs, 'handleProviderDetailTabPointerCapture', 'handleProviderDetailChange');
  assert.match(captureBody, /getProviderDetailTabButtonAtPoint/);

  const eventsBody = sliceAnyFunction(appJs, 'ensureProviderDetailEvents', 'lookupProviderDetailRow');
  assert.match(eventsBody, /document\.addEventListener\('pointerdown', handleProviderDetailTabPointerCapture, true\)/);
});

test('provider detail events rebind when the detail DOM node is replaced', () => {
  const body = sliceAnyFunction(appJs, 'ensureProviderDetailEvents', 'lookupProviderDetailRow');
  assert.equal(body.includes('pdEventsBound'), false);
  assert.match(appJs, /let\s+pdEventsContainer\s*=\s*null/);
  assert.match(body, /if\s*\(container === pdEventsContainer\) return/);
  assert.match(body, /container\.addEventListener\('click', handleProviderDetailClick\)/);
});

test('provider detail binding tab content cannot cover the tab navigation', () => {
  assert.match(stylesCss, /\.shell-v2 \.ch-detail\s*\{[^}]*isolation:\s*isolate/);
  assert.match(stylesCss, /\.shell-v2 \.pd-tabs\s*\{[^}]*z-index:\s*30/);
  assert.match(stylesCss, /\.shell-v2 \.pd-tab-content\s*\{[^}]*z-index:\s*1[^}]*overflow:\s*visible/);
  assert.match(stylesCss, /\.shell-v2 \.pd-tab-binding \.pd-info-row\.pdb-row\s*\{[^}]*grid-template-columns:\s*80px minmax\(0, 1fr\) auto/);
  assert.match(stylesCss, /\.shell-v2 \.pd-tab-binding \.pdb-del\s*\{[^}]*position:\s*static/);
});

test('provider detail async refreshes ignore stale provider or tab results', () => {
  const bindingBody = sliceAnyFunction(appJs, 'renderPdBinding', 'renderPdModels');
  assert.match(bindingBody, /isCurrentProviderDetail\(providerKey, detailTool, 'binding'\)/);
  assert.match(bindingBody, /PROJECT_BINDINGS_CACHE_MS/);
  assert.match(bindingBody, /_allProjectBindingsFetchedAt\s*=\s*Date\.now\(\)/);
  assert.match(bindingBody, /nextBindingsSig !== previousBindingsSig/);

  const modelsBody = sliceAnyFunction(appJs, 'renderPdModels', 'renderClaudeProviderDetailModels');
  assert.match(modelsBody, /isCurrentProviderDetail\(providerKey, detailTool, 'models'\)/);

  const probeBody = sliceAnyFunction(appJs, 'fetchProviderProbeData', 'pdComputeRenderSig');
  assert.match(probeBody, /if\s*\(!isCurrentProviderDetail\(expectedKey, expectedTool\)\) return/);
});

test('provider detail model support renders grouped single-level model cards', () => {
  const modelsBody = sliceAnyFunction(appJs, 'renderPdModels', 'renderClaudeProviderDetailModels');
  const cardBody = sliceAnyFunction(appJs, 'renderPdModelCard', 'renderPdModels');
  assert.match(modelsBody, /buildProviderModelGroups/);
  assert.match(modelsBody, /pdm-group/);
  assert.match(modelsBody, /pdm-grid/);
  assert.match(modelsBody, /renderPdModelCard/);
  assert.match(modelsBody, /currentIsSaved/);
  assert.match(modelsBody, /data-pd-models-clear/);
  assert.match(cardBody, /pdm-card-actions/);
  assert.match(cardBody, /data-pd-model-add-one/);
  assert.match(cardBody, /data-pd-model-remove/);
  assert.match(cardBody, /data-pd-model-set-default/);
  assert.match(stylesCss, /\.pdm-model-card/);
  assert.match(stylesCss, /\.pdm-groups/);
  assert.match(stylesCss, /\.pdm-card-actions/);
  assert.match(stylesCss, /\.pdm-action-danger/);
});

test('provider detail model support has closed-loop add remove and clear saves', () => {
  const bindBody = sliceAnyFunction(appJs, 'bindPdModelsEvents', 'openPdModelsPicker');
  assert.match(appJs, /function normalizeProviderModelList/);
  assert.match(appJs, /function addProviderModelToList/);
  assert.match(appJs, /function removeProviderModelFromList/);
  assert.match(bindBody, /data-pd-model-remove/);
  assert.match(bindBody, /removeProviderModelFromList/);
  assert.match(bindBody, /data-pd-model-add-one/);
  assert.match(bindBody, /addProviderModelToList/);
  assert.match(bindBody, /data-pd-models-clear/);
  assert.match(bindBody, /\/api\/provider\/saved-models/);
  assert.match(bindBody, /e\.stopPropagation\(\)/);
  assert.match(bindBody, /successMessage/);
});

test('provider detail battery cells expose clickable probe details', () => {
  const batteryBody = sliceAnyFunction(appJs, 'renderPdBatteryBar', 'renderPdSparkline');
  assert.match(batteryBody, /data-pd-probe-index/);
  assert.match(batteryBody, /data-pd-probe-key/);
  assert.match(batteryBody, /pd-bat-tip/);
  assert.match(batteryBody, /renderPdProbeDetail/);

  const clickBody = sliceAnyFunction(appJs, 'handleProviderDetailClick', 'ensureProviderDetailEvents');
  assert.match(clickBody, /target\.closest\('\[data-pd-probe-index\]'\)/);
  assert.match(clickBody, /selectedProbeKey/);
});

test('provider detail model eval exposes professional profile separately', () => {
  const clickBody = sliceAnyFunction(appJs, 'handleProviderDetailClick', 'ensureProviderDetailEvents');
  assert.match(clickBody, /getAttribute\('data-pd-run-eval'\)/);
  assert.match(clickBody, /actionPdRunEval\(runEvalBtn\.getAttribute\('data-pd-run-eval'\) \|\| 'quick'\)/);

  const renderBody = sliceAnyFunction(appJs, 'renderPdEval', 'renderPdEvalRunning');
  assert.match(renderBody, /data-pd-run-eval="quick"/);
  assert.match(renderBody, /data-pd-run-eval="professional"/);
  assert.match(renderBody, /专业测试/);

  const requestBody = sliceAnyFunction(appJs, 'requestPdModelEvalForRow', 'actionPdRunEval');
  assert.match(requestBody, /options\.profile === 'professional'/);
  assert.match(requestBody, /PD_EVAL_PRO_PROVIDER_TIMEOUT_MS/);
  assert.match(requestBody, /PD_EVAL_PRO_FRONTEND_TIMEOUT_MS/);
  assert.match(requestBody, /profile,/);

  const confirmBody = sliceAnyFunction(appJs, 'confirmPdEvalRun', 'fmtPdEvalProgressDuration');
  assert.match(confirmBody, /openUpdateDialog/);
  assert.match(confirmBody, /确认运行/);
  assert.match(confirmBody, /确认开始/);
  assert.match(appJs, /function getPdEvalRunEstimate/);
  assert.match(appJs, /function getPdEvalReportTitle/);
  assert.match(appJs, /专业评测报告/);
  assert.match(appJs, /快速验真报告/);
  assert.match(appJs, /function renderPdEvalReportTypePanel/);
  assert.match(appJs, /约 1-3 分钟/);
  assert.match(appJs, /约 3-7 分钟/);
  assert.match(appJs, /约 3k-8k token/);
  assert.match(appJs, /约 8k-20k token/);

  const actionBody = sliceAnyFunction(appJs, 'actionPdRunEval', 'pdBatchErrorLooksTimeout');
  assert.match(actionBody, /await confirmPdEvalRun\(evalProfile, row\)/);
  assert.match(actionBody, /if \(!confirmed\)/);

  const runningBody = sliceAnyFunction(appJs, 'renderPdEvalRunning', 'renderPdEvalResult');
  assert.match(runningBody, /getPdEvalProgressInfo/);
  assert.match(runningBody, /role="progressbar"/);
  assert.match(runningBody, /aria-valuenow/);
  assert.match(runningBody, /pd-eval-progress-meta/);
  assert.match(appJs, /function startPdEvalProgressTicker/);
  assert.match(appJs, /evalStartedAt = Date\.now\(\)/);
  assert.match(stylesCss, /\.pd-eval-confirm/);
  assert.match(stylesCss, /\.pd-eval-report-type/);
  assert.match(stylesCss, /\.pd-eval-progress/);
  assert.match(stylesCss, /\.pd-eval-progress-meta/);

  assert.match(providerEvalRs, /fn is_professional_profile/);
  assert.match(providerEvalRs, /"professional" \| "pro" \| "deep" \| "eval" \| "evals" \| "swe" \| "workbench"/);
  for (const probeId of [
    'prof_swe_patch',
    'prof_repo_diagnosis',
    'prof_context_needle',
    'prof_state_machine',
    'prof_sql_edge_case',
    'prof_instruction_integrity',
    'prof_tool_call_schema',
  ]) {
    assert.match(providerEvalRs, new RegExp(`"${probeId}"`));
  }
});

test('provider detail usage aggregates cost by model with time and model filters', () => {
  const usageBody = sliceAnyFunction(appJs, 'renderPdUsage', 'renderClaudeProviderDetailUsage');
  assert.equal(usageBody.includes('单价拟合'), false);
  assert.match(usageBody, /aggregatePdUsageByModel/);
  assert.match(usageBody, /summarizePdUsageModelCosts/);
  assert.match(usageBody, /renderPdUsageWindowControls/);
  assert.match(usageBody, /renderPdUsageModelFilter/);

  const costTableBody = sliceAnyFunction(appJs, 'renderPdUsageModelCostTable', 'renderPdUsage');
  assert.match(costTableBody, /calcModelCost/);
  assert.match(appJs, /data-pd-usage-window/);
  assert.match(appJs, /data-pd-usage-model/);
  assert.match(stylesCss, /\.pd-model-cost-table/);
});

test('provider detail usage separates local and remote relay statistics', () => {
  const clickBody = sliceAnyFunction(appJs, 'handleProviderDetailClick', 'ensureProviderDetailEvents');
  assert.match(clickBody, /data-pd-usage-view/);
  assert.match(clickBody, /data-pd-sync-remote-usage/);

  const usageBody = sliceAnyFunction(appJs, 'renderPdUsage', 'renderClaudeProviderDetailUsage');
  assert.match(usageBody, /normalizePdUsageView/);
  assert.match(usageBody, /renderPdRemoteUsage/);
  assert.match(usageBody, /renderPdUsageSourceTabs\('local'/);
  assert.match(appJs, /本地统计/);
  assert.match(appJs, /远程中转统计/);
  assert.match(appJs, /\/api\/provider\/remote-usage/);
  assert.match(appJs, /remoteUsageResult/);
  assert.match(appJs, /data-pd-save-remote-credential/);
  assert.match(appJs, /data-pd-test-remote-credential/);
  assert.match(appJs, /data-pd-open-remote-panel/);
  assert.match(appJs, /function loadProviderRemoteUsageCache/);
  assert.match(appJs, /function setProviderRemoteUsageCache/);
  assert.match(appJs, /function getRemotePanelRechargePath/);
  assert.match(appJs, /\/console\/topup/);
  assert.match(appJs, /\/purchase/);
  assert.match(appJs, /\/api\/provider\/remote-usage\/cache/);
  assert.equal(/PROVIDER_REMOTE_USAGE_CACHE_LS_KEY/.test(appJs), false);
  assert.equal(/readProviderRemoteUsageCache/.test(appJs), false);
  assert.match(appJs, /syncPdRemoteCredentialAuthFields/);
  assert.match(appJs, /data-pd-remote-auth-field/);
  assert.match(appJs, /pd-remote-auth-select-wrap/);
  assert.match(appJs, /window\.initCustomSelect/);
  assert.match(appJs, /remoteCredentialDraft:\s*\{\}/);
  assert.match(appJs, /function updatePdRemoteCredentialDraftFromForm/);
  assert.match(appJs, /container\.addEventListener\('input', handleProviderDetailInput\)/);
  assert.match(appJs, /remoteCredentialDraftAuthMode/);
  assert.match(appJs, /\{ id: 'panel',\s+label: '面板认证' \}/);
  assert.match(appJs, /function renderPdPanelAuth/);
  assert.match(appJs, /data-pd-tab="panel"/);
  assert.match(appJs, /\/api\/provider\/remote-usage\/credential/);
  assert.match(appJs, /function renderPdOauthUsage/);
  assert.match(appJs, /\/api\/codex\/oauth\/usage/);
  assert.equal(/Codex OAuth 官方用量暂不启用/.test(appJs), false);
  assert.match(stylesCss, /\.pd-usage-source-tabs/);
  assert.match(stylesCss, /\.pd-remote-head/);
  assert.match(stylesCss, /\.pd-remote-credential/);
  assert.match(stylesCss, /\.pd-remote-field \.custom-select-trigger/);
  assert.match(stylesCss, /\.pd-remote-config-note/);

  assert.match(tauriRoutesRs, /"\/api\/provider\/remote-usage", "POST"/);
  assert.match(tauriRoutesRs, /"\/api\/provider\/remote-usage\/cache", "GET"/);
  assert.match(tauriRoutesRs, /"\/api\/provider\/remote-usage\/cache", "POST"/);
  assert.match(tauriRoutesRs, /"\/api\/provider\/remote-usage\/credential", "GET"/);
  assert.match(tauriRoutesRs, /"\/api\/provider\/remote-usage\/credential", "POST"/);
  assert.match(tauriRoutesRs, /"\/api\/provider\/remote-usage\/credential", "DELETE"/);
  assert.match(tauriRoutesRs, /"\/api\/codex\/oauth\/usage", "POST"/);
  assert.match(providerRemoteUsageRs, /query_saved_provider_remote_usage/);
  assert.match(providerRemoteUsageRs, /provider-remote-panel-credentials\.json/);
  assert.match(providerRemoteUsageRs, /newapi_panel_login/);
  assert.match(providerRemoteUsageRs, /sub2api_panel_login/);
  assert.match(providerRemoteUsageRs, /New-Api-User/);
  assert.match(providerRemoteUsageRs, /X-User-Id/);
  assert.match(providerRemoteUsageRs, /newapi_user_self/);
  assert.match(providerRemoteUsageRs, /newapi_token_self/);
  assert.match(providerRemoteUsageRs, /\/api\/v1/);
  assert.match(providerRemoteUsageRs, /billing_usage/);
  assert.match(providerRemoteUsageRs, /未找到 API Key 或远程面板认证/);
  assert.match(providerRemoteUsageRs, /looks_like_cloudflare_block/);
  assert.match(providerRemoteUsageRs, /Cloudflare\/bot 拦截/);
  assert.match(providerRemoteUsageCacheRs, /provider_remote_usage_cache/);
  assert.match(providerRemoteUsageCacheRs, /rusqlite/);
  assert.match(providerRemoteUsageCacheRs, /result_json/);
  assert.equal(/password|accessToken|apiKey/.test(providerRemoteUsageCacheRs), false);
  assert.match(codexOauthUsageRs, /query_codex_oauth_usage/);
  assert.match(codexOauthUsageRs, /ChatGPT-Account-Id/i);
  assert.match(codexOauthUsageRs, /\/backend-api\/wham\/usage/);
  assert.match(codexOauthUsageRs, /\/backend-api\/codex\/usage/);
  assert.match(codexOauthUsageRs, /CODEX_DEFAULT_VERSION:\s*&str\s*=\s*"0\.142\.5"/);
  assert.match(codexOauthUsageRs, /CODEX_DEFAULT_USER_AGENT:\s*&str\s*=\s*"codex_cli_rs\/0\.142\.5"/);
  assert.match(codexOauthUsageRs, /openai-beta/);
  assert.match(codexOauthUsageRs, /originator/);
  assert.match(codexOauthUsageRs, /codex_cli_rs/);
  assert.match(codexOauthUsageRs, /id_token/);
  assert.match(codexOauthUsageRs, /refresh_token/);
  assert.match(codexOauthUsageRs, /refresh_codex_oauth_tokens/);
  assert.match(codexOauthUsageRs, /fiveHour/);
  assert.match(codexOauthUsageRs, /weekly/);
  assert.match(codexOauthUsageRs, /review/);
  assert.match(codexOauthUsageRs, /limitWindowSeconds/);
  assert.match(codexOauthUsageRs, /value_to_timestamp_iso/);
  assert.match(codexOauthUsageRs, /membership_expires_at/);
  assert.match(codexOauthUsageRs, /credits/);
  assert.match(codexOauthUsageRs, /spendControl/);
  assert.match(codexOauthUsageRs, /used_percent/);
  assert.match(codexOauthUsageRs, /100\.0 - used_percent/);
  assert.match(codexOauthUsageRs, /CHATGPT_DNS_FALLBACK_IPS/);
  assert.match(codexOauthUsageRs, /resolve_to_addrs\("chatgpt\.com"/);
  assert.match(codexOauthUsageRs, /CODEX_SYSTEM_DNS_PREFLIGHT_MS/);
  assert.match(codexOauthUsageRs, /lookup_host\(\("chatgpt\.com", 443\)\)/);
  assert.match(codexOauthUsageRs, /looks_like_cloudflare_edge/);
  assert.match(codexOauthUsageRs, /31,\s*13,\s*67,\s*33/);
  assert.match(codexOauthUsageRs, /codex_chatgpt_dns_fallback/);
  assert.match(appJs, /if \(value == null \|\| value === ''\) return '—';/);
  assert.match(appJs, /function getOauthPlanMeta/);
  assert.match(appJs, /Pro 5x/);
  assert.match(appJs, /Pro 20x/);
  assert.match(appJs, /function computeOauthFiveHourEstimate/);
  assert.match(appJs, /官方 usedPercent/);
  assert.match(appJs, /本地统计 \+ 官方 usedPercent/);
  assert.match(appJs, /renderOauthMembershipMini/);
  assert.match(appJs, /formatOauthFutureTime/);
  assert.match(appJs, /confirmOauthIpRiskBeforeRequest\('查询 Codex 官方额度'/);
  assert.match(appJs, /systemTimeoutMs:\s*1800/);
  assert.match(appJs, /fallbackTimeoutMs:\s*8000/);
  assert.match(stylesCss, /\[data-plan="pro5x"\]/);
  assert.match(stylesCss, /\[data-plan="pro20x"\]/);
  assert.match(stylesCss, /\.pd-oauth-estimate-grid/);

  const saveBody = sliceAnyFunction(appJs, 'actionPdSaveRemoteCredential', 'actionPdDeleteRemoteCredential');
  const testBody = sliceAnyFunction(appJs, 'actionPdTestRemoteCredential', 'actionPdOpenRemotePanel');
  const openPanelBody = sliceAnyFunction(appJs, 'actionPdOpenRemotePanel', 'actionPdSyncRemoteUsage');
  const panelRootBody = sliceAnyFunction(appJs, 'getRemotePanelRootFromBase', 'joinRemotePanelPath');
  assert.match(appJs, /function validatePdRemoteCredentialPayload/);
  assert.match(saveBody, /validatePdRemoteCredentialPayload\(formPayload\)/);
  assert.match(saveBody, /const formPayload = payload \|\| readPdRemoteCredentialForm\(row\)/);
  assert.match(saveBody, /body: JSON\.stringify\(formPayload\)/);
  assert.match(saveBody, /remoteCredentialDraft = \{\}/);
  assert.match(testBody, /const payload = readPdRemoteCredentialForm\(row\)/);
  assert.match(testBody, /actionPdSaveRemoteCredential\(\{ silent: true, payload \}\)/);
  assert.match(openPanelBody, /joinRemotePanelPath\(root, '\/profile'\)/);
  assert.match(panelRootBody, /\/api\/v1/);
  assert.match(panelRootBody, /\/openai\/v1/);
  assert.equal(/\/console\/setting/.test(openPanelBody), false);
});

test('provider outer list hides home paths while detail keeps them', () => {
  const heroBody = sliceAnyFunction(appJs, 'renderHeroHTML', 'rowHTML');
  const rowBody = sliceAnyFunction(appJs, 'rowHTML', 'renderListHTML');
  const detailHeaderBody = sliceAnyFunction(appJs, 'renderPdHeader', 'renderPdTab');
  const overviewBody = sliceAnyFunction(appJs, 'renderPdOverview', 'renderClaudeProviderDetailOverview');

  assert.equal(/ch-hero-url mono/.test(heroBody), false);
  assert.equal(/active\.homeLabel/.test(heroBody), false);
  assert.equal(/homeMeta/.test(rowBody), false);
  assert.equal(/homeLabel \|\| 'HOME'/.test(rowBody), false);
  assert.match(detailHeaderBody, /row\.homePath/);
  assert.match(overviewBody, /CODEX_HOME/);
});

test('provider rows have per-row balance and OAuth allowance visibility', () => {
  const rowBody = sliceAnyFunction(appJs, 'rowHTML', 'renderListHTML');
  const clickBody = sliceAnyFunction(appJs, 'wire', 'initialLoad');

  assert.match(appJs, /easyaiconfig_provider_balance_visibility_v2/);
  assert.match(appJs, /providerBalanceBatchLoading/);
  assert.match(appJs, /providerRemoteCredentialByKey/);
  assert.match(appJs, /providerRemoteUsageByKey/);
  assert.match(appJs, /function chRowHasRemotePanelCredential/);
  assert.match(appJs, /function renderChRowBalance/);
  assert.match(appJs, /function queryChRowRemoteUsage/);
  assert.match(appJs, /function refreshChAllBalances/);
  assert.match(appJs, /silentBalance/);
  assert.match(appJs, /AUTODETECT_BALANCE_MIN_MS/);
  assert.match(appJs, /runAutodetectTick/);
  assert.match(appJs, /function getChOauthAllowanceMeta/);
  assert.match(appJs, /\/api\/codex\/oauth\/usage/);
  assert.match(appJs, /value !== false/);
  assert.match(appJs, /labelKind: '额度'/);
  assert.match(appJs, /function renderChBalanceDisplay/);
  assert.match(appJs, /function renderChRowActionMenu/);
  assert.match(appJs, /function openChRowRecharge/);
  assert.match(appJs, /function buildChRowRechargeUrl/);
  assert.match(rowBody, /data-ch-row-recharge/);
  assert.match(appJs, /function getChRowBalanceToggleLabel/);
  assert.match(appJs, /pct == null \? '--%'/);
  assert.match(indexHtml, /chBalanceRefreshBtn/);
  assert.match(indexHtml, /刷新额度\/余额/);
  assert.match(rowBody, /renderChRowBalance/);
  assert.match(rowBody, /renderChRowActionMenu/);
  assert.match(rowBody, /getChRowBalanceToggleLabel/);
  assert.match(rowBody, /<span class="ch-row-status" title=/);
  assert.equal(/ch-row-status">\$\{balanceChip\}\$\{statusTxt/.test(rowBody), false);
  assert.equal(/ch-row-current-tag/.test(rowBody), false);
  assert.equal(/ch-row-icon-btn/.test(rowBody), false);
  assert.match(clickBody, /chBalanceRefreshBtn/);
  assert.match(clickBody, /data-ch-row-menu-trigger/);
  assert.match(clickBody, /data-ch-row-balance-toggle/);
  assert.match(clickBody, /data-ch-row-balance-query/);
  assert.match(clickBody, /data-ch-row-recharge/);
  assert.match(clickBody, /openChRowRecharge\(row\)/);
  assert.match(clickBody, /chRowHasRemotePanelCredential\(row\)/);
  assert.equal(/ch-row-uptime/.test(rowBody), false);
  assert.equal(/已通 ·/.test(rowBody), false);
  assert.equal(/\.ch-row-uptime/.test(stylesCss), false);
  assert.match(stylesCss, /\.ch-row-balance/);
  assert.match(stylesCss, /\.ch-balance-meter/);
  assert.match(stylesCss, /grid-template-columns:\s*10px minmax\(0, 1fr\) 190px 32px/);
  assert.match(stylesCss, /width:\s*178px/);
  assert.match(stylesCss, /\.ch-row-menu-trigger/);
  assert.match(stylesCss, /\.ch-row-menu-panel/);
  assert.match(stylesCss, /\.ch-row-menu-trigger svg/);
  assert.match(stylesCss, /width:\s*20px/);
});

test('provider router is a standalone local API-key gateway page', () => {
  const clickBody = sliceAnyFunction(appJs, 'handleProviderDetailClick', 'ensureProviderDetailEvents');
  const routerEventsBody = sliceAnyFunction(appJs, 'ensureProviderRouterEvents', 'renderProviderRouterPage');
  const routerRenderBody = sliceAnyFunction(appJs, 'renderProviderRouterPage', 'closeProviderDetail');
  assert.equal(/data-pd-router-start/.test(clickBody), false);
  assert.equal(/data-pd-router-stop/.test(clickBody), false);
  assert.equal(/data-pd-router-copy/.test(clickBody), false);

  assert.match(indexHtml, /data-page-target="providerRouter"/);
  assert.match(indexHtml, /data-page="providerRouter"/);
  assert.match(indexHtml, /providerRouterPage/);
  assert.match(appJs, /providerRouter:\s*\{/);
  assert.match(appJs, /function renderProviderRouterPage/);
  assert.match(appJs, /function ensureProviderRouterEvents/);
  assert.match(appJs, /function getProviderRouterPageTarget/);
  assert.match(appJs, /function renderProviderRouterStatsPanel/);
  assert.match(appJs, /function refreshProviderRouterStatsPanel/);
  assert.match(appJs, /data-provider-router-start/);
  assert.match(appJs, /data-provider-router-stop/);
  assert.match(appJs, /data-provider-router-copy/);
  assert.match(appJs, /data-provider-router-refresh/);
  assert.match(appJs, /data-provider-router-toggle/);
  assert.match(appJs, /data-provider-router-primary/);
  assert.match(appJs, /PROVIDER_ROUTER_STRATEGIES/);
  assert.match(appJs, /data-provider-router-strategy/);
  assert.match(appJs, /data-provider-router-weight/);
  assert.match(appJs, /data-provider-router-balance-guard/);
  assert.match(appJs, /balanceGuardEnabled/);
  assert.match(appJs, /balanceRemaining/);
  assert.match(appJs, /routeStrategy/);
  assert.match(appJs, /仅路由可读取密钥的 Provider/);
  assert.match(appJs, /PROVIDER_ROUTER_NO_PROXY = '127\.0\.0\.1,localhost,::1'/);
  assert.match(appJs, /运行中 · 反代中/);
  assert.match(appJs, /requestBytes/);
  assert.match(appJs, /responseBytes/);
  assert.match(appJs, /cachedInputTokens/);
  assert.match(appJs, /SQLite/);
  assert.match(appJs, /历史请求日志/);
  assert.match(appJs, /最近日志/);
  assert.match(appJs, /data-provider-router-log-search/);
  assert.match(appJs, /data-provider-router-panel="stats"/);
  assert.match(routerEventsBody, /getProviderRouterPageTarget\(target\)/);
  assert.match(routerEventsBody, /target\.matches\('\[data-provider-router-log-search\]'\)[\s\S]{0,260}refreshProviderRouterStatsPanel\(\)/);
  assert.doesNotMatch(routerEventsBody, /target\.matches\('\[data-provider-router-log-search\]'\)[\s\S]{0,260}renderProviderRouterPage\(\)/);
  assert.doesNotMatch(appJs, /const\s+proxyReady\s*=\s*running\s*;/);
  assert.match(routerRenderBody, /const\s+upstreamReady\s*=\s*running\s*&&\s*Boolean\(status\.proxyReady\s*\|\|\s*probe\.ok\)/);
  assert.match(routerRenderBody, /const\s+proxyReady\s*=\s*upstreamReady/);
  assert.match(routerRenderBody, /运行中 · 待探测/);
  assert.doesNotMatch(appJs, /网关收到请求后会写入 SQLite/);
  assert.doesNotMatch(appJs, /最多保留/);
  assert.equal(/\{ id: 'router',\s+label: '自动路由' \}/.test(appJs), false);
  assert.match(appJs, /\/api\/provider-router\/start/);
  assert.match(appJs, /\/api\/provider-router\/status/);
  assert.match(appJs, /\/api\/provider-router\/stop/);
  assert.match(appJs, /getProviderRouterRows/);
  assert.match(stylesCss, /\.pd-router-hero/);
  assert.match(stylesCss, /\.pd-router-status/);
  assert.match(stylesCss, /\.provider-router-page/);
  assert.match(stylesCss, /\.pd-router-strategy-bar/);
  assert.match(stylesCss, /\.pd-router-balance/);
  assert.match(stylesCss, /\.pd-router-stat-summary/);
  assert.match(stylesCss, /body\[data-page="providerRouter"\]\s+\.shell-v2\s+\.page-view\.active::-webkit-scrollbar/);
  assert.match(stylesCss, /padding:\s*58px 42px 72px/);

  assert.match(tauriRoutesRs, /"\/api\/provider-router\/status", "GET"/);
  assert.match(tauriRoutesRs, /"\/api\/provider-router\/start", "POST"/);
  assert.match(tauriRoutesRs, /"\/api\/provider-router\/stop", "POST"/);
  assert.match(providerRouterRs, /TcpListener/);
  assert.match(providerRouterRs, /LOCAL_ROUTER_NO_PROXY_ITEMS/);
  assert.match(providerRouterRs, /ensure_codex_router_no_proxy/);
  assert.match(providerRouterRs, /router_client_authorized/);
  assert.match(providerRouterRs, /invalid EasyAIConfig router API key/);
  assert.match(providerRouterRs, /x-api-key/);
  assert.match(providerRouterRs, /get_provider_secret/);
  assert.match(providerRouterRs, /DEFAULT_ROUTER_PORT: u16 = 18791/);
  assert.match(providerRouterRs, /bearer_auth\(api_key\)/);
  assert.match(providerRouterRs, /round_robin/);
  assert.match(providerRouterRs, /route_strategy/);
  assert.match(providerRouterRs, /normalize_route_strategy/);
  assert.match(providerRouterRs, /weighted_provider_order/);
  assert.match(providerRouterRs, /balance_provider_order/);
  assert.match(providerRouterRs, /balance_guard_enabled/);
  assert.match(providerRouterRs, /balance_min_percent/);
  assert.match(providerRouterRs, /MAX_ROUTER_LOG_ROWS: i64 = 10_000/);
  assert.match(providerRouterRs, /provider_router_logs/);
  assert.match(providerRouterRs, /persist_router_log/);
  assert.match(providerRouterRs, /load_persisted_router_stats/);
  assert.match(providerRouterRs, /extract_router_usage_summary/);
  assert.match(providerRouterRs, /request_bytes/);
  assert.match(providerRouterRs, /response_bytes/);
  assert.match(providerRouterRs, /cached_input_tokens/);
  assert.match(tauriCodexRs, /LOCAL_ROUTER_NO_PROXY_VALUE: &str = "127\.0\.0\.1,localhost,::1"/);
  assert.match(tauriCodexRs, /codex_launch_uses_local_router/);
  assert.match(tauriCodexRs, /env\.push\(\("NO_PROXY"/);
});

test('about page uses a full-width local-first update layout', () => {
  const aboutStart = indexHtml.indexOf('<section class="page-view" data-page="about">');
  const aboutEnd = indexHtml.indexOf('<section class="page-view" data-page="systemSettings">');
  assert.notEqual(aboutStart, -1);
  assert.notEqual(aboutEnd, -1);
  const aboutHtml = indexHtml.slice(aboutStart, aboutEnd);
  const progressBody = sliceAnyFunction(appJs, 'renderAboutUpdateProgress', 'populateAboutPanel');

  assert.match(aboutHtml, /class="about-page"/);
  assert.match(aboutHtml, /class="about-update-panel"/);
  assert.match(aboutHtml, /class="about-section about-actions-panel"/);
  assert.match(aboutHtml, /class="about-section about-trust-summary"/);
  assert.match(aboutHtml, /class="about-section about-update-flow"/);
  assert.match(aboutHtml, /id="aboutTrustBtn"/);
  assert.match(aboutHtml, /查看说明/);
  assert.match(aboutHtml, /EasyAIConfig 专注本地配置管理。/);
  assert.match(aboutHtml, /id="aboutTrustDialog" class="about-trust-dialog hide"/);
  assert.match(aboutHtml, /不内置遥测 SDK/);
  assert.match(aboutHtml, /不进行用户行为分析/);
  assert.match(aboutHtml, /不会把 API Key 或配置内容上传到项目服务器/);
  assert.match(aboutHtml, /项目代码公开/);
  assert.doesNotMatch(aboutHtml, /class="about-transparency"/);
  assert.doesNotMatch(aboutHtml, /aboutOpenSystemSettingsBtn/);
  assert.doesNotMatch(aboutHtml, />系统设置</);
  assert.doesNotMatch(appJs, /aboutOpenSystemSettingsBtn[\s\S]{0,140}setPage\('systemSettings'\)/);

  assert.match(appJs, /本地优先、开源透明的 AI 工具配置中心。/);
  assert.match(appJs, /function setAboutTrustOpen/);
  assert.match(appJs, /aboutTrustBtn'\)\?\.addEventListener\('click', \(\) => setAboutTrustOpen\(true\)\)/);
  assert.match(appJs, /data-about-trust-close/);
  assert.match(progressBody, /is-indeterminate/);
  assert.match(progressBody, /wrap\.dataset\.updateStatus\s*=\s*status/);
  assert.match(progressBody, /bar\.style\.width\s*=\s*indeterminate\s*\?\s*'42%'/);
  assert.match(appJs, /panel\.classList\.toggle\('is-updating', updating\)/);
  assert.match(appJs, /state\.appUpdateProgress\s*=\s*\{\s*status:\s*'checking'\s*\}/);
  assert.match(stylesCss, /body\[data-page="about"\]\s+\.desktop-layout\.shell-v2\s*\{[^}]*grid-template-columns:\s*var\(--rail-w\) minmax\(0,\s*1fr\)/);
  assert.match(stylesCss, /body\[data-page="about"\]\s+\.shell-secondary\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(stylesCss, /body\[data-page="about"\]\s+\.shell-v2 \.page-stack\s*\{[^}]*padding:\s*0\s*!important/);
  assert.match(stylesCss, /\.about-content-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(210px,\s*0\.42fr\) minmax\(300px,\s*0\.58fr\)/);
  assert.match(stylesCss, /\.about-content-grid\s*\{[^}]*grid-template-areas:\s*"trust actions info"\s*"flow flow flow"/);
  assert.match(stylesCss, /\.about-section\s*\{/);
  assert.match(stylesCss, /\.about-page \.about-icon-wrap\s*\{[^}]*width:\s*88px/);
  assert.match(stylesCss, /\.about-page \.about-app-name\s*\{[^}]*font-size:\s*clamp\(1\.95rem,\s*3vw,\s*2\.75rem\)/);
  assert.match(stylesCss, /\.about-page \.about-update-btn\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(stylesCss, /\.about-trust-dialog/);
  assert.match(stylesCss, /\.about-trust-panel/);
  assert.match(stylesCss, /\.about-page \.about-update-progress-wrap\.is-indeterminate \.about-update-progress-bar/);
  assert.match(stylesCss, /@keyframes aboutIndeterminate/);
  assert.match(stylesCss, /@keyframes aboutPanelSweep/);
  assert.match(i18nJs, /Open source & privacy/);
  assert.match(i18nJs, /does not include telemetry SDKs/);
});

test('Codex OAuth actions warn once per hour on risky outbound IP', () => {
  const riskBody = sliceAnyFunction(appJs, 'getOauthIpRiskMeta', 'confirmOauthIpRiskBeforeRequest');
  const confirmBody = sliceAnyFunction(appJs, 'confirmOauthIpRiskBeforeRequest', 'loadConsoleNetworkStatus');
  const loginBody = sliceAnyFunction(appJs, 'launchCodexLogin', 'launchOpenClawOnly');
  const addBody = sliceAnyFunction(appJs, 'addNewOauthAccount', 'reloginClaudeCodeOauthProfile');
  const switchBody = sliceAnyFunction(appJs, 'switchOauthProfile', 'renameOauthProfile');

  assert.match(appJs, /easyaiconfig_oauth_ip_warning_last_at/);
  assert.match(appJs, /OAUTH_IP_WARNING_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(riskBody, /countryCode && countryCode !== 'US'/);
  assert.match(confirmBody, /\/api\/network\/status/);
  assert.match(confirmBody, /openUpdateDialog/);
  assert.match(confirmBody, /继续请求/);
  assert.match(confirmBody, /localStorage\.setItem\(OAUTH_IP_WARNING_LS/);
  assert.match(loginBody, /confirmOauthIpRiskBeforeRequest\('Codex 官方登录'\)/);
  assert.match(addBody, /await confirmOauthIpRiskBeforeRequest\('新增 Codex OAuth 账号'\)/);
  assert.match(addBody, /openUpdateDialog/);
  assert.match(switchBody, /confirmOauthIpRiskBeforeRequest\('切换 Codex OAuth 账号'\)/);
});

test('provider detail pricing avoids silent primary-model fallback', () => {
  assert.match(appJs, /'gpt-5\.4-mini'/);
  assert.match(appJs, /pricing:\s*\{\s*\.\.\.pricing,\s*label:\s*`\$\{pricing\.label\}（按 \$\{key\} 估算）`/);
  const costBody = sliceAnyFunction(appJs, 'calcModelCost', 'renderPricingStandardsCards');
  assert.match(costBody, /cachedRate/);
});

test('dashboard usage cache is keyed by tool window and Codex home', () => {
  assert.match(appJs, /dashboardMetricsByWindow:\s*\{\}/);
  assert.match(appJs, /dashboardMetricsFetchedAtByWindow:\s*\{\}/);
  assert.match(appJs, /dashboardRefreshingByWindow:\s*\{\}/);

  const keyBody = sliceAnyFunction(appJs, 'getDashboardMetricsCacheKey', 'getDashboardMetricsEntryForTool');
  assert.match(keyBody, /tool: normalizedTool/);
  assert.match(keyBody, /window: normalizedWindow\.kind/);
  assert.match(keyBody, /from: normalizedWindow\.from/);
  assert.match(keyBody, /to: normalizedWindow\.to/);
  assert.match(keyBody, /codexHome: normalizedTool === 'codex'/);

  const setterBody = sliceAnyFunction(appJs, 'setDashboardMetricsForTool', 'isDashboardMetricsRefreshingForTool');
  assert.match(setterBody, /state\.dashboardMetricsByWindow\[key\]\s*=\s*data/);
  assert.match(setterBody, /state\.dashboardMetricsFetchedAtByWindow\[key\]\s*=\s*fetchedAt/);
  assert.match(setterBody, /state\.dashboardMetricsActiveKey\[tool\]\s*=\s*key/);

  const refreshBody = sliceAnyFunction(appJs, 'refreshDashboardData', 'getToolConsoleLabel');
  assert.match(refreshBody, /getDashboardMetricsCacheKey\(tool, win, codexHome\)/);
  assert.match(refreshBody, /state\.dashboardRefreshingByWindow\[cacheKey\]/);
  assert.match(refreshBody, /getDashboardRequestDays\(win\)/);
  assert.match(refreshBody, /json\.data\?\.cacheMiss/);
  assert.match(refreshBody, /setDashboardMetricsForTool\(tool, json\.data, win, codexHome\)/);

  const renderBody = sliceAnyFunction(appJs, 'renderDashboardPage', 'renderDashboardProviderFilter');
  assert.match(renderBody, /getDashboardMetricsForTool\('codex', win\)/);
  assert.match(renderBody, /getDashboardMetricsForTool\('opencode', win\)/);
  assert.match(renderBody, /db3-analytics-board/);
  assert.match(renderBody, /db3-panel--primary/);
  assert.match(renderBody, /renderDashboardTokenMix\(items\)/);
  assert.equal(renderBody.includes('db3-dashboard-grid">'), false);
  assert.equal(renderBody.includes('state.dashboardMetrics.codex'), false);
  assert.equal(renderBody.includes('state.dashboardMetrics.opencode'), false);

  const tokenMixBody = sliceAnyFunction(appJs, 'renderDashboardTokenMix', 'renderDashboardLoadingCard');
  assert.match(tokenMixBody, /db3-token-stack/);
  assert.match(tokenMixBody, /db3-token-row/);

  const modelDistBody = sliceAnyFunction(appJs, 'renderDashboardModelDistChart', 'renderCostTrendPanel');
  assert.match(modelDistBody, /db3-model-rank-summary/);
  assert.match(modelDistBody, /db3-model-rank-row/);
  assert.doesNotMatch(modelDistBody, /db2-mdist-bar-fill/);

  const costTrendBody = sliceAnyFunction(appJs, 'renderCostTrendPanel', 'renderClaudeCostTrendChart');
  assert.match(costTrendBody, /db3-cost-area-bar/);
  assert.match(costTrendBody, /appText\('日均'\)/);
  assert.match(stylesCss, /\.shell-v2 \.dashboard-page \.db3-analytics-board\s*\{/);
  assert.match(stylesCss, /\.shell-v2 \.dashboard-page \.db3-token-mix\s*\{/);
  assert.match(stylesCss, /\.shell-v2 \.dashboard-page \.db3-model-rank\s*\{/);

  const usageBody = sliceAnyFunction(appJs, 'renderPdUsage', 'renderClaudeProviderDetailUsage');
  assert.match(usageBody, /getDashboardMetricsForTool\('codex'\)/);
  assert.equal(usageBody.includes('state.dashboardMetrics?.codex'), false);
});

test('Codex launch terminal picker uses detected profiles and remembers selection', () => {
  const profilesBody = sliceAnyFunction(appJs, 'getCodexTerminalProfiles', 'describeCodexTerminalProfile');
  assert.match(profilesBody, /state\.current\?\.launch\?\.terminalProfiles/);
  assert.equal(/allowed\s*=/.test(profilesBody), false);
  for (const id of ['termius', 'terminus', 'tabby', 'warp', 'hyper', 'wezterm', 'ghostty', 'alacritty', 'kitty']) {
    assert.match(profilesBody, new RegExp(`id: '${id}'`));
  }
  for (const id of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'tilix', 'xfce4-terminal', 'lxterminal', 'xterm']) {
    assert.match(profilesBody, new RegExp(`id: '${id}'`));
  }
  assert.match(appJs, /easyaiconfig_codex_terminal_profile/);
  assert.match(appJs, /data-codex-terminal-launch/);
  assert.match(appJs, /openCodexTerminalMenu\(\)/);
  assert.match(appJs, /检测到 \$\{escapeHtml\(String\(availableCount\)\)\} 个可用终端/);
  assert.match(stylesCss, /\.codex-terminal-menu-head/);
  assert.match(stylesCss, /\.codex-terminal-selected/);
});

test('Node Codex launcher detects and launches macOS and Linux terminal profiles', () => {
  assert.match(configStoreJs, /function findDarwinApplication/);
  assert.match(configStoreJs, /function launchDarwinAppAndTypeCommand/);
  assert.match(configStoreJs, /System Events/);
  const darwinBody = sliceAnyFunction(configStoreJs, 'listDarwinTerminalProfiles', 'escapeAppleScriptText');
  for (const id of ['termius', 'terminus', 'tabby', 'warp', 'hyper']) {
    assert.match(darwinBody, new RegExp(`id: '${id}'`));
  }
  for (const id of ['wezterm', 'ghostty', 'alacritty', 'kitty']) {
    assert.match(darwinBody, new RegExp(`id: '${id}'`));
  }
  assert.match(configStoreJs, /function makeDarwinAppProfile\(\{[^}]*launchMode = 'type-command'/);
  assert.match(darwinBody, /launchMode: 'cli'/);

  const linuxListBody = sliceAnyFunction(configStoreJs, 'listLinuxTerminalProfiles', 'resolveLinuxTerminalProfile');
  for (const id of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'wezterm', 'alacritty', 'kitty', 'tilix', 'xfce4-terminal', 'lxterminal', 'xterm']) {
    assert.match(linuxListBody, new RegExp(`id: '${id}'`));
  }
  const linuxLaunchBody = sliceAnyFunction(configStoreJs, 'launchLinuxTerminal', 'buildPosixEnvPrefix');
  assert.match(linuxLaunchBody, /resolveLinuxTerminalProfile\(terminalProfile\)/);
  assert.match(linuxLaunchBody, /linuxTerminalArgs\(profile\.id/);
  assert.match(configStoreJs, /process\.platform === 'linux'\s*\?\s*listLinuxTerminalProfiles\(\)/);
});

test('Tauri Codex launcher mirrors terminal profile detection and routing', () => {
  assert.match(tauriConfigRs, /fn launch_terminal_profiles/);
  assert.match(tauriConfigRs, /macos_app_profile\("terminus", "Terminus"/);
  assert.match(tauriConfigRs, /\("x-terminal-emulator", "系统默认终端", "x-terminal-emulator"\)/);
  assert.match(tauriConfigRs, /\("xfce4-terminal", "Xfce Terminal", "xfce4-terminal"\)/);

  assert.match(tauriCodexRs, /fn generic_macos_terminal_app/);
  assert.match(tauriCodexRs, /"terminus" => Some\(\("Terminus", "Terminus"\)\)/);
  assert.match(tauriCodexRs, /fn launch_macos_app_and_type_command/);
  assert.match(tauriCodexRs, /fn resolve_linux_terminal_profile/);
  assert.match(tauriCodexRs, /fn launch_linux_terminal_with_profile/);
  assert.match(tauriCodexRs, /launch_linux_terminal_with_profile\(cwd, &command_text, "Codex", terminal_profile\)/);
  assert.match(tauriCodexRs, /launch_linux_terminal_with_profile\(&cwd, &command, "Codex 登录", &terminal_profile\)/);
  assert.match(tauriCodexRs, /launch_linux_terminal_with_profile\(&cwd, &command, tool_label, &terminal_profile\)/);
});
