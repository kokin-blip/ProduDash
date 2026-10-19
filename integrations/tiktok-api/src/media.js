import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { ApiError } from './errors.js';

export async function resolveMediaFile(mediaDir, videoPath) {
  let root, file, info;
  try {
    root = await realpath(resolve(mediaDir));
    file = await realpath(resolve(root, videoPath));
    info = await stat(file);
  } catch { throw new ApiError(400, 'media_not_found', 'The requested video must exist in TIKTOK_MEDIA_DIR.'); }
  const local = relative(root, file);
  if (!local || local.startsWith('..') || isAbsolute(local) || !info.isFile()) {
    throw new ApiError(403, 'media_path_not_allowed', 'Video files must stay within TIKTOK_MEDIA_DIR, including symlink targets.');
  }
  if (!['.mp4','.mov','.webm'].includes(extname(file).toLowerCase()) || info.size === 0 || info.size > 30_000_000_000) {
    throw new ApiError(400, 'media_invalid', 'Use a nonempty MP4, MOV or WebM file within Studio’s 30 GB limit.');
  }
  return file;
}
