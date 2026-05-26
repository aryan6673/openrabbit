<p align="center">
  <img src="https://cdn.hackclub.com/019dd5c5-82e4-7a61-b2f2-47d14fa325a2/Untitled%20design%20(9).png" width="128" height="128" alt="OpenRabbit icon">
</p>

<h1 align="center">OpenRabbit</h1>

<p align="center">
  free, open-source, self-hosted GitHub PR reviewer that replaces coderabbit.
</p>

<p align="center">
  <b>:copilot:</b> <a href="https://github.com/aryan6673/openrabbit/releases/latest"><b>Get Workflow</b></a><br>
  <sub></sub>
</p>

---

<p align="center">
  <img src="https://cdn.hackclub.com/019dd5c7-1c25-71b4-88c8-f04470b3d209/Untitled%20design%20(8)%20(1).png" alt="OpenRabbit demo" width="600">
</p>

<p align="center">
  <i>Thanks to the contributors and maintainers for making OpenRabbit possible.</i>
</p>

## Overview

OpenRabbit is a free (you can even get a free llm api explained below), open-source, self-hosted GitHub Pull Request reviewer. It analyzes PR diffs, consults a pluggable LLM provider (Groq / OpenRouter / others), and posts a concise, structured review: a human-readable summary and accurate inline comments or suggestions.

---

### Zero Hosting Required

You don't need to pay for a subscription or manage a server. OpenRabbit runs **completely** on your own GitHub Actions environment. Your code stays in your runner; it is never proxied or stored by a central authority.

---

## Quickstart in 2 minutes

Simply create a file at `.github/workflows/reviewer.yml` and paste the following:

```yaml
name: OpenRabbit Reviewer

on:
  pull_request_target:
    types: [opened, reopened, edited, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: OpenRabbit
        uses: aryan6673/openrabbit@main
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_provider: openrouter # Or groq
          llm_model: openrouter/free # Use world-class models for $0
          review_mode: both
          tone_mode: balanced
```

*Note: Ensure you add your `LLM_API_KEY` to your GitHub Repository Secrets. (guide below)*

---

## The Open Source Fight

**OpenRabbit is a stand for [Open Source Ethics](https://www.openresourcelibrary.com/concepts/ethics/).**

Centralized companies like **[CodeRabbit](https://www.coderabbit.ai/)** have become "blast-radius multipliers". In late 2025, a critical security vulnerability in their platform exposed [over 1 million repositories](https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories) to potential [Remote Code Execution (RCE)](https://www.cloudflare.com/learning/security/what-is-remote-code-execution/) because users were forced to grant broad write access to a third-party cloud.

OpenRabbit **destroys this risk** by shifting the power back to the developer. By running client-side in your own CI/CD, you maintain **total data sovereignty**. We believe you shouldn't have to trade your project's security for AI productivity.

---

## Features

- **Fixes the "Context Blindness" Problem**  
  Most AI reviewers act like your code exists in isolation, which is kinda dumb. OpenRabbit actually tries to understand the whole project:  
  - **Two-Stage File Fetch**: If it feels like it’s missing context, it can pull in extra files instead of just judging the diff blindly.  
  - **Linked Issue Awareness**: It reads linked GitHub issues so it knows what the code is *supposed* to do, not just if it compiles.

- **"Socratic Scaffold" (Basically a Mentor Mode)**  
  Instead of just dumping the answer, it acts like a mentor and asks questions so you figure stuff out yourself. It explains *why* something is wrong or risky, not just *what* is wrong. It only gives direct fixes when it’s something simple or obvious.

- **"Performance & Scalability Expert"**  
  This one is for serious code. It checks for things like race conditions, memory leaks, and slow logic (like O(n²)). It also makes sure you’re not ignoring caching or rewriting stuff that already exists. Basically, it asks: “Will this still work if traffic becomes 10x?”

- **"Security Auditor" (Catches Real Issues, Not Fake Ones)**  
  It ignores the PR description at first so it doesn’t get biased and just looks at the code. Then it checks for real problems like SQL injection, XSS, or broken auth. It also calls out fake “security improvements” where someone removes checks but claims things got safer.

- **No More "AI Slop"**  
  You know that polished but useless AI feedback? Yeah, this avoids that:  
  - **Suggestion Validation**: It checks if suggestions actually match your code before showing them.  
  - **Senior Engineer Voice**: It talks more like a real tech lead instead of nitpicking random naming stuff.

- **Stops "Vibe Coding" (DRIFT Detection)**  
  It flags when you change stuff that has nothing to do with the PR. Like random refactors or cleanup. It tells you to move that into a separate PR so things stay clean and easy to review.

---

## Getting a Free API Key

By default, this project uses the **OpenRouter free model pool**.  
It’s not perfect, the main issue is rate limits. To deal with that, it automatically rotates between different free models on OpenRouter so you don’t keep hitting the same limit again and again. It works, but it’s not super reliable or consistent.

If you want better performance and fewer interruptions, you should use your own API key.

---

### Option 1: Get a Free API Key from OpenRouter

1. Go to https://openrouter.ai  
2. Sign up / log in  
3. Open your dashboard  
4. Generate an API key  
5. Copy the key  

Then add it to your project:

```bash
LLM_API_KEY=your_api_key_here
```

---

## Adding Your API Key to GitHub Actions (Recommended)

Instead of putting your API key in a `.env` file, you should store it securely in **GitHub Actions secrets**. This keeps your key safe and prevents it from being exposed in your code.

### Steps to Add Your API Key

1. Go to your repository on GitHub  
2. Click on **Settings**  
3. In the left sidebar, go to **Secrets and variables → Actions**  
4. Click **New repository secret**  
5. Add your key:
   - **Name**: `LLM_API_KEY`  
   - **Value**: paste your API key  
6. Click **Add secret**

---

## Review Modes

- **summary:** single summary review comment (no inline comments)  
- **inline:** post only inline comments and suggestions  
- **both:** post both the summary and inline comments (default)

---

## Contributing

- Open an issue or PR  
- See `src/llm` for adding new provider adapters  

---

## License

Licensed under the MIT license.

---

![version](https://img.shields.io/badge/version-v0.5.6-orange)
