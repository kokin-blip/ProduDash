const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");

if ((process.env.PRODUDASH_SIGNING_MODE || "unsigned") !== "signed") {
  process.stdout.write("Unsigned internal build: signature and notarization checks were intentionally skipped.\n");
  process.exit(0);
}

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.`);
}

if (process.platform === "darwin") {
  const appPath = path.join(dist, `mac-${process.arch}`, "ProduDash.app");
  const dmgPath = path.join(dist, `ProduDash-${packageMetadata.version}-mac-${process.arch}.dmg`);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
} else if (process.platform === "win32") {
  const installer = path.join(dist, `ProduDash-${packageMetadata.version}-win-x64-setup.exe`);
  const command = `(Get-AuthenticodeSignature -FilePath '${installer.replaceAll("'", "''")}').Status`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Valid", "Windows installer signature is not valid.");
} else {
  throw new Error("Signature verification supports only macOS and Windows.");
}
