# Lumen Shop

Lumen Shop is the demo storefront monitored by Blast Radius. Use Node 20.19+ on the Node 20 line, or Node 22.12+.

From the repository root, install the shop dependencies and start both servers.

```sh
pnpm --filter @blast/shop-api --filter @blast/shop-web install --lockfile=false
pnpm --filter demo-shop dev
pnpm --filter demo-shop test
```

Vite serves the storefront at http://localhost:5174 and proxies API and browser telemetry requests. The Express API listens at http://localhost:4100. Start the Blast Radius agent on port 4000 to receive telemetry. The shop continues serving when the agent is down.

Set `FLAGSMITH_SERVER_KEY` and the public client-side `FLAGSMITH_ENV_KEY` in the repository root `.env` or export them in the shell. The API evaluates identities locally and refreshes its environment document every five seconds. Without a server key, the shop uses all-off defaults. The browser SDK controls the promo banner.

## Reproduce the checkout incident

Add a product and check out with `LUMEN10`. With `new_checkout` off, the order succeeds and applies 10% off. With the flag on for your identity, supplying a code triggers the planted error in `applyDiscount.ts`. Checkout without a code succeeds in either cohort. Once the API refreshes after the flag is disabled, the same discounted order succeeds again.

To generate traffic, vary `x-identity` across requests. Pass `x-cohort` when testing a cohort trait and `x-simulated: 1` for synthetic traffic.

```sh
curl -sS http://localhost:4100/api/checkout \
  -H 'content-type: application/json' \
  -H 'x-identity: demo-42' \
  -H 'x-cohort: demo' \
  -H 'x-simulated: 1' \
  --data '{"items":[{"id":"glow","quantity":1}],"discountCode":"LUMEN10"}'
```

Cart and checkout accept item IDs from `GET /api/products` and integer quantities from 1 to 99. The cart endpoint prices the supplied cart, and the storefront keeps its cart in memory. API prices and totals are in cents. The free-shipping flag value is in dollars. Request telemetry groups completed requests into five-second buckets and counts HTTP 5xx responses as errors.
