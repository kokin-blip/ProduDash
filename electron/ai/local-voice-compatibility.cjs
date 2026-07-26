const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const LOCAL_ENGINES = Object.freeze([
  {
    id: "piper",
    name: "Piper",
    kind: "speech",
    description: "Fast local speech generation with downloadable voice models; no likeness cloning.",
    minMemoryGb: 2,
    preferredMemoryGb: 4,
    accelerator: "optional",
    commands: ["piper"]
  },
  {
    id: "kokoro",
    name: "Kokoro",
    kind: "speech",
    description: "Lightweight open-weight speech generation; no likeness cloning.",
    minMemoryGb: 4,
    preferredMemoryGb: 8,
    accelerator: "optional",
    commands: ["kokoro", "kokoro-tts"]
  },
  {
    id: "chatterbox",
    name: "Chatterbox",
    kind: "likeness",
    description: "Local reference-audio speech and multilingual voice likeness generation.",
    minMemoryGb: 8,
    preferredMemoryGb: 16,
    accelerator: "preferred",
    commands: ["chatterbox", "chatterbox-tts"]
  },
  {
    id: "xtts",
    name: "XTTS",
    kind: "likeness",
    description: "Local multilingual voice likeness generation through a separately installed runtime.",
    minMemoryGb: 12,
    preferredMemoryGb: 16,
    accelerator: "preferred",
    commands: ["tts", "xtts"]
  },
  {
    id: "rvc",
    name: "RVC",
    kind: "voice_conversion",
    description: "Local voice conversion for transforming an existing speech recording; it does not generate speech from text.",
    minMemoryGb: 8,
    preferredMemoryGb: 16,
    accelerator: "preferred",
    commands: ["rvc", "rvc-cli"]
  },
  {
    id: "tortoise",
    name: "Tortoise TTS",
    kind: "likeness",
    description: "High-quality local multi-voice speech generation that is computationally intensive.",
    minMemoryGb: 8,
    preferredMemoryGb: 16,
    accelerator: "preferred",
    commands: ["tortoise-tts", "tortoise_tts"]
  }
]);

async function commandExists(command, platform = process.platform, runner = execFileAsync) {
  const locator = platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await runner(locator, [command], {
      timeout: 2_000,
      maxBuffer: 32_000,
      windowsHide: true
    });
    return Boolean(String(stdout || "").trim());
  } catch {
    return false;
  }
}

async function detectAccelerator(platform = process.platform, runner = execFileAsync) {
  try {
    if (platform === "darwin") {
      const { stdout } = await runner("system_profiler", ["SPDisplaysDataType", "-json"], {
        timeout: 5_000,
        maxBuffer: 500_000
      });
      const text = String(stdout || "").toLowerCase();
      if (text.includes("apple m") || text.includes("metal")) return "Apple GPU / Metal";
      if (text.includes("nvidia")) return "NVIDIA GPU";
      if (text.includes("amd") || text.includes("radeon")) return "AMD GPU";
    } else if (platform === "win32") {
      const { stdout } = await runner(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
        { timeout: 5_000, maxBuffer: 100_000, windowsHide: true }
      );
      const text = String(stdout || "").toLowerCase();
      if (text.includes("nvidia")) return "NVIDIA GPU";
      if (text.includes("amd") || text.includes("radeon")) return "AMD GPU";
      if (text.includes("intel")) return "Intel GPU";
    } else {
      const { stdout } = await runner("lspci", [], { timeout: 5_000, maxBuffer: 100_000 });
      const text = String(stdout || "").toLowerCase();
      if (text.includes("nvidia")) return "NVIDIA GPU";
      if (text.includes("amd") || text.includes("radeon")) return "AMD GPU";
      if (text.includes("intel")) return "Intel GPU";
    }
  } catch {
    return null;
  }
  return null;
}

function buildLocalVoiceReport(snapshot, installed = {}) {
  const memoryGb = Math.max(1, Math.round((Number(snapshot.memoryBytes) / 1024 ** 3) * 10) / 10);
  const accelerator = snapshot.accelerator || null;
  const engines = LOCAL_ENGINES.map((engine) => {
    const memoryCompatible = memoryGb >= engine.minMemoryGb;
    const preferredMemory = memoryGb >= engine.preferredMemoryGb;
    const acceleratorReady = engine.accelerator === "optional" || Boolean(accelerator);
    const compatible = memoryCompatible;
    const recommended = compatible && preferredMemory && acceleratorReady;
    const isInstalled = engine.commands.some((command) => installed[command]);
    return {
      id: engine.id,
      name: engine.name,
      kind: engine.kind,
      description: engine.description,
      compatible,
      recommended,
      installed: isInstalled,
      status: isInstalled && compatible ? "installed" : recommended ? "recommended" : compatible ? "compatible" : "not_recommended",
      reason: !memoryCompatible
        ? `Needs at least ${engine.minMemoryGb} GB system memory.`
        : engine.accelerator === "preferred" && !accelerator
          ? "Can run on CPU, but an accelerator is strongly preferred."
          : isInstalled
            ? "A matching command is installed and the hardware meets the baseline."
            : "Hardware meets the baseline; install and configure the runtime separately."
    };
  });
  const best = engines.find((engine) => engine.installed && engine.recommended) || engines.find((engine) => engine.recommended) || null;
  return {
    scannedAt: new Date().toISOString(),
    device: {
      platform: snapshot.platform,
      architecture: snapshot.architecture,
      cpuCores: snapshot.cpuCores,
      memoryGb,
      accelerator: accelerator || "Not detected"
    },
    bestEngineId: best?.id || null,
    engines,
    privacy: "This compatibility scan ran locally. ProduDash did not upload device inventory."
  };
}

async function scanLocalVoiceCompatibility(options = {}) {
  const platform = options.platform || process.platform;
  const runner = options.runner || execFileAsync;
  const accelerator = await detectAccelerator(platform, runner);
  const commands = [...new Set(LOCAL_ENGINES.flatMap((engine) => engine.commands))];
  const installedEntries = await Promise.all(commands.map(async (command) => [command, await commandExists(command, platform, runner)]));
  return buildLocalVoiceReport(
    {
      platform,
      architecture: options.architecture || process.arch,
      cpuCores: options.cpuCores || os.cpus().length,
      memoryBytes: options.memoryBytes || os.totalmem(),
      accelerator
    },
    Object.fromEntries(installedEntries)
  );
}

module.exports = { LOCAL_ENGINES, buildLocalVoiceReport, scanLocalVoiceCompatibility };
