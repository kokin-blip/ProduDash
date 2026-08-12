const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { assertArchitectureInspections, assertSignatureInspection } = require("./release-profile.cjs");

const MACH_O_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout || ""}\n${result.stderr || ""}`.trim(),
    error: result.error?.message || null
  };
}

function run(command, args) {
  const result = execute(command, args);
  assert.equal(result.error, null, `${command} could not start: ${result.error}`);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.output}`);
  return result.output;
}

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isMachO(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    return MACH_O_MAGICS.has(header.readUInt32BE(0)) || MACH_O_MAGICS.has(header.readUInt32LE(0));
  } finally {
    fs.closeSync(descriptor);
  }
}

function listFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(filePath));
    else if (entry.isFile()) result.push(filePath);
  }
  return result;
}

function signatureDetails(filePath, label) {
  const verification = execute("codesign", ["--verify", "--strict", "--verbose=4", filePath]);
  const details = execute("codesign", ["--display", "--verbose=4", filePath]);
  const authorities = Array.from(details.output.matchAll(/^Authority=(.+)$/gm), (match) => match[1].trim());
  const teamId = details.output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
  return {
    label,
    valid: verification.status === 0,
    adHoc: /^Signature=adhoc$/m.test(details.output) || authorities.length === 0,
    teamId,
    authorities
  };
}

function quarantinePresent(filePath) {
  return execute("xattr", ["-p", "com.apple.quarantine", filePath]).status === 0;
}

function collectBundleInspection(appPath, label) {
  const files = listFiles(appPath).filter(isMachO);
  const architectureInspections = files.map((filePath) => {
    const result = execute("lipo", ["-archs", filePath]);
    return {
      label: `${label}:${path.relative(appPath, filePath).replaceAll(path.sep, "/")}`,
      architectures: result.status === 0 ? result.output.split(/\s+/).filter(Boolean) : []
    };
  });
  const nestedSignatures = files.map((filePath, index) => signatureDetails(filePath, architectureInspections[index].label));
  const deepVerification = execute("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  return {
    label,
    deepSignatureValid: deepVerification.status === 0,
    outerSignature: signatureDetails(appPath, label),
    nestedSignatures,
    architectureInspections,
    gatekeeperAccepted: execute("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]).status === 0,
    appTicketValid: execute("xcrun", ["stapler", "validate", appPath]).status === 0,
    quarantinePresent: quarantinePresent(appPath)
  };
}

function assertBundleInspection(inspection, expectedArchitecture, expectedTeamId) {
  assert.equal(inspection.deepSignatureValid, true, `${inspection.label} failed strict deep code-signature verification.`);
  assertSignatureInspection(inspection.outerSignature, expectedTeamId);
  for (const signature of inspection.nestedSignatures) assertSignatureInspection(signature, expectedTeamId);
  assertArchitectureInspections(inspection.architectureInspections, expectedArchitecture);
  assert.equal(inspection.gatekeeperAccepted, true, `${inspection.label} was rejected by Gatekeeper.`);
  assert.equal(inspection.appTicketValid, true, `${inspection.label} has no valid stapled notarization ticket.`);
}

function findApplication(directory) {
  const applications = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  assert.equal(applications.length, 1, "Exactly one application bundle must be present in the macOS artifact.");
  return path.join(directory, applications[0].name);
}

function extractZip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  run("ditto", ["-x", "-k", zipPath, destination]);
  return findApplication(destination);
}

function attachDmg(dmgPath, mountDirectory) {
  fs.mkdirSync(mountDirectory, { recursive: true });
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountDirectory, dmgPath]);
  return findApplication(mountDirectory);
}

function detachDmg(mountDirectory) {
  run("hdiutil", ["detach", mountDirectory]);
}

function copyApplication(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  run("ditto", [source, destination]);
  return destination;
}

module.exports = {
  assertBundleInspection,
  attachDmg,
  collectBundleInspection,
  copyApplication,
  detachDmg,
  digest,
  execute,
  extractZip,
  quarantinePresent
};
