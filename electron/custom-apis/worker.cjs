const { pathToFileURL } = require("node:url");
let runtime;
process.parentPort.on("message", async ({ data }) => {
  try {
    if (data?.type === "start" && !runtime) {
      const { startApi } = await import(pathToFileURL(data.entryPath).href);
      runtime = await startApi(data.options);
      process.parentPort.postMessage({ type: "ready", port: runtime.port });
    } else if (data?.type === "stop") {
      await runtime?.stop();
      process.parentPort.postMessage({ type: "stopped" });
      process.exit(0);
    }
  } catch {
    // Upstream browser exceptions contain URLs and private data. Never forward.
    process.parentPort.postMessage({ type: "failed" });
    process.exit(1);
  }
});
