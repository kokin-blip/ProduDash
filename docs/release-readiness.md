# ProduDash release readiness

ProduDash is validated as a local development MVP and is configured for a private `0.1.0-alpha.1` macOS/Windows prerelease. Packaging remains fail-closed until the owner supplies approved FFmpeg and ffprobe files for every native target.

## Automated validation

The regular validation workflow runs clean installation, syntax checks, linting, formatting, and a production dependency audit on Ubuntu, plus unit/integration/renderer tests, real tiny-media tests, and Electron smoke coverage on Ubuntu, macOS, and Windows.

Two gaps in that workflow are deliberate and worth stating rather than discovering. `npm run check:package-config` runs in `npm run validate` and in the manual prerelease workflow, but in no CI job. And the dependency audit is scoped with `--omit=dev`, so advisories against build-only tooling are not gated on; `electron-builder` currently carries high-severity advisories in its transitive tree that cannot be resolved without downgrading it several major versions.

Every automated test runs against injected clients. No test authorizes with a provider or uploads anything, so automated validation says nothing about whether the live connectors work.

The manual prerelease workflow uses native hosts:

- `macos-14` for macOS arm64;
- `macos-15-intel` for macOS x64; and
- `windows-latest` for Windows x64.

Each prerelease job repeats the complete validation suite, enforces the approved-media gate, packages with Electron Builder, audits application contents, launches unpacked and installed artifacts with isolated non-ASCII user-data paths, verifies signatures when signed mode is selected, and generates checksums, a CycloneDX SBOM, and path-free build metadata. Private workflow artifacts expire after 14 days. The workflow cannot create a GitHub Release or publish through Electron Builder.

## Distribution remains blocked

The development packages `ffmpeg-static` and `@derhuerst/ffprobe-static` declare `GPL-3.0-or-later`, and the selected development build advertises `--enable-nonfree`. They remain available for development and tests but are explicitly excluded from packaged applications.

Production packaging accepts only private Git LFS files under the native target directory. Each target requires:

- exact FFmpeg and ffprobe executables;
- an immutable HTTPS source;
- version and SPDX license metadata;
- an owner/legal approval reference;
- `nonfreeBuild: false`;
- SHA-256 hashes for both binaries; and
- the referenced license notice.

The gate rejects missing binaries, Git LFS pointer stubs, path traversal, malformed metadata, mismatched target/architecture, hash mismatches, absent notices, unexpected binary versions, or detected nonfree configuration. Passing the automated gate records technical evidence; it is not a substitute for owner/legal approval.

The `win-x64` bundle originally supplied failed this gate. Its binaries matched their recorded hashes, and their embedded configuration confirmed the GPL-2.0-or-later approval, but they imported `libwinpthread-1.dll`, which is neither bundled nor provided by Windows, so they could not start. The bundle was rebuilt on 2026-07-27 with `-static` added to `--extra-ldflags`, re-approved, and now passes the gate; Windows x64 packaging is unblocked. macOS x64 remains blocked because no bundle has been supplied. The macOS arm64 bundle loads only OS-provided libraries and was unaffected. `docs/prerelease.md` records the reproduction and the rebuild.

## Signing and installation

Unsigned mode is explicitly internal and does not claim notarization. Signed macOS mode fails unless the Developer ID certificate, password, App Store Connect API key, issuer, key ID, and team ID exist. Signed Windows mode fails unless its certificate and password exist.

macOS signed builds enable hardened runtime with only Electron’s JIT and unsigned-executable-memory entitlements, then require code-signature assessment, notarization, and stapling validation. Windows uses an assisted per-user NSIS installer with no administrator requirement, no automatic launch, a Start menu shortcut, and preserved ProduDash user data during repair, upgrade, and uninstall.

There is no updater, update feed, public publishing provider, release tag automation, or rollback service in this alpha.

## One live connector, the rest still blocked

YouTube publishing is live. A build produced today can upload to a real channel using an OAuth client the owner supplies, authorized over a loopback redirect that needs no hosted service. That capability is gated on human approval of an immutable snapshot, but it is real, and it is the first thing in ProduDash that sends a user's media off their machine.

ProduDash does not claim live TikTok, Meta/Instagram, Stripe, cross-device collaboration, webhook delivery, or public API availability. Those require approved platform applications, a hosted HTTPS OAuth/webhook service, tenant-aware storage and key custody, deployment ownership, monitoring, incident response, live acceptance tests, and a separate release decision.

ProduDash never substitutes scraping, browser automation, fake connection states, or mock provider output for missing official connectors.

## Owner acceptance before distribution

Before generating the first immutable internal installer set:

1. Supply and approve all three native media-tool bundles and notices.
2. Run the manual native prerelease workflow.
3. Record whether each artifact is unsigned or signed/notarized.
4. Inspect the generated application icon and Analytics navigation glyph.
5. Review packaged-app screenshots and smoke logs.
6. Verify checksums, SBOM, package-content audit, and build metadata.
7. Accept the live YouTube connector against Google, because no automated test can. Run `scripts/acceptance/youtube.cjs` with an owner-supplied OAuth client and record, here, the date, the channel used, and the answers to:
   - Did Google return a refresh token for this client type? The connector's whole design assumes it does; if it does not, every publish needs a fresh browser authorization and that assumption must be corrected rather than worked around.
   - Did a private upload complete, and did the receipt record the id YouTube actually returned?
   - Did YouTube apply the requested visibility, or force private because the API project is unaudited?

   Status: **not yet run.** The refresh-token behaviour above is currently an assumption, not an observation.

Before any public release, additionally complete the privacy, terms, synthetic-media, retention, accessibility, support, incident-response, updater, signing, and jurisdiction-specific reviews described in the product roadmap.
