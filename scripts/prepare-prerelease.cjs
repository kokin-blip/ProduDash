const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const requested = process.argv[2];
const expectedPlatform = requested === "mac" ? "darwin" : requested === "win" ? "win32" : null;
assert.ok(expectedPlatform, "Choose either mac or win.");
assert.equal(process.platform, expectedPlatform, `The ${requested} prerelease must be built on its native operating system.`);
if (requested === "win") assert.equal(process.arch, "x64", "The Windows prerelease must be built on x64.");
if (requested === "mac") assert.ok(["arm64", "x64"].includes(process.arch), "The macOS prerelease requires arm64 or x64.");

const root = path.join(__dirname, "..");
const environment = {
  ...process.env,
  PRODUDASH_TARGET_PLATFORM: process.platform,
  PRODUDASH_TARGET_ARCH: process.arch
};

if ((process.env.PRODUDASH_SIGNING_MODE || "unsigned") !== "signed") {
  // Ad-hoc signing must never consult certificate material. The prerelease workflow exports
  // CSC_LINK and CSC_KEY_PASSWORD from secrets that are empty on unsigned runs, and
  // electron-builder resolves an empty CSC_LINK as a certificate path, which fails the build
  // before it ever reaches the ad-hoc identity.
  delete environment.CSC_LINK;
  delete environment.CSC_KEY_PASSWORD;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", stdio: "inherit" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.`);
}

run(process.execPath, [path.join(__dirname, "check-media-binaries.cjs"), "--distribution"]);
run(process.execPath, [path.join(__dirname, "check-builder-config.cjs")]);
const builderArgs = [path.join(root, "node_modules", "electron-builder", "out", "cli", "cli.js"), "--config"];
builderArgs.push(path.join(root, "electron-builder.config.cjs"), requested === "mac" ? "--mac" : "--win");
builderArgs.push(process.arch === "arm64" ? "--arm64" : "--x64");
run(process.execPath, builderArgs);
run(process.execPath, [path.join(__dirname, "write-build-metadata.cjs")]);
