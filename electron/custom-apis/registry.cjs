const path = require("node:path");
const fs = require("node:fs");
const { AppError } = require("../errors.cjs");
function tiktokConfiguration(prior, { expectedUsername, profileDir } = {}) {
  if (typeof expectedUsername !== "string" || !/^[\w.-]{1,64}$/.test(expectedUsername))
    throw new AppError("INVALID_INPUT", "Enter the expected TikTok username without @.");
  if (profileDir !== undefined) {
    let valid = false;
    if (typeof profileDir === "string" && path.isAbsolute(profileDir)) {
      try {
        const actual = fs.realpathSync(profileDir);
        valid = fs.statSync(actual).isDirectory() && !/\/Library\/Application Support\/Google\/Chrome(?:\/|$)/.test(actual);
      } catch {
        /* Invalid selection. */
      }
    }
    if (!valid) throw new AppError("INVALID_INPUT", "Choose an existing dedicated browser profile, not your regular Chrome profile.");
  }
  return {
    expectedUsername,
    ...(profileDir ? { profileDir: fs.realpathSync(profileDir) } : prior.profileDir ? { profileDir: prior.profileDir } : {})
  };
}
const CUSTOM_APIS = Object.freeze({
  tiktok: Object.freeze({
    id: "tiktok",
    name: "TikTok browser API",
    protocol: 1,
    entryPath: path.join(__dirname, "../../integrations/tiktok-api/src/runtime.js"),
    capabilities: Object.freeze(["posting", "messaging"]),
    configure: tiktokConfiguration,
    isConfigured: (config) => Boolean(config?.expectedUsername),
    publicConfiguration: (config) => ({
      expectedUsername: config?.expectedUsername || "",
      usingExistingProfile: Boolean(config?.profileDir)
    }),
    runtimeOptions: (config, dir) => ({
      mediaDir: path.join(dir, "media"),
      profileDir: config.profileDir || path.join(dir, "browser-profile"),
      expectedUsername: config.expectedUsername,
      managed: true,
      writesEnabled: true
    })
  })
});
module.exports = { CUSTOM_APIS };
