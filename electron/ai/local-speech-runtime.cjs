const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { AppError } = require("../errors.cjs");
const { workerEnvironment } = require("../media/utility-runner.cjs");

const MAX_LOCAL_AUDIO_BYTES = 32 * 1024 * 1024;

function isWav(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 44 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

function runLocalSpeechCommand({ command, args, input, timeoutMs = 120_000, runtimeName, extraEnvironment = {} }, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const name = String(runtimeName || "The local speech runtime").slice(0, 80);
    const child = spawnProcess(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...workerEnvironment(), ...extraEnvironment }
    });
    let settled = false;
    let stderrBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new AppError("LOCAL_SPEECH_TIMEOUT", `${name} did not finish the local speech request in time.`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 128_000) {
        child.kill();
        finish(new AppError("LOCAL_SPEECH_FAILED", `${name} returned too much diagnostic output.`));
      }
    });
    child.on("error", () => finish(new AppError("LOCAL_SPEECH_UNAVAILABLE", `${name} could not be started.`)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new AppError("LOCAL_SPEECH_FAILED", `${name} could not generate speech with the configured voice.`));
        return;
      }
      finish();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function readBoundedWav(outputPath, runtimeName) {
  const name = String(runtimeName || "The local speech runtime").slice(0, 80);
  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat?.isFile() || stat.size < 44 || stat.size > MAX_LOCAL_AUDIO_BYTES) {
    throw new AppError("LOCAL_SPEECH_INVALID", `${name} did not create a bounded WAV audio file.`);
  }
  const audio = await fs.promises.readFile(outputPath);
  if (!isWav(audio)) throw new AppError("LOCAL_SPEECH_INVALID", `${name} returned an invalid WAV audio file.`);
  return audio;
}

module.exports = { MAX_LOCAL_AUDIO_BYTES, isWav, readBoundedWav, runLocalSpeechCommand };
