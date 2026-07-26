const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getMediaBinaries } = require("../electron/media/binaries.cjs");

const EXPECTED_PACKAGES = Object.freeze([
  { name: "ffmpeg-static", expectedLicense: "GPL-3.0-or-later" },
  { name: "@derhuerst/ffprobe-static", expectedLicense: "GPL-3.0-or-later" }
]);

function packageMetadata(name) {
  const packagePath = require.resolve(`${name}/package.json`);
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return {
    name,
    version: String(metadata.version || ""),
    license: String(metadata.license || ""),
    packagePath
  };
}

function inspectBinary(label, binaryPath) {
  assert.equal(path.isAbsolute(binaryPath), true, `${label} must resolve to an absolute path.`);
  assert.equal(fs.statSync(binaryPath, { throwIfNoEntry: false })?.isFile(), true, `${label} binary is missing.`);
  const result = spawnSync(binaryPath, ["-version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
  assert.equal(result.error, undefined, `${label} could not start.`);
  assert.equal(result.status, 0, `${label} exited unsuccessfully.`);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.match(output, new RegExp(`^${label} version`, "m"), `${label} did not return recognizable version output.`);
  return {
    path: binaryPath,
    versionLine: output.split(/\r?\n/).find((line) => line.startsWith(`${label} version`)) || "",
    nonfreeBuild: output.includes("--enable-nonfree")
  };
}

function main() {
  const enforceDistribution = process.argv.includes("--distribution");
  const packages = EXPECTED_PACKAGES.map(({ name, expectedLicense }) => {
    const metadata = packageMetadata(name);
    assert.equal(metadata.license, expectedLicense, `${name} license metadata changed and requires review.`);
    assert.match(metadata.version, /^\d+\.\d+\.\d+/, `${name} version metadata is invalid.`);
    return metadata;
  });
  const { ffmpegPath, ffprobePath } = getMediaBinaries();
  const binaries = [inspectBinary("ffmpeg", ffmpegPath), inspectBinary("ffprobe", ffprobePath)];
  const distributionBlocked =
    packages.some(({ license }) => license.startsWith("GPL-")) || binaries.some(({ nonfreeBuild }) => nonfreeBuild);

  process.stdout.write(
    `${JSON.stringify(
      {
        platform: process.platform,
        architecture: process.arch,
        packages: packages.map(({ name, version, license }) => ({ name, version, license })),
        binaries: binaries.map(({ versionLine, nonfreeBuild }) => ({ versionLine, nonfreeBuild })),
        distribution: distributionBlocked ? "blocked_pending_owner_legal_review_or_approved_replacement_builds" : "requires_release_review"
      },
      null,
      2
    )}\n`
  );
  if (enforceDistribution && distributionBlocked) {
    process.stderr.write(
      "Distribution check failed: the development media binaries require owner legal approval or approved replacement builds.\n"
    );
    process.exitCode = 2;
  }
}

main();
