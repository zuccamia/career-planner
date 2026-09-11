// Fetches tool-call function schemas from
// web/static/tool-schemas/{module}/{name}.json — same files the Go server
// loads at boot. Locale-agnostic.

import { STATIC_ROOT } from '../../host.mjs';

const cache = new Map();

export const loadToolSchema = (name) => {
  if (!cache.has(name)) {
    cache.set(name, fetch(`${STATIC_ROOT}tool-schemas/${name}.json`).then(async (res) => {
      if (!res.ok) throw new Error(`tool schema ${name}: HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(`tool schema ${name}: expected array`);
      return body;
    }).catch((err) => {
      cache.delete(name);
      throw err;
    }));
  }
  return cache.get(name);
};
