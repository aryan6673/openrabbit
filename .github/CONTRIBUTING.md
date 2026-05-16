# Contributing to OpenRabbit

Thank you for your interest in contributing.

This document is intentionally detailed. It is designed so that even a first year student can understand how this project works and start contributing without needing to read the entire codebase.

You will still need to look at small parts of the code when making changes, but after reading this guide, you should understand how everything fits together and where to look.

---

## 1. What This Project Does

OpenRabbit is a GitHub Action that reviews pull requests using an LLM.

When someone opens a pull request, this system:

1. Reads the changed files
2. Sends relevant code to an LLM
3. Gets structured feedback
4. Posts comments directly on the pull request

---

## 2. Full System Flow

This is the most important concept in the entire project.

Everything revolves around this pipeline:

```
GitHub PR
   ↓
Collect files and diffs
   ↓
Filter unnecessary files
   ↓
Build prompt
   ↓
Send to LLM
   ↓
Receive structured JSON response
   ↓
Convert response into GitHub comments
   ↓
Post review
```

If you understand this, you understand the project.

---

## 3. File Structure Explained

You do not need to explore randomly. Here is exactly what each important file does.

### src/action.ts

This is the entry point.

It:
- reads inputs from GitHub Actions
- initializes the review process
- calls the reviewer

You usually do not need to modify this unless adding new inputs.

---

### src/reviewer.ts

This is the core of the system.

It handles:
- fetching pull request files
- filtering files
- building prompts
- calling the LLM
- parsing responses
- mapping comments to correct lines
- posting results

Most contributions will involve this file.

---

### src/llm/

This folder contains LLM integrations.

Examples:
- OpenRouter
- Groq

You only touch this if:
- adding a new provider
- changing API handling

---

### src/types.ts

Contains shared TypeScript types.

Safe to modify if:
- adding new structured fields
- updating response format

---

## 4. Understanding reviewer.ts Without Reading Everything

You do not need to read the whole file. Focus on these logical blocks.

---

### Step 1: Fetch PR Files

The system gets:
- file names
- patches (diffs)
- content (sometimes)

---

### Step 2: Filter Files

Removes:
- node_modules
- dist
- lockfiles
- generated files

Reason:
- reduces token cost
- avoids useless analysis

---

### Step 3: Build Prompt

Creates a large instruction for the LLM.

Includes:
- PR metadata
- file diffs
- rules for how to review

This is where most "intelligence" comes from.

---

### Step 4: Call LLM

Sends prompt to provider.

Returns structured JSON.

---

### Step 5: Parse Response

Expected format:

```json
{
  "summary": {},
  "comments": [],
  "separate_pr_suggestions": []
}
```

If this breaks, nothing works.

---

### Step 6: Map Comments to GitHub Positions

GitHub requires:
- diff positions
not:
- line numbers

This is handled by functions like:

- mapLineToPositionWithContent

This is one of the most sensitive parts of the system.

---

### Step 7: Post Review

Uses GitHub API to:
- post inline comments
- post summary

---

## 5. Features Explained Simply

You do not need to understand implementation details to contribute.

---

### Scope Detection

Detects if code changes are unrelated to the main purpose of the PR.

---

### Review Modes

- summary
- inline
- both

Controls how feedback is posted.

---

### Review Lens

Different review styles:
- security
- performance
- socratic
- scope guard

This only changes instructions to the LLM.

---

### Debiased Mode

Removes PR description before analysis to avoid bias.

---

### Multi Pass Review

For large pull requests:
- splits files into groups
- reviews them separately
- combines results

---

### Suggestion Validation

Ensures suggestions actually match the file content before posting.

---

## 6. Safety Model

This project is designed to be safe.

- Runs inside GitHub Actions
- No backend server
- No permanent storage
- Only PR related code is sent to the LLM
- Large content is truncated
- Suggestions are validated

---

## 7. What Can Break the System

These are the most common failure points.

---

### 1. Breaking the pipeline

If this flow breaks:

```
fetch → prompt → LLM → parse → map → post
```

the system stops working.

---

### 2. Breaking JSON parsing

If LLM output format changes, parsing fails.

---

### 3. Breaking diff mapping

Incorrect mapping leads to comments appearing on wrong lines.

---

### 4. Over-modifying prompt

Too many instructions can reduce quality.

---

## 8. How to Contribute

---

### Step 1: Pick a small change

Examples:
- improve prompt wording
- fix mapping bug
- remove unused code
- add tests

---

### Step 2: Make focused changes

Do not modify multiple systems at once.

---

### Step 3: Test locally

```bash
npm test
```

---

### Step 4: Open Pull Request

Explain:
- what you changed
- why you changed it

---

## 9. Good First Contributions

- small bug fixes
- improving prompt clarity
- cleaning unused code
- adding tests
- improving documentation

---

## 10. What to Avoid

- adding large features without discussion
- copying AI generated code blindly
- changing multiple core systems together
- increasing prompt size without reason

---

## 11. When You Are Unsure

Open an issue before making changes.

It is better to discuss than to break core behavior.

---

## Final Note

You do not need to understand the entire codebase to contribute.

Focus on:
- the pipeline
- one part at a time

If you follow this guide, you should be able to contribute safely and confidently.
