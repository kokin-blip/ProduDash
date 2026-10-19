import { ApiError } from './errors.js';

export function commentResult(response) {
  if (response?.ok && Number.isInteger(response.data?.status_code) && response.data.status_code !== 0) {
    throw new ApiError(422, 'comment_rejected', 'TikTok rejected the comment.', {
      upstream_status_code:response.data.status_code
    });
  }
  const id = response?.data?.comment?.cid;
  if (!response?.ok || response.data?.status_code !== 0 || typeof id !== 'string' || !/^\d+$/.test(id)) {
    throw new ApiError(502, 'comment_outcome_unknown', 'A comment may have been submitted, but a matching acknowledgement was unavailable. Inspect TikTok before retrying.');
  }
  return {state:'submitted', comment_id:id, verification:'upstream_acknowledgement'};
}
