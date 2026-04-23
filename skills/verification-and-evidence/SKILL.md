---
name: verification-and-evidence
description: Use whenever claiming that a change works, reporting runtime behavior, summarizing CI/CD or deployment status, or answering questions like whether something is updated, live, shipped, or passing. Enforces real verification, trustworthy evidence, and explicit status reporting instead of assumptions.
---

# Verification And Evidence

## Core rules

- Verify behavior in a real runnable environment whenever feasible.
- Do not report CI, CD, or runtime status from guesswork or superficial signals.
- Use a trustworthy source for status claims.
- Prefer direct service checks, API responses, logs, or deployment records over indirect summaries.

## Evidence standards

- Runtime: actual page load, endpoint response, health check, or service process state.
- CI: GitHub Actions, Gitea API, or equivalent system of record.
- CD: deployment workflow result plus runtime validation on the target environment.
- Long-running agent or worker systems should expose machine-readable status such as health reports, worker state, blockers, and last error without requiring transcript scraping.

## Work style rules

- Treat "有沒有更新？" as a request to complete the full follow-through path, not as a request for a verbal status guess.
- Do not trust WebFetch alone for CI state parsing when stronger evidence is available.

## Guardrails

- Do not stop at local static review if the task requires runtime confidence.
- Do not claim success before evidence exists.
- Prefer explicit status surfaces such as `doctor`, `status`, diagnostics output, or worker-state files over ad hoc narrative summaries.

## References

- `CLAUDE.md` work style section
- `skills/completion-checklist/SKILL.md`
- `docs/agent-architecture-checklist.md`
