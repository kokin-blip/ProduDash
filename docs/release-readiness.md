# ProduDash release readiness

ProduDash is validated as a local development MVP and is configured for a private `0.1.0-alpha.1` macOS/Windows prerelease. Packaging remains fail-closed until the owner supplies approved FFmpeg and ffprobe files for every native target.

## Automated validation

The regular validation workflow runs clean installation, syntax checks, linting, formatting, production dependency audit, unit/integration/renderer tests, real tiny-media tests, and Electron smoke coverage on Ubuntu, macOS, and Windows.

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

## Signing and installation

Unsigned mode is explicitly internal and does not claim notarization. Signed macOS mode fails unless the Developer ID certificate, password, App Store Connect API key, issuer, key ID, and team ID exist. Signed Windows mode fails unless its certificate and password exist.

macOS signed builds enable hardened runtime with only Electron’s JIT and unsigned-executable-memory entitlements, then require code-signature assessment, notarization, and stapling validation. Windows uses an assisted per-user NSIS installer with no administrator requirement, no automatic launch, a Start menu shortcut, and preserved ProduDash user data during repair, upgrade, and uninstall.

There is no updater, update feed, public publishing provider, release tag automation, or rollback service in this alpha.

## Live and public features remain blocked

ProduDash does not claim live TikTok, Meta/Instagram, YouTube, Stripe, cross-device collaboration, webhook delivery, or public API availability. Those require approved platform applications, a hosted HTTPS OAuth/webhook service, tenant-aware storage and key custody, deployment ownership, monitoring, incident response, live acceptance tests, and a separate release decision.

ProduDash never substitutes scraping, browser automation, fake connection states, or mock provider output for missing official connectors.

## Owner acceptance before distribution

Before generating the first immutable internal installer set:

1. Supply and approve all three native media-tool bundles and notices.
2. Run the manual native prerelease workflow.
3. Record whether each artifact is unsigned or signed/notarized.
4. Inspect the generated application icon and Analytics navigation glyph.
5. Review packaged-app screenshots and smoke logs.
6. Verify checksums, SBOM, package-content audit, and build metadata.

Before any public release, additionally complete the privacy, terms, synthetic-media, retention, accessibility, support, incident-response, updater, signing, and jurisdiction-specific reviews described in the product roadmap.
