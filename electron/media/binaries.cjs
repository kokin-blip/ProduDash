const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("@derhuerst/ffprobe-static");
const { AppError } = require("../errors.cjs");

function getMediaBinaries() {
  if (typeof ffmpegPath !== "string" || typeof ffprobePath !== "string") {
    throw new AppError("MEDIA_TOOLS_UNAVAILABLE", "Bundled FFmpeg tools are unavailable.");
  }
  return { ffmpegPath, ffprobePath };
}

module.exports = { getMediaBinaries };
