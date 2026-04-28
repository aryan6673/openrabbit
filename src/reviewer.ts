import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { createLLMClient } from './llm/index.js';
import type {
  ReviewComment,
  ReviewCommentType,
  ReviewContext,
  ReviewResponse,
  ReviewSummary,
  ToneMode,
} from './types.js';

interface ChangedFile {
  path: string;
  patch: string | null;
}

interface LinkedIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
}

const MAX_PATCH_LENGTH = 4000;
const MAX_REPOSITORY_FILES = 200;
const VALID_COMMENT_TYPES: ReviewCommentType[] = ['bug', 'scope-drift', 'reuse', 'security', 'question', 'suggestion', 'style'];

const promptTemplate = ({
  title,
  body,
  linkedIssues,
  repositoryFiles,
  changedFiles,
  skippedFiles,
  reviewMode,
  toneMode,
}: {
  title: string;
  body: string | null;
  linkedIssues: LinkedIssue[];
  repositoryFiles: string[];
  changedFiles: ChangedFile[];
  skippedFiles: string[];
  reviewMode: import('./types.js').ReviewMode;
  toneMode: ToneMode;
}) => `You are an expert code reviewer embedded in a GitHub Action. Your job is to review pull requests with deep technical understanding, sharp judgment, and a human tone. You are NOT a linter. You think before you speak.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — UNDERSTAND BEFORE COMMENTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before writing a single comment:

1. Read the PR title, description, and linked issue (if any).
2. Read the FULL diff from start to finish.
3. Identify the contributor's primary goal — what ONE thing are they trying to add or fix?
4. Map every changed file against that goal. Classify each as:
   - CORE: directly implements the goal
   - SUPPORT: legitimately needed helpers
   - DRIFT: changes unrelated to the stated goal
   - CRITICAL: changes to shared infrastructure, config, auth, DB schema, or public APIs
5. Only after this full-picture understanding, decide which lines actually need comments.

Do NOT comment on a line without context of why it exists. A comment without context is noise.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2 — SCOPE GUARD (VIBE-CODER CHECK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Many contributors (especially AI-assisted ones) change far more than needed. Your job is to catch this.

For every DRIFT or CRITICAL file:
- Ask: could the contributor's feature have been built WITHOUT touching this file?
- If yes, flag it clearly with: "This file change appears outside the scope of this PR."
- Suggest extracting those changes into a separate PR.
- If a CRITICAL file (e.g. auth middleware, database model, shared config) was modified, always ask WHY, even if the change looks innocent.

For AI-generated code specifically, watch for:
- Reformatting of unrelated code (whitespace, import reordering)
- Renamed variables across the codebase
- Logic refactors that weren't requested
- New dependencies added for things already available

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 3 — REUSE & CONSISTENCY CHECK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Scan the diff for any new:
- API client initializations (HTTP clients, SDKs, service wrappers)
- Authentication patterns (API keys, tokens, OAuth flows)
- Utility functions (formatters, parsers, validators)
- Configuration loading patterns

Cross-reference with the existing codebase context provided. If a similar pattern already exists:
- Point to the existing implementation by file and function name
- Explain what can be reused
- Flag duplicate API credentials or clients as a security and cost concern

Example trigger: contributor adds a new OpenAI/Grok/Cohere client but the codebase already initializes a Gemini/Claude client. Call this out explicitly — they should use the existing AI layer or extend it, not add a parallel one.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 4 — COMMENT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Only comment on a line if at least one of these is true:
- It introduces a bug or likely runtime error
- It's a security vulnerability (even a subtle one)
- It duplicates something that already exists in the codebase
- It changes something outside the PR's stated scope
- It will cause problems at scale or under real load
- It goes against the established patterns you've seen in the rest of the codebase
- It's confusing enough that the next developer will be slowed down

Do NOT comment on:
- Code style that matches the existing codebase (consistency > perfection)
- Minor naming nitpicks unless it causes real ambiguity
- Auto-generated files (package-lock.json, .min.js, migration checksums, etc.)
- Vendor or third-party files
- Formatting if a linter is already configured

When you DO comment, ask questions freely. Examples:
- "Why is this called outside the existing \`useApi()\` hook?"
- "Is there a reason this bypasses the cache layer that \`fetchUser()\` uses?"
- "This looks like it duplicates \`src/utils/formatDate.ts\` — intentional?"

Questions are better than accusations. You're a senior engineer curious about intent, not a CI gate looking for violations.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 5 — INLINE SUGGESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When you can improve code, don't just describe the fix — provide it as a GitHub suggestion block the author can apply in one click:

\`\`\`suggestion
// your corrected code here
\`\`\`

Only suggest code you're confident in. Never suggest refactors that span multiple files in a single suggestion block.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REVIEW MODE: ${reviewMode}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode definitions:
- summary: prioritize a concise high-signal summary with only the most important findings
- inline: prioritize surgical inline comments and keep the summary brief
- both: provide a complete summary plus the best inline comments

Apply the mode lens on top of the base review — do not skip Phases 1–5.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE: ${toneMode}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tone definitions:
- balanced: calm, specific, and collaborative
- direct: concise, firm, and highly technical
- supportive: warm, explanatory, and coaching-oriented

Adjust your communication style to the selected tone.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COST-AWARE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To keep reviews focused and cost-efficient:
- Skip files matching: **/*.min.js, **/vendor/**, **/node_modules/**, **/*.lock, **/dist/**, **/generated/**
- Do not summarize or comment on files with zero logic changes (whitespace-only diffs)
- Batch related comments into a single review thread when they share the same root cause
- Prioritize: security > correctness > scope drift > reuse > style

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return a JSON object with this exact shape:

{
  "summary": {
    "verdict": "approve" | "changes-requested" | "question" | "scope-drift",
    "primaryGoal": "One-sentence description of the contributor's main goal",
    "overview": "High-level review summary in Markdown",
    "scopeAssessment": "Brief explanation of scope fit or drift",
    "riskAssessment": "Main correctness or security risks",
    "reuseNotes": ["Existing patterns or files worth reusing"],
    "actionItems": ["Specific next steps for the author"]
  },
  "comments": [
    {
      "path": "src/api/user.ts",
      "line": 42,
      "type": "bug" | "scope-drift" | "reuse" | "security" | "question" | "suggestion" | "style",
      "body": "Your comment text here",
      "suggestion": "optional replacement code without wrapping backticks"
    }
  ],
  "separate_pr_suggestions": [
    "Description of what should be extracted into its own PR"
  ]
}

If there are no inline comments, return an empty comments array.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MARKDOWN FORMATTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Do not hesitate to use Markdown in all comment bodies and the PR summary. GitHub renders Markdown natively, so use it freely to make your output clear and well-structured. This includes:

- **Bold** for emphasis on key terms, file names, or critical warnings
- \`inline code\` for any variable names, function names, file paths, or code snippets
- Fenced code blocks (\`\`\`lang) for multi-line code examples or suggestions
- > blockquotes to highlight a specific concern or call out an important question
- ### headings inside the summary body to separate sections (e.g. ### What this PR does, ### Concerns)
- Bullet lists to enumerate issues or reuse opportunities clearly
- Checkboxes (- [ ]) in the summary to give the author a clear action list when changes are needed

A well-formatted review is easier to read, faster to act on, and feels more professional. Treat every comment body as a mini GitHub comment — write it the way a thoughtful senior engineer would post it, not as raw text dumped into a field.

PR title: ${title}

PR description:
${body ?? 'No description provided.'}

Linked issues:
${formatLinkedIssues(linkedIssues)}

Repository file inventory:
${repositoryFiles.length ? repositoryFiles.map((file) => `- ${file}`).join('\n') : '- No repository inventory available.'}

Skipped files due to cost-aware rules:
${skippedFiles.length ? skippedFiles.map((file) => `- ${file}`).join('\n') : '- None'}

Changed files and patches:
${changedFiles
  .map((file) => `File: ${file.path}\n${file.patch ? truncatePatch(file.patch) : 'Patch not available.'}`)
  .join('\n\n')}
`;

function formatLinkedIssues(linkedIssues: LinkedIssue[]): string {
  if (!linkedIssues.length) {
    return '- None';
  }
  return linkedIssues
    .map((issue) => `- #${issue.number} (${issue.state}) ${issue.title}\n${issue.body ?? 'No issue body provided.'}`)
    .join('\n');
}

function truncatePatch(patch: string): string {
  if (patch.length <= MAX_PATCH_LENGTH) {
    return patch;
  }
  return `${patch.slice(0, MAX_PATCH_LENGTH)}\n... [patch truncated for token efficiency]`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function normalizeSummary(value: unknown): ReviewSummary {
  if (typeof value === 'string') {
    return {
      overview: value.trim(),
      reuseNotes: [],
      actionItems: [],
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      overview: '',
      reuseNotes: [],
      actionItems: [],
    };
  }

  const summary = value as Record<string, unknown>;
  return {
    verdict: typeof summary.verdict === 'string' ? summary.verdict.trim() : undefined,
    primaryGoal: typeof summary.primaryGoal === 'string' ? summary.primaryGoal.trim() : undefined,
    overview: typeof summary.overview === 'string' ? summary.overview.trim() : undefined,
    scopeAssessment: typeof summary.scopeAssessment === 'string' ? summary.scopeAssessment.trim() : undefined,
    riskAssessment: typeof summary.riskAssessment === 'string' ? summary.riskAssessment.trim() : undefined,
    reuseNotes: normalizeStringArray(summary.reuseNotes),
    actionItems: normalizeStringArray(summary.actionItems),
  };
}

function normalizeComment(comment: Partial<ReviewComment>): ReviewComment | null {
  if (!comment.path || typeof comment.body !== 'string') {
    return null;
  }
  const line = typeof comment.line === 'number' && comment.line > 0 ? comment.line : 1;
  const body = comment.body.trim();
  if (!body) {
    return null;
  }
  const type = typeof comment.type === 'string' && VALID_COMMENT_TYPES.includes(comment.type as ReviewCommentType)
    ? comment.type as ReviewCommentType
    : undefined;
  const suggestion = typeof comment.suggestion === 'string' && comment.suggestion.trim()
    ? comment.suggestion.trim()
    : undefined;
  return { path: comment.path, line, body, type, suggestion };
}

interface PromptOptions {
  title: string;
  body: string | null;
  linkedIssues?: LinkedIssue[];
  repositoryFiles?: string[];
  changedFiles: ChangedFile[];
  skippedFiles?: string[];
  reviewMode?: import('./types.js').ReviewMode;
  toneMode?: ToneMode;
}

export function buildReviewPrompt({
  title,
  body,
  linkedIssues = [],
  repositoryFiles = [],
  changedFiles,
  skippedFiles = [],
  reviewMode = 'both',
  toneMode = 'balanced',
}: PromptOptions): string {
  return promptTemplate({ title, body, linkedIssues, repositoryFiles, changedFiles, skippedFiles, reviewMode, toneMode });
}

export function parseReviewResponse(text: string): ReviewResponse {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const summarySource = parsed.summary ?? parsed.review ?? '';
    const summary = normalizeSummary(summarySource);
    const commentsWithNull: Array<ReviewComment | null> = Array.isArray(parsed.comments)
      ? parsed.comments.map((item: unknown) => normalizeComment(item as Partial<ReviewComment>))
      : [];
    const comments = commentsWithNull.filter((comment): comment is ReviewComment => Boolean(comment));
    const separatePrSuggestions = normalizeStringArray(parsed.separate_pr_suggestions);
    return { summary, comments, separatePrSuggestions };
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return parseReviewResponse(trimmed.slice(first, last + 1));
    }
    return {
      summary: {
        overview: trimmed,
        reuseNotes: [],
        actionItems: [],
      },
      comments: [],
      separatePrSuggestions: [],
    };
  }
}

function shouldSkipFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  if (normalized.endsWith('.min.js') || normalized.endsWith('.lock') || normalized.endsWith('package-lock.json')) {
    return true;
  }
  return segments.includes('vendor') || segments.includes('node_modules') || segments.includes('dist') || segments.includes('generated');
}

function hasLogicChange(patch: string | null): boolean {
  if (!patch) {
    return true;
  }
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith('+') && !line.startsWith('-')) {
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.slice(1).trim().length > 0) {
      return true;
    }
  }
  return false;
}

async function fetchPullRequestFiles(octokit: Octokit, owner: string, repo: string, pull_number: number) {
  const changedFiles: ChangedFile[] = [];
  const skippedFiles: string[] = [];
  for await (const response of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  })) {
    for (const file of response.data) {
      const changedFile = { path: file.filename, patch: file.patch ?? null };
      if (shouldSkipFile(changedFile.path) || !hasLogicChange(changedFile.patch)) {
        skippedFiles.push(changedFile.path);
        continue;
      }
      changedFiles.push(changedFile);
    }
  }
  return { changedFiles, skippedFiles };
}

function extractLinkedIssueNumbers(owner: string, repo: string, body: string | null): number[] {
  if (!body) {
    return [];
  }
  const issueNumbers = new Set<number>();
  const closingKeywordPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  for (const match of body.matchAll(closingKeywordPattern)) {
    issueNumbers.add(Number(match[1]));
  }

  const issueUrlPattern = new RegExp(`https://github\\.com/${owner}/${repo}/issues/(\\d+)`, 'gi');
  for (const match of body.matchAll(issueUrlPattern)) {
    issueNumbers.add(Number(match[1]));
  }

  return Array.from(issueNumbers).filter((value) => Number.isInteger(value) && value > 0).slice(0, 3);
}

async function fetchLinkedIssues(octokit: Octokit, owner: string, repo: string, body: string | null): Promise<LinkedIssue[]> {
  const issueNumbers = extractLinkedIssueNumbers(owner, repo, body);
  const linkedIssues: LinkedIssue[] = [];
  for (const issueNumber of issueNumbers) {
    try {
      const { data } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      linkedIssues.push({
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        state: data.state,
      });
    } catch {
      // Ignore individual issue lookup failures so the review can still proceed.
    }
  }
  return linkedIssues;
}

async function collectRepositoryFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= MAX_REPOSITORY_FILES) {
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (results.length >= MAX_REPOSITORY_FILES) {
        return;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
      if (!relativePath) {
        continue;
      }

      const normalized = relativePath.toLowerCase();
      if (entry.isDirectory()) {
        if (normalized === '.git' || normalized === 'node_modules' || normalized === 'dist' || normalized === 'vendor') {
          continue;
        }
        await walk(absolutePath);
        continue;
      }

      if (!/\.(ts|tsx|js|jsx|json|ya?ml|md)$/i.test(entry.name)) {
        continue;
      }

      results.push(relativePath);
    }
  }

  await walk(rootDir);
  return results;
}

function renderSummaryMarkdown(summary: ReviewSummary, separatePrSuggestions: string[]): string {
  const sections: string[] = [];

  if (summary.verdict) {
    sections.push(`### Verdict\n**${summary.verdict}**`);
  }
  if (summary.primaryGoal) {
    sections.push(`### Primary Goal\n${summary.primaryGoal}`);
  }
  if (summary.overview) {
    sections.push(`### Overview\n${summary.overview}`);
  }
  if (summary.scopeAssessment) {
    sections.push(`### Scope Assessment\n${summary.scopeAssessment}`);
  }
  if (summary.riskAssessment) {
    sections.push(`### Risk Assessment\n${summary.riskAssessment}`);
  }
  if (summary.reuseNotes.length) {
    sections.push(`### Reuse Notes\n${summary.reuseNotes.map((item) => `- ${item}`).join('\n')}`);
  }
  if (summary.actionItems.length) {
    sections.push(`### Action Items\n${summary.actionItems.map((item) => `- [ ] ${item}`).join('\n')}`);
  }
  if (separatePrSuggestions.length) {
    sections.push(`### Separate PR Suggestions\n${separatePrSuggestions.map((item) => `- ${item}`).join('\n')}`);
  }

  return sections.join('\n\n').trim() || 'Automated PR review generated by OpenRabbit.';
}

function formatCommentBody(comment: ReviewComment): string {
  const prefix = comment.type ? `**${comment.type}:** ` : '';
  const suggestionBlock = comment.suggestion ? `\n\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\`` : '';
  return `${prefix}${comment.body}${suggestionBlock}`;
}

export async function runReview(context: ReviewContext): Promise<void> {
  const octokit = new Octokit({ auth: context.githubToken });
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
  });

  const [{ changedFiles, skippedFiles }, linkedIssues, repositoryFiles] = await Promise.all([
    fetchPullRequestFiles(octokit, context.owner, context.repo, context.pullNumber),
    fetchLinkedIssues(octokit, context.owner, context.repo, pullRequest.body),
    collectRepositoryFiles(process.cwd()),
  ]);

  const prompt = buildReviewPrompt({
    title: pullRequest.title,
    body: pullRequest.body,
    linkedIssues,
    repositoryFiles,
    changedFiles,
    skippedFiles,
    reviewMode: context.reviewMode,
    toneMode: context.toneMode,
  });
  const client = createLLMClient(context.llmProvider, {
    apiKey: context.llmApiKey,
    apiUrl: context.llmApiUrl,
    model: context.llmModel,
  });
  const response = await client.complete(prompt);
  const reviewBody = renderSummaryMarkdown(response.summary, response.separatePrSuggestions);
  const commentablePaths = new Set(changedFiles.map((file) => file.path));
  const comments = context.reviewMode === 'summary'
    ? []
    : response.comments.filter((comment) => commentablePaths.has(comment.path)).slice(0, 5);

  await octokit.rest.pulls.createReview({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    commit_id: pullRequest.head.sha,
    body: reviewBody,
    event: 'COMMENT',
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      body: formatCommentBody(comment),
      side: 'RIGHT',
    })),
  });
}
