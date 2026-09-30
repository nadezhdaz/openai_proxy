# WhatToEat OpenAI Proxy

Node 22+, one server instance. No API key in the iOS app.

## Run and test

```sh
npm ci
cp .env.example .env
# Set OPENAI_API_KEY locally; use secret environment variables on Render.
npm start
npm test
```

Tests use a fake upstream, not paid OpenAI requests. `GET /health` checks the server process, not OpenAI credentials/model access.

## Versioned recommendations

`POST /api/v1/recommendations` accepts:

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "menuText": "Греческий салат\nОгурцы, помидоры, сыр фета",
  "profile": {
    "goal": "Похудение",
    "strictness": "Обычно",
    "restrictions": {
      "avoidFatty": true,
      "avoidFried": true,
      "avoidCreamSauces": true,
      "avoidSugarDesserts": true,
      "avoidAlcohol": true
    },
    "exclusions": ["молоко"],
    "preferences": []
  }
}
```

Returns a JSON object directly (not JSON inside a `result` string): `status`, `summary`, `topChoices`, `alternatives`, `rejectedHighlights`. Choices include literal menu names, explanations, warnings, modifications and clarification. `noSuitableChoices` has empty choice arrays. See `contract.js` for the schema and validation.

Structured Outputs is supported by the candidate default `gpt-4o-mini-2024-07-18`: https://developers.openai.com/api/docs/guides/structured-outputs . Availability, dietary quality and latency must be measured before release; the pinned candidate is not quality-certified. Explicit exclusions are always hard. Menu text is untrusted data, not instructions.

Menu cap: 24,000 UTF-8 bytes; total JSON body: 40kb; upstream timeout: 45 seconds (iOS timeout: 50). Repeated UUIDs reuse the pending/completed response for 10 minutes, including failures. Changed input with the same UUID returns 409. A deliberate new attempt needs a new UUID. Cache is in memory and does not survive restart.

Error categories: 400 invalid input; 409 UUID conflict; 413 body too large; 422 model refusal; 429 rate limit/upstream rate; 502 invalid/incomplete/upstream failure; 503 budget/configuration/storage/busy; 504 upstream timeout. Server logs only request UUID, status and elapsed time, not menu/profile/key.

## Legacy compatibility

- `POST /api/ask-gpt`: `{ "prompt": "..." }` -> `{ "result": "..." }`.
- `POST /api/analyze-image`: multipart `file` (JPEG/PNG, up to 5MB) and optional `context` -> `{ "result": "..." }`.
- CORS is preserved. Both legacy routes share spend and per-IP limits. New iOS code sends text only.

## Render release gates

The existing free-plan blueprint is retained; this PR does not purchase a plan or enable a persistent disk. Do not treat an ephemeral `./data/budget.json` as a production spend control across restarts/deploys.

Before enabling production traffic:

1. Confirm this repository is attached to the actual `openai-proxy-3gin.onrender.com` service, and confirm its autodeploy settings. Merge only after reviewing the rollout.
2. Configure a persistent volume and `BUDGET_FILE` on a storage-capable service (or replace counters with shared durable accounting). Keep one instance until counters/cache are shared. No paid resources are provisioned by this PR.
3. Set `OPENAI_API_KEY`, model and limits from `.env.example`; set `TRUST_PROXY_HOPS` for the verified proxy chain, not by guesswork. Configure provider-level monetary limits too. Daily request/token reservations are conservative, UTC-based, atomic and fail closed on invalid/unwritable counters.
4. Verify a real strict request, repeated UUID, conflict, rate limit and legacy routes. Confirm OpenAI credentials/model access and cold/warm latency.
5. Validate recommendations against 30 real menus and exclusions, including milk/nuts/fish/gluten/sugar/alcohol. No allergen safety claim is certified by JSON validation alone.

The API has no user accounts. Global request/token caps bound the public endpoint's exposure; add authenticated quotas before substantial public traffic or monetization. Render/provider IP and data retention must match the published privacy policy.
