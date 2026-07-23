# ProduDash

ProduDash is a glassy operations dashboard concept for managing businesses, Shopify stores, social inboxes, AI customer replies, signals, orders, shipping, and payment verification from one place.

## Current Connection-First MVP

ProduDash is now an Electron desktop app with a secure preload bridge, local JSON persistence, and connector interfaces. It intentionally starts with no fake stores, no fake inboxes, and no fake orders. The app waits for real accounts to be connected through official APIs.

- Functional Dashboard, AI Inbox, Orders, Signals, and Integrations views with connection-required empty states.
- Content Studio for local auto-clip job planning and approval-gated short-form posting plans.
- In-app analytics framework for TikTok, Instagram Reels, and YouTube Shorts metrics once official APIs are connected.
- Local persistence under Electron `userData`.
- Secure renderer API exposed through `window.produdash`.
- Connector contracts for Shopify, Gemini, and social platforms.
- Manual credential settings for user-supplied API keys, stored separately from the renderer app state.
- Draft-only AI workflow as the default automation stance.
- Compliance-first integration copy for Shopify, Gemini, Meta, TikTok, and Stripe.

## Local Instance Model

ProduDash does not currently need app-level user accounts or an admin account. Each downloaded Electron instance is treated as its own local workspace, with its own connected business accounts and local state.

A hosted backend should be added only when needed for production integrations: OAuth callbacks, server-side API secrets, webhook verification, token refresh, optional sync across devices, or centralized user management.

## Credentials

For the local MVP, users enter their own API keys in the Integrations settings screen. Saved credential values are not returned through `window.produdash.getAppState()` and are not rendered back into the UI; the app only shows whether each required field is saved.

Current local storage is a separate Electron `userData` credentials file with restricted file permissions where supported. Before production distribution, replace this with OS credential storage such as macOS Keychain, Windows Credential Manager, or a hosted backend for OAuth-based apps.

## Run Locally

```bash
cd /Users/kokinmartinez/ProduDash
npm install
npm run app
```

That launches ProduDash as an Electron desktop app.

The browser-only preview is limited because the app depends on Electron's secure preload API:

```bash
npm run web
```

## Checks

```bash
npm run check
npm test
npm audit
npm run build
```

The smoke tests verify that no fake business data loads, old demo state is ignored, local clearing keeps the app connection-first, and connector contracts stay available.
For now, `npm run build` is a validation build; installer packaging can be added once the app identity, icon, and signing requirements are decided.

## Automation and Platform Rules

ProduDash should never rely on scraping, stealth browser automation, password sharing, private-account automation, or attempts to bypass platform limits.

Safe integration posture:

1. Shopify first: use OAuth, HMAC verification, least-privilege Admin API scopes, and webhooks.
2. Gemini second: use each user's own key for the local app, use structured output for drafts/classification/extraction, and keep human approval before external side effects.
3. Meta and Instagram: use approved Messenger Platform and Instagram Messaging APIs only, follow app review, user-initiated conversation limits, opt-ins, rate limits, and negative-feedback constraints.
4. TikTok: use TikTok API for Business or Business Messaging API only if access is approved.
5. TikTok/Reels/Shorts posting: use TikTok Content Posting APIs, Meta Instagram content publishing, and YouTube Data API uploads only after authorization. Otherwise export files for manual posting.
6. Payments: use hosted payment links and webhooks. Do not store card data.
7. AI clerk: keep Draft + Approval until a platform and the account owner explicitly allow a narrower auto-send workflow.

## Integration Roadmap

The safest production architecture is:

1. Backend API layer for OAuth callbacks, app-owned secrets, webhook verification, and external API calls that cannot safely happen inside a local client.
2. Shopify Admin API for orders, products, customers, fulfillment, and payment status.
3. Gemini API for drafting replies, classifying intent, summarizing handoffs, and extracting order details.
4. Meta and TikTok official APIs only after app review/access approval.
5. Content pipeline for source video ingestion, FFmpeg/Gemini-assisted clip candidate generation, caption drafts, destination-specific validation, and local exports.
6. Publishing connectors for TikTok Content Posting API, Meta Instagram Reels publishing, and YouTube Data API upload, all behind human approval and platform policy gates.
7. Analytics connectors for TikTok-approved reporting, Meta insights, and YouTube Analytics/Reporting APIs.
8. Human approval gates for customer messages, payment links, order creation, refunds, discounts, angry customers, ambiguous addresses, payment failures, and external publishing.
9. Audit log for every AI action, including source conversation, draft, approval/rejection, final reply, payment link, order creation, post plan, upload/export status, and staff override.

Never expose production API keys in a browser renderer. `.env.example` is documentation for a future hosted backend, not the preferred local-app setup.
