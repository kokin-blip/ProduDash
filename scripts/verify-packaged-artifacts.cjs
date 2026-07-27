const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ProduDash artifact verification "));

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", stdio: "inherit" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.`);
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
    const prefix = `ProduDash-${packageMetadata.version}-mac-${process.arch}`;
    const dmgPath = path.join(dist, `${prefix}.dmg`);
    const zipPath = path.join(dist, `${prefix}.zip`);
    assert.equal(fs.statSync(dmgPath, { throwIfNoEntry: false })?.isFile(), true, "macOS DMG is missing.");
    assert.equal(fs.statSync(zipPath, { throwIfNoEntry: false })?.isFile(), true, "macOS ZIP is missing.");

    const unpackedExecutable = path.join(dist, `mac-${process.arch}`, "ProduDash.app", "Contents", "MacOS", "ProduDash");
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
  fs.rmSync(temporary, { recursive: true, force: true });
}
