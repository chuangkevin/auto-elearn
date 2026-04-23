---
name: execution-style
description: Use as the default behavior for normal HomeProject implementation work, especially when the user intent is clear, the next action is obvious, or multiple independent tasks can run in parallel. Covers direct-solution-first behavior, no redundant confirmations, clear task framing, and coordination-first parallel execution.
---

# Execution Style

Apply this skill as the default working style unless a more specific workflow skill overrides it.

## Core rules

- Read the current code, files, and runtime context before deciding on a change.
- Lead with the best solution once the root direction is clear; do not send the user through unnecessary intermediate debugging.
- Do not ask for redundant confirmation when the next action is obvious from context.
- Do not use regex to parse structured formats when explicit parsing or a proper parser is more reliable.
- If a requirement is intended to be implemented repeatedly or enforced operationally, write it into the proper rule source instead of leaving it only in chat.
- Once implementation work starts, continue driving the task until the requested work is actually complete unless the user explicitly pauses, redirects, or a real blocker requires user input.
- For complex or multi-step work, use a todo list to track required workflow checkpoints, not just implementation subtasks.
- Treat new user messages during an active task as updates to the current task unless the user explicitly pauses, cancels, or redirects the work.
- When the user asks a side question during active work, answer it and then resume the main task automatically.
- Treat exploratory testing as part of normal completion for agentic or user-facing behavior, not as optional polish.
- Re-read the governing rules at major task boundaries instead of assuming the initial read is still sufficient.
- Before implementation starts, evaluate whether the work can be split into independent implementation units for different agents.
- Split independent work into parallel subagents when the task is large enough to benefit.
- Keep the main session focused on coordination, synthesis, and final decisions.
- Frame each subtask clearly: include context, the actual problem, and the expected outcome.
- Prefer guidance and memory files for information that cannot be inferred directly from code.
- When the user is likely to reuse, forward, or paste the output, provide a copyable fenced code block version of the key content.

## Multi-agent split rule

- If the work can be cleanly split into independent implementation units, assign them to separate agents instead of stacking everything in one branch or worktree.
- The main agent should coordinate boundaries, own the integration plan, and merge the final result.
- Only keep work in one branch when the parts are too tightly coupled to split safely.

## Anti-runaway development rule

- Do not let multiple independent units pile up without intermediate review and commit checkpoints.
- After one coherent unit is implemented and reviewed, commit it before continuing into the next independent unit.
- If several agents are running in parallel, each agent-sized unit should return to a commit checkpoint instead of silently accumulating into one late mega-commit.

## Todo checkpoint rule

- For non-trivial tasks, the todo list should include workflow gates such as split assessment, reading spec/config, child branch/worktree setup when needed, verification, review, memory update, spec update, commit, and push when applicable.
- Do not rely on memory alone for required process steps; put the must-do gates in the todo list.
- Do not leave `commit` as a single final task when the work clearly contains multiple logical units.
- When a todo list is active, also present a user-visible copyable summary block that mirrors the current todo items and statuses.
- When the user adds new requirements mid-task, merge them into the active todo list instead of silently dropping the original unfinished workflow gates.

## Commit checkpoint rule

- For work that contains multiple coherent logical units, each unit should reach its own reviewer-and-commit checkpoint.
- Do not wait until every unit is finished before the first commit when the units could have been reviewed and committed incrementally.
- When multiple units belong to the same larger batch, prefer committing each unit first and pushing after the batch is complete, unless an earlier push is needed for collaboration, backup, or PR flow.
- If a user needs to create a PR, provide the PR title and a Markdown-ready PR message at the handoff point.

## Rule recall

- At the start of the task, identify the active skills and governing rules.
- After each major subtask, re-check the active rules before moving on.
- Before declaring completion, explicitly re-run the completion workflow instead of assuming the earlier checks still hold.
- Re-check the rules again when the work changes mode, such as moving from debugging to implementation, implementation to deployment, or implementation to exploratory testing.

## Rule codification

- Any implementation-bound rule should be written into the proper source: `CLAUDE.md`, a matching `skills/**/SKILL.md`, spec docs, or memory when it is a reusable lesson.
- Do not rely on conversational context alone for rules that must affect future work.

## When to parallelize

- Multiple projects are involved.
- Frontend, backend, infra, or docs can progress independently.
- Several searches, investigations, or verifications do not depend on one another.

## When not to parallelize

- One step depends directly on the output of the previous step.
- The change is small enough that coordination overhead would slow things down.

## Prompting and task framing

- State the concrete failure or goal, not just the topic.
- Include known constraints and expected end state.
- Prefer one clear unit of work per prompt or subtask.

## User-facing formatting

- For commands, prompts, PR bodies, status summaries, and other content the user may want to copy, include a fenced code block when it improves reuse.
- Keep the normal conversational explanation concise, then provide the copyable block.
- For longer progress or planning updates, prefer a short prose lead-in plus a compact Markdown or text code block containing the reusable summary.
- If showing todo progress to the user, make the copyable block reflect the same items and states as the tracked todo list.
- When the product or UI supports structured task widgets, prefer a structured todo block over plain Markdown lists.
- Structured todo UI should show explicit states such as pending, in_progress, completed, and cancelled.
- Completed items should have a clear completed-state treatment such as dimming, strike-through, or a collapsed completed section.
- When many items are completed, prefer collapsing or visually de-emphasizing completed tasks so active work remains prominent.
- The visible todo UI and any copyable todo summary must stay synchronized with the real tracked todo state.
- If the UI supports copy actions, provide a copyable summary for the todo block even when the primary display is interactive.
- Do not wrap everything in code blocks; use them for high-value reusable content rather than ordinary conversation.

## Guardrails

- Do not confuse speed with skipping context-building.
- Do not ask the user to perform checks you can perform directly.
- Do not leave work half-finished when the path is already clear.
- Do not stop at analysis, partial fixes, or status updates when the remaining path to completion is actionable.
- Do not assume you will remember the rules later; externalize the important workflow gates.
- Do not keep coding through multiple logical milestones without stopping for review and commit.
- Do not let a mid-task user interruption reset the active task unless the user clearly requested a reset.

## References

- `docs/claude-code-best-practices.md`
- `.claude-memory/feedback_execution_style.md`
- `.claude-memory/feedback_direct_solution.md`
- `.claude-memory/feedback_dont_ask.md`
- `.claude-memory/feedback_copyable_response_format.md`
- `.claude-memory/feedback_structured_todo_ui.md`
