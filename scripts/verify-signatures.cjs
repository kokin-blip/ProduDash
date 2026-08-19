const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");

const signingMode = process.env.PRODUDASH_SIGNING_MODE || "unsigned";
const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const macAppPath = path.join(dist, `mac-${process.arch}`, "ProduDash.app");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed.\n${result.stderr || ""}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

if (signingMode !== "signed") {
  if (process.platform !== "darwin") {
    process.stdout.write("Unsigned internal build: this platform carries no signature to verify.\n");
    process.exit(0);
  }
  // An unsigned macOS build is still ad-hoc signed. A bundle without a complete ad-hoc signature
  // fails to launch once quarantined, reporting only that the application is damaged.
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", macAppPath]);
  const description = capture("codesign", ["-dv", "--verbose=4", macAppPath]);
  assert.match(description, /Signature=adhoc/, "Unsigned macOS builds must carry an ad-hoc signature.");
  assert.doesNotMatch(description, /Sealed Resources=none/, "The ad-hoc signature must seal the application bundle resources.");
  process.stdout.write("Unsigned internal build: ad-hoc signature verified. Notarization checks were intentionally skipped.\n");
  process.exit(0);
}

if (process.platform === "darwin") {
  const dmgPath = path.join(dist, `ProduDash-${packageMetadata.version}-mac-${process.arch}.dmg`);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", macAppPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", macAppPath]);
  run("xcrun", ["stapler", "validate", macAppPath]);
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
