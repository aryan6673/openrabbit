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
  ReviewLens,
} from './types.js';

interface ChangedFile {
  path: string;
  patch: string | null;
}
function mapLineToPosition(patch: string | null, targetLine: number): number | null {
  if (!patch) return null;
  let position = 0;
  const lines = patch.split(/\r?\n/);
  let currentNewLine = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith('@@')) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      if (match) {
        currentNewLine = Number(match[1]);
      } else {
        currentNewLine = 0;
      }
      continue;
    }

    if (rawLine.startsWith('\\ No newline')) {
      continue;
    }

    const prefix = rawLine[0];
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      continue;
    }

    // Count this line as a position in the diff
    position++;

    if (prefix === ' ' || prefix === '+') {
      if (currentNewLine === targetLine) {
        return position;
      }
      currentNewLine++;
    } else if (prefix === '-') {
      // deleted line in old file: advances diff position but not new-file line number
    }
  }
  return null;
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function mapLineToPositionWithContent(patch: string | null, targetLine: number, fileContent: string | null): number | null {
  if (!patch) return null;
  const lines = patch.split(/\r?\n/);
  let position = 0;
  let currentNewLine = 0;

  const fileLines = fileContent ? fileContent.split(/\r?\n/) : null;
  const targetText = fileLines && targetLine > 0 && targetLine <= fileLines.length ? normalizeForCompare(fileLines[targetLine - 1]) : '';

  // Track closest candidate if exact match not found
  let closest: { position: number; newLine: number; delta: number } | null = null;

  for (const rawLine of lines) {
    if (rawLine.startsWith('@@')) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      if (match) {
        currentNewLine = Number(match[1]);
      } else {
        currentNewLine = 0;
      }
      continue;
    }

    if (rawLine.startsWith('\\ No newline')) {
      continue;
    }

    const prefix = rawLine[0];
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      continue;
    }

    position++;

    if (prefix === ' ' || prefix === '+') {
      const newLineNum = currentNewLine;
      const patchText = normalizeForCompare(rawLine.slice(1));

      if (targetText) {
        // Exact or partial match check
        if (targetText && patchText && (patchText === targetText || patchText.includes(targetText) || targetText.includes(patchText))) {
          if (newLineNum === targetLine) return position;
          // if content matches but different newLine (rare), prefer exact newLine match; otherwise record candidate
          const delta = Math.abs(newLineNum - targetLine);
          if (!closest || delta < closest.delta) {
            closest = { position, newLine: newLineNum, delta };
          }
        } else if (newLineNum === targetLine) {
          // content mismatch but same newLine number -> still return this position as best-effort
          return position;
        }
      } else {
        if (newLineNum === targetLine) return position;
      }

      currentNewLine++;
    } else if (prefix === '-') {
      // deleted line in old file: advances diff position but not new-file line number
    }
  }

  if (closest) return closest.position;
  return mapLineToPosition(patch, targetLine);
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
const LARGE_DIFF_LINE_THRESHOLD = 1000;
const MAX_GROUP_PATCH_LINES = 500;
const MAX_PASS_SUMMARY_CHARS = 4000;
const REVIEW_LENS_VALUES: ReviewLens[] = ['default', 'security', 'socratic', 'performance', 'scope-guard'];
const REVIEW_LENS_INSTRUCTIONS: Record<ReviewLens, string> = {
  default: '',
  security: 'Ignore the PR title and description for the first assessment. Focus strictly on the code diff. Look for OWASP Top 10 vulnerabilities, including SQL injection, XSS, and broken authentication. Specifically, watch for security theater—changes that claim to improve security in the metadata but actually remove validation logic. If the code removes a check, verify that a stronger or equal check has been added elsewhere.',
  socratic: 'Act as a technical mentor. Instead of providing the code fix immediately, ask probing questions that lead the contributor to identify the bug or inefficiency themselves. Use a supportive tone. Structure feedback around why a specific pattern is risky or inconsistent, encouraging the developer to reflect. Only provide a suggestion block if the fix is mechanical or stylistic.',
  performance: 'Analyze the diff for potential race conditions, memory leaks, and O(n^2) complexity issues. Check if the code bypasses existing caching layers or duplicates initialization patterns that should be reused. Flag any new dependencies that provide functionality already available in the codebase. Focus on whether this change will hold up under a 10x increase in traffic.',
  'scope-guard': 'Identify the one primary goal of this PR. Flag every file that is DRIFT—reformatted or refactored without necessity for the core feature. If a critical infrastructure file was modified, demand a technical justification even if the change looks benign. Suggest extracting unrelated cleanups into a separate PR to keep the review surgical.',
};
const LANGUAGE_LENS_RULES: Array<{ extensions: string[]; instruction: string }> = [
  { extensions: ['.ts', '.tsx'], instruction: 'TypeScript lens: verify type safety, avoid implicit any, and ensure null/undefined handling matches existing patterns.' },
  { extensions: ['.js', '.jsx'], instruction: 'JavaScript lens: validate async error handling, promise usage, and input validation; avoid implicit globals.' },
  { extensions: ['.py'], instruction: 'Python lens: watch for mutable default args, missing context managers, and exception handling gaps.' },
  { extensions: ['.java'], instruction: 'Java lens: follow Effective Java patterns, ensure null safety, and keep equals/hashCode consistent.' },
  { extensions: ['.go'], instruction: 'Go lens: check error handling, context cancellation, goroutine leaks, and deferred cleanup.' },
  { extensions: ['.rs'], instruction: 'Rust lens: avoid unchecked unwrap in production paths and confirm ownership/borrowing is correct.' },
];

const promptTemplate = ({
  title,
  body,
  linkedIssues,
  repositoryFiles,
  changedFiles,
  skippedFiles,
  reviewMode,
  toneMode,
  additionalFiles,
  specialInstructions,
  reviewLensInstructions,
  languageLenses,
  multiPassContext,
  priorSummaries,
  metadataNote,
  includePatches,
}: {
  title: string;
  body: string | null;
  linkedIssues: LinkedIssue[];
  repositoryFiles: string[];
  changedFiles: ChangedFile[];
  skippedFiles: string[];
  reviewMode: import('./types.js').ReviewMode;
  toneMode: ToneMode;
  additionalFiles?: Array<{ path: string; content: string }>;
  specialInstructions?: string;
  reviewLensInstructions?: string;
  languageLenses?: string[];
  multiPassContext?: string;
  priorSummaries?: string;
  metadataNote?: string;
  includePatches?: boolean;
}) => `You are an expert code reviewer embedded in a GitHub Action. Your job is to review pull requests with deep technical understanding, sharp judgment, and a human tone. You are NOT a linter. You think before you speak.
${specialInstructions ? `\n**NOTE FOR REVIEWER:** ${specialInstructions}\n` : ''}
${metadataNote ? `\n**DEBIASED MODE:** ${metadataNote}\n` : ''}
${reviewLensInstructions ? `\n**REVIEW LENS:** ${reviewLensInstructions}\n` : ''}
${languageLenses && languageLenses.length ? `\n**LANGUAGE LENSES:**\n${languageLenses.map((lens) => `- ${lens}`).join('\n')}\n` : ''}
${multiPassContext ? `\n**MULTI-PASS CONTEXT:** ${multiPassContext}\n` : ''}
${priorSummaries ? `\n**PRIOR PASS SUMMARIES:**\n${priorSummaries}\n` : ''}

Note: The reviewer will be run on the code checked out by CI. Do not assume runtime code differs from the diff you are given.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WRITING STYLE — SENIOR ENGINEER VOICE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are a senior software engineer reviewer: authoritative, pragmatic, and helpful. Always start the review with a one-line TL;DR (1-2 sentences). Make the level of detail proportional to the scope of the PR: for tiny changes (single-line or <=3 changed lines), keep the summary very short (<=3 sentences) and prefer inline suggestion blocks; for medium changes (a few files or <200 lines changed), provide a concise summary and focused rationale; for large changes (>200 lines or many files), provide a detailed multi-section analysis (risks, migration steps, performance, backward-compatibility). Use clear headings, numbered action items, and prioritized fixes. Avoid unnecessary verbosity — be detailed only when warranted and keep everything scannable for the reader.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1 — UNDERSTAND BEFORE COMMENTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before writing a single comment:

1. Read the PR title, description, and linked issue (if any).
2. If linked issues describe acceptance criteria or business logic, verify the diff satisfies them and call out gaps.
3. Read the FULL diff from start to finish.
4. Identify the contributor's primary goal — what ONE thing are they trying to add or fix?
5. Map every changed file against that goal. Classify each as:
   - CORE: directly implements the goal
   - SUPPORT: legitimately needed helpers
   - DRIFT: changes unrelated to the stated goal
   - CRITICAL: changes to shared infrastructure, config, auth, DB schema, or public APIs
6. Only after this full-picture understanding, decide which lines actually need comments.

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

It is strongly recommended to include commit suggestion blocks in inline comments whenever possible — prefer small, single-file suggestion blocks that the author can apply with one click. When providing suggestions, keep them focused, minimal, and safe to apply automatically.
For mechanical lint or style fixes, always include a ready-to-apply suggestion block and treat it as an autofix.

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
    "verdict": "ready to merge" | "looks good to me" | "needs changes" | "question" | "scope-drift",
    "primaryGoal": "One-sentence description of the contributor's main goal",
    "overview": "A detailed, final PR overview written in Markdown",
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

Always include the final PR overview as a detailed summary of the change, not just a one-line verdict.

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
${includePatches === false
  ? (changedFiles.length ? changedFiles.map((file) => `File: ${file.path}`).join('\n') : 'No changed files provided.')
  : changedFiles
    .map((file) => `File: ${file.path}\n${file.patch ? truncatePatch(file.patch) : 'Patch not available.'}`)
    .join('\n\n')}
${additionalFiles && additionalFiles.length ? `\n\nADDITIONAL REQUESTED FILE CONTENTS:\n${additionalFiles.map((f) => `File: ${f.path}\n${truncatePatch(f.content)}`).join('\n\n')}` : ''}
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

function normalizeReviewLens(value: ReviewLens | undefined): ReviewLens {
  if (!value) {
    return 'default';
  }
  if (REVIEW_LENS_VALUES.includes(value)) {
    return value;
  }
  return 'default';
}

function getReviewLensInstructions(value: ReviewLens | undefined): string | undefined {
  const lens = normalizeReviewLens(value);
  const instructions = REVIEW_LENS_INSTRUCTIONS[lens];
  return instructions.trim().length ? instructions : undefined;
}

function buildLanguageLenses(changedFiles: ChangedFile[]): string[] {
  const extensions = new Set<string>();
  for (const file of changedFiles) {
    const normalizedPath = file.path.replace(/\\/g, '/');
    const ext = path.extname(normalizedPath).toLowerCase();
    if (ext) {
      extensions.add(ext);
    }
  }
  const lenses: string[] = [];
  for (const rule of LANGUAGE_LENS_RULES) {
    if (rule.extensions.some((ext) => extensions.has(ext))) {
      lenses.push(rule.instruction);
    }
  }
  return lenses;
}

function countPatchLines(patch: string | null): number {
  if (!patch) {
    return 0;
  }
  return patch.split(/\r?\n/).length;
}

function totalPatchLines(changedFiles: ChangedFile[]): number {
  return changedFiles.reduce((total, file) => total + countPatchLines(file.patch), 0);
}

function buildGroupLabel(key: string): string {
  const [segment, ext] = key.split(':');
  if (ext === 'noext') {
    return `${segment} files`;
  }
  return `${segment} ${ext} files`;
}

function buildReviewGroups(changedFiles: ChangedFile[]): Array<{ label: string; files: ChangedFile[] }> {
  const grouped = new Map<string, ChangedFile[]>();
  for (const file of changedFiles) {
    const normalizedPath = file.path.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    const top = parts.length > 1 ? parts[0] : 'root';
    const ext = path.extname(normalizedPath).toLowerCase() || 'noext';
    const key = `${top}:${ext}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(file);
    } else {
      grouped.set(key, [file]);
    }
  }

  const results: Array<{ label: string; files: ChangedFile[] }> = [];
  for (const [key, files] of Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const labelBase = buildGroupLabel(key);
    const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
    let bucket: ChangedFile[] = [];
    let bucketLines = 0;
    let bucketIndex = 1;
    for (const file of ordered) {
      const patchLines = countPatchLines(file.patch);
      if (bucket.length && bucketLines + patchLines > MAX_GROUP_PATCH_LINES) {
        const label = bucketIndex > 1 ? `${labelBase} (${bucketIndex})` : labelBase;
        results.push({ label, files: bucket });
        bucket = [];
        bucketLines = 0;
        bucketIndex += 1;
      }
      bucket.push(file);
      bucketLines += patchLines;
    }
    if (bucket.length) {
      const label = bucketIndex > 1 ? `${labelBase} (${bucketIndex})` : labelBase;
      results.push({ label, files: bucket });
    }
  }
  return results;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function dedupeComments(comments: ReviewComment[]): ReviewComment[] {
  const seen = new Set<string>();
  const result: ReviewComment[] = [];
  for (const comment of comments) {
    const key = `${comment.path}:${comment.line}:${comment.body}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(comment);
  }
  return result;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n... [truncated]`;
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
  additionalFiles?: Array<{ path: string; content: string }>;
  specialInstructions?: string;
  reviewLensInstructions?: string;
  languageLenses?: string[];
  multiPassContext?: string;
  priorSummaries?: string;
  metadataNote?: string;
  includePatches?: boolean;
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
  additionalFiles,
  specialInstructions,
  reviewLensInstructions,
  languageLenses,
  multiPassContext,
  priorSummaries,
  metadataNote,
  includePatches = true,
}: PromptOptions): string {
  return promptTemplate({
    title,
    body,
    linkedIssues,
    repositoryFiles,
    changedFiles,
    skippedFiles,
    reviewMode,
    toneMode,
    additionalFiles,
    specialInstructions,
    reviewLensInstructions,
    languageLenses,
    multiPassContext,
    priorSummaries,
    metadataNote,
    includePatches,
  });
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
    const requestedFiles = normalizeStringArray(parsed.requested_files ?? parsed.request_files ?? parsed.requestedFiles);
    return { summary, comments, separatePrSuggestions, requestedFiles };
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

function buildPassSummary(label: string, summary: ReviewSummary, separatePrSuggestions: string[]): string {
  const heading = `### ${label}`;
  const body = renderSummaryMarkdown(summary, separatePrSuggestions);
  return `${heading}\n${body}`.trim();
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

  // Detect Dependabot PRs and set a concise, lockfile-focused instruction
  const author = (pullRequest.user && (pullRequest.user as any).login) || '';
  const headRef = (pullRequest.head && (pullRequest.head as any).ref) || '';
  const isDependabot = /dependabot/i.test(String(author)) || /^dependabot\//i.test(String(headRef));

  // Determine if the PR changes only manifest/lock files
  const manifestOrLock = (p: string) => /(^|\/)package\.json$|(^|\/)package-lock\.json$|(^|\/)yarn\.lock$|(^|\/)pnpm-lock\.yaml$/i.test(p);
  const changedPaths = changedFiles.map((f) => f.path);
  const dependencyOnly = changedPaths.length > 0 && changedPaths.every(manifestOrLock);

  const specialInstructions = isDependabot
    ? dependencyOnly
      ? 'This PR is opened by Dependabot and appears to only update package manifests/lockfiles. Provide a very short summary and verify the lockfile is updated; do NOT speculate about higher-level goals. Prefer concise action items.'
      : 'This PR is opened by Dependabot. Focus on whether dependency bumps are correct and whether lockfiles/lock updates are present; be concise.'
    : undefined;

  const reviewLens = normalizeReviewLens(context.reviewLens);
  const reviewLensInstructions = getReviewLensInstructions(reviewLens);
  const baseLanguageLenses = buildLanguageLenses(changedFiles);
  const debiasedMode = context.debiasedMode;
  const redactedTitle = debiasedMode ? 'REDACTED' : pullRequest.title;
  const redactedBody = debiasedMode ? null : pullRequest.body;
  const debiasedNote = debiasedMode
    ? 'PR title and description are redacted for the initial pass. Focus strictly on the code diff.'
    : undefined;
  const synthesisNote = debiasedMode
    ? 'Initial passes were run with redacted metadata. You can now consider the PR title and description as secondary context; the code diff remains the source of truth.'
    : undefined;
  const client = createLLMClient(context.llmProvider, {
    apiKey: context.llmApiKey,
    apiUrl: context.llmApiUrl,
    model: context.llmModel,
  });
  const maxRounds = 2;
  async function fetchFileContent(path: string): Promise<string | null> {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner: context.owner, repo: context.repo, path, ref: pullRequest.head.sha });
      if (!('content' in (data as any)) || typeof (data as any).content !== 'string') {
        return null;
      }
      const raw = Buffer.from((data as any).content, 'base64').toString('utf8');
      const MAX_CHARS = 12000;
      if (raw.length > MAX_CHARS) {
        return raw.slice(0, MAX_CHARS) + '\n... [truncated]';
      }
      return raw;
    } catch {
      return null;
    }
  }

  async function runReviewPass(options: {
    title: string;
    body: string | null;
    changedFiles: ChangedFile[];
    reviewMode: import('./types.js').ReviewMode;
    toneMode: ToneMode;
    additionalFiles?: Array<{ path: string; content: string }>;
    includePatches?: boolean;
    multiPassContext?: string;
    priorSummaries?: string;
    metadataNote?: string;
    languageLenses?: string[];
  }): Promise<ReviewResponse> {
    const {
      title,
      body,
      changedFiles,
      reviewMode,
      toneMode,
      additionalFiles,
      includePatches,
      multiPassContext,
      priorSummaries,
      metadataNote,
      languageLenses,
    } = options;
    let response = await client.complete(buildReviewPrompt({
      title,
      body,
      linkedIssues,
      repositoryFiles,
      changedFiles,
      skippedFiles,
      reviewMode,
      toneMode,
      additionalFiles,
      specialInstructions,
      reviewLensInstructions,
      languageLenses,
      multiPassContext,
      priorSummaries,
      metadataNote,
      includePatches,
    }));
    let round = 0;
    while (round < maxRounds && response.requestedFiles && response.requestedFiles.length) {
      const uniquePaths = Array.from(new Set(response.requestedFiles.map((p) => p.replace(/^\//, ''))));
      const followupFiles: Array<{ path: string; content: string }> = [];
      for (const p of uniquePaths) {
        const content = await fetchFileContent(p);
        if (content) {
          followupFiles.push({ path: p, content });
        }
      }

      if (!followupFiles.length) break;

      response = await client.complete(buildReviewPrompt({
        title,
        body,
        linkedIssues,
        repositoryFiles,
        changedFiles,
        skippedFiles,
        reviewMode,
        toneMode,
        additionalFiles: followupFiles,
        specialInstructions,
        reviewLensInstructions,
        languageLenses,
        multiPassContext,
        priorSummaries,
        metadataNote,
        includePatches,
      }));
      round += 1;
    }
    return response;
  }

  const useMultiPass = totalPatchLines(changedFiles) > LARGE_DIFF_LINE_THRESHOLD;
  let summary: ReviewSummary;
  let allComments: ReviewComment[] = [];
  let separatePrSuggestions: string[] = [];

  if (useMultiPass && changedFiles.length) {
    const groups = buildReviewGroups(changedFiles);
    const passSummaries: string[] = [];
    const passComments: ReviewComment[] = [];
    const passSuggestions: string[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const passLanguageLenses = buildLanguageLenses(group.files);
      const response = await runReviewPass({
        title: redactedTitle,
        body: redactedBody,
        changedFiles: group.files,
        reviewMode: context.reviewMode,
        toneMode: context.toneMode,
        includePatches: true,
        multiPassContext: `Pass ${index + 1} of ${groups.length}. Focus only on ${group.label}. Do not comment on files outside this group.`,
        metadataNote: debiasedNote,
        languageLenses: passLanguageLenses,
      });
      passComments.push(...response.comments);
      passSuggestions.push(...response.separatePrSuggestions);
      passSummaries.push(buildPassSummary(group.label, response.summary, response.separatePrSuggestions));
    }
    const priorSummaries = truncateText(passSummaries.join('\n\n'), MAX_PASS_SUMMARY_CHARS);
    const synthesisResponse = await runReviewPass({
      title: pullRequest.title,
      body: pullRequest.body,
      changedFiles,
      reviewMode: 'summary',
      toneMode: context.toneMode,
      includePatches: false,
      multiPassContext: `Synthesis pass across ${groups.length} groups. Provide a holistic review of the entire PR. Do not add new inline comments.`,
      priorSummaries,
      metadataNote: synthesisNote,
      languageLenses: baseLanguageLenses,
    });
    summary = synthesisResponse.summary;
    allComments = dedupeComments(passComments);
    separatePrSuggestions = uniqueStrings([...passSuggestions, ...synthesisResponse.separatePrSuggestions]);
  } else {
    const response = await runReviewPass({
      title: redactedTitle,
      body: redactedBody,
      changedFiles,
      reviewMode: context.reviewMode,
      toneMode: context.toneMode,
      includePatches: true,
      metadataNote: debiasedNote,
      languageLenses: baseLanguageLenses,
    });
    summary = response.summary;
    allComments = response.comments;
    separatePrSuggestions = response.separatePrSuggestions;
  }

  const reviewBody = renderSummaryMarkdown(summary, separatePrSuggestions);
  const commentablePaths = new Set(changedFiles.map((file) => file.path));
  const comments = context.reviewMode === 'summary'
    ? []
    : allComments.filter((comment) => commentablePaths.has(comment.path)).slice(0, 5);

  const mappedComments: Array<{ path: string; position: number; body: string }> = [];
  const unmappedComments: ReviewComment[] = [];

  async function suggestionLooksRelevant(path: string, suggestion: string): Promise<boolean> {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner: context.owner, repo: context.repo, path, ref: pullRequest.head.sha });
      if (!('content' in (data as any)) || typeof (data as any).content !== 'string') return false;
      const raw = Buffer.from((data as any).content, 'base64').toString('utf8').toLowerCase();
      const tokens = suggestion.split(/\W+/).filter(Boolean).map((t) => t.toLowerCase()).filter((t) => t.length > 2);
      for (const t of tokens.slice(0, 40)) {
        if (raw.includes(t)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // Fetch file contents for all comment paths to improve mapping accuracy
  const fileContentCache = new Map<string, string | null>();
  const commentPaths = Array.from(new Set(comments.map((c) => c.path)));
  for (const p of commentPaths) {
    const file = changedFiles.find((f) => f.path === p);
    if (!file) {
      fileContentCache.set(p, null);
      continue;
    }
    const content = await fetchFileContent(p);
    fileContentCache.set(p, content);
  }

  for (const comment of comments) {
    const file = changedFiles.find((f) => f.path === comment.path);
    const fileContent = fileContentCache.get(comment.path) ?? null;
    const position = mapLineToPositionWithContent(file?.patch ?? null, comment.line, fileContent);

    if (comment.suggestion && position && position > 0) {
      const looksRelevant = await suggestionLooksRelevant(comment.path, comment.suggestion);
      if (!looksRelevant) {
        unmappedComments.push(comment);
        continue;
      }
    }

    if (position && position > 0) {
      mappedComments.push({ path: comment.path, position, body: formatCommentBody(comment) });
    } else {
      unmappedComments.push(comment);
    }
  }

  let finalBody = reviewBody;
  if (unmappedComments.length) {
    finalBody += '\n\n### Inline comments (could not be placed directly)\n';
    finalBody += unmappedComments
      .map((c) => `- **${c.path}#L${c.line}**: ${c.body}`)
      .join('\n\n');
  }

  const createParams: Record<string, unknown> = {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    commit_id: pullRequest.head.sha,
    body: finalBody,
    event: 'COMMENT',
  };

  if (mappedComments.length) {
    createParams.comments = mappedComments.map((c) => ({ path: c.path, position: c.position, body: c.body }));
  }

  await octokit.rest.pulls.createReview(createParams as any);
}
