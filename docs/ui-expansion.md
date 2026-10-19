# Studio and commerce UI extension

The approved extension adapts the owner's iMovie and Numbers kit patterns into the existing ProduDash interface. It preserves the shared blue selection language, system typography, native form controls and four explicit themes: Light, Dark, Glass Light and Glass Dark. System remains the default appearance. `src/appearance.css` is unchanged.

## Reference and implementation

The supplied high-fidelity screens and code were reviewed during this pass. Reference nodes in Figma file `Gz7WEiN8Y3Vvivvae0ZPlP` are `137:45061`, `137:46139`, `137:45637`, `137:47155`, `126:1687`, `126:943` and `126:1959`. These are pattern references, not production content. Kit-native extracted assets remain local; reference sample media and data are not added to production. No new static assets or color identity are introduced.

| Surface                 | Implemented behavior                                                                                                                                                                                                                             | Source                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Library                 | Responsive media tiles with indexed thumbnails, duration overlay, status, selected state and existing detail/actions. Missing thumbnails retain the format fallback.                                                                             | `src/renderer/views/studio.js`                                                                      |
| Project preview         | Separate source/edited mode and playback groups, existing frame stepping and labeled seek control.                                                                                                                                               | `src/renderer/views/projects.js`                                                                    |
| Project timeline        | Existing interactive SVG spans the editor width, with edited-time ruler, actual cut/source labels, indexed source thumbnail backdrops, internal horizontal scrolling and 1–4× zoom. The prepared waveform is explicitly labeled Source waveform. | `src/renderer/views/projects.js`                                                                    |
| Inspector and templates | Numbers-style headings and ruled property rows retain native fields, form names, constraints, values and existing actions.                                                                                                                       | `src/renderer/ui-patterns.js`, `src/renderer/views/projects.js`, `src/renderer/views/templates.js`  |
| Orders                  | Compact read-only records with scoped headers, numeric alignment and internal overflow.                                                                                                                                                          | `src/renderer/views/dashboard.js`                                                                   |
| Revenue                 | Dashboard and Analytics share SVG bar presentation, each retaining its own series, definitions and limits. Dense series scroll. Exact accessible values remain in Dashboard's screen-reader table and Analytics' visible table.                  | `src/renderer/ui-patterns.js`, `src/renderer/views/dashboard.js`, `src/renderer/views/analytics.js` |

Shared geometry and theme-token usage live in `src/styles.css`. The timeline's indexed thumbnail is reused across cuts; it is not a per-cut filmstrip. The waveform describes the source rather than the edited output. Revenue presentation retains negative, zero and unavailable values without manufacturing a series. Commerce remains read-only and existing approval, consent and provider boundaries remain in place. Current product capabilities are authoritative in `PRODUCT.md`.

## Verification status

Implementation, source review, full automated validation and final visual review are complete. The app is open in Content Studio → Library with Glass Dark selected.

- Full `npm run validate` passed: syntax (**173 files**), media binaries, package configuration, lint, format, **486/486 unit tests** and **4/4 Electron smoke tests**.
- The earlier focused run passed **59 tests**, including five expansion helper/parity tests. This verifies the covered contracts and cases; it does not establish every possible workflow.
- Source review found timeline zoom and dense-chart issues; both were corrected. Runtime smoke additionally caught a legacy row-count assertion and a dense-chart intrinsic-width issue; both were corrected before the passing full rerun.
- The cleaned capture matrix contains **92 unique redesign files** and **32 appearance files**, for **124 current captures**. An additional recapture run passed after the test began waiting for a decoded video frame, replacing metadata-only black previews in eight editor captures. This test-only change does not alter production behavior. Older galleries predate this extension and are not its acceptance evidence.
- Final visual review: **SHIP**. The reviewer checked all eight decoded editor and eight template captures and found no material visual blockers at the captured themes, sizes and states. This is a visual verdict, not a guarantee of every workflow.
- The initial restricted run hit loopback `listen EPERM` and Electron sandbox launch failures; automatic approval review temporarily reported MODEL AT CAPACITY. Execution subsequently recovered and the unrestricted full validation passed. Those earlier logs are historical, not current blockers.
- `npm run app` opened the user's application after validation passed.

Current capture manifests are `test-results/redesign/manifest.json` and `test-results/appearance/manifest.json`. Validation evidence and logs are in `test-results/ui-expansion/`, including current `verification.json`, `validate.log` and `recapture.log`, plus earlier `focused.log`, `syntax.log`, `restricted.log` and `visual.log`. Renderer form/action parity is recorded in `docs/ui-expansion-parity.json`. Root `DESIGN.md` and `.impeccable/design.json` describe the extended visual patterns while preserving incumbent tokens.

## Review and reproduction

The commands below completed successfully from the project root:

```sh
npm run validate
npm run app
```

The automated smoke suite uses isolated fixtures. The captured matrix covers populated, empty, missing/error and disabled states across the four themes at the minimum window size and narrower effective zoom widths. For future changes, recheck Library selection and thumbnail fallback; preview transport; keyboard cut selection and focus; timeline scroll/zoom; native property-field validation; exact revenue table values, dense series and zero/negative/unavailable cases; and Orders table overflow. Check Juanito open, reduced motion/transparency and preservation of drafts, focus, scroll and playback during background updates. Capture fresh evidence and repeat visual review after further UI changes.
