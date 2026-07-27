const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const packageMetadata = require("../package.json");

const root = path.join(__dirname, "..");
const distDirectory = path.join(root, "dist");
const ignored = /(?:checksums\.txt|build-metadata\.json|sbom\.cdx\.json)$/;
const artifactPattern = /\.(?:dmg|zip|exe)$/i;
const artifacts = fs
  .readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && artifactPattern.test(entry.name) && !ignored.test(entry.name))
  .map((entry) => {
    const filePath = path.join(distDirectory, entry.name);
    const data = fs.readFileSync(filePath);
    return {
      name: entry.name,
      bytes: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex")
    };
  });
if (!artifacts.length) throw new Error("No prerelease artifacts were produced.");

const prefix = `ProduDash-${packageMetadata.version}`;
fs.writeFileSync(
  path.join(distDirectory, `${prefix}-checksums.txt`),
  `${artifacts.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`
);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const sbom = spawnSync(npmCommand, ["sbom", "--omit=dev", "--sbom-format=cyclonedx"], {
  cwd: root,
  encoding: "utf8"
});
if (sbom.status !== 0) throw new Error(sbom.stderr || "SBOM generation failed.");
JSON.parse(sbom.stdout);
fs.writeFileSync(path.join(distDirectory, `${prefix}-sbom.cdx.json`), sbom.stdout);

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0) throw new Error("Build revision could not be determined.");
fs.writeFileSync(
  path.join(distDirectory, `${prefix}-build-metadata.json`),
  `${JSON.stringify(
    {
      product: "ProduDash",
      version: packageMetadata.version,
      channel: "internal-alpha",
      revision: revision.stdout.trim(),
      platform: process.platform,
      architecture: process.arch,
      signingMode: process.env.PRODUDASH_SIGNING_MODE || "unsigned",
      generatedAt: new Date().toISOString(),
      artifacts
    },
    null,
    2
  )}\n`
);
