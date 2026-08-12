const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertArtifactDigest } = require("./release-profile.cjs");
const { attachDmg, collectBundleInspection, detachDmg, digest, execute, quarantinePresent } = require("./macos-gatekeeper.cjs");

if (process.platform !== "darwin") throw new Error("macOS artifact diagnostics must run on macOS.");
const artifactPath = path.resolve(process.argv[2] || "");
if (!fs.statSync(artifactPath, { throwIfNoEntry: false })) throw new Error("Pass an existing ProduDash .dmg or .app path.");
const expectedDigest = process.argv[3] || null;
const isDmg = path.extname(artifactPath).toLowerCase() === ".dmg";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ProduDash diagnostics "));
let appPath = artifactPath;
let mounted = false;

try {
  if (isDmg) {
    appPath = attachDmg(artifactPath, path.join(temporary, "dmg"));
    mounted = true;
  } else if (!artifactPath.endsWith(".app")) {
    throw new Error("Diagnostics accept only a ProduDash .dmg or .app.");
  }
  const sha256 = isDmg ? digest(artifactPath) : null;
  let checksumMatched = null;
  if (expectedDigest) {
    assertArtifactDigest(sha256, expectedDigest);
    checksumMatched = true;
  }
  const inspection = collectBundleInspection(appPath, "ProduDash.app");
  const report = {
    schemaVersion: 1,
    artifact: path.basename(artifactPath),
    hostArchitecture: process.arch,
    sha256,
    checksumMatched,
    artifactQuarantined: quarantinePresent(artifactPath),
    dmgTicketValid: isDmg ? execute("xcrun", ["stapler", "validate", artifactPath]).status === 0 : null,
    application: {
      deepSignatureValid: inspection.deepSignatureValid,
      gatekeeperAccepted: inspection.gatekeeperAccepted,
      appTicketValid: inspection.appTicketValid,
      quarantined: inspection.quarantinePresent,
      teamId: inspection.outerSignature.teamId,
      developerIdAuthority:
        inspection.outerSignature.authorities.find((authority) => authority.startsWith("Developer ID Application:")) || null,
      adHoc: inspection.outerSignature.adHoc,
      invalidNestedSignatures: inspection.nestedSignatures.filter(({ valid }) => !valid).map(({ label }) => label),
      architectures: Array.from(new Set(inspection.architectureInspections.flatMap(({ architectures }) => architectures))).sort()
    }
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (mounted) detachDmg(path.join(temporary, "dmg"));
  fs.rmSync(temporary, { recursive: true, force: true });
}
