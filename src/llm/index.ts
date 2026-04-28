import { GroqClient } from './groq.js';
import type { LLMConfig, LLMProvider, ReviewResponse } from '../types.js';

export interface LLMClient {
  complete(prompt: string): Promise<ReviewResponse>;
}

export function createLLMClient(provider: LLMProvider, config: LLMConfig): LLMClient {
  if (provider === 'groq' || provider === 'openrouter') {
    return new GroqClient(config);
  }
  throw new Error(`Unsupported provider ${provider}`);
}
