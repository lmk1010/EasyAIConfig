import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const configStoreJs = readFileSync(new URL('../src/lib/config-store.js', import.meta.url), 'utf8');
const tauriConfigRs = readFileSync(new URL('../src-tauri/src/config.rs', import.meta.url), 'utf8');
const tauriCodexRs = readFileSync(new URL('../src-tauri/src/codex.rs', import.meta.url), 'utf8');
const providerEvalRs = readFileSync(new URL('../src-tauri/src/provider_eval.rs', import.meta.url), 'utf8');
const providerRouterRs = readFileSync(new URL('../src-tauri/src/provider_router.rs', import.meta.url), 'utf8');
const providerRemoteUsageRs = readFileSync(new URL('../src-tauri/src/provider_remote_usage.rs', import.meta.url), 'utf8');
const providerRemoteUsageCacheRs = readFileSync(new URL('../src-tauri/src/provider_remote_usage_cache.rs', import.meta.url), 'utf8');
const codexOauthUsageRs = readFileSync(new URL('../src-tauri/src/codex_oauth_usage.rs', import.meta.url), 'utf8');
const tauriRoutesRs = readFileSync(new URL('../src-tauri/src/routes.rs', import.meta.url), 'utf8');

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
  assert.equal(/data-pd-router-start/.test(clickBody), false);
  assert.equal(/data-pd-router-stop/.test(clickBody), false);
  assert.equal(/data-pd-router-copy/.test(clickBody), false);

  assert.match(indexHtml, /data-page-target="providerRouter"/);
  assert.match(indexHtml, /data-page="providerRouter"/);
  assert.match(indexHtml, /providerRouterPage/);
  assert.match(appJs, /providerRouter:\s*\{/);
  assert.match(appJs, /function renderProviderRouterPage/);
  assert.match(appJs, /function ensureProviderRouterEvents/);
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
  assert.match(appJs, /OAuth 不进入路由池/);
  assert.match(appJs, /PROVIDER_ROUTER_NO_PROXY = '127\.0\.0\.1,localhost,::1'/);
  assert.match(appJs, /运行中 · 反代中/);
  assert.match(appJs, /requestBytes/);
  assert.match(appJs, /responseBytes/);
  assert.match(appJs, /cachedInputTokens/);
  assert.match(appJs, /SQLite/);
  assert.match(appJs, /最多保留/);
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
