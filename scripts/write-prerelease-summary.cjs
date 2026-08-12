const fs = require("node:fs");
const path = require("node:path");
const packageMetadata = require("../package.json");
const { macArtifactName, releaseProfile } = require("./release-profile.cjs");

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (!summaryPath) process.exit(0);
const signingMode = process.env.PRODUDASH_SIGNING_MODE || "unsigned";
const targetPlatform = process.env.PRODUDASH_TARGET_PLATFORM || process.platform;
const profile = releaseProfile(signingMode, targetPlatform);
const lines = ["## ProduDash prerelease", "", `- Release profile: \`${profile.id}\``];
if (targetPlatform === "darwin" && profile.testerFacing) {
  lines.push(
    `- Tester artifact: \`${macArtifactName(packageMetadata.version, process.arch, "dmg", signingMode)}\``,
    "- This DMG passed Developer ID, Gatekeeper, nested-code, architecture, notarization, and stapling verification.",
    "- The ZIP is an internal verification archive and must not be sent to testers."
  );
} else if (targetPlatform === "darwin") {
  lines.push("- Local-only artifact: do not distribute this unsigned DMG or ZIP to another Mac.");
} else {
  lines.push(`- Tester-facing: ${profile.testerFacing ? "yes" : "no"}`);
}
fs.appendFileSync(path.resolve(summaryPath), `${lines.join("\n")}\n`);
