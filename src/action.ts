import * as core from '@actions/core';
import * as github from '@actions/github';
import { runReview } from './reviewer.js';

function getInputValue(name: string, fallback = '', envName?: string): string {
  const input = core.getInput(name);
  if (input.length) {
    return input;
  }
  if (envName && process.env[envName]) {
    return process.env[envName] ?? '';
  }
  return fallback;
}

async function run(): Promise<void> {
  const githubToken = getInputValue('github_token', process.env.GITHUB_TOKEN ?? '', 'GITHUB_TOKEN');
  const botToken = getInputValue('bot_token', process.env.BOT_TOKEN ?? '', 'BOT_TOKEN');
  const llmProvider = (getInputValue('llm_provider', process.env.LLM_PROVIDER ?? 'openrouter', 'LLM_PROVIDER') ?? 'openrouter') as import('./types.js').LLMProvider;
  const llmApiUrl = getInputValue('llm_api_url', process.env.LLM_API_URL ?? 'https://openrouter.ai/api/v1', 'LLM_API_URL') ?? 'https://openrouter.ai/api/v1';
  const llmApiKey = getInputValue('llm_api_key', process.env.LLM_API_KEY ?? '', 'LLM_API_KEY');
  const llmModel = getInputValue('llm_model', process.env.LLM_MODEL ?? 'openrouter/free', 'LLM_MODEL') ?? 'openrouter/free';
  const reviewMode = (getInputValue('review_mode', process.env.REVIEW_MODE ?? 'both', 'REVIEW_MODE') ?? 'both') as import('./types.js').ReviewMode;
  const toneMode = (getInputValue('tone_mode', process.env.TONE_MODE ?? 'balanced', 'TONE_MODE') ?? 'balanced') as import('./types.js').ToneMode;
  const repository = github.context.repo;
  const pullRequestNumber = github.context.payload.pull_request?.number;

  if (!llmApiKey) {
    core.setFailed('LLM API key is required through llm_api_key input or LLM_API_KEY env var.');
    return;
  }

  if (!pullRequestNumber) {
    core.setFailed('Pull request number is required from the GitHub event context.');
    return;
  }

  await runReview({
    owner: repository.owner,
    repo: repository.repo,
    pullNumber: pullRequestNumber,
    githubToken: githubToken || undefined,
    llmProvider: llmProvider as import('./types.js').LLMProvider,
    llmApiUrl,
    llmApiKey,
    llmModel,
    reviewMode: reviewMode as import('./types.js').ReviewMode,
    toneMode,
    botToken: botToken || undefined,
  });
}

run().catch((error) => core.setFailed(`${error}`));
