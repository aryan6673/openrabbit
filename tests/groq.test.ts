import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroqClient } from '../src/llm/groq.js';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: fetchMock,
}));

describe('GroqClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('tries the chat completion endpoint first when the base URL already ends with /v1', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"review":"Looks good","comments":[]}',
              },
            },
          ],
        }),
      });

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.groq.ai/v1',
      model: 'openai/gpt-oss-120b',
    });

    const response = await client.complete('Review this');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.groq.ai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.groq.ai/v1/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(response.review).toBe('Looks good');
    expect(response.comments).toEqual([]);
  });

  it('prepends /v1 when the configured base URL omits it', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"review":"Looks good","comments":[]}',
            },
          },
        ],
      }),
    });

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.groq.ai',
      model: 'openai/gpt-oss-120b',
    });

    await client.complete('Review this');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.ai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
