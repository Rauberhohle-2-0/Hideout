# Hideout — Agent Instructions

## Tool & Web Search Policy

**Not every answer needs a tool.** Be conservative:

* **Do NOT use `websearch` / `webfetch` / MCP Exa search for:**
  - Greetings, thanks, small-talk (`hi`, `how are you`, `thanks!`)
  - Casual conversation, creative writing, brainstorming without factual claims
  - Coding help that can be answered from the repo/context (`explain this file`, `fix this bug`)
  - General knowledge that hasn't changed recently

* **DO use search/tools when:**
  - The user explicitly asks (`/search`, `search:`, `look up`, `find latest`)
  - The question is time-sensitive / needs fresh data (`latest`, `today`, `current`, `2026`, `news`, `price`, `weather`, `release`, `score`)
  - You need to verify a fact / URL / citation before answering
  - The answer would be incomplete or hallucinated without external sources

* **How to decide:** If `shouldUseWebSearch`-style heuristic would return false (short, no `?` + no search keywords, greeting), skip the tool and answer directly. The wrench toggle (`toolsEnabled`) is the user's master switch — when disabled, never search. When enabled, still apply this heuristic.

* **MCP:** Prefer a single `web_search_exa` call (numResults 5) over multiple searches. Dedupe sources. Failure is non-fatal — continue without sources rather than retrying aggressively.

## General

- Use output text to communicate directly; keep answers concise and factual.
- Reference code with `file_path:line_number` when mentioning implementations.
