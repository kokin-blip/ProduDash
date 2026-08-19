const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");
const { findMacApplication, macArtifactName, releaseProfile } = require("./release-profile.cjs");
const {
  assertBundleInspection,
  attachDmg,
  collectBundleInspection,
  copyApplication,
  detachDmg,
  digest,
  execute,
  extractZip
} = require("./macos-gatekeeper.cjs");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const signingMode = process.env.PRODUDASH_SIGNING_MODE || "unsigned";
const profile = releaseProfile(signingMode, process.platform);

function writeStamp(data) {
  fs.writeFileSync(
    path.join(dist, ".produdash-signature-verification.json"),
    `${JSON.stringify({ schemaVersion: 1, signingMode, releaseProfile: profile.id, ...data }, null, 2)}\n`
  );
}

if (signingMode !== "signed") {
  assert.equal(profile.testerFacing, false, "An unsigned artifact must never be classified as tester-facing.");
  if (process.platform === "darwin") {
    // An unsigned macOS build is still ad-hoc signed. A bundle with no complete signature cannot be
    // launched once quarantined: macOS reports only that the application is damaged. Gatekeeper and
    // stapler checks are intentionally skipped because no ad-hoc build can pass them.
    const application = findMacApplication(dist, process.arch);
    const verification = execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
    assert.equal(verification.status, 0, `The ad-hoc signature is not valid: ${verification.output}`);
    const description = execute("codesign", ["-dv", "--verbose=4", application]);
    assert.equal(description.status, 0, `codesign could not describe the bundle: ${description.output}`);
    assert.match(description.output, /Signature=adhoc/, "Unsigned macOS builds must carry an ad-hoc signature.");
    assert.doesNotMatch(description.output, /Sealed Resources=none/, "The ad-hoc signature must seal the application bundle resources.");
  }
  writeStamp({ signatureStatus: "ad-hoc-local-only", notarizationStatus: "not-applicable" });
  process.stdout.write("Local unsigned build: ad-hoc signature verified. Not eligible for external macOS testing.\n");
  process.exit(0);
}

if (process.platform === "darwin") {
  const expectedTeamId = process.env.APPLE_TEAM_ID;
  assert.ok(expectedTeamId, "APPLE_TEAM_ID is required for macOS signature verification.");
  const dmgPath = path.join(dist, macArtifactName(packageMetadata.version, process.arch, "dmg", signingMode));
  const zipPath = path.join(dist, macArtifactName(packageMetadata.version, process.arch, "zip", signingMode));
  const unpackedApp = findMacApplication(dist, process.arch);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ProduDash Gatekeeper verification "));
  const inspections = [];
  let mounted = false;
  try {
    inspections.push(collectBundleInspection(unpackedApp, "unpacked-app"));
    const zipApp = extractZip(zipPath, path.join(temporary, "zip"));
    inspections.push(collectBundleInspection(zipApp, "zip-extracted-app"));
    const mountDirectory = path.join(temporary, "dmg");
    const mountedApp = attachDmg(dmgPath, mountDirectory);
    mounted = true;
    inspections.push(collectBundleInspection(mountedApp, "dmg-mounted-app"));
    const copiedApp = copyApplication(mountedApp, path.join(temporary, "Applications", "ProduDash.app"));
    inspections.push(collectBundleInspection(copiedApp, "dmg-copied-app"));
    for (const inspection of inspections) assertBundleInspection(inspection, process.arch, expectedTeamId);
    assert.equal(execute("xcrun", ["stapler", "validate", dmgPath]).status, 0, "The DMG notarization ticket is missing or invalid.");
    const artifactDigests = [dmgPath, zipPath].map((artifactPath) => ({ name: path.basename(artifactPath), sha256: digest(artifactPath) }));
    writeStamp({
      signatureStatus: "verified-developer-id",
      notarizationStatus: "verified-stapled",
      teamId: expectedTeamId,
      architecture: process.arch,
      representations: inspections.map(({ label }) => label),
      artifacts: artifactDigests
    });
    process.stdout.write(
      `macOS Developer ID, Gatekeeper, architecture, and notarization verification passed for ${inspections.length} representations.\n`
    );
  } finally {
    if (mounted) detachDmg(path.join(temporary, "dmg"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else if (process.platform === "win32") {
  const installer = path.join(dist, `ProduDash-${packageMetadata.version}-win-x64-setup.exe`);
  const command = `(Get-AuthenticodeSignature -FilePath '${installer.replaceAll("'", "''")}').Status`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Valid", "Windows installer signature is not valid.");
  writeStamp({ signatureStatus: "verified-authenticode", notarizationStatus: "not-applicable" });
} else {
  throw new Error("Signature verification supports only macOS and Windows.");
}
