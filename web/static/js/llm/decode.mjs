// Ports internal/sources/llm/client.go: extractJSON + DecodeJSONResponse.
// Strips markdown fences and slices to the outermost JSON object so the
// browser BYOK path sees the same sanitized shape the Go /parse endpoint
// produces.

export const extractJSON = (raw) => {
  let s = (raw ?? '').trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end >= start) return s.slice(start, end + 1);
  return s;
};

// decodeJSONResponse mirrors Go's DecodeJSONResponse. Throws on parse
// failure — callers surface as the same "decode JSON response" error the
// server returns.
export const decodeJSONResponse = (raw) => {
  const cleaned = extractJSON(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`decode JSON response: ${err.message}`);
  }
};

// nonNegInt coerces a raw LLM field to an integer ≥ min, or null. Guards
// against floats and negatives that bare Number() would silently accept.
export const nonNegInt = (raw, min = 0) => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : null;
};
