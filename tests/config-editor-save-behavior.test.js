import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const configStoreJs = readFileSync(new URL('../src/lib/config-store.js', import.meta.url), 'utf8');
const tauriConfigRs = readFileSync(new URL('../src-tauri/src/config.rs', import.meta.url), 'utf8');
const tauriCodexRs = readFileSync(new URL('../src-tauri/src/codex.rs', import.meta.url), 'utf8');

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
  assert.equal(renderBody.includes('state.dashboardMetrics.codex'), false);
  assert.equal(renderBody.includes('state.dashboardMetrics.opencode'), false);

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
