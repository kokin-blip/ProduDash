import { ApiError } from './errors.js';

export class Publishing {
  constructor(token, request = fetch) { this.token = token; this.request = request; }
  async call(path, body) {
    if (!this.token) throw new ApiError(503, 'publishing_not_configured', 'Set TIKTOK_ACCESS_TOKEN with video.publish authorization.');
    let response, data;
    try {
      response = await this.request(`https://open.tiktokapis.com${path}`, {
        method: 'POST', headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000)
      });
      data = await response.json();
    } catch {
      throw new ApiError(502, 'upstream_outcome_unknown', 'TikTok did not return a readable response. No retry was attempted.');
    }
    if (!response.ok || data.error?.code !== 'ok') throw new ApiError(response.status === 429 ? 429 : 502,
      'tiktok_rejected', 'TikTok rejected the request.', {
        upstream_code: typeof data.error?.code === 'string' && /^[\w-]+$/.test(data.error.code) ? data.error.code : 'unknown',
        retry_after: response.headers.get('retry-after')
      });
    return data.data;
  }
  creator() { return this.call('/v2/post/publish/creator_info/query/', {}); }
  status(publishId) { return this.call('/v2/post/publish/status/fetch/', {publish_id: publishId}); }
  async post(body) {
    const creator = await this.creator();
    if (!creator.privacy_level_options?.includes(body.privacy_level)) throw new ApiError(400, 'privacy_unavailable', 'The creator does not allow this privacy level.');
    if (!Number.isFinite(creator.max_video_post_duration_sec) || body.duration_seconds > creator.max_video_post_duration_sec) {
      throw new ApiError(400, 'duration_unavailable', 'The duration exceeds the creator limit or that limit is unavailable.');
    }
    for (const interaction of ['comment', 'duet', 'stitch']) {
      if (creator[`${interaction}_disabled`] && !body[`disable_${interaction}`]) throw new ApiError(400, 'interaction_unavailable', `${interaction} is disabled by the creator.`);
    }
    const post_info = Object.fromEntries(['title','privacy_level','disable_comment','disable_duet','disable_stitch',
      'brand_content_toggle','brand_organic_toggle','is_aigc'].map(k => [k, body[k]]));
    const result = await this.call('/v2/post/publish/video/init/', {
      post_info, source_info: {source:'PULL_FROM_URL', video_url:body.video_url}
    });
    if (typeof result?.publish_id !== 'string') throw new ApiError(502, 'upstream_outcome_unknown', 'TikTok returned no publish ID. Inspect the account before retrying.');
    return {state:'submitted', publish_id:result.publish_id};
  }
}
