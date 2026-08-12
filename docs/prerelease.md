# ProduDash `0.1.0-alpha.1` internal prerelease

This guide covers the private macOS and Windows alpha. It does not authorize publishing, tagging, uploading, or public distribution.

## Supported artifacts

| Platform | Architecture        | Artifacts                                                |
| -------- | ------------------- | -------------------------------------------------------- |
| macOS    | Apple silicon arm64 | `ProduDash-0.1.0-alpha.1-mac-arm64-signed-notarized.dmg` |
| macOS    | Intel x64           | `ProduDash-0.1.0-alpha.1-mac-x64-signed-notarized.dmg`   |
| Windows  | x64                 | `ProduDash-0.1.0-alpha.1-win-x64-setup.exe`              |

The application ID is `com.kokinblip.produdash`. The approved PD mark is the temporary alpha icon. No automatic updater or publishing provider is present. Signed and notarized DMGs are the only macOS artifacts intended for another person to test. macOS ZIPs are retained only as internal verification archives.

## Current release blockers

Installer creation requires owner-approved FFmpeg and ffprobe bundles in:

- `vendor/media/mac-arm64` — supplied and verified (FFmpeg 8.1.2, GPL-2.0-or-later)
- `vendor/media/win-x64` — rebuilt and verified on 2026-07-27; see below
- `vendor/media/mac-x64` — still required

Intel macOS packaging stays blocked until its bundle is supplied. Apple silicon
macOS and Windows x64 both produce verified artifacts, first confirmed on
2026-08-01.

An approved media bundle is necessary for packaging but not sufficient: Windows
x64 passed this gate on 2026-07-27 and still could not produce an artifact for
another five days, for an unrelated reason recorded below. "The bundle is
approved" and "the target packages" are separate claims.

### Resolved: win-x64 bundle linked a runtime library it did not ship

The bundle approved as `OWNER-DIRECTIVE-2026-07-26-PRODUDASH-ALPHA1-WIN` could
not start on a clean Windows host. Both `ffmpeg.exe` and `ffprobe.exe` exited
`0xC0000135` (`STATUS_DLL_NOT_FOUND`) because they imported
`libwinpthread-1.dll`, a MinGW runtime library that was neither included in the
bundle nor provided by Windows, so `npm run check:distribution` failed with
`Distribution check failed: ffmpeg exited unsuccessfully.`

Both files matched their recorded SHA-256 hashes, so the bundle was intact and
was the one covered by that approval. The defect was in how the binaries were
linked, not in how they were delivered. Their embedded configuration reported
`--enable-gpl` and `--enable-static` with neither `--enable-version3` nor
`--enable-nonfree`, so the recorded GPL-2.0-or-later license was accurate; only
the pthread runtime was left dynamically linked. The macOS arm64 binaries were
unaffected and load only OS-provided libraries.

The bundle was rebuilt on 2026-07-27 under
`OWNER-DIRECTIVE-2026-07-27-PRODUDASH-ALPHA1-WIN-REBUILD` from the same
GPG-verified FFmpeg 8.1.2 release tarball and the same pinned x264 commit, with
`-static` added to `--extra-ldflags` and `--disable-asm` dropped. The rebuilt
binaries import only Windows system libraries, report version `8.1.2`, retain
`--disable-network`, and expose no network protocol.
`vendor/media/win-x64/NOTICE.txt` records the full provenance.

The configure flags recovered from the superseded binary were:

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

The `/private/tmp` prefixes show it was cross-compiled from macOS with a
mingw-w64 toolchain, reusing the `--extra-ldflags` pattern from the macOS
build. `--pkg-config-flags=--static` was already present; it governs how
pkg-config reports third-party dependencies and does not control linkage of the
toolchain's own runtime. The omission was `-static` in `--extra-ldflags`, which
left mingw-w64 resolving `libwinpthread-1.dll` at load time.

The rebuild was performed natively on Windows under MSYS2 with the same
mingw-w64 GCC 16.1.0, adding `-static` and dropping `--disable-asm` because
NASM was available. Dropping `--disable-asm` restores SIMD; the macOS arm64
bundle was never built with it, so the two targets are now closer in
configuration, not further apart.

Publicly distributed Windows FFmpeg builds were considered and rejected as a
substitute. The BtbN and gyan.dev builds are configured with
`--enable-version3` and are therefore GPL-3.0-or-later, which conflicts with
the recorded GPL-2.0-or-later approval and with the licensing rationale in
`docs/release-readiness.md`. They also enable network protocols, which this
project's build deliberately disables, and are roughly four times the size.

A corrected bundle is accepted only once `npm run check:distribution` passes
natively on Windows x64 and both binaries report their version without a loader
error. The rebuilt bundle satisfies both conditions.

### Resolved: the packaged Windows app rejected its own renderer

With the media gate passing, `npm run package:win` succeeded and
`npm run verify:artifacts` then failed on every run from 2026-07-27 to
2026-08-01 with `page.waitForFunction: Timeout 30000ms exceeded`. The packaged
app launched and rendered **"Startup blocked — The request did not come from the
ProduDash application."** No Windows artifact was produced in that window, so
the earlier claim that Windows x64 packaging was unblocked described the media
gate only.

`createTrustedSender` compared `event.senderFrame.url` with `appUrl` as strings.
`appUrl` is built by `pathToFileURL()` and the frame's URL by Chromium by way of
`loadFile()`, and the two spell the same file differently:

```
expected=file:///C:/Users/RUNNER%7E1/.../app.asar/index.html
actual=  file:///C:/Users/RUNNER~1/.../app.asar/index.html
```

`%7E` is `~`. A GitHub Windows runner resolves `os.tmpdir()` to
`C:\Users\RUNNER~1\...`, the 8.3 short name for `runneradmin`. `pathToFileURL()`
percent-encodes the tilde; Chromium does not. It never reproduced on a developer
machine, because a temp path with no tilde has nothing to encode.

The check now compares the resolved file path, which is the question being
asked, and is case-folded on win32 only. Its security properties are unchanged
and were always carried by the two conditions around it: the sender is a real
`BrowserWindow`, and it is that window's main frame rather than an embedded one.

The failure took five attempts to explain because `PRODUDASH_TRACE_IPC_SENDER`,
which exists for exactly this, wrote only to `process.stderr` — and a packaged
Windows GUI-subsystem app has no reliable stderr, so on the one platform where
the check rejects, its diagnostic was guaranteed to vanish. The trace is now
also written beside the user data and read back by the packaged smoke test.

Note that `npm run verify:artifacts` and `npm run test:packaged` run in no CI
job. They execute only here, so a packaged-app regression is invisible until a
prerelease is attempted.

Use private Git LFS for the executable files. Each directory must contain a completed `manifest.json`, its referenced notice file, and the exact binaries named by the manifest. The example in `vendor/media/manifest.example.json` documents the contract.

`npm run check:distribution` must pass natively on each target. It rejects missing or placeholder files, wrong platforms, mismatched hashes, missing notices, nonfree builds, and binaries whose reported version differs from the manifest. The npm static packages are never accepted for distribution.

## Building privately

Run the manual **Internal desktop prerelease** workflow. Its default is `signed`. Choose a signing mode:

- `signed` for an external macOS test after configuring all required platform secrets; or
- `unsigned` only for a clearly labeled local build that never leaves the build Mac.

Then choose which platforms to package:

- `all` builds every target in one run; or
- `mac-arm64`, `mac-x64`, or `win-x64` builds that target alone.

Select a single target when the other platforms still lack approved media
bundles, so a run is not spent on a target that cannot pass the distribution
check.

The workflow performs a clean install, complete validation, production dependency audit, distribution check, native packaging, package-content audit, unpacked/DMG/ZIP/installer smoke testing, signature and Gatekeeper validation, checksums, SBOM generation, and build metadata generation. Metadata is written only after verification. It retains private workflow artifacts for 14 days and does not create a release.

For macOS, the workflow verifies the unpacked app, ZIP-extracted app, DMG-mounted app, and a copy made from the DMG. Every Mach-O file, including FFmpeg and ffprobe, must have a valid non-ad-hoc Developer ID signature from `APPLE_TEAM_ID` and contain the requested architecture. Every app representation must pass Gatekeeper and stapler validation, and the DMG must carry a valid stapled ticket.

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

Missing values stop signed mode. Signed mode also enables Electron Builder's `forceCodeSigning`, so a missing or unusable identity cannot silently produce an unsigned artifact. Unsigned mode sets no identity, uses the `local-unsigned` release profile, and never claims notarization.

Unsigned macOS builds are local-only and must not be sent to testers. Finder overrides, quarantine removal, and ad-hoc re-signing are not release procedures. Unsigned Windows builds can display a Microsoft Defender SmartScreen warning and remain explicitly internal.

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
shasum -a 256 ProduDash-0.1.0-alpha.1-mac-arm64-signed-notarized.dmg
```

Windows PowerShell:

```powershell
Get-FileHash .\ProduDash-0.1.0-alpha.1-win-x64-setup.exe -Algorithm SHA256
```

Signed macOS artifacts must pass `codesign`, Gatekeeper assessment, nested architecture checks, and stapler validation. Signed Windows installers must report a valid Authenticode signature. The generated CycloneDX SBOM and path-free build metadata should be retained with the matching immutable artifacts.

For a failed macOS test, preserve the original downloaded file and run the path-safe diagnostic without removing quarantine or modifying the app:

```bash
npm run diagnose:mac -- "/path/to/ProduDash-0.1.0-alpha.1-mac-arm64-signed-notarized.dmg" EXPECTED_SHA256
```

The report includes only the artifact basename, checksum result, quarantine state, signature/notarization results, Team ID, authority, and observed architectures. It does not emit the tester's filesystem path.

Final acceptance must use a clean Apple-silicon Mac: download the checksum-matched DMG through Chrome, drag ProduDash to Applications, and open it normally. No damaged-app, unidentified-developer, malware-verification, or manual-override dialog is acceptable.

## Troubleshooting

- **Approved media metadata is unavailable:** the native Git LFS files or `manifest.json` are absent.
- **Integrity validation failed:** a binary does not match its approved SHA-256; do not package it.
- **Media binary exits `0xC0000135` on Windows:** the executable depends on a DLL that is neither bundled nor provided by the operating system. Inspect its imports and rebuild it with that runtime linked statically. Do not copy the missing DLL into the bundle.
- **Target platform or architecture differs:** run the check on the native target runner.
- **Secure credential storage unavailable:** connections stay disabled; do not attempt a plaintext fallback.
- **Unsigned application warning:** do not distribute it; rebuild with the signed workflow and use the `signed-notarized` DMG.
- **Damaged application warning:** retain the downloaded DMG, run `npm run diagnose:mac`, and compare its checksum. Do not clear quarantine or re-sign the tester's copy.
- **Packaged smoke failure:** keep the workflow logs private, correct the package/runtime issue, and rerun from a clean checkout. Do not bypass the smoke or content audit.
