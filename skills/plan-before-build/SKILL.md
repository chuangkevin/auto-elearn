---
name: plan-before-build
description: Use whenever the user asks for a new project, any non-trivial feature or requirement, redesign, rewrite, or any implementation with unresolved product, UX, naming, stack, or architecture decisions. Forces exploration, OpenSpec capture, and a reviewable plan before product code is written.
---

# Plan Before Build

Do not jump directly into implementation for new projects or major features.

## Trigger conditions

- A new project is being proposed.
- A non-trivial feature or requirement is being proposed.
- A large feature introduces multiple design or architecture choices.
- A redesign changes UX, structure, deployment, or naming conventions.

## Required output

Produce a short, reviewable plan covering:

1. Problem and user goal.
2. Scope boundaries.
3. Proposed architecture or stack.
4. UI or workflow direction if applicable.
5. Deployment or integration impact.
6. Open questions needing user confirmation.

For major changes, include a short brainstorming section comparing plausible directions before recommending one.

## Implementation rule

- Use an exploration/superpower step to confirm non-trivial requirements with the user before implementation.
- Capture the confirmed non-trivial requirement in OpenSpec before implementation starts.
- Wait for user confirmation on the plan before writing product code.
- If the user only wants exploration, use the OpenSpec explore workflow instead of implementation.

## Guardrails

- Do not make silent product decisions when key tradeoffs are still open.
- Do not bury the plan inside a long narrative; keep it easy to review.

## References

- `.claude-memory/feedback_plan_first.md`
- `.github/skills/openspec-explore/SKILL.md`
