const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SIGNING_MODES = new Set(["unsigned", "signed"]);

function releaseProfile(signingMode, platform) {
  assert.ok(SIGNING_MODES.has(signingMode), "Signing mode must be either unsigned or signed.");
  if (platform === "darwin") {
    return signingMode === "signed"
      ? {
          id: "external-signed-notarized",
          artifactSuffix: "signed-notarized",
          testerFacing: true,
          notarizationRequired: true
        }
      : {
          id: "local-unsigned",
          artifactSuffix: "local-unsigned",
          testerFacing: false,
          notarizationRequired: false
        };
  }
  if (platform === "win32") {
    return signingMode === "signed"
      ? { id: "external-signed", artifactSuffix: "signed", testerFacing: true, notarizationRequired: false }
      : { id: "internal-unsigned", artifactSuffix: "unsigned", testerFacing: false, notarizationRequired: false };
  }
  return { id: "internal-validation", artifactSuffix: "internal", testerFacing: false, notarizationRequired: false };
}

function macArtifactName(version, architecture, extension, signingMode) {
  const profile = releaseProfile(signingMode, "darwin");
  return `ProduDash-${version}-mac-${architecture}-${profile.artifactSuffix}.${extension}`;
}

function findMacApplication(distDirectory, architecture) {
  assert.ok(["arm64", "x64"].includes(architecture), "macOS artifacts require arm64 or x64.");
  const directoryNames = architecture === "x64" ? ["mac", "mac-x64"] : ["mac-arm64"];
  const candidates = directoryNames
    .map((directoryName) => path.join(distDirectory, directoryName, "ProduDash.app"))
    .filter((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory());
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length
        ? `Multiple unpacked ProduDash applications were found for ${architecture}.`
        : `The unpacked ProduDash application was not found for ${architecture}.`
    );
  }
  return candidates[0];
}

function assertSignatureInspection(inspection, expectedTeamId) {
  assert.equal(inspection.valid, true, `${inspection.label} has an invalid code signature.`);
  assert.equal(inspection.adHoc, false, `${inspection.label} is ad-hoc signed.`);
  assert.equal(inspection.teamId, expectedTeamId, `${inspection.label} has an unexpected Apple Team ID.`);
  assert.equal(
    inspection.authorities.some((authority) => authority.startsWith("Developer ID Application:")),
    true,
    `${inspection.label} is not signed with a Developer ID Application identity.`
  );
}

function assertArchitectureInspections(inspections, expectedArchitecture) {
  assert.ok(inspections.length, "No Mach-O executables were found in the application bundle.");
  for (const inspection of inspections) {
    assert.equal(
      inspection.architectures.includes(expectedArchitecture),
      true,
      `${inspection.label} does not contain the expected ${expectedArchitecture} architecture.`
    );
  }
}

function assertNotarizationInspection(inspection) {
  assert.equal(inspection.appTicketValid, true, "The application notarization ticket is missing or invalid.");
  assert.equal(inspection.dmgTicketValid, true, "The DMG notarization ticket is missing or invalid.");
  assert.equal(inspection.gatekeeperAccepted, true, "Gatekeeper rejected the application.");
}

function assertArtifactDigest(actual, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/i, "The expected SHA-256 digest is invalid.");
  assert.equal(actual.toLowerCase(), expected.toLowerCase(), "The artifact SHA-256 digest does not match.");
}

module.exports = {
  SIGNING_MODES,
  assertArchitectureInspections,
  assertArtifactDigest,
  assertNotarizationInspection,
  assertSignatureInspection,
  findMacApplication,
  macArtifactName,
  releaseProfile
};
