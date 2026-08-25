// Regression guard: every prompt flow must have a JSON file for every
// locale in web/static/i18n/manifest.json. Mirrors the Go-side
// TestPromptsCoverManifest checks so the same invariant is caught on the
// JS side too (matters once GH Pages ships without the Go test suite in
// the loop).

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsers } from '../../prompt-handlers/index.mjs';
import { decodeJSONResponse, extractJSON } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// HERE is web/static/js/sources/llm — five levels below the repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const PROMPTS_DIR = join(REPO_ROOT, 'web', 'static', 'i18n', 'prompts');
const MANIFEST = join(REPO_ROOT, 'web', 'static', 'i18n', 'manifest.json');

const locales = JSON.parse(readFileSync(MANIFEST, 'utf8')).supported;
const flowNames = Object.keys(parsers);

// ---- decode ----

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

// ---- coverage ----

describe('prompts coverage', () => {
  it('has at least one flow and one locale (sanity)', () => {
    expect(flowNames.length).toBeGreaterThan(0);
    expect(locales.length).toBeGreaterThan(0);
  });

  for (const name of flowNames) {
    for (const locale of locales) {
      it(`${name}.${locale}.json exists and is valid`, () => {
        const path = join(PROMPTS_DIR, `${name}.${locale}.json`);
        expect(existsSync(path), `missing ${path}`).toBe(true);
        const body = JSON.parse(readFileSync(path, 'utf8'));
        expect(body.name).toBe(name);
        expect(body.locale).toBe(locale);
        expect(body.system).toBeTruthy();
        expect(body.user).toBeTruthy();
      });
    }
  }
});
