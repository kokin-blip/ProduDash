# ProduDash `0.1.0-alpha.1` internal prerelease

This guide covers the private macOS and Windows alpha. It does not authorize publishing, tagging, uploading, or public distribution.

## Supported artifacts

| Platform | Architecture        | Artifacts                                                                        |
| -------- | ------------------- | -------------------------------------------------------------------------------- |
| macOS    | Apple silicon arm64 | `ProduDash-0.1.0-alpha.1-mac-arm64.dmg`, `ProduDash-0.1.0-alpha.1-mac-arm64.zip` |
| macOS    | Intel x64           | `ProduDash-0.1.0-alpha.1-mac-x64.dmg`, `ProduDash-0.1.0-alpha.1-mac-x64.zip`     |
| Windows  | x64                 | `ProduDash-0.1.0-alpha.1-win-x64-setup.exe`                                      |

The application ID is `com.kokinblip.produdash`. The approved PD mark is the temporary alpha icon. No automatic updater or publishing provider is present.

## Current release blocker

Installer creation requires owner-approved FFmpeg and ffprobe bundles in:

- `vendor/media/mac-arm64`
- `vendor/media/mac-x64`
- `vendor/media/win-x64`

Use private Git LFS for the executable files. Each directory must contain a completed `manifest.json`, its referenced notice file, and the exact binaries named by the manifest. The example in `vendor/media/manifest.example.json` documents the contract.

`npm run check:distribution` must pass natively on each target. It rejects missing or placeholder files, wrong platforms, mismatched hashes, missing notices, nonfree builds, and binaries whose reported version differs from the manifest. The npm static packages are never accepted for distribution.

## Building privately

Run the manual **Internal desktop prerelease** workflow. Choose:

- `unsigned` for a clearly labeled internal build; or
- `signed` only after configuring all required platform secrets.

The workflow performs a clean install, complete validation, production dependency audit, distribution check, native packaging, package-content audit, unpacked/DMG/ZIP/installer smoke testing, signature validation, checksums, SBOM generation, and build metadata generation. It retains private workflow artifacts for 14 days and does not create a release.

Local native commands are:

```bash
npm run package:mac
npm run package:win
```

Only the command matching the current operating system and native architecture is accepted.

## Signing variables

Signed macOS builds require:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_API_KEY_CONTENT`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Signed Windows builds require:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

Missing values stop signed mode. Unsigned mode sets no identity and never claims notarization.

Unsigned macOS builds may require the tester to use Finder’s **Open** confirmation. Unsigned Windows builds can display a Microsoft Defender SmartScreen warning. These warnings are expected only for explicitly internal unsigned artifacts and must not be hidden or described as signed.

## Data and secure storage

Packaged ProduDash stores application data beneath Electron’s standard per-user location:

- macOS: `~/Library/Application Support/ProduDash`
- Windows: `%APPDATA%\ProduDash`

Credentials remain encrypted through Electron `safeStorage` and are never included in application state, build metadata, screenshots, logs, or installers. Windows installation, repair, upgrade, and uninstall preserve this user-data directory.

**Reset dashboard data** retains provider profiles and encrypted credentials as documented in the application. **Delete all data and credentials** removes ProduDash-managed metadata and credentials but never deletes user-owned source or generated media.

## Verifying an artifact

Compare the artifact with `ProduDash-0.1.0-alpha.1-checksums.txt`.

macOS:

```bash
shasum -a 256 ProduDash-0.1.0-alpha.1-mac-arm64.dmg
```

Windows PowerShell:

```powershell
Get-FileHash .\ProduDash-0.1.0-alpha.1-win-x64-setup.exe -Algorithm SHA256
```

Signed macOS artifacts must pass `codesign`, Gatekeeper assessment, and stapler validation. Signed Windows installers must report a valid Authenticode signature. The generated CycloneDX SBOM and path-free build metadata should be retained with the matching immutable artifacts.

## Troubleshooting

- **Approved media metadata is unavailable:** the native Git LFS files or `manifest.json` are absent.
- **Integrity validation failed:** a binary does not match its approved SHA-256; do not package it.
- **Target platform or architecture differs:** run the check on the native target runner.
- **Secure credential storage unavailable:** connections stay disabled; do not attempt a plaintext fallback.
- **Unsigned application warning:** confirm the artifact is the intended internal checksum-matched build, or use the signed workflow.
- **Packaged smoke failure:** keep the workflow logs private, correct the package/runtime issue, and rerun from a clean checkout. Do not bypass the smoke or content audit.
