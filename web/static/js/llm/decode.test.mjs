import { describe, expect, it } from 'vitest';
import { decodeJSONResponse, extractJSON } from './decode.mjs';

describe('extractJSON', () => {
  it('returns raw JSON unchanged', () => {
    expect(extractJSON('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences', () => {
    expect(extractJSON('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('slices to the outermost JSON object', () => {
    expect(extractJSON('here is your answer: {"a":1} thanks')).toBe('{"a":1}');
  });

  it('leaves non-object payloads alone', () => {
    expect(extractJSON('nope')).toBe('nope');
  });
});

describe('decodeJSONResponse', () => {
  it('parses stripped JSON', () => {
    expect(decodeJSONResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('throws with a decode-shaped error on malformed input', () => {
    expect(() => decodeJSONResponse('{ not json')).toThrowError(/decode JSON response/);
  });
});
