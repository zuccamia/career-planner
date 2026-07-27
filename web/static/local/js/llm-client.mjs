// Browser-side OpenAI-compatible LLM client. Used only by the BYOK path —
// rpc.mjs calls this directly from the browser so the user's API key never
// touches our server. Works with any OpenAI /v1/chat/completions endpoint:
// api.openai.com, Groq, Together, Ollama Cloud, MiniMax, LM Studio, vLLM…
//
// CORS caveat: the endpoint must send `Access-Control-Allow-Origin` for our
// origin. OpenAI, Groq, Together do. Some self-hosted or niche providers
// don't — the caller should surface the CORS failure clearly (see
// classifyError) rather than silently falling back.

const TIMEOUT_MS = 60_000;

// getServerLLMStatus fetches /api/llm/server-status once per browser session
// and caches the promise. Callers use it to decide whether the server has an
// LLM key configured (falls back to that path when BYOK is not set) or
// whether the user must configure BYOK first. Cache is per-session (module
// scope) rather than per-tab-lifetime; a hard refresh re-fetches.
let serverLLMStatusPromise = null;
export const getServerLLMStatus = () => {
  if (!serverLLMStatusPromise) {
    serverLLMStatusPromise = fetch('/api/llm/server-status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        // Reset so a later call can retry; treat network errors as "unknown"
        // → assume the server-side LLM is available to avoid falsely locking
        // users out.
        serverLLMStatusPromise = null;
        console.warn('[local] server-status fetch failed, assuming available', err);
        return { available: true, provider: '', model: '' };
      });
  }
  return serverLLMStatusPromise;
};

// isLocalUrl detects loopback base URLs. Ollama's default allowlist already
// covers localhost/127.0.0.1/0.0.0.0 on any port, so the usual cause of a
// network failure against a local URL is the server not running or the wrong
// port — not CORS.
const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url || '');

// classifyError maps a fetch failure or non-2xx response into a stable
// { code, message } shape the UI can act on without regexing free-form text.
const classifyError = (status, text, baseUrl) => {
  if (status === 0) {
    if (isLocalUrl(baseUrl)) {
      return { code: 'network', message: `Couldn't reach ${baseUrl}. Check that the server is running (e.g. \`ollama serve\`) and the base URL includes the OpenAI-compatible path (Ollama needs /v1).` };
    }
    return { code: 'network', message: 'Network error or CORS blocked. Some providers do not allow browser calls — see docs.' };
  }
  if (status === 401 || status === 403) return { code: 'auth', message: 'API key rejected. Check the key in Settings.' };
  if (status === 429) return { code: 'rate_limit', message: 'Provider rate-limited this call. Wait a moment.' };
  if (status >= 500) return { code: 'provider', message: `Provider error (HTTP ${status}). ${text || ''}`.trim() };
  return { code: 'other', message: `HTTP ${status}${text ? `: ${text}` : ''}` };
};

// callOpenAICompatible sends the assembled prompt to the user's provider and
// returns the raw string content of the assistant message. Response is
// deliberately NOT decoded — the server's /parse/:name endpoint owns JSON
// extraction + sanitization to stay identical to the server-side path.
export const callOpenAICompatible = async (prompt, cfg) => {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw Object.assign(new Error('BYOK config incomplete'), { code: 'config' });
  }
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        // response_format is not sent — many OpenAI-compatible providers
        // don't support json_object mode. The server's DecodeJSONResponse
        // strips markdown fences either way.
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw Object.assign(new Error('Request timed out'), { code: 'timeout' });
    // fetch() throws on network errors and (opaquely) CORS. Both surface here.
    throw Object.assign(new Error(classifyError(0, '', cfg.baseUrl).message), { code: 'network' });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const { code, message } = classifyError(res.status, text, cfg.baseUrl);
    throw Object.assign(new Error(message), { code, status: res.status });
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw Object.assign(new Error('Provider returned an unexpected response shape'), { code: 'shape' });
  }
  return content;
};

// testConnection hits the provider's /models endpoint. Cheap, works across
// mainstream OpenAI-compatible providers, and confirms both the base URL and
// the API key in one round trip. Returns { ok, latencyMs, modelsCount, error }.
export const testConnection = async (cfg) => {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    return { ok: false, error: 'Base URL and API key are required.' };
  }
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/models`;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const { message } = classifyError(res.status, text, cfg.baseUrl);
      return { ok: false, latencyMs, error: message };
    }
    const payload = await res.json().catch(() => null);
    // Providers vary: OpenAI returns { data: [...] }, some return a bare array.
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return { ok: true, latencyMs, modelsCount: list.length };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - started);
    if (err.name === 'AbortError') return { ok: false, latencyMs, error: 'Timed out after 10s.' };
    return { ok: false, latencyMs, error: classifyError(0, '', cfg.baseUrl).message };
  }
};
