---
name: frontend-design
description: Use whenever creating, redesigning, polishing, or reviewing a HomeProject frontend, page, dashboard, or UX flow. Enforces distinct non-generic visual design, proper Traditional Chinese copy, mobile-first interaction quality, and HomeProject frontend standards.
---

# Frontend Design — HomeProject Standard

## Tech Stack

- **Framework**: React + TypeScript + Vite (primary)
- **Styling**: Tailwind CSS
- **Lightweight alternative**: Alpine.js + Tailwind (for simple, server-rendered pages like sheet-to-car)
- **Language**: Traditional Chinese (繁體中文) for all UI text, labels, and messages

## Design Principles

### Avoid Generic AI Aesthetics
Do not produce the default "AI-generated" look:
- No purple/blue gradients as the main theme
- No rounded-everything cards with drop shadows on everything
- No predictable hero → features → CTA grid layout
- No placeholder Inter/Arial as the only font choice

### Choose a Tone
Pick an extreme and commit to it. Options:
- **極簡 (Minimal)**: maximum whitespace, monochrome, one accent color
- **密集資訊 (Dense)**: data-heavy dashboard feel, tight grid, muted palette
- **有機 (Organic)**: soft shapes, warm colors, irregular layout
- **編輯感 (Editorial)**: strong typography, asymmetric layout, bold contrast
- **工業感 (Industrial)**: dark theme, mono font, sharp edges

### Typography
- Use a distinctive font pairing — not just system-ui
- Headings: bold weight with tight tracking for Chinese characters
- Body: comfortable line-height (1.6+) for Chinese readability

### Color
- One strong accent color per project (not "brand blue")
- Backgrounds: off-white or dark — avoid pure #FFFFFF / #000000
- Status colors: follow Tailwind semantic (green=success, red=error, yellow=warning)

### Motion
- Subtle transitions on interactive elements (`transition-colors`, `transition-opacity`)
- Loading states: skeleton screens or spinner — never blank
- SSE/streaming: animate incoming text character-by-character or fade-in per chunk

## Component Patterns

### Service Card (Portal)
```tsx
// Offline: grey opacity + red badge
// Online: full opacity + status indicator
<div className={`rounded-lg p-4 ${offline ? 'opacity-50 grayscale' : ''}`}>
```

### Version Footer
Every project shows version in footer:
```tsx
// version.ts
export const APP_VERSION = '1.2.3'

// AppFooter.tsx
<footer>v{APP_VERSION}</footer>
```

### Version Update Prompt
For user-facing HomeProject apps, add a lightweight release-notes prompt on the first open after an upgrade:
- Compare current app version with the last seen version stored locally.
- If the version changed, show a concise modal or sheet such as `在你不在的時候，我們加入了這些功能`.
- Keep the content short: 1-5 highlights per version, written in Traditional Chinese.
- Prefer a frontend changelog data file over hardcoding copy directly in the component tree.
- Dismiss once per version by updating the stored `lastSeenVersion`.
- The prompt should inform, not block core work; keep it easy to dismiss.

### Auth State
Use JWT httpOnly cookie — no localStorage tokens.
`AuthContext` → `PrivateRoute` → protected pages pattern.

### Mobile First
- Touch targets minimum 44px height
- Navigation: bottom tab bar or collapsible top nav on mobile
- Chat/streaming UI: fixed input at bottom, scrollable message list above

## What to Avoid

- Regex for Caddyfile/structured config parsing — use brace counting
- `localStorage` for auth tokens — use httpOnly cookies
- Blocking UI during AI calls — always show progress/streaming
- Alert/confirm dialogs — use inline feedback or toast notifications
- Emojis in code unless user explicitly requested them
