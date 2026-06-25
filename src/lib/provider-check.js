// Provider 连通性探测 + 诊断分级。
//
// 给前端两层信号：
//   1. ok / 失败的二元判定（红绿灯用）
//   2. 失败时的 stage + hint（让用户知道是 DNS / TLS / Auth / 上游 5xx 还是
//      body 解析问题，给出对应的修复提示）
//
// 返回结构：
//   成功: { ok: true, status: 'ok', stage: 'ok', latencyMs, statusCode,
//          baseUrl, models, supportsGpt, recommendedModel, raw }
//   失败: throw Error，并附 .diag = { stage, hint, latencyMs?, statusCode? }
//
// stage 取值（前端按此分类显示提示）：
//   dns      — 域名解析失败
//   connect  — TCP 拒绝 / 重置
//   tls      — TLS 握手失败 / 证书校验失败
//   timeout  — 超时
//   auth     — 401 / 403
//   notfound — 404 / 405
//   http     — 其他 4xx / 5xx
//   body     — JSON 解析或 schema 不符
//   ok       — 成功

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    throw new Error('Base URL is required');
  }

  const withScheme = /^[a-z]+:\/\//i.test(raw)
    ? raw
    : (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`);

  const url = new URL(withScheme);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function parseModelVersion(modelId) {
  const match = String(modelId || '').match(/gpt-(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
  };
}

function compareModels(left, right) {
  const a = parseModelVersion(left);
  const b = parseModelVersion(right);
  if (a && b) {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    const leftCodex = /codex/i.test(left);
    const rightCodex = /codex/i.test(right);
    if (leftCodex !== rightCodex) return rightCodex - leftCodex;
    return String(left).localeCompare(String(right));
  }
  if (a) return -1;
  if (b) return 1;
  return String(left).localeCompare(String(right));
}

function summarizeModels(modelIds) {
  const uniqueIds = [...new Set(modelIds.filter(Boolean))].sort(compareModels);
  const gptModels = uniqueIds.filter((id) => /gpt/i.test(id));
  return {
    models: uniqueIds,
    supportsGpt: gptModels.length > 0,
    recommendedModel: gptModels[0] ?? uniqueIds[0] ?? null,
  };
}

function buildHeaders(apiKey) {
  return {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${String(apiKey || '').trim()}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CodexConfigUI/0.1',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
}

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
]);

// 把任何下层抛出的错误归一到 { stage, hint, errorMessage } 三元组。
// 调用方：detectProvider 内部 + testSavedProvider 落盘前。
export function classifyProbeError(error) {
  const cause = error?.cause || {};
  const code = String(cause.code || error?.code || '').toUpperCase();
  const msg = String(error?.message || cause.message || '');

  if (error?.name === 'AbortError' || /timeout|timed out/i.test(msg)) {
    return {
      stage: 'timeout',
      hint: '15 秒内没有响应。可能是网络受限、需要代理（试试为该 Provider 配 HTTPS_PROXY），或对端服务异常。',
      errorMessage: '检测超时',
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|dns/i.test(msg)) {
    return {
      stage: 'dns',
      hint: 'DNS 解析失败：检查 Base URL 域名拼写、本机 DNS、或网络是否需要代理。',
      errorMessage: msg || 'DNS 解析失败',
    };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return {
      stage: 'connect',
      hint: `TCP 连接失败 (${code || 'unknown'})：对端端口未开放或被防火墙拦截，请确认 Base URL 端口正确。`,
      errorMessage: msg || `TCP 连接失败 (${code})`,
    };
  }
  if (TLS_ERROR_CODES.has(code) || /tls|ssl|certificate/i.test(msg)) {
    return {
      stage: 'tls',
      hint: `TLS / 证书校验失败 (${code || 'unknown'})：可能是自签证书 / 中间人代理 / 系统时间不准。`,
      errorMessage: msg || 'TLS 握手失败',
    };
  }
  // 通用 fetch failure（chrome 风格的 "fetch failed"）— 最常见，给一个综合提示
  if (/fetch failed/i.test(msg)) {
    return {
      stage: 'connect',
      hint: '请求失败：可能是网络不可达、代理设置错误，或对端返回了非法响应。',
      errorMessage: msg,
    };
  }
  return {
    stage: 'unknown',
    hint: '未知错误，请查看下方原始错误信息。',
    errorMessage: msg || '检测失败',
  };
}

function classifyHttpStatus(status) {
  if (status === 401) {
    return {
      stage: 'auth',
      hint: 'HTTP 401：API Key 无效 / 已过期 / 未授权访问 /models 端点。',
    };
  }
  if (status === 403) {
    return {
      stage: 'auth',
      hint: 'HTTP 403：Key 没有权限访问 /models（部分中转站需要付费套餐或白名单 IP）。',
    };
  }
  if (status === 404 || status === 405) {
    return {
      stage: 'notfound',
      hint: `HTTP ${status}：Base URL 路径不对，确认是否需要带 /v1。常见正确形式：https://api.example.com/v1`,
    };
  }
  if (status === 429) {
    return {
      stage: 'http',
      hint: 'HTTP 429：触发限流，Key 还能用但当前速率太快，稍后重试。',
    };
  }
  if (status >= 500) {
    return {
      stage: 'http',
      hint: `HTTP ${status}：上游服务异常（不是你的配置问题），等几分钟重试或联系 Provider。`,
    };
  }
  return {
    stage: 'http',
    hint: `HTTP ${status}：非预期状态码。`,
  };
}

function attachDiag(error, diag) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.diag = { ...diag };
  return wrapped;
}

export async function detectProvider({ baseUrl, apiKey, timeoutMs = 15000 }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const startedAt = Date.now();

  try {
    let response;
    try {
      response = await fetch(`${normalizedBaseUrl}/models`, {
        method: 'GET',
        headers: buildHeaders(apiKey),
        signal: controller.signal,
      });
    } catch (networkError) {
      const diag = classifyProbeError(networkError);
      const latencyMs = Date.now() - startedAt;
      throw attachDiag(new Error(`检测失败：${diag.errorMessage}`), {
        stage: diag.stage,
        hint: diag.hint,
        errorMessage: diag.errorMessage,
        latencyMs,
        statusCode: null,
      });
    }

    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const cls = classifyHttpStatus(response.status);
      const rawMessage = payload?.error?.message || payload?.message || text || `HTTP ${response.status}`;
      throw attachDiag(new Error(`检测失败：${rawMessage}`), {
        stage: cls.stage,
        hint: cls.hint,
        errorMessage: rawMessage,
        latencyMs,
        statusCode: response.status,
      });
    }

    const modelIds = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter(Boolean)
      : [];
    if (!modelIds.length && payload && typeof payload === 'object') {
      // 兼容一些只返回 { models: [...] } 或裸数组的实现
      const alt = Array.isArray(payload.models) ? payload.models : (Array.isArray(payload) ? payload : []);
      for (const m of alt) {
        if (typeof m === 'string') modelIds.push(m);
        else if (m?.id) modelIds.push(String(m.id));
      }
    }

    if (!modelIds.length) {
      throw attachDiag(new Error('检测失败：响应不包含模型列表'), {
        stage: 'body',
        hint: '/models 返回了 200 但 body 里没有模型数组。可能是中转站的伪 OK，或路径不对（试试不带 /v1）。',
        errorMessage: '响应缺少 models 数组',
        latencyMs,
        statusCode: response.status,
      });
    }

    return {
      baseUrl: normalizedBaseUrl,
      status: 'ok',
      stage: 'ok',
      latencyMs,
      statusCode: response.status,
      ...summarizeModels(modelIds),
      raw: payload,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 给调用方在 catch 里统一拿诊断数据：
//   try { await detectProvider(...) } catch (err) { const d = readDiag(err); ... }
export function readDiag(error) {
  if (error?.diag) return error.diag;
  // 没 diag 的（normalize 等参数校验抛的）就走一次分类作为兜底
  const c = classifyProbeError(error);
  return { stage: c.stage, hint: c.hint, errorMessage: c.errorMessage, latencyMs: null, statusCode: null };
}
