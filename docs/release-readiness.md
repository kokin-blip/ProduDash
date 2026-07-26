# ProduDash release readiness

ProduDash is validated as a local development MVP. This document separates
working product behavior from the owner-controlled work required before any
external distribution or hosted feature is enabled.

## Automated on every supported desktop OS

GitHub Actions runs on current Ubuntu, macOS, and Windows runners. Each runner:

- installs from the lockfile;
- checks syntax, linting, and formatting;
- verifies the resolved FFmpeg and ffprobe executables;
- runs the complete unit, integration, renderer, and real tiny-media suite; and
- launches the Electron smoke test, using Xvfb only on Linux.

The Ubuntu quality job also audits production dependencies. Smoke screenshots
are retained as CI artifacts for visual inspection.

`npm run check:media` reports the exact installed static-package versions,
declared licenses, executable version lines, and whether a binary advertises a
nonfree build configuration. It intentionally does not convert legal review
into an automated approval. `npm run check:distribution` applies the release
gate and exits unsuccessfully while the current media-binary block exists.

## Distribution is blocked

The development dependencies `ffmpeg-static` and
`@derhuerst/ffprobe-static` currently declare `GPL-3.0-or-later`. The selected
binary build may also report `--enable-nonfree`. ProduDash therefore must not
package or redistribute these development binaries until the owner completes
license review and supplies an approved distribution decision or replacement
builds. Passing CI is not legal approval.

No installer target is configured. A release additionally requires:

- final product name, bundle/application identifiers, versioning policy, and
  platform icons;
- Apple Developer ID signing, hardened-runtime entitlements, notarization, and
  a tested macOS minimum version;
- Windows code-signing credentials, installer choice, and SmartScreen testing;
- Linux package targets plus documented secure-secret-service requirements;
- signed update metadata and an owner-approved update/rollback policy;
- a dependency and asset-license inventory for every bundled model, voice,
  font, image, sound, and native executable; and
- privacy policy, terms, synthetic-media disclosures, retention policy, and
  jurisdiction-specific release review.

## Live connectors are blocked

ProduDash does not claim live TikTok, Meta/Instagram, YouTube, Stripe,
cross-device collaboration, webhook delivery, or public API availability.
Those features require owner-controlled external systems:

- approved platform applications, client identifiers, secrets, scopes, review
  status, redirect URIs, and test accounts;
- a hosted HTTPS callback service with OAuth state/PKCE/HMAC verification,
  encrypted token custody, rotation, revocation, webhook verification, and
  audit operations;
- a selected identity provider, transactional database, tenant/data-residency
  policy, encryption and key-custody design, backups, retention jobs, incident
  response, and support ownership; and
- deployment domains, DNS/TLS control, monitoring, rate limiting, abuse
  handling, signing/wrapping keys, and production secret delivery.

The repository contains tested local publishing, analytics, collaboration, and
developer-platform contracts. They remain UI/network-disabled until these
prerequisites are supplied and live acceptance tests pass. ProduDash never
substitutes scraping, browser automation, fake connection states, or mock
provider output for a missing official connector.

## Owner acceptance before release

Before a public build, record:

1. The approved media-binary distribution strategy and all required notices.
2. The exact platforms and versions supported by the release.
3. Signing/notarization results for each produced artifact.
4. Live-provider tests performed with owner-controlled test accounts.
5. Synthetic voice/likeness policy and provider-specific consent requirements.
6. Security, privacy, accessibility, backup/restore, and deletion test results.
7. Checksums and a software bill of materials for the final immutable build.

Until every applicable item is complete, ProduDash should remain a local
development MVP rather than a publicly distributed or hosted product.
