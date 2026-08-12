const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");
const { assertArtifactDigest, macArtifactName, releaseProfile } = require("./release-profile.cjs");

const root = path.join(__dirname, "..");
const distDirectory = path.join(root, "dist");
const ignored = /(?:checksums\.txt|build-metadata\.json|sbom\.cdx\.json)$/;
const artifactPattern = /\.(?:dmg|zip|exe)$/i;
const artifacts = fs
  .readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && artifactPattern.test(entry.name) && !ignored.test(entry.name))
  .map((entry) => {
    const filePath = path.join(distDirectory, entry.name);
    const data = fs.readFileSync(filePath);
    return {
      name: entry.name,
      bytes: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex")
    };
  });
if (!artifacts.length) throw new Error("No prerelease artifacts were produced.");

const signingMode = process.env.PRODUDASH_SIGNING_MODE || "unsigned";
const profile = releaseProfile(signingMode, process.platform);
const verificationPath = path.join(distDirectory, ".produdash-signature-verification.json");
const verification = JSON.parse(fs.readFileSync(verificationPath, "utf8"));
if (verification.signingMode !== signingMode || verification.releaseProfile !== profile.id) {
  throw new Error("Signature verification does not match this build profile.");
}
if (profile.notarizationRequired) {
  if (verification.signatureStatus !== "verified-developer-id" || verification.notarizationStatus !== "verified-stapled") {
    throw new Error("External macOS metadata requires verified Developer ID signing and stapled notarization.");
  }
  for (const verifiedArtifact of verification.artifacts || []) {
    const artifact = artifacts.find(({ name }) => name === verifiedArtifact.name);
    if (!artifact) throw new Error(`Verified artifact is missing: ${verifiedArtifact.name}.`);
    assertArtifactDigest(artifact.sha256, verifiedArtifact.sha256);
  }
}

const prefix = `ProduDash-${packageMetadata.version}`;
fs.writeFileSync(
  path.join(distDirectory, `${prefix}-checksums.txt`),
  `${artifacts.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`
);

const windows = process.platform === "win32";
const npmCommand = windows ? "npm.cmd" : "npm";
// Node refuses to spawn .cmd files without a shell, so Windows needs one.
// The arguments are fixed literals, so nothing user-supplied reaches it.
const sbom = spawnSync(npmCommand, ["sbom", "--omit=dev", "--sbom-format=cyclonedx"], {
  cwd: root,
  encoding: "utf8",
  shell: windows
});
if (sbom.error) throw new Error(`SBOM generation could not start: ${sbom.error.message}`);
if (sbom.status !== 0) throw new Error(sbom.stderr || "SBOM generation failed.");
JSON.parse(sbom.stdout);
fs.writeFileSync(path.join(distDirectory, `${prefix}-sbom.cdx.json`), sbom.stdout);

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0) throw new Error("Build revision could not be determined.");
fs.writeFileSync(
  path.join(distDirectory, `${prefix}-build-metadata.json`),
  `${JSON.stringify(
    {
      product: "ProduDash",
      version: packageMetadata.version,
      channel: "internal-alpha",
      revision: revision.stdout.trim(),
      platform: process.platform,
      architecture: process.arch,
      signingMode,
      releaseProfile: profile.id,
      testerFacing: profile.testerFacing,
      signatureStatus: verification.signatureStatus,
      notarizationStatus: verification.notarizationStatus,
      canonicalTesterArtifact:
        process.platform === "darwin" && profile.testerFacing
          ? macArtifactName(packageMetadata.version, process.arch, "dmg", signingMode)
          : null,
      generatedAt: new Date().toISOString(),
      artifacts
    },
    null,
    2
  )}\n`
);
