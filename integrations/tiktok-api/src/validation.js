import { ApiError, requireValue } from './errors.js';

const privacy = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
export function text(value, name, max = 1000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    `${name} must be a nonempty string of at most ${max} characters.`);
  return value;
}

export function validate(route, body, recipient = 'user602phx') {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'A JSON object is required.');
  requireValue(body.dry_run === undefined || typeof body.dry_run === 'boolean', 'dry_run must be boolean.');
  const allowed = {
    '/v1/comments': ['dry_run', 'video_url', 'text', 'reply_to'],
    '/v1/messages': ['dry_run', 'recipient', 'text'],
    '/v1/posts': ['dry_run', 'provider', 'video_path', 'video_url', 'title', 'privacy_level', 'duration_seconds',
      'disable_comment', 'disable_duet', 'disable_stitch', 'brand_content_toggle',
      'brand_organic_toggle', 'is_aigc', 'consent']
  }[route];
  if (!allowed) throw new ApiError(404, 'not_found', 'Unknown endpoint.');
  requireValue(Object.keys(body).every(k => allowed.includes(k)), 'Unknown request field.');
  const result = { ...body, dry_run: body.dry_run !== false };
  if (route === '/v1/messages') {
    text(body.recipient, 'recipient', 64);
    if (body.recipient !== recipient) throw new ApiError(403, 'recipient_not_allowed',
      `Outgoing messages are restricted to ${recipient}.`);
    text(body.text, 'text', 1000);
  } else if (route === '/v1/comments') {
    text(body.video_url, 'video_url', 4096);
    let url;
    try { url = new URL(body.video_url); } catch { requireValue(false, 'video_url must be a URL.'); }
    requireValue(url.protocol === 'https:' && !url.username && !url.password, 'video_url must use HTTPS without credentials.');
      requireValue(url.hostname === 'www.tiktok.com' && /^\/@[\w.-]+\/video\/\d+\/?$/.test(url.pathname)
        && !url.search && !url.hash, 'Use the canonical https://www.tiktok.com/@user/video/ID URL.');
      text(body.text, 'text', 150);
      if (body.reply_to !== undefined) {
        requireValue(body.reply_to && typeof body.reply_to === 'object' && !Array.isArray(body.reply_to), 'reply_to must be an object.');
        requireValue(Object.keys(body.reply_to).every(k => ['username', 'text'].includes(k)), 'Unknown reply_to field.');
        text(body.reply_to.username, 'reply_to.username', 64);
        requireValue(/^[\w.-]+$/.test(body.reply_to.username), 'Invalid reply username.');
        text(body.reply_to.text, 'reply_to.text', 1000);
      }
  } else {
      result.provider = body.provider || 'browser';
      requireValue(['browser', 'official'].includes(result.provider), 'provider must be browser or official.');
      if (result.provider === 'browser') {
        text(body.video_path, 'video_path', 4096);
        requireValue(!body.video_path.includes('\0'), 'Invalid video_path.');
        requireValue(body.video_url === undefined, 'Browser posting uses video_path, not video_url.');
        requireValue(body.duration_seconds === undefined, 'Browser posting reads media in Studio; omit duration_seconds.');
        requireValue(body.disable_duet === body.disable_stitch, 'Studio uses one Reuse of content control; disable_duet and disable_stitch must match.');
        requireValue(body.brand_content_toggle === false && body.brand_organic_toggle === false,
          'Browser brand-disclosure choices are not yet verified. Use the official provider or prepare branded posts manually.');
      } else {
        text(body.video_url, 'video_url', 4096);
        let url;
        try { url = new URL(body.video_url); } catch { requireValue(false, 'video_url must be a URL.'); }
        requireValue(url.protocol === 'https:' && !url.username && !url.password, 'video_url must use HTTPS without credentials.');
        requireValue(body.video_path === undefined, 'Official posting uses video_url, not video_path.');
        requireValue(Number.isFinite(body.duration_seconds) && body.duration_seconds > 0, 'duration_seconds must be positive.');
      }
      requireValue(typeof body.title === 'string' && Buffer.byteLength(body.title, 'utf16le') / 2 <= 2200, 'title must be at most 2200 UTF-16 units.');
      requireValue(privacy.includes(body.privacy_level), 'Choose an explicit privacy_level.');
      requireValue(body.consent === true, 'consent must confirm approval of this video and its settings.');
      for (const k of ['disable_comment', 'disable_duet', 'disable_stitch', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc']) {
        requireValue(typeof body[k] === 'boolean', `${k} must be an explicit boolean.`);
      }
      requireValue(!(body.brand_content_toggle && body.privacy_level === 'SELF_ONLY'), 'Branded content cannot use SELF_ONLY.');
  }
  return result;
}
