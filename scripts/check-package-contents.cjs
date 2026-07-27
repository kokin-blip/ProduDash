const path = require("node:path");
const { auditPackage } = require("./package-audit.cjs");

const targets = process.argv.slice(2);
if (!targets.length) {
  throw new Error("Pass at least one unpacked application directory to check:package.");
}
const results = targets.map((target) => auditPackage(path.resolve(target)));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
