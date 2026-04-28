import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, parseReviewResponse } from '../src/reviewer.js';

describe('reviewer prompt', () => {
  it('generates a prompt with title and patch snippets', () => {
    const prompt = buildReviewPrompt({
      title: 'Feature update',
      body: 'Adds new validation',
      reviewMode: 'both',
      toneMode: 'balanced',
      changedFiles: [
        { path: 'src/index.ts', patch: '+const x = 1\n' },
      ],
      repositoryFiles: ['src/index.ts'],
    });
    expect(prompt).toContain('Feature update');
    expect(prompt).toContain('src/index.ts');
    expect(prompt).toContain('REVIEW MODE: both');
  });
});

describe('review response parser', () => {
  it('parses a valid JSON review response', () => {
    const response = parseReviewResponse('{"summary":{"verdict":"question","overview":"Looks good","reuseNotes":[],"actionItems":[]},"comments":[{"path":"src/index.ts","line":5,"type":"question","body":"Fix this."}],"separate_pr_suggestions":["Split config changes"]}');
    expect(response.summary.overview).toBe('Looks good');
    expect(response.comments).toHaveLength(1);
    expect(response.comments[0].path).toBe('src/index.ts');
    expect(response.comments[0].type).toBe('question');
    expect(response.separatePrSuggestions).toEqual(['Split config changes']);
  });

  it('falls back gracefully for plain text responses', () => {
    const response = parseReviewResponse('Some review without JSON');
    expect(response.summary.overview).toBe('Some review without JSON');
    expect(response.comments).toEqual([]);
  });
});
