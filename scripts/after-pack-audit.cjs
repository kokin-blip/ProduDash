const { auditPackage } = require("./package-audit.cjs");
const { Arch } = require("builder-util");

module.exports = async function afterPack(context) {
  const architecture = typeof context.arch === "number" ? Arch[context.arch] : context.arch;
  const result = auditPackage(context.appOutDir, {
    platform: context.electronPlatformName,
    architecture
  });
  process.stdout.write(`Package content audit passed: ${JSON.stringify(result)}\n`);
};
