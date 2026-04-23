---
name: key-pool-standard
description: Use whenever building or reviewing a Gemini integration, AI key pool, agent key management flow, Gemini retry wrapper, or multi-key quota handling in a HomeProject repo. Ensures the implementation follows the HomeProject standard with durable cooldown persistence, error-tiered backoff, load-aware key selection, correct failing-key rotation, `gemini-2.5-flash` for agent implementation, and management APIs when the project owns key administration.
---

# Gemini Key Pool Standard

All AI agent systems in the HomeProject ecosystem must implement this standard.
Reference implementation example: `kevinsisi/project-bridge` → `src/geminiKeys.ts` + `src/geminiRetry.ts`
Analysis doc: `D:\GitClone\_HomeProject\key-pool-analysis.md`

## Checklist

Before shipping any AI feature, verify all items:

- [ ] A shared retry wrapper exists — callers never write ad hoc retry loops
- [ ] Cooldown state persisted to durable storage (survives restarts)
- [ ] Error-tiered cooldown applied (see table below)
- [ ] Keys loaded from both env vars AND DB
- [ ] Batch allocation distributes keys without hot-spotting the first few keys
- [ ] Single-request allocation is load-aware (do not always start from front keys)
- [ ] Retry rotation excludes and cools down the actual failing key, not just the initial key
- [ ] Blocked key mechanism (ENV keys can be blocked, not deleted)
- [ ] Placeholder strings filtered (`YOUR_KEY_HERE`, `xxx`, etc.)
- [ ] If the project owns key administration, provide management endpoints for import/status/block/delete/usage
- [ ] Import-time validation (test API call before accepting key)

## Error-Tiered Cooldown

| HTTP Status | Cooldown | Reason |
|-------------|----------|--------|
| 429 | 2 minutes | Rate limited — key hit RPM/RPD cap |
| 401 | 30 minutes | Invalid key |
| 403 | 30 minutes | Quota exhausted for today |
| 5xx | 30 seconds | Server error — retry sooner |

## Management REST API

If the project includes key administration UI or operational tooling, expose endpoints such as:

```
POST   /api/keys/import     Import new keys (validates each before adding)
GET    /api/keys/status      List all keys with cooldown state
DELETE /api/keys/:id         Remove a key
PUT    /api/keys/:id/block   Block a key without deleting
GET    /api/keys/usage       Usage statistics
```

## Using @kevinsisi/ai-core

For new projects, use the shared package instead of reimplementing:

```json
"@kevinsisi/ai-core": "https://github.com/kevinsisi/ai-core.git"
```

- Keep the committed lockfile aligned with the exact ai-core commit/version you verified, or pin an explicit git ref when reproducibility matters more than floating on the default branch.
- Prefer an ai-core revision that already includes load-aware allocation, atomic key leasing, and long-running lease renewal, and verify the exact consumed tag/commit instead of assuming repo head.

```ts
import { KeyPool, SqliteAdapter, withRetry } from '@kevinsisi/ai-core'

const pool = new KeyPool(new SqliteAdapter(db))
const result = await withRetry(() => pool.callGemini(prompt))
```

Important:

- Before adopting `@kevinsisi/ai-core`, verify the consumed version or pinned commit already includes load-aware allocation, atomic key leasing, long-running lease renewal, and retry rotation away from the actual failing key.
- If the published package version in a consuming repo does not yet include those behaviors, either update the dependency or patch the consumer so it still satisfies this skill.

## Gemini Model Rule

When implementing an AI agent or Gemini-backed agent workflow, use `gemini-2.5-flash` by default. Hardcode it, allow override via `GEMINI_MODEL` env.

Reason: Per-model quota is independent. Switching models burns separate quota pools.
A 5–10s thinking delay on first response is normal for this model.

## Allocation Rules

- Plain `Math.random()` over the same available array is not sufficient if it still creates front-key hot spots in practice.
- Prefer load-aware selection using signals such as in-flight count, recent assignment time, and/or recent successful usage count.
- For batch allocation, avoid returning the same early keys repeatedly when many keys are equally healthy.
- For retry flows, the key put on cooldown and excluded from the next pick must be the key that actually failed on the last attempt.
- For quota-sensitive multi-step jobs, first split the workflow into small named actions (for example: `identify-object`, `extract-features-batch-1`, `search-dimensions`, `generate-featurescript`) instead of one large opaque Gemini call.
- When healthy capacity allows, different actions within the same job should prefer different keys.
- If healthy keys are fewer than action count, later actions must explicitly fall back to shared rotation, and this must be represented as a real fallback path rather than pretending full per-action isolation still exists.
- Do not silently collapse back to one-key reuse while still claiming per-action isolation; if the design is soft preference only, document it as soft preference.
- For HomeProject repos, this quota-sensitive micro-step orchestration should be implemented in `@kevinsisi/ai-core`, not re-created separately in each consuming app.
- If a consuming repo temporarily patches around missing ai-core behavior, that patch should be treated as temporary and upstreamed back into `@kevinsisi/ai-core`.
