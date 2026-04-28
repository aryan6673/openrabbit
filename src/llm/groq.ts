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

export class GroqClient implements LLMClient {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly model: string;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.model = config.model;
  }

  async complete(prompt: string): Promise<ReviewResponse> {
    const response = await fetch(`${this.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
        stop: null,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Groq API error ${response.status}: ${body}`);
    }

    const body = await response.json();
    const text = extractTextFromResponse(body);
    return parseReviewResponse(text);
  }
}
