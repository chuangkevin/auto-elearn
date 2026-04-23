---
name: agent-design
description: Use whenever designing or refactoring AI agent systems, multi-agent orchestration, tool-enabled workflows, long-running agent pipelines, or parent/child agent responsibilities beyond the key-pool layer. Covers permission boundaries, context management, error isolation, sensitive-output filtering, and retry design.
---

# Agent Design

## Core design principles

- Give different agents different permission scopes.
- Manage long context deliberately; add summarization or consolidation for long-running flows.
- Isolate subagent failures so one agent does not collapse the whole pipeline.
- Filter sensitive information from agent-visible or user-visible outputs.
- Design retries with backoff and explicit failure states.
- Treat memory as a hint, not source of truth; important decisions must be re-validated against the live codebase or runtime state.
- Prefer a capability registry where tools are defined centrally with schema, permission level, and execution constraints.
- Bind subagent roles to explicit allowed-tool sets instead of giving every agent the full tool surface.
- Add anti-loop guards for repeated identical tool calls or approval cycles so the runtime can interrupt runaway behavior.
- Let persisted runtime state determine whether the agent should continue or stop; do not rely only on the model provider's finish reason.
- Long-running agents should keep an explicit active-task state instead of relying only on conversational memory.
- Agents that ask the user for confirmation of an action should persist a structured pending action so a later short reply like `可以` or `yes` can resume deterministically.
- Treat exploratory testing and human-meaning variation as first-class parts of agent design, not optional QA afterthoughts.
- Favor semantic intent classification over brittle keyword-only routing for user commands, confirmations, and follow-up replies.
- Design the runtime so new user messages can be merged into the active task without discarding the unfinished main workflow.

## Architecture checklist

- Permission gating for tools or operations.
- Context compression or summarization for long threads.
- Error isolation between parent and child tasks.
- Sensitive data filtering for keys, internal paths, and hidden system details.
- Retry behavior that distinguishes transient from persistent failures.
- Tool definitions captured as data: name, schema, permission requirement, timeout, and side-effect class.
- Role-based subagents with narrow tool allow-lists for explore, plan, implement, and verify style tasks.
- Session compaction that preserves recent verbatim turns and does not break tool-call / tool-result pair integrity.
- Layered instruction files for workspace, repo, and subdirectory guidance instead of overloading one giant prompt.
- Todo or task tracking should be formal session state, not only markdown emitted in assistant text.

## Practical guidance

- Start with a small set of roles: `Explore`, `Plan`, `Implement`, `Verify`.
- Give each role only the tools it actually needs.
- Keep permission policy outside the tool handlers so policy can evolve without rewriting every tool.
- Persist session summaries or compaction metadata so resumed work has explicit provenance.
- Persist task state separately from chat transcript when the system needs resumable execution, follow-up confirmation, or user interruptions during active work.
- Define a clear parent/child contract: delegated context, task goal, constraints, and expected output shape.
- Prefer structured child outputs over large free-form narrative handoffs.
- Give child agents explicit iteration limits, timeouts, and stop conditions.
- Make interruption handling explicit: classify each new user turn as status question, requirement update, clarification, or explicit task redirect.
- Resume the active task automatically after answering side questions unless the interrupt classifier decides the main task was cancelled or replaced.
- Keep tool-use state, streamed output state, and persisted history consistent so the runtime does not show content that later disappears from history.
- Stabilize task, team, cron, or worker-state data models before investing in heavier daemon or scheduler behavior.
- Prefer capability-registry -> permission model -> role-based subagents -> session compaction -> worker/task state -> heavier background autonomy as the adoption order.
- Consider session-scoped approval memory so already-approved tools do not create repeated ask loops inside the same run.
- Capture structured handoff data during compaction, including goals, instructions, discoveries, completed work, and relevant files.
- Keep background or autonomous work on a budget: define when the agent may act silently, when it must defer, and when it must ask.
- Separate novelty or companion UX from core runtime, permission, and memory systems.

## Active task state

- Keep a structured active task record with at least: objective, todo/checkpoints, current step, blockers, completed steps, and updated timestamp.
- Treat the transcript as an event log, not the only source of runtime state.
- If the user adds scope mid-task, merge the new requirement into the active task state and update checkpoints instead of starting from scratch.

## Confirmation and follow-up design

- When the agent asks `是否現在生成` / `要不要繼續` / similar confirmation prompts, save a structured pending action containing the action name, arguments, source turn, and expiry policy.
- Short human confirmations such as `可以`, `好`, `yes`, `直接生成` should first try to resume the pending action before asking the model to guess intent again.
- If no pending action exists, short confirmations should not silently trigger an unrelated action.

## Human-meaning testing

- Agent QA should include command-vs-question distinctions, abbreviations, short confirmations, mixed-language input, typo/colloquial variants, and multi-turn follow-ups.
- Test unsupported or ambiguous phrases on purpose so the system can prove it fails safely rather than over-triggering.
- For tool-routed behavior, verify four surfaces together: streamed response, final done state, persisted history, and actual tool side effects.

## Memory discipline

- Use persistent memory for durable preferences, architecture decisions, and hard-earned lessons.
- Prefer indexed memory: a small always-loaded index plus topic files loaded on demand.
- Update memory only after the underlying write or state change succeeded.
- Before acting on memory about code, files, or runtime state, re-read the live source to confirm it is still true.

## Safety boundaries

- Treat sensitive-output filtering as a first-class output stage, not just a prompt warning.

## Relationship to key-pool-standard

- Use `key-pool-standard` for Gemini key management specifics.
- Use this skill for broader orchestration and agent-system design choices.

## References

- `claude-code-agent-analysis.md`
- `opencode-agent-analysis.md`
- `docs/agent-architecture-checklist.md`
- `.claude-memory/feedback_agent_design_standard.md`
