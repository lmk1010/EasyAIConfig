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
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1';
  } else if (!/\/v1$/i.test(url.pathname)) {
    url.pathname = `${url.pathname}/v1`;
  }
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

export async function detectProvider({ baseUrl, apiKey, timeoutMs = 15000 }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const response = await fetch(`${normalizedBaseUrl}/models`, {
      method: 'GET',
      headers: buildHeaders(apiKey),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const rawMessage = payload?.error?.message || payload?.message || text || `HTTP ${response.status}`;
      throw new Error(`检测失败：${rawMessage}`);
    }

    const modelIds = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter(Boolean)
      : [];

    return {
      baseUrl: normalizedBaseUrl,
      status: 'ok',
      ...summarizeModels(modelIds),
      raw: payload,
    };
  } catch (error) {
    if (error?.name === 'AbortError' || String(error?.message || '').includes('timeout')) {
      throw new Error('检测超时：该接口 15 秒内没有返回模型列表，请检查 Base URL、Key 或服务端兼容性');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
