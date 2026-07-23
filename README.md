# ProduDash

ProduDash is a local-first Electron dashboard for merchant operations. The secure MVP connects Shopify data, routes approval-only drafting through provider-neutral AI profiles, indexes local video, and creates human-approved clips with isolated local media tools. Media analysis is local by default and can use one explicitly selected cloud provider only after a per-job disclosure and consent. Incomplete social, publishing, advisor, and analytics features remain visibly separated from working functionality.

## What works

- Recoverable schema-versioned local state with atomic writes, last-known-good backups, bounded recovery snapshots, and a 500-entry audit log.
- OS-protected credential encryption through Electron `safeStorage`; decrypted values remain in the main process.
- Shopify GraphQL Admin API connection and refresh using API version `2026-07`.
- Up to 100 recent products and 100 recent orders per refresh, with cursor pagination and safe partial-sync reporting.
- Locally derived revenue, order, fulfillment, and zero-inventory signals based only on imported Shopify data.
- Capability-based AI provider profiles, model metadata, and independent Advisor, Inbox Drafting, Clip Analysis, and Transcription workload assignments.
- Gemini, OpenAI, Anthropic Claude, custom OpenAI-compatible, and local whisper.cpp provider adapters with injected test clients and capability-gated workloads.
- OpenAI timestamped cloud transcription and optional user-supplied whisper.cpp executable/model paths; ProduDash never downloads local models.
- Explicit local, transcript-only, transcript-plus-frames, and Gemini native-video analysis modes with exact per-job provider/model/data-category consent and no silent provider or mode fallback.
- Schema-validated AI candidates with bounded timestamps, overlap/duplicate rejection, limited boundary snapping, eleven stored component scores, and concise rationale.
- Human approval gates for AI drafts and local post-export plans.
- Hardened Electron renderer isolation, restrictive CSP, trusted IPC senders, blocked navigation/windows, and normalized errors.
- A separate atomic and recoverable Clip Library index with folder/loose-file imports, recursive scans, search, filters, tags, cached thumbnails, opaque previews, and visible missing/offline/corrupt/unsupported states.
- A durable one-at-a-time local media queue with deterministic silence/scene inspection, candidate review, cancel/retry behavior, H.264/AAC rendering, optional SRT/burned captions, thumbnails, safe manifests, and automatic Clip Library import.
- Local post planning queues that state clearly that no external publishing occurs.

## What is not implemented

- Social inbox imports or external message sending.
- Automatic order creation, payments, refunds, discounts, or fulfillment.
- TikTok, Instagram, Facebook, YouTube, or Stripe API connectors.
- External publishing or any unapproved media upload.
- Frog Advisor chat and tools.
- Social analytics or Shopify profit/conversion figures without real cost and traffic inputs.
- Hosted accounts, cross-device synchronization, OAuth callbacks, webhooks, or token refresh.
- Signed installers, notarization, automatic updates, or production release packaging.

ProduDash never substitutes scraped data, browser automation, emulators, password-based automation, fabricated analytics, or silent mock results for these missing capabilities.

## Local security model

Each installation is one local workspace. Application state is stored beneath Electron’s `userData` directory. Sensitive values are encrypted with the operating system’s credential facilities through asynchronous `safeStorage`:

- macOS uses Keychain-backed protection.
- Windows uses DPAPI-backed protection.
- Linux requires an available secure secret provider. ProduDash refuses to save secrets when Electron reports the insecure `basic_text` backend.

The encrypted credential file contains a versioned ciphertext envelope. Public metadata such as a canonical `name.myshopify.com` domain, AI profile type, models, verified capabilities, status, and workload assignments is kept separately so the renderer can describe connections without receiving tokens.

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

## Configure AI providers

1. Choose Gemini, OpenAI, Anthropic Claude, a custom OpenAI-compatible endpoint, or local whisper.cpp.
2. Open **Integrations** in ProduDash.
3. Under **AI providers**, enter the key and choose **Save and validate**.
4. Review the model’s verified capabilities and choose compatible assignments under **Workload assignments**.

ProduDash makes a small validation request before marking a cloud profile connected. Stored credentials are not treated as a successful connection. OpenAI-compatible remote endpoints require HTTPS; HTTP is accepted only for explicit loopback addresses. URLs with credentials, query strings, fragments, invalid ports, cross-origin requests, and redirects are rejected.

For local transcription, choose an existing whisper.cpp executable and model through the native file pickers. Protected paths stay in the encrypted vault and are never returned to the renderer. ProduDash does not download, update, or execute an installer for whisper.cpp or its models. After validation, assign a transcription-capable model under **Workload assignments**. “Same as advisor” resolves only when the Advisor model has the capabilities required by the inheriting workload.

Inbox draft requests include only the selected business, a bounded operator instruction, and the latest bounded messages from one conversation. Output is schema-validated before storage. It can contain a draft, intent, summary, possible order details, a recommended action, and risk flags. It cannot send a message or perform an external side effect, and ProduDash never silently switches providers.

## Clip Library

Open **Content Studio → Library** to add folders or loose video files. ProduDash:

- Recursively scans MP4, MOV, M4V, WebM, and MKV files with bounded concurrency.
- Skips symlinks and hidden folders.
- Uses bundled, version-pinned ffprobe/FFmpeg binaries only for metadata inspection and cached thumbnail creation.
- Keeps tags across rescans and exposes previews through an opaque local `produdash-media` protocol with byte-range support.
- Records unsupported, corrupt, permission-denied, missing, and detached-drive states per file.
- Stores security-scoped bookmarks in the encrypted credential vault when a macOS App Store sandbox requires them.

The library never copies, uploads, modifies, or deletes source media. Removing a video or folder removes only its ProduDash index record and cached thumbnail.

The bundled binaries are included for development, CI, local inspection, and thumbnail generation. External distribution remains blocked until the owner completes legal review of the applicable FFmpeg/ffprobe GPL obligations or supplies approved replacement builds.

## Create clips

Open **Content Studio → Create clips**, select an available library video, and choose a destination folder. ProduDash creates a collision-free job directory and:

1. Validates the source and available disk space.
2. Extracts a local analysis track, detects sustained silence and scene boundaries, and samples review frames.
3. Uses the selected analysis mode:
   - **Local heuristics** sends nothing to an AI provider.
   - **Transcript only** sends cloud audio only when cloud transcription is selected, then sends the bounded timestamped transcript to the assigned analysis provider.
   - **Transcript + frames** additionally sends up to three sampled frames.
   - **Native video** sends the complete source video to the assigned compatible Gemini model.
4. Validates candidate count, 5–180 second bounds, source bounds, confidence, near-duplicates, and overlap. Boundaries may snap by at most 1.5 seconds to a nearby scene or transcript boundary.
5. Stores hook, complete-thought, audio-clarity, visual-continuity, goal-relevance, duration, platform-fit, novelty, duplication, silence, and unusable-frame scores plus concise rationale.
6. Pauses for explicit human approval.
7. Renders only approved candidates as H.264/AAC MP4 files.
8. Optionally creates an SRT file or SRT plus burned-in captions.
9. Creates thumbnails and a safe manifest, then imports completed video artifacts into the Clip Library.

Only one media job processes at a time. Additional jobs remain queued. Coarse stage progress is persisted without writing on every FFmpeg event. If ProduDash closes mid-job, the job is marked interrupted at the next launch and can retry from validated durable artifacts; it never claims to resume a terminated process.

Temporary work lives in a hidden `.produdash-job` directory inside the selected job folder and is removed after complete success. Cancellation first requests graceful termination, then uses bounded force termination if needed. Partial generated artifacts remain user-owned, are reported without exposing absolute paths, and can be reused during an explicit retry. ProduDash never overwrites an unrecognized output file.

Public app state contains only opaque media IDs, output folder names, stages, settings, warnings, and safe artifact filenames. Source/output paths and macOS security-scoped bookmarks are stored only in the encrypted credential vault. Manifests omit absolute paths, credentials, provider payloads, and hidden reasoning.

Aspect treatment can keep the original frame, fit/pad, or center crop; fit/pad is the safe default. Caption mode defaults to Off. Cloud choices appear only when the assigned models are connected and capability-compatible. Consent is specific to one queued job and names the analysis provider/model, transcription provider/model when applicable, and the exact categories sent. A provider failure makes that job fail safely and retryably; it never switches provider, analysis mode, or data mode.

## Reset and deletion

- **Reset dashboard data** clears imported businesses, snapshots, local plans, media-job records and protected path references, approvals, audits, advisor history when introduced, the Clip Library index, and cached thumbnails. AI profiles, workload assignments, and encrypted provider/integration credentials remain. Integrations return to a disconnected state until refreshed.
- **Remove** on an integration deletes that integration’s credentials and marks its snapshots disconnected; already imported Shopify snapshots remain for local reference.
- **Delete all data and credentials** removes ProduDash state, provider metadata, indexes, cached thumbnails, stored bookmarks, backups, recovery snapshots, and the encrypted credential vault, then creates a clean local workspace.

All destructive operations require explicit confirmation in the renderer. Reset, removal, and delete-all never delete user-owned source or generated media files.

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

`npm run validate` runs syntax, lint, formatting, unit/integration/renderer tests, real tiny bundled-binary analysis/render tests, and the Electron smoke test. Provider tests use injected clients and encryption fakes; they never require or contact live Shopify, Gemini, OpenAI, Anthropic, or custom endpoints. Live-provider acceptance therefore requires owner-supplied credentials and an explicit media-consent test outside automation.

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
- [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [OpenAI models](https://developers.openai.com/api/docs/models)
- [OpenAI speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Anthropic TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
