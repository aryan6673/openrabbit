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
      apiUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
    });

    const response = await client.complete('Review this');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(response.summary.overview).toBe('Looks good');
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
      apiUrl: 'https://api.groq.com/openai',
      model: 'openai/gpt-oss-120b',
    });

    await client.complete('Review this');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports every attempted endpoint when requests fail', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"error":"missing"}',
      });

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.groq.com/openai',
      model: 'openai/gpt-oss-120b',
    });

    await expect(client.complete('Review this')).rejects.toThrow(
      'LLM request failed for all endpoints. Errors: request to https://api.groq.com/openai/v1/chat/completions failed: fetch failed | request to https://api.groq.com/openai/chat/completions failed: LLM API error 404 from https://api.groq.com/openai/chat/completions: {"error":"missing"}',
    );
  });
});
