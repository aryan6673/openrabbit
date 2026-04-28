import { runReview } from './reviewer.js';
import type { ReviewMode, LLMProvider } from './types.js';

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function getValue(name: string, envName: string, fallback?: string): string {
  return getArg(name) ?? process.env[envName] ?? fallback ?? '';
}

async function main(): Promise<void> {
  const owner = getValue('owner', 'GITHUB_OWNER');
  const repo = getValue('repo', 'GITHUB_REPO');
  const pullNumber = Number(getValue('pull-number', 'GITHUB_PULL_NUMBER'));
  const githubToken = getValue('github-token', 'GITHUB_TOKEN');
  const llmProvider = (getValue('llm-provider', 'LLM_PROVIDER', 'openrouter') as LLMProvider);
  const llmApiUrl = getValue('llm-api-url', 'LLM_API_URL', 'https://openrouter.ai/api/v1');
  const llmApiKey = getValue('llm-api-key', 'LLM_API_KEY');
  const llmModel = getValue('llm-model', 'LLM_MODEL', 'openrouter/free');
  const reviewMode = (getValue('review-mode', 'REVIEW_MODE', 'both') as ReviewMode);

  if (!owner || !repo || !pullNumber || !githubToken || !llmApiKey) {
    console.error('Missing required arguments. Use --owner, --repo, --pull-number, --github-token, --llm-api-key.');
    process.exit(1);
  }

  await runReview({
    owner,
    repo,
    pullNumber,
    githubToken,
    llmProvider,
    llmApiUrl,
    llmApiKey,
    llmModel,
    reviewMode,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
