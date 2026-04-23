---
name: project-stack-standard
description: Use whenever choosing, reviewing, or validating the implementation stack for a HomeProject app or service, especially for new projects, major rewrites, backend setup, frontend setup, database choice, package layout, or monorepo structure. Defines the default stack preferences, language consistency, and parsing rules for HomeProject repos.
---

# Project Stack Standard

Use this skill when deciding or validating the technical stack of a HomeProject project.

## Default stack

- Frontend: React + TypeScript + Vite
- Styling: Tailwind CSS
- Backend: Node.js + Express or Fastify + TypeScript
- Database: SQLite via `better-sqlite3`
- Monorepo shape: npm workspaces with `packages/server` and `packages/client` when both frontend and backend exist

## Accepted lightweight alternative

- For small or UI-light projects, Alpine.js + Tailwind is acceptable.

## Accepted Python alternative

- For Python-first services, FastAPI is the preferred backend framework.

## Language and parsing rules

- UI text should be Traditional Chinese unless the product explicitly requires another language.
- Do not parse structured formats with regex when explicit parsing or a proper parser is more reliable.

## Selection rule

- Start from the default stack unless the project requirements clearly justify a different choice.
- When deviating from the default stack, state the reason in the plan or project documentation.
- For HomeProject apps that use Gemini or long-running agent behavior, default to `@kevinsisi/ai-core` for shared AI infrastructure and runtime primitives before creating project-local wrappers.

## Relationship to other skills

- Use `plan-before-build` before implementation when the project is new or the architecture is still open.
- Use `frontend-design` for UI and interaction quality after the stack direction is chosen.
- Use `deployment` for Docker, CI/CD, and release workflow.

## References

- Former frontend and backend stack guidance from `CLAUDE.md`
