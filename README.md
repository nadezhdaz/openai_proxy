# WhatToEat proxy

Node 22+ server for the native WhatToEat app. The OpenAI key stays in Render's environment.

## API

- GET /health
- POST /api/v1/recommendations — manual text and older versioned clients
- POST /api/v2/menu-pages/analyze — one normalized JPEG page, up to 3 MiB and 2560 px
- POST /api/v2/recommendations — structured menu and dietary profile, verified dish IDs

The former /api/ask-gpt and /api/analyze-image routes are intentionally retired. Run npm ci and npm test to verify both versioned contracts. Offline tests use synthetic JPEGs and mocked model replies; user photographs are not published.

## Deployment

The existing Render service deploys main with npm install and node server.js. Keep OPENAI_API_KEY in its existing environment. The default model is gpt-4o-mini-2024-07-18, configurable with OPENAI_MODEL. No paid resources are added by this update.

Defaults: 60 API calls/minute/IP, 200 generations/day, conservative 2,000,000 tokens/day. Budget reservations count image-reading calls as well as ranking. An explicit REQUESTS_PER_MINUTE=6 environment override should be raised to 60 for multipage use.

The budget file defaults to ./data/budget.json. On the current free Render instance, local storage is ephemeral: reservations reset after a new deployment or instance replacement. Provider-level spend limits are required; persistent budgeting requires a separately approved storage setup. Keep one server instance until shared budgeting/cache is implemented.

Responses and request hashes are cached in memory for ten minutes. Images are never stored on disk or logged. Existing text consent does not authorize photo transmission; the iOS app requests separate consent.

For live photo evaluation, put authorized JPEGs and matching reference JSONs in a local directory and run npm run evaluate -- --endpoint https://openai-proxy-3gin.onrender.com --fixtures YOUR_DIRECTORY. The gate transmits those photographs to the service. Offline tests do not certify live model accuracy or dietary safety.
