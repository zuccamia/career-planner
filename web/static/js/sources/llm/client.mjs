// Browser-side OpenAI-compatible LLM client for the BYOK path (key stays in-browser).
// CORS: endpoint must send `Access-Control-Allow-Origin` for our origin; classifyError surfaces failures.

import { isStaticHost } from '../../host.mjs';

const TIMEOUT_MS = 60_000;

// Static build has no server, so short-circuit to avoid a 404 on /api/llm/server-status.
let serverLLMStatusPromise = null;
export const getServerLLMStatus = () => {
  if (isStaticHost()) return Promise.resolve({ available: false, provider: '', model: '' });
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
  if (status === 429) return { code: 'rate_limit', message: `HTTP 429${text ? `: ${text}` : ''}` };
  if (status >= 500) return { code: 'provider', message: `Provider error (HTTP ${status}). ${text || ''}`.trim() };
  return { code: 'other', message: `HTTP ${status}${text ? `: ${text}` : ''}` };
};

// callOpenAICompatible sends the assembled prompt to the user's provider.
// Accepts either { system, user } (single-shot) or { messages, tools?,
// tool_choice? } (multi-turn tool loop). Returns { content, toolCalls }
// where `content` is the raw assistant string (may be '' when the model
// only emits tool calls) and `toolCalls` is a normalized array of
// { id, name, arguments } — `arguments` stays as the raw JSON string the
// provider returned, callers own parsing. Response is deliberately NOT
// JSON-decoded here; the server's /parse/:name endpoint owns extraction +
// sanitization to keep the browser + server paths identical.
export const callOpenAICompatible = async (prompt, cfg) => {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw Object.assign(new Error('BYOK config incomplete'), { code: 'config' });
  }
  const messages = Array.isArray(prompt.messages)
    ? prompt.messages
    : [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ];
  const body = { model: cfg.model, messages };
  if (Array.isArray(prompt.tools) && prompt.tools.length) body.tools = prompt.tools;
  if (prompt.tool_choice != null) body.tool_choice = prompt.tool_choice;

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
      body: JSON.stringify(body),
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
    // Distinguish "provider doesn't support tools" from generic 4xx so the
    // tool-loop caller can fall back cleanly. Structured signals only: the
    // OpenAI-style { error.param } and the substring "tool" in the field
    // name ({unsupported_parameter, param: "tools"|"tool_choice"|...}).
    if (body.tools && res.status === 400) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
      const param = parsed?.error?.param || '';
      const errCode = parsed?.error?.code || '';
      if ((errCode === 'unsupported_parameter' || errCode === 'invalid_request_error')
          && /tool/i.test(param)) {
        throw Object.assign(new Error(`Provider does not support tools: ${param}`), {
          code: 'tools_unsupported', status: 400,
        });
      }
    }
    const { code, message } = classifyError(res.status, text, cfg.baseUrl);
    throw Object.assign(new Error(message), { code, status: res.status });
  }

  const payload = await res.json();
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') {
    throw Object.assign(new Error('Provider returned an unexpected response shape'), { code: 'shape' });
  }
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter((call) => call?.function?.name)
        .map((call) => ({
          id: call.id || '',
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '',
        }))
    : [];
  return { content, toolCalls };
};

// testConnection sends a minimal /chat/completions POST to confirm baseUrl +
// apiKey + model work end-to-end. Costs ≤8 output tokens per test. This is
// the only universally supported endpoint across OpenAI-compatible providers
// (MiniMax and similar don't implement /models). Cap is 8 rather than 1
// because some providers (MiniMax) 400 with "output limit was reached" when
// the model can't emit any content within the given budget.
// Returns { ok, latencyMs, error }.
//
// Token-limit parameter name varies across providers: older ones only accept
// `max_tokens`; newer OpenAI models (o1, gpt-5, some 4.x) require
// `max_completion_tokens` and reject `max_tokens` with
// { error.code: "unsupported_parameter", error.param: "max_tokens" }.
// We try `max_tokens` first and retry with `max_completion_tokens` on that
// exact structured signal — no regex-matching provider messages.
export const testConnection = async (cfg) => {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    return { ok: false, error: 'Base URL, API key, and model are required.' };
  }
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const probe = (tokenKey) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'ping' }],
      [tokenKey]: 8,
    }),
    signal: controller.signal,
  });
  try {
    let res = await probe('max_tokens');
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
      const err = parsed?.error;
      if (err?.code === 'unsupported_parameter' && err?.param === 'max_tokens') {
        res = await probe('max_completion_tokens');
      } else {
        const latencyMs = Math.round(performance.now() - started);
        const { message } = classifyError(res.status, text, cfg.baseUrl);
        return { ok: false, latencyMs, error: message };
      }
    }
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const { message } = classifyError(res.status, text, cfg.baseUrl);
      return { ok: false, latencyMs, error: message };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (err.name === 'AbortError') return { ok: false, latencyMs, error: 'Timed out after 10s.' };
    return { ok: false, latencyMs, error: classifyError(0, '', cfg.baseUrl).message };
  } finally {
    clearTimeout(timer);
  }
};
