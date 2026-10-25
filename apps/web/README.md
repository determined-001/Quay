# @checkout/web

`apps/web` is the Next.js (App Router) frontend for Quay, providing the public checkout experience, the merchant dashboard, and the embedded widget host.

---

## Overview

The web application serves two main surfaces:

1. **Public Checkout (`/links/[id]`, `/r/[reference]`):**
   - Renders payment details, dynamic QR codes (SEP-7 payment request URIs), and copyable addresses/memos.
   - Listens for real-time payment settlement via Server-Sent Events (SSE) from the API.
   - Supports optional in-browser wallet connection and transaction submission (Freighter, Lobstr, xBull via `@creit.tech/stellar-wallets-kit`) when enabled.
   - Hosts the embeddable modal checkout iframe consumed by [`@checkout/widget`](../../packages/widget).

2. **Merchant Dashboard (`/`):**
   - Non-custodial SEP-10 wallet authentication (`POST /auth`) issuing session JWT cookies.
   - Payment link creation and management.
   - Off-ramp cash-out initiation: quote discovery (SEP-38), customer KYC registration and consent management (SEP-12), and interactive withdrawal transfers (SEP-6).
   - API key management and webhook endpoint delivery monitoring.

---

## Scripts & Running Locally

All commands can be run from the repository root using `pnpm --filter @checkout/web <script>` or directly within `apps/web/`:

| Command | Script | Description |
| --- | --- | --- |
| `pnpm dev` | `next dev -p 3000` | Starts the development server at `http://localhost:3000`. |
| `pnpm build` | `next build` | Builds the production Next.js bundle. Automatically runs `prebuild` to compile `@checkout/widget`. |
| `pnpm start` | `next start -p 3000` | Starts the production server on port 3000 (requires `pnpm build` first). |
| `pnpm typecheck` | `tsc -p tsconfig.json` | Type-checks the Next.js application. |
| `pnpm test` | `vitest run` | Runs unit and component test suites using Vitest and Happy DOM. |
| `pnpm e2e` | `playwright test --project=local` | Runs end-to-end integration tests with Playwright against a local API instance in `E2E_TEST_MODE=1`. |
| `pnpm e2e:live` | `playwright test --project=live` | Runs live end-to-end smoke tests against deployed demo services. |

---

## Environment Variables

### Build-Time vs. Runtime Variables

Next.js handles environment variables differently depending on whether they begin with the `NEXT_PUBLIC_` prefix:

- **Build-time (`NEXT_PUBLIC_*`):**
  Variables prefixed with `NEXT_PUBLIC_` are **inlined into the JavaScript bundle at build time** (`next build`). They are exposed to code running in the visitor's browser.
  > [!IMPORTANT]
  > Changing a `NEXT_PUBLIC_*` variable in your deployment platform requires a **complete rebuild and redeployment**. Updating the environment variable on an existing container without rebuilding leaves the old value baked into client bundles. Leaving `NEXT_PUBLIC_API_URL` unset at build time will cause client API calls to fail in production (see `docs/FIXLOG.md`, BUG-1.4).

- **Runtime (Server-Only):**
  Variables without the `NEXT_PUBLIC_` prefix (such as `API_URL` or `STELLAR_NETWORK`) are accessed strictly on the server during server-side rendering (SSR) or Server Component execution. They can be configured or changed in the deployment environment without rebuilding the frontend bundle.

---

### Configuration Reference

The following table lists every `process.env.*` variable read across `apps/web/app` and `apps/web/lib`:

| Variable | Read In | Scope | Default | When to Set / Purpose |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | [`apps/web/lib/api.ts:148`](lib/api.ts) | **Build-time** (browser client) | `http://localhost:8787` (dev only) | **Required for production.** Base URL of the Quay API server called by browser client code. In production, building without this variable set throws an error to prevent leaking dev localhost fallbacks. |
| `API_URL` | [`apps/web/lib/api.ts:174`](lib/api.ts) | **Runtime** (server-only) | `NEXT_PUBLIC_API_URL` or `http://localhost:8787` | Server-side API base URL used for SSR and Server Component fetches. Set this when the web container reaches the API over an internal network (e.g. Docker container networking like `http://api:8787`) while browsers use a public URL. |
| `NEXT_PUBLIC_STELLAR_NETWORK` | [`apps/web/lib/wallet.ts:20`](lib/wallet.ts)<br>[`apps/web/app/components/WalletPayButton.tsx:16`](app/components/WalletPayButton.tsx)<br>[`apps/web/app/components/TransferStep.tsx:63`](app/components/TransferStep.tsx)<br>[`apps/web/lib/explorer.ts`](lib/explorer.ts) | **Build-time** (browser client) | `"testnet"` | Target Stellar network: `"testnet"` or `"public"`. Selects the network passphrase used by the browser to sign transactions and SEP-10 challenges, and determines default Horizon endpoints. **Must match the API's `STELLAR_NETWORK`.** |
| `NEXT_PUBLIC_HORIZON_URL` | [`apps/web/lib/wallet.ts:149`](lib/wallet.ts)<br>[`apps/web/app/components/WalletPayButton.tsx:15`](app/components/WalletPayButton.tsx)<br>[`apps/web/app/components/TransferStep.tsx:65`](app/components/TransferStep.tsx) | **Build-time** (browser client) | SDF public Horizon (`https://horizon-testnet.stellar.org` or `https://horizon.stellar.org`) | Custom Horizon server URL for browser wallet operations, balance lookups, and transaction submissions. Set when using private or dedicated Horizon nodes. |
| `NEXT_PUBLIC_ENABLE_WALLET_PAY` | [`apps/web/app/components/CheckoutClient.tsx:13`](app/components/CheckoutClient.tsx) | **Build-time** (browser client) | `false` | Feature flag enabling direct in-browser wallet connection and payments (Freighter, Lobstr, xBull via Stellar Wallets Kit) on the public checkout page. Set to `"true"` to enable. |
| `NEXT_PUBLIC_OFFRAMP_MODE` | [`apps/web/app/components/Dashboard.tsx:39,44`](app/components/Dashboard.tsx)<br>[`apps/web/app/links/[id]/page.tsx:219`](app/links/[id]/page.tsx) | **Build-time** (browser client) | `"mock"` | Mirrors the API's `OFFRAMP` setting. `"mock"` displays a "(simulated)" badge on the dashboard cash-out button; `"testanchor"` or `"anchor"` enables real anchor off-ramp flows; `"none"` hides cash-out buttons and KYC panels entirely. |
| `NEXT_PUBLIC_OFFRAMP_CURRENCY` | [`apps/web/app/components/Dashboard.tsx:34`](app/components/Dashboard.tsx) | **Build-time** (browser client) | `"NGN"` | Display fiat currency symbol in the merchant dashboard cash-out modal (e.g. `"NGN"`, `"USD"`, `"CAD"`). Should match the fiat currency quoted by the configured anchor. |
| `NODE_ENV` | [`apps/web/lib/api.ts:149`](lib/api.ts) | **Runtime** (Node environment) | Managed by Next.js (`"development"`, `"production"`, `"test"`) | Determines environment mode. In production, prevents falling back to unconfigured `http://localhost:8787`. |

---

### Test & E2E Variables

The following variables are used exclusively by Playwright testing harnesses (`apps/web/playwright.config.ts`, `apps/web/e2e/urls.ts`):

- `CI`: When set, enables headless CI configurations, strict forbidding of `.only`, and GitHub Actions reporting.
- `E2E_LIVE`: Set to `"1"` when running live verification tests (`pnpm e2e:live`) against live deployments.
- `BASE_URL`: Overrides the default base URL (`http://localhost:3000`) for E2E tests.
