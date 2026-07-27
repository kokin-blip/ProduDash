# Approved media-tool intake

Production packages accept media binaries only from the native target folder:

- `mac-arm64`
- `mac-x64`
- `win-x64`

Each folder must contain `manifest.json`, its referenced license notice, and the exact FFmpeg/ffprobe files named by that manifest. Large executable files are stored with private Git LFS. Copy `manifest.example.json`, replace every placeholder with reviewed provenance and SHA-256 values, and set `approvedForDistribution` to `true` only after owner/legal approval.

Development and automated tests continue to use the npm-provided static binaries. They are excluded from packaged applications and do not satisfy the distribution gate.
