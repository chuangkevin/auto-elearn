---
name: root-cause-debugging
description: Use whenever the user reports a bug, regression, wrong behavior, misleading UI state, silent failure, or mismatch between displayed state and actual behavior. Enforces tracing the real cause and fixing it before cosmetic or display-layer patches.
---

# Root-Cause Debugging

## Core rules

- Trace the full execution path behind the reported behavior.
- Ask what causes the behavior, not only what displays it.
- Fix the underlying cause before adding display-layer adjustments.
- Validate that the real-world failure is gone after the fix.

## Debug workflow

1. Reproduce or inspect the failing path.
2. Identify the state transition, ordering bug, or integration failure that actually causes the symptom.
3. Implement the smallest fix that removes the cause.
4. Only then clean up related UI or secondary symptoms if still needed.
5. Verify the original user-visible failure is resolved.

## Anti-patterns

- Updating a progress bar while the underlying process is still wrong.
- Masking bad state with defaults or catch-all UI patches.
- Declaring success from a partial symptom improvement.

## References

- `.claude-memory/feedback_fix_root_cause.md`
