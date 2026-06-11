import { describe, expect, it } from 'vitest';

import { parseCorsOrigin } from './cors.js';

describe('parseCorsOrigin', () => {
  it('disables CORS when unset or empty', () => {
    expect(parseCorsOrigin(undefined)).toBe(false);
    expect(parseCorsOrigin('')).toBe(false);
    expect(parseCorsOrigin('   ')).toBe(false);
  });

  it('reflects any origin for the wildcard', () => {
    expect(parseCorsOrigin('*')).toBe(true);
  });

  it('parses a single explicit origin', () => {
    expect(parseCorsOrigin('https://other-gpt.example.com')).toEqual([
      'https://other-gpt.example.com',
    ]);
  });

  it('parses and trims a comma-separated allow-list', () => {
    expect(parseCorsOrigin(' https://a.example.com , https://b.example.com ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('drops empty entries from a trailing comma', () => {
    expect(parseCorsOrigin('https://a.example.com,')).toEqual(['https://a.example.com']);
  });
});
