import { fetch } from 'undici';
import type { LLMClient } from './index.js';
import type { LLMConfig, ReviewResponse } from '../types.js';

function extractTextFromResponse(body: any): string {
  if (!body) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (choice) {
    if (typeof choice.text === 'string') {
      return choice.text;
    }
    if (choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    if (typeof choice.delta?.content === 'string') {
      return choice.delta.content;
    }
  }
  if (typeof body.output === 'string') {
    return body.output;
  }
  if (Array.isArray(body.outputs) && typeof body.outputs[0]?.content === 'string') {
    return body.outputs[0].content;
  }
  return JSON.stringify(body);
}

function parseReviewResponse(raw: string): ReviewResponse {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
      }
    }
    return {
      review: text,
      comments: [],
    };
  }
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details: string[] = [error.message];
  const errorWithCause = error as Error & { cause?: unknown; code?: string };
  if (errorWithCause.code) {
    details.push(`code=${errorWithCause.code}`);
  }

  if (errorWithCause.cause && typeof errorWithCause.cause === 'object') {
    const cause = errorWithCause.cause as { message?: string; code?: string };
    if (cause.message) {
      details.push(`cause=${cause.message}`);
    }
    if (cause.code) {
      details.push(`causeCode=${cause.code}`);
    }
  }

  return details.join(', ');
}

export class GroqClient implements LLMClient {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly model: string;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.model = config.model;
  }

  private buildEndpoints(): string[] {
    const base = this.apiUrl;
    if (base.endsWith('/v1')) {
      return [`${base}/chat/completions`];
    }
    return [`${base}/v1/chat/completions`, `${base}/chat/completions`];
  }

  private buildRequestBody(prompt: string) {
    return {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 1,
      max_completion_tokens: 8192,
      top_p: 1,
      reasoning_effort: 'medium',
      stream: false,
    };
  }

  async complete(prompt: string): Promise<ReviewResponse> {
    const endpoints = this.buildEndpoints();
    const body = JSON.stringify(this.buildRequestBody(prompt));
    const failures: string[] = [];

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        });

        if (!response.ok) {
          const responseText = await response.text();
          throw new Error(`LLM API error ${response.status} from ${url}: ${responseText}`);
        }

        const responseBody = await response.json();
        const text = extractTextFromResponse(responseBody);
        return parseReviewResponse(text);
      } catch (error) {
        failures.push(`request to ${url} failed: ${describeFetchError(error)}`);
      }
    }

    throw new Error(`LLM request failed for all endpoints. Errors: ${failures.join(' | ') || 'unknown error'}`);
  }
}
