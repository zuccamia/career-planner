// hostOf returns a URL's hostname, or "" for unparseable input. Shared by
// modules that need to display a short host label (dashboard-discover) or
// filter by host (ats-lookup).
export const hostOf = (rawURL) => {
  try { return new URL(rawURL).hostname; } catch { return ''; }
};

// isFetchNetworkError distinguishes network/CORS failures from HTTP responses.
// fetch() rejects with TypeError on all browsers when the request never
// reaches the server (Chrome: "Failed to fetch", Firefox: "NetworkError…",
// Safari: "Load failed"). If we saw an HTTP status the request DID reach the
// server, so that's not a network error even if it later failed.
export const isFetchNetworkError = (err) => err?.name === 'TypeError' && err?.status == null;

// fetchJSON is the shared GET/POST helper used by rpc.mjs,
// discover-client.mjs, and search-client.mjs. Returns the parsed JSON
// response or `{ raw: text }` when the body wasn't JSON. On non-2xx it
// throws an Error whose `.status` and `.payload` fields expose the response
// for callers that want to distinguish auth/network failures.
//
// opts:
//   method      — 'GET' | 'POST' (default 'POST' when body set, 'GET' otherwise)
//   body        — JSON-serializable value; sets Content-Type when present
//   headers     — extra headers merged into the request
//   signal      — AbortSignal for cancellation (ignored if timeoutMs is set)
//   timeoutMs   — abort the request after N ms
//   errorPrefix — prepended to the error message ("<prefix>: <msg>")
export const fetchJSON = async (url, opts = {}) => {
  const { method, body, headers = {}, signal: callerSignal, timeoutMs, errorPrefix } = opts;

  // If timeoutMs is set, we own the AbortController; the caller's signal is
  // ignored (rare to pass both — add AbortSignal.any() combining if needed).
  let signal = callerSignal;
  let timer;
  if (timeoutMs) {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const init = {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { ...headers },
      signal,
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { raw: text }; }
    if (!res.ok) {
      const msg = payload.error || payload.detail || payload.message || text || `HTTP ${res.status}`;
      const err = new Error(errorPrefix ? `${errorPrefix}: ${msg}` : msg);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
