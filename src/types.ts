export type ReviewMode = 'summary' | 'inline' | 'both';
export type LLMProvider = 'groq' | 'openrouter';
export type ToneMode = 'balanced' | 'direct' | 'supportive';
export interface LLMConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
}
export type ReviewCommentType = 'bug' | 'scope-drift' | 'reuse' | 'security' | 'question' | 'suggestion' | 'style';
export interface ReviewSummary {
  verdict?: string;
  primaryGoal?: string;
  overview?: string;
  scopeAssessment?: string;
  riskAssessment?: string;
  reuseNotes: string[];
  actionItems: string[];
}
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  type?: ReviewCommentType;
  suggestion?: string;
}
export interface ReviewResponse {
  summary: ReviewSummary;
  comments: ReviewComment[];
  separatePrSuggestions: string[];
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
  toneMode: ToneMode;
}
