---
name: completion-checklist
description: Use whenever a HomeProject code change is complete or nearly complete, or when the user asks whether something is done, updated, shipped, committed, or deployed. Every change must trigger the mandatory follow-through workflow: update memory, update spec, commit, push, plus e2e test, CI/CD check, version bump, domain update when needed, and CI/CD tracking so work is not left half-done.
---

# Completion Checklist

Every code change in the HomeProject ecosystem must complete ALL steps before reporting "done".
Every change must update memory, update spec, commit, and push, but larger work batches may reach multiple commit checkpoints before the final push.
Never ask "要我 commit 嗎？" — execute all steps automatically.

## Workflow discipline

- For non-trivial work, put the required completion gates into the todo list early so they are tracked to completion.
- After each major implementation step, re-check the active skills and rules before continuing.
- Before commit and before final reporting, re-run this checklist explicitly rather than assuming earlier steps are still satisfied.
- Use commit checkpoints for each coherent logical unit; do not accumulate many finished units and commit them all only at the end.
- When several coherent units belong to one larger delivery batch, prefer batching the `push` near the end instead of triggering CI/CD after every small commit.

## Steps (in order)

### 1. E2E Test
Verify the change works in the actual running environment on the real target host for the environment you changed.
- SSH to the actual target host (RPi, VM, workstation, or amd64 host)
- Check the service at its `https://<name>.sisihome.org` URL or direct health endpoint
- Confirm the specific feature changed works end-to-end in that deployed environment

Build check rule:
- When the repo has a local build target, run the repo's concrete build command before commit.
- Do not describe this vaguely as "驗證" if the actual required command is something like `npm run build`, `tsc && vite build`, or another concrete build command.
- In the review/completion flow, record which concrete build command was actually run.

### 2. Confirm CI/CD Pipeline Exists
Every project must have CI/CD automation, using GitHub Actions or Gitea Actions as appropriate:
- `docker-publish.yml` or equivalent — build + push container/image artifact
- `deploy.yml` or equivalent — deploy to the target environment

If missing, create them. Reference: `kevinsisi/home-media` or `kevinsisi/project-bridge`.

### 3. Version Bump
Bump version **before** committing. Locations (keep in sync):
- `packages/client/src/version.ts` — `APP_VERSION` constant
- `package.json` (root + `packages/client` + `packages/server`)

Rules:
- **Patch** (0.0.x): bug fixes, small tweaks
- **Minor** (0.x.0): new features
- **Major** (x.0.0): breaking changes, major redesign

### 4. Update Memory
Save relevant decisions to `.claude-memory/` in homelab-docs:
- New project decisions → `project_<name>.md`
- Tech choices that surprised you → `feedback_<topic>.md`
- New domain mappings → `project_domain_mapping.md`

### 5. Update Spec
- Sync CLAUDE.md if infrastructure or project info changed
- Update AutoSpec at `https://autospec.sisihome.org` (API: `http://localhost:8223` on RPi)
- Update `docs/projects.md` if project status changed

### 6. Update Domain (if new service)
- Add to Caddyfile inside `*.sisihome.org` block (HTTPS)
- Add HTTP fallback block
- Restart Caddy: `docker compose restart` in `/home/kevin/DockerCompose/caddy/`
- Add row to URL Routing Table in CLAUDE.md

### 7. Commit
Commit discipline:
- Commit after each coherent logical unit is implemented and reviewed.
- If the work can be split into multiple agent-sized units, each unit should reach its own commit checkpoint.

Write a meaningful commit message (conventional commits style):
```
feat: add SSE streaming for diary AI analysis
fix: correct key pool cooldown persistence on restart
```

### 8. Push
Push to remote using `chuangkevin` account for `kevinsisi` org repos.

Push discipline:
- Commit each coherent logical unit as it finishes.
- When several units are part of one larger work batch, prefer pushing once after the batch is complete so CI/CD is not retriggered unnecessarily.
- Push earlier only when collaboration, remote backup, or PR timing requires it.

### 8.1 PR Handoff
If the user needs to create the PR themselves, provide:
- the PR title
- the PR message/body in Markdown ready to paste

Hook note:
- Hooks should enforce commit/push gates, not PR handoff content quality. The PR title/body requirement is still mandatory, but it is enforced by workflow and review rather than by git hook.

### 9. Track CI
Watch the repository CI system until the build/publish workflow passes.
If it fails, fix the issue before proceeding.

### 10. Track CD
Watch the repository deployment workflow until it succeeds.
SSH to the actual target host and confirm the service is running:
```bash
docker ps | grep <container-name>
curl -s http://localhost:<port>/health
```
