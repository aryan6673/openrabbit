export type ReviewMode = 'summary' | 'inline' | 'both';
export type LLMProvider = 'groq' | 'openrouter';
export interface LLMConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
}
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}
export interface ReviewResponse {
  review: string;
  comments: ReviewComment[];
}
export interface ReviewContext {
  owner: string;
  repo: string;
  pullNumber: number;
  githubToken: string;
  llmProvider: LLMProvider;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  reviewMode: ReviewMode;
}
