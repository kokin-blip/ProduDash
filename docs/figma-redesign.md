# ProduDash shared macOS workspace

This redesign adapts the owner's [Figma UI kit](https://www.figma.com/design/Gz7WEiN8Y3Vvivvae0ZPlP) to the existing Electron application. Baseline: `a2c599352ef2d864f4161656b03a684e9c76a86b`. All 34 pages were inventoried; references were selected across application families rather than from the Mail inbox alone.

## Visual references

| Surface                       | Figma nodes                     | Adaptation                                                                                  |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Foundations and shell         | 8:67, 10:2, 75:8, 75:936        | Shared Light/Dark variables, compact navigation and contextual toolbar                      |
| Dashboard and Signals         | 47:2178, 47:3240, 43:59, 43:171 | Attention rows, compact summaries and read-only activity                                    |
| Inbox                         | 75:8, 75:1584, 17:2934, 17:3242 | Mail list/detail and Messages conversation patterns; approval remains separate from sending |
| Library and Templates         | 4:49, 31:137, 31:316, 35:4437   | Media previews, Notes browsing and grouped composition controls                             |
| Projects and candidate review | 35:3450, 35:3941, 17:4296       | Editor, inspector and transcript organization surrounding the existing timeline engine      |
| Publishing                    | 56:14, 56:58, 61:22003          | Grouped local date/time planning, timezone context and immutable approval snapshots         |
| Analytics and Integrations    | 10:149, 10:265, 10:334, 47:3240 | Shared controls, grouped settings and evidence-backed reporting                             |
| Juanito                       | 17:2934, 17:4296, 17:3242       | Conversation surfaces with existing artwork and event-driven reactions                      |

The kit's SF Pro intent uses the existing local system font stack. Body/control type is 13px, metadata 11px and message text 14/20. Shared blue replaces Notes yellow and Music red. Semantic warning/error/success colors retain text labels. Action-fill and muted-text adaptations meet contrast requirements; canvas, panel and selection primitives remain grounded in Shared · Color. No font or media service is needed at runtime.

## Implementation and compatibility

- Seven navigation sections and all five Studio tabs remain. Shared controls, surfaces and layout primitives style every nested view, form and dialog.
- Native Electron chrome and minimum window dimensions are retained. No decorative window controls were introduced. The window background follows the OS appearance at startup.
- `ui-patterns.js` supplies shared headings, tabs and local kit icons. `dom.js` reconciles the current record's markup in place using existing identity attributes. It retains media nodes, dirty form controls, focus/selection, scroll and disclosures. Changing record scope discards the previous record's transient presentation. Successful form submissions consume their drafts; failures preserve them. Credentials stay in their existing form elements rather than a secondary state cache.
- Juanito occupies a reserved layout region. At wide sizes it docks beside the workspace; at narrower sizes it sits above content. The launcher occupies sidebar footer space. Neither panel covers approval or timeline controls.
- Studio tabs support arrows/Home/End, selected tabs retain focus, timeline segments support Enter/Space, native dialogs remain modal and cancel with Escape, and Juanito closes with Escape when no modal is active.
- Persisted schemas, IPC contracts, credentials, consent scopes, publishing approval rules, media access and backend services are unchanged. Four unused bridge methods remain backend-only: `completeCommand`, `getAuthorizationInstructions`, `cancelClipSearchIndex`, `updateBrandTemplate`.

## Feature parity checklist

The [machine-readable inventory](renderer-parity.json) records 176 original renderer attributes, their originating functions/locations, direct handler selectors/API calls and global action IDs. Regenerate it with `node scripts/audit-renderer-parity.cjs`. Availability and confirmation logic remain in those functions and main-process services; the inventory does not imply every bridge method has a UI.

| Workflows retained                                                                                                                                                                       | Verification                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Shopify connection, refresh, business selection, bounded Orders/Signals and dashboard summaries                                                                                          | Existing renderer, connection, Shopify and workflow suites; populated and disconnected Electron captures           |
| Metric definitions, freshness, bounded 7/30/60-day comparisons, unavailable values, CSV export                                                                                           | Existing analytics and renderer suites; analytics fixture built by the real report builder                         |
| Provider profiles, workload capabilities, local runtime file selection, compatibility scan, planned connectors                                                                           | Existing provider, integration action/UI and renderer suites                                                       |
| Inbox selection, instructions, draft generation, approval/rejection and approved-but-not-sent state                                                                                      | Existing workflow and renderer suites; populated Inbox capture                                                     |
| Folders/files, rescan/relocate/remove, search/filter/tags/pagination, smart index, previews and media failure states                                                                     | Existing media library/search suites and renderer contracts; real local import in Electron                         |
| Exact cloud mode disclosures, consent, candidate review/edit/reject/select, approval, queue/progress/cancel/retry and exports                                                            | Existing media analysis/job/candidate tests; real local candidate edit → project → approved render smoke           |
| Thumbnail alternatives, preferred selection and platform previews                                                                                                                        | Existing renderer and media-job suites                                                                             |
| Project collections/favorites/lifecycle/relink, portable import/export, revisions/versions, transcript import/correction, timeline, snapping, frame step, markers/comments and undo/redo | Existing project/renderer/IPC suites; real editor smoke and background-update preservation checks                  |
| Templates, local brand assets, captions/overlays, music/logo/intro/outro, reviewed framing/audio/resize, B-roll and SFX                                                                  | Existing composition/project/renderer suites; local template application and render smoke                          |
| Localized captions, translation, speaker voiceovers, custom/local likeness authorization, RVC conversion and removal                                                                     | Existing localization/voice/IPC/renderer suites; expanded inspector and native consent-dialog captures             |
| Completed-render attachments, destination copy/options, timezone planning, frozen approvals, manual export and explicit YouTube publishing/recovery                                      | Existing workflow/options/dispatch/upload-recovery suites; local rendered media and approved/draft outbox captures |
| Juanito naming, consent/history/tools/cancellation/errors/reactions/cooldown/reduced motion                                                                                              | Existing advisor/renderer suites and Electron smoke; panel collision and Escape checks                             |
| Reset, credential removal, delete-all and all destructive confirmations                                                                                                                  | Existing persistence/credential/IPC/interaction tests, always isolated from user data                              |

## Validation evidence

Baseline `npm run validate` passed outside the sandbox: 454 unit tests and the original Electron smoke test. The sandbox-only attempt blocked nine local OAuth-listener tests with `listen EPERM 127.0.0.1`; rerunning with normal local listener access passed.

The solid-redesign `npm run validate` passed: syntax, media binary inspection, package configuration, ESLint, formatting, **461 unit tests and both Electron suites**. The visual suite regenerated **75 screenshots**. A real close/relaunch of Electron verified saved project drafts/revisions/versions and frozen publishing approvals survive unchanged. Focus regressions cover background error updates and native text undo in the editor. The final independent design review returned **ship** after those fixes.

Screenshots are generated under `test-results/baseline`, `test-results/smoke` and `test-results/redesign`. The redesign matrix records filenames, appearance, size and state in `test-results/redesign/manifest.json`. It covers both appearances at 1440×960 and 1120×760, all primary sections and Studio tabs, expanded inspectors, voice consent, local approval outbox, pending/error/disabled states, 125% zoom and reduced motion. Each capture asserts the whole document has no horizontal overflow. Timeline overflow stays inside its own scroll container.

Verification creates temporary workspaces and generated video fixtures. No live provider, upload, paid request, real credential, or real workspace deletion is used. macOS Electron is exercised here; native Windows title-bar behavior requires Windows verification. Media distribution eligibility remains the repository's existing owner-review limitation reported by `check:media`.

## Review artifacts

- [Screenshot index](../test-results/redesign/index.html), [capture manifest](../test-results/redesign/manifest.json) and [full validation log](../test-results/redesign/validate.log). These local artifacts are intentionally ignored by Git and can be regenerated with `npm run test:smoke`.
- [Visual system](../DESIGN.md), [product constraints](../PRODUCT.md), and [local kit asset provenance](../src/assets/kit/provenance.json).
- The single mechanical design scan found a chrome-padding warning; explicit native-chrome insets resolved it. No detector rerun was needed.
- Verification exercises isolated fixtures and existing automated contracts; it does not certify live Shopify/provider/YouTube credentials or native Windows behavior.

## Optional glass appearances

The owner requested additive glass themes after the solid redesign. Document-level discovery now finds 40 kit pages, including **35 · Native Fidelity Lab** (`115:2`). High-fidelity context and screenshots confirmed the recovered blur studies in Light (`116:55`) and Dark (`116:115`), with reusable Chrome (`116:164`), Button (`116:166`) and Content (`116:168`) Recipe components under `116:170`.

`src/appearance.css` adapts the Fidelity · Color tints and effect recipes: chrome opacity 52% light / 60% dark, content 62% / 66%, button 23% / 32%, a fine white rim and offset soft shadows. CSS blur sigma uses half the Figma radius: chrome 11.25px, button 7.5px, content 22.5px. The background uses the kit studies’ blue-to-rose color stops; primary actions and selected rows retain shared blue. Fields, media, status and approval controls keep their readable working surfaces. Secondary text is darkened/lightened for readable glass contrast. Reduced-transparency preferences and unavailable blur fall back to opaque surfaces.

The sidebar Appearance selector offers **System**, **Light**, **Dark**, **Glass Light** and **Glass Dark**. System remains the default solid appearance and tracks OS changes. Explicit choices override the OS and are restored before styles load. Only the allowlisted `produdash.appearance` preference is saved in renderer local storage; no workspace schema, IPC or credential contract changes. Selecting a theme updates root attributes without rendering content, preserving input drafts, focus and video playback.

Theme verification includes all four explicit choices against the opposite OS appearance, system change events, invalid or unavailable preference storage, restart persistence and unchanged editor media/drafts during switching. The additional matrix captures all seven sections in both glass variants at 1440×960 and 1120×760, plus solid comparisons. Local evidence is in `test-results/appearance`; the original screenshot matrix remains separate.

The glass-theme final `npm run validate` passed all syntax, binary inspection, configuration, lint and formatting checks, **465 unit tests and all three Electron suites**. It regenerated the original 75 captures plus **32 appearance captures**. The bounded visual review returned **ship**. See the [appearance screenshot index](../test-results/appearance/index.html), [appearance manifest](../test-results/appearance/manifest.json) and [latest validation log](../test-results/appearance/validate.log).
