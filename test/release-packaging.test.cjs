const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const asar = require("@electron/asar");
const packageMetadata = require("../package.json");
const builderConfiguration = require("../electron-builder.config.cjs");
const { loadApprovedMediaManifest } = require("../electron/media/binaries.cjs");
const { workerEnvironment } = require("../electron/media/utility-runner.cjs");
const { auditPackage } = require("../scripts/package-audit.cjs");
const { createDirectory } = require("./helpers.cjs");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeApprovedMedia(directory, overrides = {}) {
  const ffmpeg = Buffer.from("approved ffmpeg");
  const ffprobe = Buffer.from("approved ffprobe");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "ffmpeg"), ffmpeg);
  fs.writeFileSync(path.join(directory, "ffprobe"), ffprobe);
  fs.writeFileSync(path.join(directory, "NOTICE.txt"), "Reviewed license notice");
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "darwin",
      architecture: "arm64",
      version: "6.0",
      source: "https://downloads.example.test/ffmpeg-6.0.tar.xz",
      approvedForDistribution: true,
      approvalReference: "owner-legal-review-2026-07",
      nonfreeBuild: false,
      license: { spdx: "LGPL-2.1-or-later", noticeFile: "NOTICE.txt" },
      binaries: {
        ffmpeg: { file: "ffmpeg", sha256: hash(ffmpeg) },
        ffprobe: { file: "ffprobe", sha256: hash(ffprobe) }
      },
      ...overrides
    })
  );
}

test("prerelease identity and builder configuration are fixed and non-publishing", () => {
  assert.equal(packageMetadata.version, "0.1.0-alpha.1");
  assert.equal(builderConfiguration.appId, "com.kokinblip.produdash");
  assert.equal(builderConfiguration.productName, "ProduDash");
  assert.equal(builderConfiguration.publish, null);
  assert.equal(builderConfiguration.asar, true);
  assert.deepEqual(builderConfiguration.asarUnpack, ["electron/ai/python/*.py"]);
  assert.equal(builderConfiguration.nsis.oneClick, false);
  assert.equal(builderConfiguration.nsis.perMachine, false);
  assert.equal(builderConfiguration.nsis.deleteAppDataOnUninstall, false);
  assert.match(builderConfiguration.mac.artifactName, /mac-\$\{arch\}/);
  assert.match(builderConfiguration.win.artifactName, /win-\$\{arch\}-setup/);
  assert.ok(builderConfiguration.files.includes("!node_modules/ffmpeg-static/**/*"));
});

test("signed packaging fails closed when platform credentials are absent", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./electron-builder.config.cjs')"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PRODUDASH_SIGNING_MODE: "signed",
      PRODUDASH_TARGET_PLATFORM: "darwin"
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Signed darwin builds require/);
});

test("approved media manifests require provenance, notices, hashes, platform, and architecture", (t) => {
  const directory = createDirectory("produdash-approved-media-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeApprovedMedia(directory);
  const approved = loadApprovedMediaManifest(directory, { platform: "darwin", architecture: "arm64" });
  assert.equal(path.basename(approved.ffmpegPath), "ffmpeg");
  assert.equal(approved.manifest.approvedForDistribution, true);

  writeApprovedMedia(directory, { nonfreeBuild: true });
  assert.throws(() => loadApprovedMediaManifest(directory), { code: "MEDIA_TOOLS_UNAVAILABLE" });
  writeApprovedMedia(directory, { architecture: "x64" });
  assert.throws(() => loadApprovedMediaManifest(directory, { platform: "darwin", architecture: "arm64" }), {
    code: "MEDIA_TOOLS_UNAVAILABLE"
  });
  writeApprovedMedia(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, source: "https://user:secret@example.test/ffmpeg" }));
  assert.throws(() => loadApprovedMediaManifest(directory), { code: "MEDIA_TOOLS_UNAVAILABLE" });
  writeApprovedMedia(directory);
  fs.writeFileSync(path.join(directory, "ffmpeg"), "version https://git-lfs.github.com/spec/v1\n");
  assert.throws(() => loadApprovedMediaManifest(directory), { code: "MEDIA_TOOLS_UNAVAILABLE" });
});

test("package audit rejects test content while accepting approved media resources", async (t) => {
  const directory = createDirectory("produdash-package-audit-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const appOut = path.join(directory, "app");
  const resources = path.join(appOut, "resources");
  fs.mkdirSync(source);
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(source, "index.html"), "<p>ProduDash</p>");
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"produdash"}');
  await asar.createPackage(source, path.join(resources, "app.asar"));
  writeApprovedMedia(path.join(resources, "media"));
  assert.equal(auditPackage(appOut).mediaVersion, "6.0");

  fs.mkdirSync(path.join(source, "test"));
  fs.writeFileSync(path.join(source, "test", "fixture.js"), "module.exports = true;");
  fs.rmSync(path.join(resources, "app.asar"));
  await asar.createPackage(source, path.join(resources, "app.asar"));
  assert.throws(() => auditPackage(appOut), /forbidden files/);
});

test("packaged worker environment forwards only required media resource metadata", () => {
  assert.deepEqual(
    workerEnvironment({
      PATH: "/bin",
      PRODUDASH_PACKAGED: "1",
      PRODUDASH_RESOURCES_PATH: "/Applications/ProduDash.app/Contents/Resources",
      SECRET: "do-not-forward"
    }),
    {
      PATH: "/bin",
      PRODUDASH_PACKAGED: "1",
      PRODUDASH_RESOURCES_PATH: "/Applications/ProduDash.app/Contents/Resources"
    }
  );
});

test("prerelease icons and Analytics navigation use the approved ProduDash mark and visible glyph", () => {
  const root = path.join(__dirname, "..");
  assert.equal(
    fs
      .readFileSync(path.join(root, "build", "icon.png"))
      .subarray(1, 4)
      .toString("ascii"),
    "PNG"
  );
  assert.equal(
    fs
      .readFileSync(path.join(root, "build", "icon.icns"))
      .subarray(0, 4)
      .toString("ascii"),
    "icns"
  );
  const ico = fs.readFileSync(path.join(root, "build", "icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /data-section="analytics"[\s\S]*M4 19V11M10 19V6M16 19v-5M3 19h18M4 11l6-5 6 8 4-4/);
  assert.doesNotMatch(html, /M4 20V10M10 20V4M16 20v-7M22 20H2/);
});
