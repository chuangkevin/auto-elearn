---
name: integration-robustness
description: Use whenever implementing or reviewing AI calls, Gemini calls, external APIs, retries, fan-out requests, search enrichment, fallback behavior, or any integration that can partially fail. Covers preserving user intent, retrying transient failures correctly, avoiding swallowed errors, and adding per-item timeouts in batched integrations.
---

# Integration Robustness

## Core rules

- Do not replace user intent with hardcoded fallback values after a failure.
- Preserve original user input when an AI or external dependency fails, or surface a clear error.
- Retry transient failures with backoff instead of swallowing them.
- Use per-item timeouts for batched external calls so one slow request does not block the whole batch.
- Keep search or intent keywords unchanged unless the user explicitly asked for transformation.
- In HomeProject repos, prefer `@kevinsisi/ai-core` as the default shared layer for Gemini retry, key rotation, cooldown, and related AI-call robustness instead of re-implementing them per project.

## Failure handling

- `429` and `5xx` style transient failures must be retried.
- After retries are exhausted, return the real failure mode rather than a generic silent error.
- Only apply defaults when the user provided no usable input at all.
- Classify failures clearly so orchestrators can distinguish retryable transient failures from invalid input, permission blocks, and terminal failures.

## Fan-out requests

- Any `Promise.all` over external requests must include per-item timeout control.
- Prefer partial progress over full-batch failure when possible.
- Make cache breaks, provider changes, and dependency degradation observable instead of treating them as invisible implementation details.
- When prompt or response caching exists, expose cache hit/miss, break reason, and meaningful token-drop signals so performance and cost regressions can be diagnosed.
- If the project has many API keys, do not stop at retry-time rotation only; design task scheduling or batching so work can be distributed across keys instead of stampeding the same key until `429` happens.

## Intent preservation

- Pass user keywords through unchanged into search or retrieval stages.
- If an external API ignores filters, add an explicit filtering layer before enrichment.

## References

- `CLAUDE.md` feedback rules section
- `docs/agent-architecture-checklist.md`
