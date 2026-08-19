const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");
const { findMacApplication, macArtifactName } = require("./release-profile.cjs");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ProduDash artifact verification "));

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", stdio: "inherit" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.`);
}

// The approved media binaries must reach the artifact byte for byte. Code signing rewrites Mach-O
// files, and a re-signed FFmpeg no longer matches the SHA-256 recorded in manifest.json, so
// electron/media/binaries.cjs rejects it at runtime and media support is disabled in the packaged
// app. Every other media check runs before signing and cannot observe this.
function assertApprovedMediaSurvivedPackaging(mediaDirectory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(mediaDirectory, "manifest.json"), "utf8"));
  for (const [name, entry] of Object.entries(manifest.binaries)) {
    const filePath = path.join(mediaDirectory, entry.file);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    assert.equal(digest, entry.sha256, `Packaged ${name} no longer matches its approved SHA-256. It was most likely re-signed.`);
  }
}

function smoke(executablePath, extraEnvironment = {}) {
  run(process.execPath, ["--test", path.join(root, "smoke", "packaged-electron-smoke.test.cjs")], {
    ...process.env,
    ...extraEnvironment,
    PRODUDASH_PACKAGED_EXECUTABLE: executablePath
  });
}

try {
  if (process.platform === "darwin") {
    const signingMode = process.env.PRODUDASH_SIGNING_MODE || "unsigned";
    const dmgPath = path.join(dist, macArtifactName(packageMetadata.version, process.arch, "dmg", signingMode));
    const zipPath = path.join(dist, macArtifactName(packageMetadata.version, process.arch, "zip", signingMode));
    assert.equal(fs.statSync(dmgPath, { throwIfNoEntry: false })?.isFile(), true, "macOS DMG is missing.");
    assert.equal(fs.statSync(zipPath, { throwIfNoEntry: false })?.isFile(), true, "macOS ZIP is missing.");

    const applicationPath = findMacApplication(dist, process.arch);
    assertApprovedMediaSurvivedPackaging(path.join(applicationPath, "Contents", "Resources", "media"));

    const unpackedExecutable = path.join(applicationPath, "Contents", "MacOS", "ProduDash");
    smoke(unpackedExecutable);

    const zipDirectory = path.join(temporary, "zip");
    fs.mkdirSync(zipDirectory);
    run("ditto", ["-x", "-k", zipPath, zipDirectory]);
    smoke(path.join(zipDirectory, "ProduDash.app", "Contents", "MacOS", "ProduDash"));

    const mountDirectory = path.join(temporary, "dmg");
    fs.mkdirSync(mountDirectory);
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountDirectory, dmgPath]);
    try {
      smoke(path.join(mountDirectory, "ProduDash.app", "Contents", "MacOS", "ProduDash"));
    } finally {
      run("hdiutil", ["detach", mountDirectory]);
    }
  } else if (process.platform === "win32") {
    assert.equal(process.arch, "x64", "Windows artifact verification requires x64.");
    const installer = path.join(dist, `ProduDash-${packageMetadata.version}-win-x64-setup.exe`);
    assert.equal(fs.statSync(installer, { throwIfNoEntry: false })?.isFile(), true, "Windows installer is missing.");
    const installDirectory = path.join(temporary, "Installed ProduDash");
    const redirectedAppData = path.join(temporary, "AppData");
    const environment = { ...process.env, APPDATA: redirectedAppData, LOCALAPPDATA: redirectedAppData };
    run(installer, ["/S", `/D=${installDirectory}`], environment);
    const executable = path.join(installDirectory, "ProduDash.exe");
    smoke(executable, { APPDATA: redirectedAppData, LOCALAPPDATA: redirectedAppData });
    const sentinelDirectory = path.join(redirectedAppData, "ProduDash");
    fs.mkdirSync(sentinelDirectory, { recursive: true });
    const sentinelPath = path.join(sentinelDirectory, "prerelease-data-sentinel");
    fs.writeFileSync(sentinelPath, "preserve");
    run(installer, ["/S", `/D=${installDirectory}`], environment);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "preserve");
    run(path.join(installDirectory, "Uninstall ProduDash.exe"), ["/S"], environment);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "preserve");
  } else {
    throw new Error("Packaged artifact verification supports only macOS and Windows.");
  }
} finally {
  // The NSIS uninstaller relaunches itself from a copy under the temporary
  // directory and returns before that copy exits, so the directory can still
  // be held here. Removing it is not part of the verification contract, so a
  // failure to clean up must not mask a successful verification.
  try {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error) {
    process.stderr.write(`Could not remove ${temporary}: ${error.message}\n`);
  }
}
