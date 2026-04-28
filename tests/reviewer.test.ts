import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, parseReviewResponse } from '../src/reviewer.js';

describe('reviewer prompt', () => {
  it('generates a prompt with title and patch snippets', () => {
    const prompt = buildReviewPrompt('Feature update', 'Adds new validation', [
      { path: 'src/index.ts', patch: '+const x = 1\n' },
    ]);
    expect(prompt).toContain('Feature update');
    expect(prompt).toContain('src/index.ts');
  });
});

describe('review response parser', () => {
  it('parses a valid JSON review response', () => {
    const response = parseReviewResponse('{"review":"Looks good","comments":[{"path":"src/index.ts","line":5,"body":"Fix this."}]}');
    expect(response.review).toBe('Looks good');
    expect(response.comments).toHaveLength(1);
    expect(response.comments[0].path).toBe('src/index.ts');
  });

  it('falls back gracefully for plain text responses', () => {
    const response = parseReviewResponse('Some review without JSON');
    expect(response.review).toBe('Some review without JSON');
    expect(response.comments).toEqual([]);
  });
});
