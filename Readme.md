![version](https://img.shields.io/badge/version-v0.0.7-orange)

# OpenRabbit

OpenRabbit is a GitHub Action that generates PR review summaries and inline comments using a Groq-compatible LLM provider.

## Test usage

Use this repo as a workflow action in another repository:

```yaml
name: OpenRabbit PR review

on:
  pull_request:
    types: [opened, reopened, edited, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - run: node dist/action.js
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LLM_API_KEY: ${{ secrets.GROQ_API_KEY }}
          LLM_API_URL: https://api.groq.ai/v1
          LLM_MODEL: openai/gpt-oss-120b
          REVIEW_MODE: both
```

## Notes

- The action reads `GROQ_API_KEY` from repo secrets.
- This branch contains both documentation cleanup and a small review-quality TODO that the PR reviewer should catch.

# OpenRabbit

OpenRabbit is a GitHub Action that generates PR review summaries and inline comments using a Groq-compatible LLM provider.

## Test usage

Use this repo as a workflow action in another repository:

```yaml
name: OpenRabbit PR review

on:
  pull_request:
    types: [opened, reopened, edited, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - run: node dist/action.js
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LLM_API_KEY: ${{ secrets.GROQ_API_KEY }}
          LLM_API_URL: https://api.groq.ai/v1
          LLM_MODEL: openai/gpt-oss-120b
          REVIEW_MODE: both
```

## Notes

- The action reads `GROQ_API_KEY` from repo secrets.
- This branch contains both documentation cleanup and a small review-quality TODO that the PR reviewer should catch.

# OpenRabbit

OpenRabbit is a GitHub Action that generates PR review summaries and inline comments using a Groq-compatible LLM provider.

## Test usage

Use this repo as a workflow action in another repository:

```yaml
name: OpenRabbit PR review

on:
  pull_request:
    types: [opened, reopened, edited, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v5
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - run: node dist/action.js
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          LLM_API_KEY: ${{ secrets.GROQ_API_KEY }}
          LLM_API_URL: https://api.groq.ai/v1
          LLM_MODEL: openai/gpt-oss-120b
          REVIEW_MODE: both
```

## Notes

- The action reads `GROQ_API_KEY` from repo secrets.
- This branch contains both documentation cleanup and a small review-quality TODO that the PR reviewer should catch.
