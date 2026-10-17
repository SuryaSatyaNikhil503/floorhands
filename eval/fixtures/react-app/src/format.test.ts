import { describe, expect, it } from 'vitest';
import { readingMinutes, shortTitle } from './format';

describe('format helpers', () => {
  it('shortens long titles at a word boundary', () => {
    expect(shortTitle('A very long headline that keeps going and going for ages', 30)).toBe('A very long headline that...');
  });

  it('never reports zero minutes', () => {
    expect(readingMinutes(50)).toBe(1);
    expect(readingMinutes(1000)).toBe(5);
  });
});
