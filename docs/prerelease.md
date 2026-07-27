# ProduDash `0.1.0-alpha.1` internal prerelease

This guide covers the private macOS and Windows alpha. It does not authorize publishing, tagging, uploading, or public distribution.

## Supported artifacts

| Platform | Architecture        | Artifacts                                                                        |
| -------- | ------------------- | -------------------------------------------------------------------------------- |
| macOS    | Apple silicon arm64 | `ProduDash-0.1.0-alpha.1-mac-arm64.dmg`, `ProduDash-0.1.0-alpha.1-mac-arm64.zip` |
| macOS    | Intel x64           | `ProduDash-0.1.0-alpha.1-mac-x64.dmg`, `ProduDash-0.1.0-alpha.1-mac-x64.zip`     |
| Windows  | x64                 | `ProduDash-0.1.0-alpha.1-win-x64-setup.exe`                                      |

The application ID is `com.kokinblip.produdash`. The approved PD mark is the temporary alpha icon. No automatic updater or publishing provider is present.

## Current release blockers

Installer creation requires owner-approved FFmpeg and ffprobe bundles in:

- `vendor/media/mac-arm64` — supplied and verified (FFmpeg 8.1.2, GPL-2.0-or-later)
- `vendor/media/win-x64` — supplied but rejected; see below
- `vendor/media/mac-x64` — still required

Intel macOS packaging stays blocked until its bundle is supplied. Windows x64
packaging stays blocked until its bundle is rebuilt. Apple silicon macOS can
package now.

### Windows x64 bundle links a runtime library it does not ship

`vendor/media/win-x64/ffmpeg.exe` and `ffprobe.exe` fail to start on a clean
Windows host, exiting `0xC0000135` (`STATUS_DLL_NOT_FOUND`). Both import
`libwinpthread-1.dll`, a MinGW runtime library that is neither included in the
bundle nor provided by Windows. `npm run check:distribution` consequently fails
with `Distribution check failed: ffmpeg exited unsuccessfully.`

Both files match the SHA-256 hashes recorded in `manifest.json`, so the bundle
is intact and is the one covered by
`OWNER-DIRECTIVE-2026-07-26-PRODUDASH-ALPHA1-WIN`. The defect is in how the
binaries were linked, not in how they were delivered. Their embedded
configuration reports `--enable-gpl` and `--enable-static` with neither
`--enable-version3` nor `--enable-nonfree`, so the recorded GPL-2.0-or-later
license is accurate; only the pthread runtime was left dynamically linked. The
macOS arm64 binaries are unaffected and load only OS-provided libraries.

The configure flags recovered from the shipped binary are:

```
--prefix=/private/tmp/produdash-win-media/out
--target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32-
--enable-gpl --enable-static --disable-shared --enable-libx264
--disable-asm --disable-autodetect --disable-debug --disable-doc
--disable-ffplay --disable-network
--pkg-config-flags=--static
--extra-cflags=-I/private/tmp/produdash-win-media/deps/include
--extra-ldflags=-L/private/tmp/produdash-win-media/deps/lib
```

The `/private/tmp` prefixes show this was cross-compiled from macOS with a
mingw-w64 toolchain, reusing the `--extra-ldflags` pattern from the macOS
build. `--pkg-config-flags=--static` is already present; it governs how
pkg-config reports third-party dependencies and does not control linkage of the
toolchain's own runtime. The omission is `-static` in `--extra-ldflags`, which
left mingw-w64 resolving `libwinpthread-1.dll` at load time.

Resolution requires rebuilding this configuration with `-static` added to
`--extra-ldflags`, then confirming the result imports no non-system DLL. A
rebuilt bundle needs refreshed SHA-256 hashes in `manifest.json` and a new owner
approval reference.

Note also that the Windows build sets `--disable-asm` while the macOS arm64
build does not, so it has no SIMD acceleration and encodes substantially more
slowly. This does not block packaging, but a rebuild is the natural point to
supply nasm to the cross toolchain and drop that flag.

Publicly distributed Windows FFmpeg builds are not a substitute. The BtbN and
gyan.dev builds are configured with `--enable-version3` and are therefore
GPL-3.0-or-later, which conflicts with the recorded GPL-2.0-or-later approval
and with the licensing rationale in `docs/release-readiness.md`. Adopting one
would be a licensing decision for the owner, not a packaging fix.

A corrected bundle is accepted only once `npm run check:distribution` passes
natively on Windows x64 and both binaries report their version without a loader
error.

Use private Git LFS for the executable files. Each directory must contain a completed `manifest.json`, its referenced notice file, and the exact binaries named by the manifest. The example in `vendor/media/manifest.example.json` documents the contract.

`npm run check:distribution` must pass natively on each target. It rejects missing or placeholder files, wrong platforms, mismatched hashes, missing notices, nonfree builds, and binaries whose reported version differs from the manifest. The npm static packages are never accepted for distribution.

## Building privately

Run the manual **Internal desktop prerelease** workflow. Choose a signing mode:

- `unsigned` for a clearly labeled internal build; or
- `signed` only after configuring all required platform secrets.

Then choose which platforms to package:

- `all` builds every target in one run; or
- `mac-arm64`, `mac-x64`, or `win-x64` builds that target alone.

Select a single target when the other platforms still lack approved media
bundles, so a run is not spent on a target that cannot pass the distribution
check.

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
- **Media binary exits `0xC0000135` on Windows:** the executable depends on a DLL that is neither bundled nor provided by the operating system. Inspect its imports and rebuild it with that runtime linked statically. Do not copy the missing DLL into the bundle.
- **Target platform or architecture differs:** run the check on the native target runner.
- **Secure credential storage unavailable:** connections stay disabled; do not attempt a plaintext fallback.
- **Unsigned application warning:** confirm the artifact is the intended internal checksum-matched build, or use the signed workflow.
- **Packaged smoke failure:** keep the workflow logs private, correct the package/runtime issue, and rerun from a clean checkout. Do not bypass the smoke or content audit.
