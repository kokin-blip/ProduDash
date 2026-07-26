# ProduDash creator expansion

Status: Phase 0 preserved and validated; Phase 1 is implemented in this working
tree. Phases 2–8 are plans only and are not exposed as nonfunctional product UI.

## Sources and comparison boundary

This analysis uses OpusClip only as a functional reference. It does not copy
assets, inspect private APIs, scrape authenticated pages, or treat marketing
claims as implementation facts. The primary source is the official
[documentation index](https://help.opus.pro/llms.txt), with the official pages
for [project saving](https://help.opus.pro/docs/article/saving-your-projects.md),
[trimming and adding sections](https://help.opus.pro/docs/article/9442115-trim-the-clip-or-add-new-sections-from-original-video.md),
[scene rearrangement](https://help.opus.pro/docs/article/can-i-drag-rearrange-sections-timeline.md),
[Snap Editing](https://help.opus.pro/docs/article/snap-editing.md),
[keyboard editing](https://help.opus.pro/docs/article/keyboard-precise-editing.md),
[source transcripts](https://help.opus.pro/api-reference/endpoints/transcripts/get-transcript.md),
[project representation](https://help.opus.pro/api-reference/schemas/project-representation.md),
[brand templates](https://help.opus.pro/api-reference/brand-template.md), and
[social posting](https://help.opus.pro/api-reference/endpoints/social-posting/overview.md).
The supplied Brand Template screenshot is used only to identify functional
categories: aspect ratio, layout, captions, headline, overlays, intro/outro,
music, cleanup rules, preview, undo/redo, and template saving.

## Preservation inventory

| Existing capability   | State and persistence                                                   | Service / IPC                                               | View and assets                                                               | Tests                                   | User workflow preserved                                         |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| Secure dashboard data | Schema 6 main state, atomic primary/backup/snapshots, encrypted vault   | store, credential service, normalized trusted IPC           | Overview, Integrations                                                        | persistence, credentials, IPC, smoke    | Connect, refresh, reset, delete-all                             |
| Shopify               | Public connection metadata; secret token only in vault                  | GraphQL client, connection service                          | Setup, Integrations, dashboard metrics/orders                                 | Shopify, connection service             | Connect and synchronize a custom app                            |
| Provider-neutral AI   | Provider profiles, verified capabilities, workload assignments          | provider registry/adapters                                  | AI Providers in Integrations                                                  | provider adapters/service               | Configure and assign Advisor, drafting, analysis, transcription |
| Inbox approvals       | Conversations, drafts, approval audit                                   | workflow service                                            | Inbox master/detail                                                           | workflow, renderer                      | Draft, approve/reject; never claims “sent”                      |
| Clip Library          | Separate media index with recovery, opaque IDs, bookmarks, thumbnails   | media library/protocol                                      | Studio → Library                                                              | media library/protocol, renderer, smoke | Add folders/files, scan, search, tag, preview, relocate         |
| Clip generation       | Typed `clip_generation` media jobs; durable stages and artifacts        | media job service, utility runner, FFmpeg worker            | Studio → Create clips                                                         | media jobs, worker, analysis            | Create, cancel, retry, review, approve, render, reveal          |
| Candidate editor      | Original suggestion plus bounded user edit, captions and ranking        | candidate validation/job IPC                                | Candidate review editor                                                       | candidate edit, captions, renderer      | Trim, restyle, select/reject, approve                           |
| Local publishing plan | Post drafts and enforced approval/export transitions                    | workflow service                                            | Studio → Publishing                                                           | workflow, renderer                      | Plan locally; manual export only after approval                 |
| Juanito               | Separate bounded history, session consent, configurable name            | advisor service, read-only tool allowlist, one event stream | Accessible launcher/panel; Juanito sprite strips                              | advisor, renderer, smoke                | Ask, cancel, clear, inspect setup/jobs without mutation         |
| Motion/accessibility  | Renderer-local state only                                               | none                                                        | navigation indicator, view transitions, disclosures, focus and reduced motion | renderer, smoke                         | Keyboard navigation and restrained motion                       |
| Projects (Phase 1)    | Separate versioned project store, recoverable draft and max 50 versions | project store, project IPC, media queue                     | Studio → Projects                                                             | project, IPC, renderer, smoke           | Create/manage/edit/prepare/approve/render                       |

The seven application sidebar rows remain unchanged. Projects is the fourth
Content Studio tab, alongside Library, Create clips, and Publishing. Existing
media jobs are annotated as `clip_generation`; none is promoted, hidden, or
rewritten into a Project.

## Phase 1 regression-risk map

| Change                   | Main regression risk                  | Guardrail and evidence                                                                                                    |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| State schema 5→6         | Old jobs rejected or altered          | Sequential idempotent migration; legacy job tests; nullable project fields                                                |
| Separate project store   | Corruption destroys drafts            | Atomic same-directory writes, backup recovery, corrupt-file preservation, future-version block                            |
| Reset/delete semantics   | User media deleted or projects lost   | Reset retains drafts/versions and clears preparation; delete-all removes metadata only; tests assert source files survive |
| Clip fingerprints/relink | Wrong source attached                 | Opaque metadata fingerprint and duration match before mutation                                                            |
| Project lifecycle        | Cross-business or accidental deletion | Bounded IDs/business references, confirmation, metadata-only deletion, linked-job detachment                              |
| Draft autosave           | Conflicting edits overwrite work      | Serialized mutations and expected-revision conflict                                                                       |
| Version restore          | Later history disappears              | Restore creates a new draft revision; immutable history retained and capped at 50                                         |
| Transcript import/edit   | XSS or invalid timing                 | Main-process SRT/VTT parsing, bounds/monotonic validation, escaped renderer text                                          |
| Timeline editing         | Out-of-range or overlapping EDL       | Central render-plan normalization, calculated timeline positions, 100-operation undo cap                                  |
| Preview                  | Preview timing differs from export    | One normalized segment order and source mapping for preview and render                                                    |
| Project preparation      | UI freezes or uploads media           | Existing utility process, one-active-job queue, local FFmpeg only, cancellable/retryable                                  |
| Project rendering        | Edited project mutates queued output  | Approval revalidates and hashes revision; immutable plan snapshot in job                                                  |
| Captions across cuts     | Non-monotonic or stale cues           | Central transcript rebasing and caption tests                                                                             |
| FFmpeg graphs            | Command injection or shell expansion  | Executable plus argument array, `shell:false`, bounded filter graph                                                       |
| Renderer expansion       | Studio regressions/overflow           | Delegated handlers, existing tab workflows retained, renderer and Electron smoke                                          |
| Preload expansion        | New privileged surface                | Renderer-used methods only; trusted sender validation and normalized envelopes                                            |
| Juanito tools            | Advisor mutates or leaks paths/PII    | Read-only allowlist, business scope, bounded summaries, project tool tests                                                |

## A–X parity matrix

“Local” means the work can be performed without uploading user media. “Cloud”
names a capability need, not an enabled ProduDash feature.

| Section / feature                          | Official OpusClip reference capability                  | ProduDash now                                                                                                                                                          | Gap                                                                      | Local                                  | Cloud / official API                      | Privacy and security                                                            | Dependencies / complexity          | Recommended phase and acceptance                                                    |
| ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| A. Projects/dashboard                      | Projects, clips, collections and status                 | Lifecycle, metadata, favorites, tags, collections, search/filter/sort, activity and linked jobs                                                                        | Partial: bulk actions, templates, posts/analytics links deferred         | Yes                                    | No for Phase 1                            | Metadata-only delete; opaque source                                             | Project store; high                | **1:** all implemented lifecycle operations persist/recover without affecting media |
| B. Source ingestion                        | Local upload and documented provider imports            | Existing Library files/folders plus project references and SRT/VTT                                                                                                     | Partial: watch, drag/drop, managed copy and cloud imports deferred       | Yes                                    | Official APIs for each cloud source       | Explicit cloud consent; no unofficial download                                  | Library/connectors; high           | **1/3:** local references and transcript import work; later imports cancel/retry    |
| C. Clip discovery                          | Prompt/timeframe/narrative discovery and ranked results | Deterministic signals, provider modes, transparent component scores, candidate edits                                                                                   | Partial: broad semantic and visual modes deferred                        | Yes, limited                           | Optional provider                         | Per-job data-category consent, no “viral fact”                                  | Analysis adapters; high            | **3:** complete pool, provenance, measured/provider distinction                     |
| D. Semantic search                         | Search-oriented clip discovery                          | Library/project filename, tags, collection, and deterministic local transcript search with timestamped why-match excerpts                                              | Partial: model-generated natural-language embeddings remain deferred     | Yes                                    | Optional embeddings provider              | Never upload whole library automatically                                        | Index/embedding model; high        | **3:** cancellable reindex with provenance and bounded timestamp matches             |
| E. Non-destructive editor                  | Trim/add sections, rearrange, Snap Editing, shortcuts   | One-source preview, transcript, tracks, inspector, trim/extend/split/ripple/duplicate/move, waveform/scenes, markers/comments, comparison, undo/redo/autosave/versions | Partial: multi-source, B-roll, speed/freeze/fades/overlays later         | Yes                                    | No                                        | Original untouched; bounded EDL; no renderer paths                              | FFmpeg/canvas; very high           | **1:** preview/final share plan; crash recovery and version restore pass            |
| F. Layout/reframe/tracking                 | Aspect/layout/reframe controls                          | Original/vertical/square/landscape with fit/pad or center crop                                                                                                         | Partial: custom ratios/layouts/tracking deferred                         | Mostly                                 | Optional vision model                     | Review low-confidence tracking                                                  | FFmpeg/OpenCV/provider; very high  | **2/3:** keyframed crop and reviewable confidence                                   |
| G. Brand templates                         | Official Brand Template APIs and screenshot categories  | Existing per-job presentation settings only                                                                                                                            | Missing template workspace                                               | Yes                                    | Optional for generated assets             | Validate assets; snapshot queued template                                       | New template store; very high      | **2:** atomic versions, preview, variants, import/export, immutable render snapshot |
| H. Captions/transcripts                    | Source transcript API and caption tools                 | Local/cloud transcription, SRT/VTT import, corrections, rebasing, SRT/burned modes                                                                                     | Partial: export formats, typography, RTL, translation/diarization        | Yes                                    | Optional transcription/translation        | Transcript separate from style; fonts validated                                 | FFmpeg/fonts/providers; high       | **2/4:** all cues monotonic and exports round-trip                                  |
| I. Speech/audio cleanup                    | Speech cleanup/enhancement features                     | Silence detection metadata; original audio preserved                                                                                                                   | Missing reviewable cleanup/enhancement                                   | Yes                                    | Optional enhancement provider             | Every proposed cut reviewable                                                   | FFmpeg/audio DSP; high             | **3:** individual accept/reject and before/after parity                             |
| J. B-roll/custom media                     | AI/stock B-roll and custom upload                       | Library can index user-owned media; no insertion                                                                                                                       | Missing editor track, search and provenance                              | Yes for owned media                    | Official stock/generative APIs            | No silent generation/download; license provenance                               | Multi-source EDL; very high        | **3:** every insertion is movable/removable/reviewed                                |
| K. Text/headlines/overlays/transitions/SFX | Editor overlays, AI suggestions and transitions         | Caption text only                                                                                                                                                      | Missing                                                                  | Yes for manual/local SFX               | Optional generation                       | Generated elements individually removable                                       | Composition graph; very high       | **2/3:** timing, safe areas and deterministic render                                |
| L. Music                                   | Music controls                                          | None                                                                                                                                                                   | Missing                                                                  | Yes                                    | Official stock APIs optional              | Rights/attribution warnings; no bundled unlicensed tracks                       | Audio mixing; high                 | **2:** trim/loop/duck/fade preview equals render                                    |
| M. Voiceover/translation/dubbing           | Voice and localization tools                            | Provider contracts exist; no project feature                                                                                                                           | Missing                                                                  | Local TTS possible                     | Declared TTS/dubbing providers            | Explicit identity consent, provenance, deletion                                 | TTS/diarization; very high         | **4:** per-speaker review and regenerated timing                                    |
| N. Video enhancement                       | Upscale and visual adjustment                           | Normalized H.264/AAC output                                                                                                                                            | Missing enhancement controls                                             | Yes, bounded                           | Optional upscale provider                 | Never claim recovered detail                                                    | FFmpeg/GPU/provider; high          | **4:** labeled operation and before/after comparison                                |
| O. Thumbnails                              | Source/custom/generative thumbnails                     | Three local source-frame choices, validated custom-image variants, persisted preference, and approximate platform framing checks                                      | Partial: composition editor and provider-generated variants deferred     | Yes                                    | Optional generation provider              | Opaque previews; signature validation; no upload/publish                          | Existing job artifacts; medium     | **4:** implemented local source/custom review; generation requires a declared provider |
| P. Results/clip management                 | Result cards, edit/download/publish and collections     | Jobs, candidates, artifacts, Library import, Projects/collections                                                                                                      | Partial: grid/list bulk workflows deferred                               | Yes                                    | Publishing API only when connected        | Human approval before render/publish                                            | Existing job/library UI; high      | **3/5:** filters and safe bulk validation before mutation                           |
| Q. Social copy                             | Platform-specific copy generation                       | Bounded per-platform packages from shared user-authored copy, with immutable approval provenance                                                                       | Partial: provider-assisted variants and per-platform editing deferred    | Yes for manual                         | Optional current-data/provider capability | Human approval; never claims live trends                                        | Provider structured output; medium | **5:** local package foundation implemented; generated variants require exact consent |
| R. Official publishing/scheduler           | Official social posting APIs                            | Local time-zone-aware outbox, rendered-media snapshot, idempotency keys, cancellation, and path-free manual package export                                              | Official OAuth connections, dispatch, retries and published URLs missing | Foundation only                        | OAuth and official APIs required          | Least privilege, immutable approval, no browser automation                      | Hosted callback backend; very high | **5:** local foundation implemented; live delivery waits for approved connectors    |
| S. Analytics                               | Official platform metrics                               | Shopify-supported commerce metrics only; creator analytics unavailable                                                                                                 | Missing                                                                  | Cached analysis possible               | Official platform analytics APIs          | Definitions/freshness; no fabricated profit/conversion                          | Connectors/reporting; very high    | **6:** raw definitions, normalized views, evidence language                         |
| T. Teams/collaboration                     | Project sharing and team management                     | Local single-user app                                                                                                                                                  | Missing by design                                                        | Local remains usable                   | Hosted identity/sync required             | Granular roles, revocation and conflicts                                        | Backend; very high                 | **7:** permission matrix and offline-safe local mode                                |
| U. Export/interoperability                 | Downloads/transcript export and APIs                    | MP4, captions, thumbnails, safe manifests, immutable EDL internally                                                                                                    | Partial: portable project, ZIP and NLE formats deferred                  | Yes                                    | No                                        | No paths/secrets in exports; checksums                                          | Format writers/target QA; high     | **2/4:** round-trip safe project JSON and tested format claims                      |
| V. API/webhooks/automation                 | Official project/clip/transcript/social APIs            | Internal versioned IPC only                                                                                                                                            | Missing external API by design                                           | Optional localhost                     | Hosted delivery for webhooks              | Disabled default, scoped tokens, signing/replay defense                         | API server/backend; very high      | **8:** OpenAPI, idempotency, rate limits and dead-letter visibility                 |
| W. ProduDash advantages                    | Comparison category                                     | Local-first desktop, provider choice, BYO keys, transparent scores, consent, atomic recovery, approval gates, portability foundation, accessibility                    | Partial batch/cost/collaboration ambitions                               | Yes                                    | Optional by workload                      | Exact data categories; safe deletion; no silent fallback                        | Existing architecture; medium–high | **All:** advantages must remain measurable, not marketing-only                      |
| X. Juanito                                 | ProduDash-specific advisor scope                        | Current project, render readiness, missing source, revision/job failures; existing setup/library/provider help                                                         | Partial: future template/publish/analytics tools wait for those features | Yes tool execution; model may be cloud | Selected advisor provider                 | Read-only, consent-aware, business-scoped, no edit/approve/delete/upload/render | Advisor allowlist; medium          | **1+ each phase:** bounded tool tests prove mutation prohibition                    |

## Phase 1 architecture and acceptance

- **Data model:** main schema 6 adds typed jobs and nullable project/render
  metadata. A separate project-store schema keeps project summaries, drafts,
  preparation summaries, activity, and the last 50 immutable versions.
- **Render plan:** version 1 references one opaque media ID and ordered source
  intervals. Timeline positions are calculated, never trusted from renderer
  input. Transcript, markers, comments and allowlisted presentation are bounded.
- **Mutation model:** project operations and drafts serialize through one queue;
  draft saves carry an expected revision. Undo/redo is renderer-local and capped
  at 100; every completed operation is immediately persisted.
- **Rendering:** `project_prepare` and `project_render` extend the existing
  single-active media queue. Approval snapshots and hashes the revalidated plan.
  FFmpeg uses argument arrays and a concat filter; preview maps through the same
  ordered intervals. Captions are rebased across cuts.
- **Privacy/security:** provider networking is not involved. Paths remain in the
  main/utility process. Project documents contain no path, bookmark, credential,
  raw provider response, or hidden reasoning.
- **Failure model:** corrupt primary data is preserved and recovered from backup;
  future versions block. Preparation/render jobs can cancel, fail, interrupt and
  retry through the existing truthful job lifecycle. Missing sources require
  fingerprint-validated relinking.
- **Acceptance:** old Studio flows and jobs remain usable; projects support
  lifecycle and metadata operations; drafts recover; versions restore without
  deleting history; SRT/VTT is safe; edit operations remain bounded; approved
  jobs keep immutable older revisions; real multi-segment output timing and
  captions match the plan; reset retains drafts while delete-all removes only
  ProduDash metadata.

## Planned roadmap: Phases 2–8

Nothing below is currently exposed as a placeholder control.

### Phase 2 — Brand and composition (implemented)

- **Problem/scope:** reusable brand consistency; template store/builder,
  caption styling, layouts/reframe, text/logo/CTA overlays, intro/outro, music,
  transitions and safe project/template export.
- **Affected systems:** Projects, render plan, Library, FFmpeg worker, preload,
  Studio. **Non-goals:** tracking, AI B-roll, publishing.
- **Data/migration:** versioned atomic template store and render-plan v2;
  migration preserves v1 plans. Queue snapshots template version and assets.
- **Privacy/security/providers/APIs:** local by default; generated assets optional
  with per-operation disclosure. Validate fonts/media and keep paths private. No
  official external API required.
- **Failures/tests/acceptance:** missing assets block batch start; previews and
  renders match; template versions recover; imports reject traversal; all current
  workflows and Phase 1 tests stay green.
- **Risks/dependencies:** composition complexity, font licensing, FFmpeg filter
  parity; depends on stable Phase 1 EDL.
- **Implemented Phase 2A:** atomic recoverable template versions, render-plan v2
  migration, immutable template references in project/job snapshots, path-free
  template and project import/export, branded caption colors/scaling,
  aspect/layout presets, canvas color, per-cut fades, timed text/CTA overlays,
  editor preview, real bundled-FFmpeg verification, and reset/delete semantics.
- **Implemented Phase 2B:** separate atomic and recoverable managed brand assets;
  FFprobe validation and opaque range-capable previews; dedicated logo, music,
  intro, and outro editor tracks; live logo preview; immutable per-job asset
  snapshots; real FFmpeg logo overlay, music mixing, normalized bookends, and
  caption timing across intros; and integrity-checked portable template packages
  containing only the assets referenced by that template.

### Phase 3 — Intelligent editing (implemented foundation)

- **Problem/scope:** semantic search, larger diversified candidate pools,
  subject tracking, speech cleanup, audio enhancement, B-roll and SFX.
- **Affected systems:** media index, provider registry, analysis jobs, EDL,
  Library and editor. **Non-goals:** dubbing and publishing.
- **Data/migration:** provenance-bearing search index and render-plan v3 tracks;
  model change triggers cancellable reindex.
- **Privacy/security/providers/APIs:** local models first; optional embeddings,
  multimodal and stock providers with exact consent. Only official stock APIs;
  prompt injection cannot invoke tools.
- **Failures/tests/acceptance:** no provider fallback, complete score components,
  reviewable tracking/cleanup/B-roll, bounded indexing, license provenance and
  deterministic retry.
- **Risks/dependencies:** model downloads, GPU variance, tracking confidence and
  stock licensing; depends on Phase 2 composition tracks.
- **Implemented Phase 3 foundation:** recoverable media-index v3 search
  documents with local-metadata or local-project-transcript provenance,
  deterministic synonym-aware ranking, bounded timestamped why-match excerpts,
  and cancellable rebuilds; diversified candidate pools with the existing
  component-score contract and final-selection limit; render-plan v3 reviewed
  subject, audio, B-roll and sound-effect tracks; local focus-aware center crop,
  time-bounded voice cleanup/enhancement, immutable user-Library B-roll
  snapshots with fingerprint verification, and managed local sound-effect
  mixing. Existing exact-consent provider analysis remains the only cloud
  analysis route and never falls back to another provider. Automated subject
  detection, downloadable local models and stock/generative B-roll remain
  deferred until their model/license/provider gates are implemented.

### Phase 4 — Localization and enhancement (implemented local foundation)

- **Problem/scope:** translation, voiceover, consented dubbing, video enhancement
  and thumbnail variants.
- **Affected systems:** transcript, audio tracks, provider contracts, renders,
  manifests. **Non-goals:** social account connection.
- **Data/migration:** language variants, per-speaker voice references and
  synthetic-media provenance; no voice biometrics in ordinary project JSON.
- **Privacy/security/providers/APIs:** explicit voice-identity authorization,
  provider/cost disclosure and deletion. Declared TTS/dubbing/upscale providers;
  no platform API required.
- **Failures/tests/acceptance:** dialogue edits invalidate dependent dubbing;
  segment previews, timing review, abuse controls and truthful upscale labels.
- **Risks/dependencies:** impersonation, cost, latency, language QA; depends on
  stable Phase 2/3 tracks and transcript provenance.
- **Implemented Phase 4 foundation:** every approved render creates three
  deterministic local thumbnail choices from early, middle and late frames.
  Their safe filenames, local-render provenance and normalized positions are
  recorded in the manifest. Completed jobs expose those frames through the
  allowlisted opaque media protocol and persist one explicit preferred choice
  per rendered clip without altering or publishing any file. A user can add up
  to 12 signature-validated JPG, PNG, or WebP choices per job; ProduDash copies
  them into the output folder, never stores their source path, and scopes each
  choice to one rendered clip. Approximate vertical safe-area checks use the
  selected target-platform labels without claiming an official post preview.
  Provider-generated thumbnail composition remains deferred until a declared
  image provider and per-operation consent flow exist. Versioned language variants support manual drafts
  and strictly validated provider translation after exact per-operation
  transcript consent; a human must review and select a variant before render.
  A reviewed local HD-frame resize is also available and is labeled as pixel
  resizing rather than recovered detail. Projects support bounded OpenAI
  built-in, configured local Piper/Kokoro, or authorized custom-voice WAV previews only after exact provider, model, text, voice and
  AI-generated-audio disclosure consent. Opaque local previews retain safe
  provenance, support playback and permanent deletion, and become draft again
  when dependent transcript text changes. Only human-reviewed previews enter an
  immutable job, with bounded timing and explicit mix/replace treatment recorded
  in the manifest. Custom likeness creation requires versioned first-use
  acceptance, an adult rights declaration, the provider’s exact consent
  recording, and a separate matching sample. ProduDash stores only a hash of
  the typed signer name plus provider resource metadata; it does not copy the
  selected source recordings.
  ElevenLabs is now an independent encrypted speech/likeness provider with
  mocked connection, clone, and PCM-to-WAV coverage. Integrations also offers a
  private on-demand compatibility scan for Piper, Kokoro, Chatterbox, XTTS,
  RVC, and Tortoise TTS. RVC is labeled as voice conversion rather than
  text-to-speech. The scan distinguishes hardware compatibility from actual
  installed readiness and never downloads runtimes or model weights. Piper now
  has a direct user-configured adapter with encrypted executable/model paths.
  The separately installed `kokoro-tts` CLI also has a direct adapter with one
  bounded configured voice ID. Both use a real WAV connection test, fixed
  shell-free arguments, bounded output, and no bundled runtime or model. The
  other scanned engines remain
  compatibility-only pending their distinct runtime and likeness contracts.
  Loopback OpenAI-compatible endpoints may explicitly declare
  `speech_generation`.
  Custom likenesses now have a separately confirmed removal lifecycle:
  ElevenLabs deletion uses its official provider API before local authorization
  is removed, while providers without an exposed voice-delete operation remove
  ProduDash authorization and the stored consent reference without claiming
  that the remote voice resource was deleted.
  Voice selection is provider-scoped, preventing an OpenAI built-in voice from
  being submitted to ElevenLabs or another incompatible runtime. A validated
  OpenAI-compatible loopback runtime may expose one configured voice ID.
  Speaker-labeled transcripts can generate a bounded set of unvoiced segment
  drafts for one speaker after one exact provider/model/voice/text disclosure.
  The operation never changes provider on failure, saves the project once, and
  keeps every generated segment in draft until individual playback and review.

### Phase 5 — Official publishing (local foundation in progress)

- **Problem/scope:** approved social copy, OAuth connections, drafts, immediate
  publish, calendar/scheduling, retry/cancel and bulk scheduling.
- **Affected systems:** Integrations, approval workflows, queue, audit, Studio.
  **Non-goals:** browser automation or unsupported platforms.
- **Data/migration:** encrypted refresh tokens, public health/status, idempotent
  schedule records and platform metadata.
- **Privacy/security/providers/APIs:** official APIs only, least privilege,
  hosted OAuth callback, state/HMAC, token rotation, rate limits and audit.
- **Failures/tests/acceptance:** DST/time-zone tests, duplicate prevention,
  revocation, normalized provider failures, published URLs and human approval.
- **Risks/dependencies:** platform review/policy changes and hosted backend;
  requires owner credentials and connector approvals.
- **Implemented local foundation:** completed media jobs can be attached by
  opaque identifier and snapshotted as safe output filenames. Each selected
  destination receives independently editable, bounded user-authored copy
  before approval. An optional planning target retains its ISO instant plus IANA
  time zone, and the local outbox distinguishes upcoming and past targets
  without claiming that a post will be dispatched. Copy and scheduling changes
  are idempotent and rejected after approval. Manual approval freezes a
  hash-verified snapshot and deterministic per-destination idempotency keys. The
  approved package exports as path-free JSON; cancellation is idempotent and
  never deletes rendered or exported media. Official OAuth, remote scheduling,
  retries, revocation and published URLs remain blocked on approved connectors
  and a hosted callback backend.

### Phase 6 — Analytics (local foundation in progress)

- **Problem/scope:** official creator performance, freshness, comparisons,
  experiments, CSV and evidence-backed recommendations.
- **Affected systems:** connectors, Analytics, Projects/templates/posts,
  advisor read tools. **Non-goals:** causal claims or fabricated commerce joins.
- **Data/migration:** source-specific raw definitions plus normalized dimensions;
  provenance and freshness on every metric.
- **Privacy/security/providers/APIs:** official analytics APIs and scoped tokens;
  bounded business isolation and exports.
- **Failures/tests/acceptance:** stale/partial sources remain visible, definitions
  are inspectable, totals reconcile, recommendations cite evidence.
- **Risks/dependencies:** metric incompatibility and API retention windows;
  depends on Phase 5 published identity mapping.
- **Implemented local foundation:** ProduDash derives revenue, imported-order
  count, average order value, fulfillment rate and weekly revenue totals only
  from the selected business’s bounded local Shopify snapshot. Every metric
  includes a visible definition, source sync time, freshness classification and
  the recent-order/60-day limitation. Profit, conversion and social performance
  remain explicitly unavailable. Validated 7, 30 and 60-day comparisons use the
  source sync time as their anchor and compare only dated orders in the bounded
  snapshot against the immediately preceding equal window. Deterministic
  observations describe the records without claiming causation or forecasting.
  Juanito can read a smaller business-scoped projection of that same central
  report for 7, 30 or 60 days. The tool exposes aggregate definitions,
  freshness, coverage, comparison values and limitations, but no customer or
  order records and no refresh, export or mutation action.
  A local CSV export contains aggregate metrics, comparison rows, observations,
  trend points, definitions and source timestamps only; it neutralizes
  spreadsheet formulas and excludes customer PII, credentials, filesystem paths
  and raw provider payloads. Official social analytics, published-content
  identity mapping, platform comparisons and provider-backed recommendations
  remain blocked on approved OAuth connectors.

### Phase 7 — Hosted collaboration (planned)

- **Problem/scope:** accounts, teams, granular roles, reviews, mentions,
  assignments, sync and conflict handling while preserving local use.
- **Affected systems:** all persistence, approval, audit and credentials.
  **Non-goals:** requiring an account for local editing.
- **Data/migration:** organization/project ACLs, sync revisions, device identity
  and export/revocation records.
- **Privacy/security/providers/APIs:** hosted service, encryption in transit,
  tenant isolation, separate edit/approve/publish/analytics/admin permissions.
- **Failures/tests/acceptance:** offline edits reconcile or surface conflicts;
  revocation is immediate online; full org export and permission matrix pass.
- **Risks/dependencies:** backend operations, data residency and conflict UX;
  requires stable schemas from earlier phases.
- **Implemented Phase 7A contract foundation:** an internal, UI-free
  collaboration contract now separates viewer, editor, approver, publisher,
  analyst and administrator permissions. Every authorization check is scoped to
  an organization and an explicit all-project or bounded project list; revoked,
  expired, cross-organization and out-of-scope access fails closed. A separate
  sync envelope accepts only opaque organization/project/resource/device and
  mutation identifiers, consecutive revisions, a timestamp and a SHA-256
  payload reference. Duplicate mutation IDs are idempotent, while stale base
  revisions surface a conflict instead of silently merging. Payload content,
  filesystem paths and credentials are not valid envelope fields.
- **Implemented Phase 7B record foundation:** strict internal contracts now
  cover review threads, plain-text comments, opaque user-ID mentions,
  assignments, access revocations and complete organization-export manifests.
  Creation actions require a safe initial state and an actor ID matching the
  authenticated principal; resolving reviews, assigning work, exporting an
  organization and revoking access each use distinct permissions. Export
  manifests include every supported resource category, bounded counts, an
  opaque artifact ID, checksum and expiry rather than a URL or local path.
  Revocations contain opaque subject IDs and safe reason codes rather than
  tokens. User-authored review text remains explicitly untrusted plain text and
  will require the final hosted privacy, encryption and retention policy.
- **Implemented Phase 7C integrity foundation:** public device records are
  limited to organization/user/device IDs, a plain-text label, coarse platform
  and architecture, a public-key fingerprint, lifecycle timestamps and a
  monotonic sequence. They exclude raw keys, machine UUIDs, IP addresses and
  tokens; registration is self-owned and revoked devices cannot reactivate.
  Explicit conflict records preserve both divergent revisions and hashes. They
  never merge automatically, require a named keep-local, accept-remote or
  manual-revision resolution, and cannot replace evidence after detection.
  Collaboration audit events contain only allowlisted actions, outcomes, safe
  reason codes and opaque identifiers—never payloads, headers, stack traces or
  provider errors.
- **Still blocked before product exposure:** this foundation does not
  authenticate identities, persist ACLs, connect to a server, synchronize
  content or add account/team controls. Backend selection must settle identity
  provider, tenant and data-residency boundaries, encryption and key ownership,
  revocation delivery, offline conflict UX, audit/export retention and
  notification policy before schema migration, IPC or renderer work begins.

### Phase 8 — Developer platform (planned)

- **Problem/scope:** optional versioned API, scoped tokens, signed webhooks and
  external automation for mature product operations.
- **Affected systems:** service boundary, jobs, projects, collections, approval,
  publishing and analytics. **Non-goals:** exposing local filesystem paths or
  enabling automation by default.
- **Data/migration:** API resource versions, idempotency records, webhook
  attempts and dead-letter state.
- **Privacy/security/providers/APIs:** opt-in, scoped/rotatable tokens, rate
  limits, signed payloads, replay protection and safe logs.
- **Failures/tests/acceptance:** OpenAPI contract tests, retries, replay and
  authorization tests, bounded payloads, operational visibility.
- **Risks/dependencies:** long-term compatibility and abuse; depends on stable
  product contracts through Phase 7.
- **Implemented Phase 8A API contract foundation:** an internal `v1` contract
  now maps every allowlisted project, job, approval, publishing, analytics,
  organization-export and webhook-management operation to one minimal scope.
  Read operations reject mutation fields; mutations require a bounded
  idempotency key and SHA-256 body hash. Organization-wide operations reject
  project-limited tokens, and all authorization remains organization/project
  scoped with explicit expiry, revocation, clock-window and rate-limit-class
  metadata. Token metadata contains no bearer value, digest, authorization
  header or credential. Idempotency fingerprints bind the logical mutation
  while ignoring retry transport IDs and timestamps; matching terminal requests
  replay only a response hash, mismatched key reuse fails, expired records
  surface explicitly, and terminal records cannot be rewritten. No external
  publish/dispatch operation exists in this contract.
- **Implemented Phase 8B webhook contract foundation:** strict internal
  endpoint records accept public-style HTTPS hostnames only, with no embedded
  credentials, query parameters, fragments, literal IP addresses or
  local/private hostname suffixes. Event envelopes contain only versioned
  opaque identifiers, timestamps, sequence numbers and SHA-256 data references.
  Native HMAC-SHA256 signatures bind the timestamp, delivery ID and exact body;
  verification uses constant-time comparison, a bounded five-minute default
  clock window and caller-supplied delivery IDs for replay rejection. Signing
  material is accepted only in memory and is never returned in public metadata.
  Delivery records keep only a body hash, bounded response status, safe result
  code and lifecycle timestamps. They allow at most ten attempts, schedule any
  retry within 24 hours, advance through consecutive immutable states and
  preserve delivered or dead-lettered outcomes as terminal records. Response
  bodies, headers, endpoint credentials, raw errors and local paths are invalid
  fields.
- **Implemented Phase 8C runtime contract foundation:** list pagination now
  uses one-hour-or-shorter cursor records bound to the exact API version,
  organization, token, project, resource, query hash, snapshot revision and page
  size. Reusing a cursor outside that scope or after expiry fails closed.
  Successful response metadata contains only bounded counts, opaque cursor IDs
  and a SHA-256 data reference. Error envelopes use fixed safe messages and
  status codes; only rate-limit responses include a bounded retry delay.
  Concrete fixed-window limits are 60, 300 and 1,200 weighted units per minute
  for low, standard and high classes. Reads cost one unit, ordinary mutations
  cost five, and organization-export creation costs ten. Rate records are
  token/tenant-bound, chronological and reset only at the next fixed window.
  Operational audit records retain allowlisted operation/outcome/error codes,
  coarse duration buckets and opaque identifiers without request/response
  bodies, headers, IP addresses, paths, stacks or raw provider errors.
- **Implemented Phase 8D token-credential foundation:** native cryptographic
  randomness now creates a versioned bearer with a 96-bit lookup identifier and
  a separate 256-bit secret. The complete bearer is returned only by the
  issuance result; the strict internal credential record retains only the
  lookup identifier and SHA-256 hash. Random bearer entropy makes the stored
  hash resistant to practical offline guessing without storing the secret.
  Issuance rejects revoked, expired, future-dated or stale creation metadata.
  Verification parses the exact token format, compares both lookup and hash
  with constant-time operations, confirms the credential matches its public
  organization/token lifecycle metadata, and returns only verified opaque
  identifiers. Revocation advances one immutable sequence and cannot reactivate.
  Rotation requires a new token identity, explicit predecessor linkage, prior
  revocation, non-overlapping creation time and the same tenant, scopes, project
  boundary and rate-limit class; privilege changes are not disguised as
  rotation.
- **Implemented Phase 8E machine-readable contract foundation:** one validated
  surface manifest maps all 22 allowlisted operations to unique `v1` routes,
  scopes, methods, statuses and strict resource-specific response schemas. The
  generated internal OpenAPI 3.1.2 draft uses bearer security, required request
  metadata, bounded cursor and idempotency parameters, internal references only,
  no server address and an explicit not-production-ready marker. Safe project,
  job, approval, publishing, analytics, organization-export and webhook
  projections reject unknown fields and omit paths, credentials and delivery
  claims. Mutation request schemas remain explicitly undefined and no request
  bodies are invented, so the draft cannot be mistaken for a publishable API.
  Separate abuse-signal records contain only allowlisted event and disposition
  codes, opaque organization/token/operation identifiers and bounded counters.
  Signal windows are at most one hour, temporary token restrictions at most 24
  hours and record retention at most 30 days. Review and restriction
  dispositions are terminal, evidence cannot decrease, expired restrictions
  release automatically, and no request bodies, headers, IP addresses, stacks
  or credentials are accepted.
- **Implemented Phase 8F mutation-request foundation:** all eleven allowlisted
  mutations now map to strict, bounded request schemas and matching runtime
  normalizers. Project creation accepts an opaque Library media ID rather than
  a path; project updates require an expected revision and at least one real
  metadata change. Preparation and rendering are distinct job requests, and a
  render requires an immutable plan hash plus an approval ID. Approval and
  publishing decisions name their expected pending state, organization exports
  include every supported resource category, and webhook changes reuse the
  public-HTTPS and event allowlists with stale-update timestamps. Cancel and
  retry remain explicit empty commands. The internal OpenAPI draft now embeds
  these request bodies and marks them `defined_internal`, while still declaring
  no server and remaining unavailable through the app, IPC or network.
- **Implemented Phase 8G credential-boundary foundation:** pagination now uses
  a bounded HMAC-SHA256 cursor token instead of exposing a raw cursor lookup ID.
  Its signature covers the API version, tenant, API token, project, resource,
  query hash, snapshot revision, offset, page size and one-hour-or-shorter
  lifecycle. Verification uses constant-time comparison and rejects tampering,
  expiry, a changed record, a different signing key or reuse outside the exact
  authorized list request. The internal OpenAPI draft now accepts and returns
  this opaque cursor shape. Webhook provisioning separately creates 256 bits of
  random signing material, returns its public secret once, and requires an
  injected host sealing function before producing a persistable record. That
  record contains only an opaque wrapping-key ID and bounded ciphertext.
  Unsealing is likewise injected, normalized and available only in memory for
  the existing HMAC operation; revocation is consecutive and irreversible.
  ProduDash does not select a KMS, persist these records or expose provisioning.
- **Implemented Phase 8H hosted-record foundation:** a database-neutral envelope
  now classifies every API token, cursor, idempotency, webhook, rate-limit,
  abuse and operational-audit record as restricted or sealed; there is no
  public storage class. Envelopes contain tenant and record identifiers,
  retention-policy IDs, lifecycle timestamps, revisions and SHA-256 payload
  references rather than raw payloads. Inserts must begin at revision one,
  updates use consecutive optimistic revisions, cannot change tenant or record
  identity, cannot extend existing retention and must change the payload hash.
  Credential records require sealed storage. Deletion removes the payload
  reference and creates a terminal tombstone retained for no more than 30 days.
  Reads fail across tenant or record boundaries, and bounded expiry sweeps
  return only safe record references for one tenant. Cursor, rate-limit,
  idempotency, delivery and abuse lifetimes preserve their existing bounds;
  audit retention accepts an owner policy but is hard-capped at one year.
  This contract does not select or connect a database.
- **Still blocked before product exposure:** ProduDash does not generate API
  tokens through a product workflow, listen on a network interface, expose
  these contracts through IPC, accept automation, dispatch webhooks, or persist
  hosted records. Authentication, a concrete transactional database and
  migrations, signing/wrapping-key custody, globally unique key allocation, API
  hosting, distributed rate-limit and abuse enforcement, retention-job
  operations, authenticated one-time secret delivery, audit/appeal policy and
  OpenAPI publication require the hosted service and owner policy decisions. A
  future outbound transport must also resolve and re-check public IP ranges
  immediately before connection, pin the authorized origin, reject DNS
  rebinding, and reject redirects to any unauthorized origin.
