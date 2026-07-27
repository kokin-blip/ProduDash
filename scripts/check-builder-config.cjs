const { validateConfiguration } = require("app-builder-lib/out/util/config/config");
const { DebugLogger } = require("builder-util");
const configuration = require("../electron-builder.config.cjs");

validateConfiguration(configuration, new DebugLogger(false))
  .then(() => process.stdout.write("Electron Builder configuration is valid.\n"))
  .catch((error) => {
    process.stderr.write(`Package configuration check failed: ${error instanceof Error ? error.message : "Invalid configuration."}\n`);
    process.exitCode = 2;
  });
