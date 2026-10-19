import test from 'node:test';
import assert from 'node:assert/strict';
import { commentResult } from '../src/comment-result.js';

test('TikTok rejection is explicit rather than an uncertain submission', () => {
  assert.throws(() => commentResult({ok:true,data:{status_code:2209,status_msg:'This video does not exist'}}),
    e => e.code === 'comment_rejected' && e.status === 422 && e.details.upstream_status_code === 2209);
});
test('successful comments preserve the full upstream ID', () => {
  assert.equal(commentResult({ok:true,data:{status_code:0,comment:{cid:'7695910788313271566'}}}).comment_id,
    '7695910788313271566');
});
test('missing acknowledgement or success without a valid ID stays uncertain', () => {
  for (const response of [null,{ok:false,data:{}},{ok:true,data:{status_code:0}},
    {ok:true,data:{status_code:0,comment:{cid:7695910788313271566}}}]) {
    assert.throws(() => commentResult(response), {code:'comment_outcome_unknown'});
  }
});
