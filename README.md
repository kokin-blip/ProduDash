# ProduDash

ProduDash is a local-first Electron dashboard for merchant operations. The secure MVP connects Shopify data, validates a Gemini API key for approval-only drafting, and keeps incomplete social, publishing, analytics, and media features visibly separated from working functionality.

## What works

- Recoverable schema-versioned local state with atomic writes, last-known-good backups, bounded recovery snapshots, and a 500-entry audit log.
- OS-protected credential encryption through Electron `safeStorage`; decrypted values remain in the main process.
- Shopify GraphQL Admin API connection and refresh using API version `2026-07`.
- Up to 100 recent products and 100 recent orders per refresh, with cursor pagination and safe partial-sync reporting.
- Locally derived revenue, order, fulfillment, and zero-inventory signals based only on imported Shopify data.
- Gemini `gemini-3.6-flash` connection validation and structured customer-support drafts.
- Human approval gates for AI drafts and local post-export plans.
- Hardened Electron renderer isolation, restrictive CSP, trusted IPC senders, blocked navigation/windows, and normalized errors.
- Local clip and post planning queues that state clearly that no media processing or external publishing occurs.

## What is not implemented

- Social inbox imports or external message sending.
- Automatic order creation, payments, refunds, discounts, or fulfillment.
- TikTok, Instagram, Facebook, YouTube, or Stripe API connectors.
- Media analysis, clipping, rendered export files, or external publishing.
- Social analytics or Shopify profit/conversion figures without real cost and traffic inputs.
- Hosted accounts, cross-device synchronization, OAuth callbacks, webhooks, or token refresh.
- Signed installers, notarization, automatic updates, or production release packaging.

ProduDash never substitutes scraped data, browser automation, emulators, password-based automation, fabricated analytics, or silent mock results for these missing capabilities.

## Local security model

Each installation is one local workspace. Application state is stored beneath Electron’s `userData` directory. Sensitive values are encrypted with the operating system’s credential facilities through asynchronous `safeStorage`:

- macOS uses Keychain-backed protection.
- Windows uses DPAPI-backed protection.
- Linux requires an available secure secret provider. ProduDash refuses to save secrets when Electron reports the insecure `basic_text` backend.

The encrypted credential file contains a versioned ciphertext envelope. Public metadata such as a canonical `name.myshopify.com` domain is kept separately so the renderer can describe the connection without receiving tokens.

Legacy `produdash-credentials.json` values are encrypted and the plaintext file is removed after a successful migration. JavaScript and SSD storage cannot guarantee forensic secure erasure of historical filesystem blocks or external backups.

## Connect Shopify

The local MVP accepts credentials from a merchant-owned Shopify custom app:

1. In Shopify Admin, create or select a custom app for the store.
2. Grant the minimum required Admin API scopes:
   - `read_products`
   - `read_orders`
3. Install the app and copy its Admin API access token.
4. Open **Integrations** in ProduDash.
5. Enter the canonical `name.myshopify.com` domain and the Admin API token.
6. Choose **Save and validate**.

ProduDash fetches shop identity first, then products and orders through the official GraphQL Admin API. Shopify normally exposes only the most recent 60 days of orders with `read_orders`; older orders require Shopify’s separately approved `read_all_orders` access.

Credential presence is not connection success. The UI reports `connected`, `degraded`, or `error` only after a real provider request.

Public distribution must replace manual custom-app tokens with a hosted OAuth flow, HMAC verification, least-privilege scopes, webhook verification, and token lifecycle management.

## Connect Gemini

1. Create a Gemini API key in Google AI Studio.
2. Open **Integrations** in ProduDash.
3. Enter the key and choose **Save and validate**.

ProduDash makes a small structured validation request before marking Gemini connected. Draft requests include only the selected business, bounded operator instruction, and the latest bounded messages from one conversation.

Gemini output is schema-validated before storage. It can produce a draft, intent, summary, possible order details, a recommended action, and risk flags. It cannot send a message or perform an external side effect.

## Reset and deletion

- **Reset dashboard data** clears imported businesses, snapshots, local plans, approvals, and audits while retaining encrypted credentials. Integrations return to a disconnected state until refreshed.
- **Remove** on an integration deletes that integration’s credentials and marks its snapshots disconnected; already imported Shopify snapshots remain for local reference.
- **Delete all data and credentials** removes ProduDash state, backups, recovery snapshots, and the encrypted credential vault, then creates a clean local workspace.

All destructive operations require explicit confirmation in the renderer.

## Development

Requirements:

- Node.js 22
- npm 10+

```bash
cd /Users/kokinmartinez/ProduDash
npm ci
npm run app
```

Validation commands:

```bash
npm run check:syntax
npm run lint
npm run format:check
npm test
npm run test:smoke
npm run validate
npm audit --omit=dev
```

`npm run validate` runs syntax, lint, formatting, unit/integration/renderer tests, and the Electron smoke test. Tests use injected provider and encryption fakes; they never require or contact live Shopify or Gemini accounts.

The browser-only `npm run web` command can display static assets but cannot use local persistence or credentials because the secure preload bridge is available only in Electron.

## Release requirements

Installer creation is intentionally deferred. A production release still needs:

- Final application identity and bundle identifiers.
- Platform-specific icons.
- Apple Developer ID signing and notarization.
- Windows code signing.
- Linux packaging targets and secure-secret-provider documentation.
- An updater design and signed update metadata.
- A hosted backend for OAuth callbacks, app-owned secrets, webhooks, and optional cross-device synchronization.

Relevant primary documentation:

- [Shopify Admin API versioning](https://shopify.dev/docs/api/usage/versioning)
- [Shopify GraphQL products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)
- [Shopify GraphQL orders query](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
