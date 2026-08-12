const path = require("node:path");
const { SIGNING_MODES, releaseProfile } = require("./scripts/release-profile.cjs");

const signingMode = process.env.PRODUDASH_SIGNING_MODE || "unsigned";
const targetPlatform = process.env.PRODUDASH_TARGET_PLATFORM || process.platform;

if (!SIGNING_MODES.has(signingMode)) {
  throw new Error("PRODUDASH_SIGNING_MODE must be either unsigned or signed.");
}

function requireEnvironment(names, platform) {
  if (signingMode !== "signed" || targetPlatform !== platform) return;
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Signed ${platform} builds require: ${missing.join(", ")}.`);
  }
}

requireEnvironment(["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"], "darwin");
requireEnvironment(["CSC_LINK", "CSC_KEY_PASSWORD"], "win32");

const signed = signingMode === "signed";
const targetReleaseProfile = releaseProfile(signingMode, targetPlatform);
const macReleaseProfile = releaseProfile(signingMode, "darwin");
const resourcePlatform = targetPlatform === "darwin" ? "mac" : targetPlatform === "win32" ? "win" : targetPlatform;

module.exports = {
  appId: "com.kokinblip.produdash",
  productName: "ProduDash",
  copyright: "Copyright © 2026 ProduDash",
  asar: true,
  asarUnpack: ["electron/ai/python/*.py"],
  directories: {
    output: "dist",
    buildResources: "build"
  },
  files: [
    "index.html",
    "electron/**/*",
    "src/**/*",
    "assets/advisor/states/**/*",
    "package.json",
    "!**/*.map",
    "!**/.DS_Store",
    "!**/.env*",
    "!electron/**/*.test.*",
    "!assets/advisor/concepts/**/*",
    "!node_modules/ffmpeg-static/**/*",
    "!node_modules/@derhuerst/ffprobe-static/**/*",
    "!node_modules/protobufjs/scripts/**/*",
    "!node_modules/**/{test,tests,__tests__,docs,example,examples}/**/*"
  ],
  extraResources: [
    {
      from: `vendor/media/${resourcePlatform}-\${arch}`,
      to: "media",
      filter: ["ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe", "manifest.json", "NOTICE*"]
    }
  ],
  npmRebuild: false,
  publish: null,
  forceCodeSigning: signed,
  mac: {
    target: ["dmg", "zip"],
    artifactName: `ProduDash-\${version}-mac-\${arch}-${macReleaseProfile.artifactSuffix}.\${ext}`,
    category: "public.app-category.business",
    icon: "build/icon.icns",
    identity: signed ? undefined : null,
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: signed ? "build/entitlements.mac.plist" : undefined,
    entitlementsInherit: signed ? "build/entitlements.mac.inherit.plist" : undefined,
    notarize: signed
  },
  dmg: {
    sign: signed
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "ProduDash-${version}-win-${arch}-setup.${ext}",
    icon: "build/icon.ico",
    signAndEditExecutable: signed
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    runAfterFinish: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico"
  },
  extraMetadata: {
    releaseChannel: "internal-alpha",
    buildSigningMode: signingMode,
    releaseProfile: targetReleaseProfile.id,
    testerFacing: targetReleaseProfile.testerFacing
  },
  afterPack: path.join(__dirname, "scripts", "after-pack-audit.cjs")
};
