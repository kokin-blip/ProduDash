# ProduDash

ProduDash is a local-first Electron dashboard for merchant operations. The secure MVP connects Shopify data, routes approval-only drafting through provider-neutral AI profiles, indexes local video, creates human-approved clips with isolated local media tools, and provides a read-only operations Advisor. Media analysis is local by default and can use one explicitly selected cloud provider only after a per-job disclosure and consent. Incomplete social, publishing, and analytics features remain visibly separated from working functionality.

## Internal desktop prerelease

The repository is configured for the private `0.1.0-alpha.1` desktop prerelease:

- macOS arm64 and x64 DMG and ZIP artifacts;
- a Windows x64 assisted, per-user installer;
- permanent application ID `com.kokinblip.produdash`;
- the existing PD mark as the temporary prerelease application icon; and
- no automatic updates, public publishing, or GitHub Release creation.

ProduDash packages only owner-approved, checksummed FFmpeg and ffprobe builds from the private Git LFS intake. The current npm static binaries remain development/test tools and are excluded from installers. `npm run check:distribution` intentionally blocks packaging until every native target has its approved binaries, provenance, approval reference, SHA-256 values, and license notice.

### Installing the macOS build

Internal macOS artifacts are ad-hoc signed but not notarized, so Gatekeeper blocks the first launch of a downloaded DMG. Open the DMG, drag `ProduDash.app` to `/Applications`, then either open it once and allow it under **System Settings → Privacy & Security → Open Anyway**, or clear the quarantine attribute directly:

```bash
xattr -dr com.apple.quarantine /Applications/ProduDash.app
```

This prompt is expected for an unsigned internal build and is not a malware detection. Apple Developer ID signing and notarization remain outstanding for a public release.

See [the internal prerelease guide](docs/prerelease.md) for artifact names, installation behavior, signing, verification, data locations, and the exact release blockers.

## What works

- Recoverable schema-versioned local state with atomic writes, last-known-good backups, bounded recovery snapshots, and a 500-entry audit log.
- A one-time schema v5 migration that changes the legacy default Advisor name to Juanito without preventing a user from later choosing “Advisor” or any other valid 1–40 character name.
- An idempotent schema v5→v6 migration that preserves existing media jobs as compatible `clip_generation` jobs and adds nullable project/render-plan metadata.
- OS-protected credential encryption through Electron `safeStorage`; decrypted values remain in the main process.
- Shopify GraphQL Admin API connection and refresh using API version `2026-07`.
- Up to 100 recent products and 100 recent orders per refresh, with cursor pagination and safe partial-sync reporting.
- Locally derived revenue, order, fulfillment, and zero-inventory signals based only on imported Shopify data.
- Capability-based AI provider profiles, model metadata, and independent Advisor, Inbox Drafting, Clip Analysis, and Transcription workload assignments.
- Gemini, OpenAI, Anthropic Claude, custom OpenAI-compatible, local whisper.cpp, and user-configured local Piper, Kokoro, XTTS, Chatterbox, Tortoise TTS, and RVC provider adapters with injected test clients and capability-gated workloads.
- OpenAI timestamped cloud transcription and optional user-supplied whisper.cpp executable/model paths; ProduDash never downloads local models.
- Explicit local, transcript-only, transcript-plus-frames, and Gemini native-video analysis modes with exact per-job provider/model/data-category consent and no silent provider or mode fallback.
- Schema-validated AI candidates with bounded timestamps, overlap/duplicate rejection, limited boundary snapping, eleven stored component scores, and concise rationale.
- Human approval gates for AI drafts and local post-export plans.
- A provider-neutral Advisor with session-only cloud consent, request cancellation, a five-round local tool limit, bounded business-scoped summaries, safe media/detail/help/setup tools, and a separate recoverable 50-turn visible history.
- Juanito, an original transparent frog field-scout character with idle blinking, breathing, an eight-frame periodic journal-writing sequence, thinking, success, warning, and compact avatar artwork; reduced-motion mode keeps him fully static.
- Event-driven Juanito media reactions: queue and candidate approval are only acknowledged, processing shows a working state, failed/interrupted work warns, and a full alternating celebration occurs only after a real completed transition.
- Hardened Electron renderer isolation, restrictive CSP, trusted IPC senders, blocked navigation/windows, and normalized errors.
- A separate atomic and recoverable Clip Library index with folder/loose-file imports, recursive scans, search, filters, tags, cached thumbnails, opaque previews, and visible missing/offline/corrupt/unsupported states.
- A durable one-at-a-time local media queue with deterministic audio-activity, silence, scene, and black/frozen-footage inspection; non-destructive candidate editing; transcript-derived timed captions; cancel/retry behavior; H.264/AAC rendering; thumbnails; safe manifests; and automatic Clip Library import.
- A separate atomic Projects store with lifecycle metadata, collections, tags, favorites, exact-fingerprint relinking, recoverable drafts, and up to 50 immutable saved versions.
- A local single-source editor with source/edited preview, SRT/VTT import and transcript corrections, waveform and scene overlays, ordered video/transcript/marker tracks, trim/extend/split/ripple/duplicate/reorder operations, snapping, frame stepping, comments, 100-step undo/redo, and approved multi-segment rendering.
- Recoverable local brand templates with immutable version snapshots, portable asset packages, project export/import, render-plan v2, branded caption colors/scaling, aspect/layout presets, per-cut fades, timed text/CTA overlays, and validated local logo, music, intro, and outro tracks rendered through FFmpeg.
- A separate atomic brand-asset library copies supported files into ProduDash-managed storage, serves opaque previews, validates media with FFprobe, and snapshots exact assets into every human-approved render job.
- A local publishing outbox that attaches completed renders, supports destination-specific copy and time-zone-aware planning changes before approval, summarizes upcoming and past local targets, freezes hash-verified human approval snapshots, exports path-free JSON handoffs, and states clearly that no external publishing occurs.
- A derived Shopify analytics report with explicit metric definitions, source freshness, snapshot limitations, 7/30/60-day bounded comparisons, non-causal observations, unavailable profit/conversion/social states, and a PII-free local CSV export.

## What is not implemented

- Social inbox imports or external message sending.
- Automatic order creation, payments, refunds, discounts, or fulfillment.
- TikTok, Instagram, Facebook, YouTube, or Stripe API connectors.
- External publishing or any unapproved media upload.
- Social analytics or Shopify profit/conversion figures without official reporting, cost, and traffic inputs.
- Hosted accounts, cross-device synchronization, OAuth callbacks, webhooks, or token refresh.
- Publicly distributed installers, automatic updates, or production release publishing. Internal installer configuration exists but remains blocked by the approved-media gate.
- General multi-source editing, speed/freeze effects, advanced audio mixing, animated overlays, model-generated embeddings, and hosted collaboration.

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

1. Choose Gemini, OpenAI, Anthropic Claude, a custom OpenAI-compatible endpoint, local whisper.cpp, or one of the supported local speech and voice-conversion runtimes.
2. Open **Integrations** in ProduDash.
3. Under **AI providers**, enter the key and choose **Save and validate**.
4. Review the model’s verified capabilities and choose compatible assignments under **Workload assignments**.

ProduDash makes a small validation request before marking a cloud profile connected. Stored credentials are not treated as a successful connection. OpenAI-compatible remote endpoints require HTTPS; HTTP is accepted only for explicit loopback addresses. URLs with credentials, query strings, fragments, invalid ports, cross-origin requests, and redirects are rejected.

For local transcription, choose an existing whisper.cpp executable and model through the native file pickers. Protected paths stay in the encrypted vault and are never returned to the renderer. ProduDash does not download, update, or execute an installer for whisper.cpp or its models. After validation, assign a transcription-capable model under **Workload assignments**. “Same as advisor” resolves only when the Advisor model has the capabilities required by the inheriting workload.

For local speech, choose a user-installed Piper executable and an ONNX voice
model whose matching `.onnx.json` file is beside it. ProduDash runs a real local
WAV validation before reporting the profile connected, passes text through
standard input, uses fixed argument arrays with no shell, and returns only
bounded audio. Executable/model paths and macOS bookmarks remain encrypted and
never enter renderer state. ProduDash does not bundle, download, update, or
license Piper or its voice models; review the selected runtime/model licenses
before distribution.

ProduDash also supports the separately installed `kokoro-tts` CLI. Choose its
executable and one installed voice ID, such as `af_heart`; validation generates
a bounded WAV with `--no-play --batch --save`, and later previews use that same
fixed local contract. ProduDash does not install Kokoro, `espeak-ng`, Python
packages, or model weights, and it does not support arbitrary CLI arguments or
voice mixing in this adapter.

For XTTS likeness speech, choose a Python executable from a separately managed
environment, a complete local XTTS model folder, its `config.json`, one
authorized WAV reference, and a supported language code. ProduDash’s bundled
wrapper uses the official local Python API, reads project text from standard
input, blocks network connections, and forces Hugging Face/Transformers offline
mode; it never downloads a model or Python package. Connection validation loads
the selected local model without generating a likeness. The configured voice
does not appear in Projects until the user separately accepts the first-use
likeness terms and authorizes it. Runtime/model/reference paths and macOS
bookmarks remain encrypted. Review the
[Coqui XTTS documentation](https://coqui-tts.readthedocs.io/en/latest/inference.html)
and the selected model license before use or distribution.

Chatterbox likeness speech follows the same authorization boundary with its
own official API contract. Choose a separately installed Chatterbox Python
environment, a populated local Hugging Face cache, an authorized WAV reference,
the installed `english`, `multilingual-v3`, `nano`, or `turbo` variant, a
language, and `cpu`, `cuda`, or `mps`. ProduDash forces offline mode, points
`HF_HOME` at the selected cache, denies socket connections inside its bundled
wrapper, and never installs or downloads packages or model weights. Validation
loads only the selected cached model; generation remains unavailable until the
configured likeness is separately authorized. Review the
[official Chatterbox repository](https://github.com/resemble-ai/chatterbox)
and the specific model license before use.

Tortoise TTS is also available as an explicitly configured offline likeness
runtime. Choose a separately installed Tortoise Python executable, a complete
local model folder, an authorized WAV reference, and one of Tortoise’s
`ultra_fast`, `fast`, `standard`, or `high_quality` presets. ProduDash points
`TORTOISE_MODELS_DIR` at that folder, forces Hugging Face and Transformers
offline mode, blocks socket connections inside its bundled wrapper, and never
installs or downloads packages or model weights. Validation loads the selected
model without synthesizing the likeness. The configured voice remains
unavailable until the user accepts the versioned likeness terms and separately
authorizes it. Tortoise is compute-intensive; compatibility scan results are
only guidance and do not guarantee usable speed. Review the
[official Tortoise TTS repository](https://github.com/neonbjb/tortoise-tts)
and the selected model license before use.

Inbox draft requests include only the selected business, a bounded operator instruction, and the latest bounded messages from one conversation. Output is schema-validated before storage. It can contain a draft, intent, summary, possible order details, a recommended action, and risk flags. It cannot send a message or perform an external side effect, and ProduDash never silently switches providers.

## Juanito advisor

The lower-right Juanito panel uses the model assigned to the **Advisor** workload. The selected profile must be genuinely connected and expose text generation plus local tool calling. Before the first question in each app session, ProduDash names the selected provider/model and the bounded data categories that may be sent. Consent expires when ProduDash closes and must be confirmed again if the provider changes or a new category is requested.

Juanito can read only ProduDash’s allowlisted local summaries: current view/selected safe record ID, supported business metrics, defined Shopify analytics with 7, 30, or 60-day equal-window comparisons, recent order statuses, attention counts, public integration health, media-job/candidate details, Clip Library counts/item metadata, normalized visible errors, public provider/workload setup, a small built-in help index, and the next verified setup step. Analytics tool results contain aggregates and limitations rather than customer records, and Juanito is instructed not to treat observations as causal findings or forecasts. He cannot mutate records or use provider-hosted web, code execution, MCP, or computer-use tools. Each turn stops after five local tool rounds.

Default tool results exclude customer names, addresses, emails, authorization data, raw messages, credentials, and unrelated businesses. Imported fields are treated as untrusted quoted data rather than instructions. Up to 50 visible user/assistant turns are stored in a separate atomic, recoverable file; provider reasoning and credentials are never stored there. **Clear history** deletes the visible local conversation.

## Clip Library

Open **Content Studio → Library** to add folders or loose video files. ProduDash:

- Recursively scans MP4, MOV, M4V, WebM, and MKV files with bounded concurrency.
- Skips symlinks and hidden folders.
- Uses bundled, version-pinned ffprobe/FFmpeg binaries only for metadata inspection and cached thumbnail creation.
- Keeps tags across rescans and exposes previews through an opaque local `produdash-media` protocol with byte-range support.
- Records unsupported, corrupt, permission-denied, missing, and detached-drive states per file.
- Stores security-scoped bookmarks in the encrypted credential vault when a macOS App Store sandbox requires them.

The library never copies, uploads, modifies, or deletes source media. Removing a video or folder removes only its ProduDash index record and cached thumbnail.

Library search uses a bounded local index with recorded provenance. It can
match filename/tag concepts and current local project-transcript text, returning
bounded timestamped why-match excerpts without uploading media. The index can
be rebuilt or canceled safely. It is deterministic keyword/synonym search and
does not claim model-generated embeddings or visual understanding.

The bundled binaries are included for development, CI, local inspection, and thumbnail generation. External distribution remains blocked until the owner completes legal review of the applicable FFmpeg/ffprobe GPL obligations or supplies approved replacement builds.

## Create clips

Open **Content Studio → Create clips**, select an available library video, and choose a destination folder. ProduDash creates a collision-free job directory and:

1. Validates the source and available disk space.
2. Extracts a local analysis track, measures audio activity/sustained silence, detects scene boundaries and sustained black/frozen footage, and samples review frames.
3. Uses the selected analysis mode:
   - **Smart local cuts** builds and ranks a bounded deterministic candidate pool, diversifies selections across the source, truthfully leaves semantic goal relevance unscored, and sends nothing to an AI provider.
   - **Transcript only** sends cloud audio only when cloud transcription is selected, then sends the bounded timestamped transcript to the assigned analysis provider.
   - **Transcript + frames** additionally sends up to three sampled frames.
   - **Native video** sends the complete source video to the assigned compatible Gemini model.
4. Validates candidate count, 5–180 second bounds, source bounds, confidence, near-duplicates, and overlap. Boundaries may snap by at most 1.5 seconds to a nearby scene or transcript boundary.
5. Stores hook, complete-thought, audio-clarity, visual-continuity, goal-relevance, duration, platform-fit, novelty, duplication, silence, and unusable-frame scores plus concise rationale.
6. Pauses in a non-destructive review editor with safe range playback, exact in/out points, original-versus-edited values, score explanations, aspect/crop previews, caption timing/style controls, and explicit select/reject/reset/save actions. No candidate is selected automatically.
7. Persists the immutable suggestion separately from the approved title, timing, captions, and presentation values, then renders only the explicitly approved edits as H.264/AAC MP4 files.
8. Optionally rebases timestamped transcript segments into monotonic per-clip SRT cues. Without a transcript, the UI explains the limitation and accepts only an intentional single-cue manual fallback. Burned captions use an allowlisted style, position, and safe-area preset.
9. Creates thumbnails and a safe manifest, then imports completed video artifacts into the Clip Library.

Only one media job processes at a time. Additional jobs remain queued. Coarse stage progress is persisted without writing on every FFmpeg event. If ProduDash closes mid-job, the job is marked interrupted at the next launch and can retry from validated durable artifacts; it never claims to resume a terminated process.

Temporary work lives in a hidden `.produdash-job` directory inside the selected job folder and is removed after complete success. Cancellation first requests graceful termination, then uses bounded force termination if needed. Partial generated artifacts remain user-owned, are reported without exposing absolute paths, and can be reused during an explicit retry. ProduDash never overwrites an unrecognized output file.

Public app state contains only opaque media IDs/protocol preview URLs, output folder names, stages, settings, warnings, immutable candidate suggestions, explicit edits, and safe artifact filenames. Source/output paths and macOS security-scoped bookmarks are stored only in the encrypted credential vault. Manifests record safe original-versus-approved timing/presentation and caption cue counts while omitting absolute paths, credentials, provider payloads, and hidden reasoning.

Aspect treatment can keep the original frame, fit/pad, or center crop; fit/pad is the safe default. Caption mode defaults to Off. Cloud choices appear only when the assigned models are connected and capability-compatible. Consent is specific to one queued job and names the analysis provider/model, transcription provider/model when applicable, and the exact categories sent. A provider failure makes that job fail safely and retryably; it never switches provider, analysis mode, or data mode.

Project render-plan v3 also supports explicitly reviewed focus framing, local
voice cleanup/enhancement, one user-owned Library B-roll track, and one managed
local sound-effect track. B-roll is fingerprint-verified and copied into the
immutable approved job snapshot; source paths remain private. These controls
are off until reviewed. ProduDash does not yet claim automatic person tracking
or offer stock/generative B-roll.

Each completed clip also receives three local thumbnail choices sampled from
early, middle, and late frames. The manifest records their local-render
provenance and normalized positions. The completed-job review shows those frames
through opaque local URLs and lets the user mark one preferred frame per rendered
clip. Users can also add a signature-validated JPG, PNG, or WebP custom choice;
ProduDash copies it into the completed output folder, keeps its original path
private, and never alters the source image. The preferred result can be checked
against approximate vertical platform safe areas that are explicitly not official
publishing previews. These preferences do not upload or publish media. Project transcripts can be translated into
provider-generated caption drafts only after an exact provider/model/transcript
disclosure is confirmed; every result remains inactive until human review.
Projects can also apply a reviewed local HD-frame resize. The UI and manifest
state truthfully that resizing pixels does not recover missing source detail.
Projects can generate bounded OpenAI built-in, configured local Piper/Kokoro, or authorized local/cloud custom-voice previews for individual
transcript cues after exact provider/model/text consent and the required
AI-generated-voice disclosure. Preview audio is stored behind an opaque local
URL, contains safe provenance, can be played and permanently deleted, and is
invalidated by dependent transcript edits. Only explicitly reviewed previews
enter immutable jobs, where users choose to mix them with or replace original
audio for the reviewed interval. Creating a custom likeness requires a
versioned first-use acceptance, an adult rights declaration, OpenAI’s exact
consent recording, and a separate matching sample. ProduDash does not retain
either selected source recording and labels resulting audio as synthetic.
Provider account eligibility and supplemental terms still apply.
Voice choices are scoped to the selected provider: OpenAI exposes its supported
built-in voices, ElevenLabs exposes only ProduDash-authorized custom voices, and
Piper exposes only its configured local model, and Kokoro exposes only its
validated configured voice ID. An OpenAI-compatible loopback runtime may expose
one explicitly configured voice ID. Projects with
speaker-labeled transcript cues can generate up to 12
unvoiced drafts for one speaker in a single confirmed operation. Every segment
remains independently playable, removable, and excluded from rendering until
human review.
An existing local WAV preview can also be converted with a user-configured RVC
runtime and `.pth` model. RVC is a separate voice-conversion capability, never
presented as text-to-speech. Before the first conversion, ProduDash requires the
full adult rights, consent, disclosure, misuse, and runtime/model-terms
acceptance; every conversion also requires an exact source-audio authorization.
The selected executable/model paths remain encrypted, commands use a fixed
shell-free argument list, validation performs a real bounded local conversion,
and the result is imported as a new unreviewed synthetic-likeness preview. The
original preview is never modified or removed.
Authorized custom voices can be removed from ProduDash with a separate
confirmation. ElevenLabs voices are deleted through its official API before
local authorization is removed. For providers without an exposed voice-delete
operation, ProduDash removes its authorization and consent reference while
clearly directing the owner to manage any remaining provider resource.

ElevenLabs is also available as an independent encrypted provider profile for
Instant Voice Cloning and multilingual speech. Its API key stays in Electron
secure storage, and ProduDash retains only safe voice identifiers plus a hash
of the separately recorded consent evidence. Cloud voice profiles are never
used as silent fallbacks.

Integrations includes an on-demand local compatibility scan for Piper, Kokoro,
Chatterbox, XTTS, RVC, and Tortoise TTS. RVC is identified separately as voice
conversion because it transforms an existing speech recording rather than
generating speech from text. It reports coarse OS, architecture, core-count,
memory, accelerator, and matching-command availability without reading
personal files or uploading device inventory. “Compatible” means only that the
hardware meets the documented baseline; “installed” requires a matching local
command. ProduDash never downloads local executables or model weights
automatically. Piper, the separately installed `kokoro-tts` CLI, and the
offline user-configured XTTS, Chatterbox, and Tortoise runtimes are direct local
speech adapters, while RVC is a direct local voice-conversion adapter.
Each becomes available only after its selected runtime creates a valid WAV in
a local connection test. An explicitly configured
loopback OpenAI-compatible endpoint may also declare `speech_generation` after
its connection test succeeds.

## Projects and local editor

Open **Content Studio → Projects** to create a project from an available Clip Library asset, or choose **Open as project** on an existing media-job candidate. Projects reference source media in place and never copy, modify, upload, or delete it.

Project metadata supports title, description, optional business, favorites, tags, collections, target platforms, desired lengths, instructions, archive/restore, search/filter/sort, duplication, and metadata-only deletion. A duplicate receives a new identity and clean job history while retaining the current edit plan.

The render-plan schema stores only opaque media IDs and bounded edit data. Every completed edit operation saves a recoverable draft; undo and redo keep up to 100 local operations. **Save version** creates an immutable entry, capped at 50. Restoring an older version creates a new current revision and leaves later history intact.

Use **Prepare local signals** to generate waveform peaks and scene boundaries through the existing isolated utility process. **Approve plan and render** is the explicit human gate: the main process reloads and validates the selected revision, records its hash, and places an immutable snapshot in the one-at-a-time media queue. Later project edits never alter a queued render. Preview and final FFmpeg output use the same normalized segment order, and transcript cues are rebased across cuts.

If a Library record disappears, the project retains a safe source fingerprint and name. Relinking accepts only an available Library asset with matching duration and fingerprint. Project documents, renderer state, manifests, and errors never include absolute paths, bookmarks, credentials, raw provider payloads, or hidden reasoning.

The complete preservation inventory, Phase 1 risk map, official-documentation parity analysis, and planned Phase 2–8 roadmap are in [docs/creator-expansion.md](docs/creator-expansion.md).

## Reset and deletion

- **Reset dashboard data** clears imported businesses, snapshots, local plans, media-job records and protected path references, approvals, audits, Advisor history, the Clip Library index, cached thumbnails, and project preparation caches. Project metadata, recoverable drafts, and saved versions remain, with affected sources marked for relinking. AI profiles, workload assignments, and encrypted provider/integration credentials remain. Integrations return to a disconnected state until refreshed.
- **Remove** on an integration deletes that integration’s credentials and marks its snapshots disconnected; already imported Shopify snapshots remain for local reference.
- **Delete all data and credentials** removes ProduDash state, project metadata and caches, provider metadata, indexes, cached thumbnails, stored bookmarks, backups, recovery snapshots, and the encrypted credential vault, then creates a clean local workspace.

All destructive operations require explicit confirmation in the renderer. Reset, removal, and delete-all never delete user-owned source or generated media files.
Reset retains a custom Juanito display name; delete-all intentionally returns the display name to the clean-install default, Juanito.

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
npm run check:media
npm run check:package-config
npm run lint
npm run format:check
npm test
npm run test:smoke
npm run validate
npm audit --omit=dev
npm run check:distribution
```

`npm run validate` runs syntax, executable media-tool checks, lint, formatting, unit/integration/renderer tests, real tiny bundled-binary analysis/render tests, and the Electron smoke test. Provider tests use injected clients and encryption fakes; they never require or contact live Shopify, Gemini, OpenAI, Anthropic, or custom endpoints. Live-provider acceptance therefore requires owner-supplied credentials and an explicit media-consent test outside automation.

CI repeats media and Electron validation across Ubuntu, macOS, and Windows. A separate manual prerelease workflow builds natively on macOS arm64, macOS x64, and Windows x64, then checks package contents, launches unpacked and installed artifacts, verifies signing when requested, and produces SHA-256 checksums, a CycloneDX SBOM, and path-free build metadata. It never creates a public release.

See [the release-readiness gate](docs/release-readiness.md) for the exact owner-controlled licensing, signing, hosted-service, and live-connector work that remains intentionally blocked.

The browser-only `npm run web` command can display static assets but cannot use local persistence or credentials because the secure preload bridge is available only in Electron.

## Release requirements

Internal installer configuration is implemented. A public production release still needs:

- Approved native FFmpeg and ffprobe builds plus license notices for every target.
- Apple Developer ID signing and notarization credentials.
- Windows code signing credentials and owner verification of SmartScreen behavior.
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
