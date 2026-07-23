const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { AppError } = require("../errors.cjs");
const { Headers, Response } = globalThis;

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

function safeErrorResponse(error) {
  const status = error instanceof AppError && ["CLIP_NOT_FOUND", "THUMBNAIL_NOT_FOUND"].includes(error.code) ? 404 : 403;
  return new Response("", { status });
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function createMediaProtocolHandler(mediaLibrary) {
  return async (request) => {
    let stopAccess = null;
    try {
      if (!["GET", "HEAD"].includes(request.method)) return new Response("", { status: 405 });
      const url = new URL(request.url);
      const kind = url.hostname;
      const clipId = url.pathname.replace(/^\/+/, "");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(clipId) || !["clip", "thumbnail"].includes(kind)) {
        return new Response("", { status: 404 });
      }
      const filePath = kind === "clip" ? mediaLibrary.resolveClipPath(clipId) : mediaLibrary.resolveThumbnailPath(clipId);
      if (kind === "clip") stopAccess = mediaLibrary.startClipAccess(clipId);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response("", { status: 404 });
      const range = parseRange(request.headers.get("range"), stat.size);
      const start = range?.start ?? 0;
      const end = range?.end ?? stat.size - 1;
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": kind === "thumbnail" ? "private, max-age=3600" : "no-store"
      });
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      if (request.method === "HEAD") {
        if (typeof stopAccess === "function") stopAccess();
        return new Response(null, { status: range ? 206 : 200, headers });
      }
      const stream = fs.createReadStream(filePath, { start, end });
      if (typeof stopAccess === "function") stream.once("close", stopAccess);
      return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
    } catch (error) {
      if (typeof stopAccess === "function") stopAccess();
      return safeErrorResponse(error);
    }
  };
}

module.exports = { createMediaProtocolHandler, parseRange };
