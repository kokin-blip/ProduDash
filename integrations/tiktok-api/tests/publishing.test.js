import test from 'node:test';
import assert from 'node:assert/strict';
import { Publishing } from '../src/publishing.js';
import { validate } from '../src/validation.js';

const post = {provider:'official', video_url:'https://media.example.com/video.mp4', title:'Caption',
  privacy_level:'SELF_ONLY', duration_seconds:10, consent:true,
  disable_comment:true, disable_duet:true, disable_stitch:true,
  brand_content_toggle:false, brand_organic_toggle:false, is_aigc:false};
const creator = {privacy_level_options:['SELF_ONLY'], max_video_post_duration_sec:300,
  comment_disabled:true, duet_disabled:true, stitch_disabled:true};
function client(info = creator) {
  const requests = [];
  const p = new Publishing('token-secret', async (url, options) => {
    requests.push({url, ...options, body:JSON.parse(options.body)});
    return new Response(JSON.stringify({error:{code:'ok'}, data:requests.length === 1 ? info : {publish_id:'publish-1'}}));
  });
  return {p, requests};
}
test('publishing queries fresh creator limits before sending the correct payload', async () => {
  const {p, requests} = client();
  assert.equal((await p.post(post)).publish_id, 'publish-1');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith('/creator_info/query/'));
  assert.deepEqual(requests[1].body.source_info, {source:'PULL_FROM_URL', video_url:post.video_url});
  assert.equal(requests[1].body.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(requests[1].body.post_info.duration_seconds, undefined);
  assert.equal(requests[1].redirect, 'error');
});
test('invalid creator privacy, duration or interaction prevents any publish call', async () => {
  for (const change of [{privacy_level:'PUBLIC_TO_EVERYONE'}, {duration_seconds:301}, {disable_comment:false}]) {
    const {p, requests} = client();
    await assert.rejects(p.post({...post, ...change})); assert.equal(requests.length, 1);
  }
});
test('consent, explicit toggles, field allowlist and UTF-16 caption limit are enforced', () => {
  assert.equal(validate('/v1/posts', post).dry_run, true);
  for (const change of [{consent:false}, {disable_comment:'false'}, {unknown:1}, {title:'😀'.repeat(1101)}]) {
    assert.throws(() => validate('/v1/posts', {...post, ...change}));
  }
  assert.throws(() => validate('/v1/posts', {...post, brand_content_toggle:true}));
});
test('missing authorization and upstream application errors are surfaced honestly', async () => {
  await assert.rejects(new Publishing().creator(), {code:'publishing_not_configured'});
  const p = new Publishing('secret', async () => new Response(JSON.stringify({error:{code:'scope_not_authorized', message:'secret'}})));
  await assert.rejects(p.creator(), error => error.code === 'tiktok_rejected' && error.details.upstream_code === 'scope_not_authorized' && !error.message.includes('secret'));
});
test('rate limits and network ambiguity are never automatically retried', async () => {
  let calls = 0;
  const rate = new Publishing('secret', async () => {calls++; return new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}), {status:429, headers:{'retry-after':'60'}});});
  await assert.rejects(rate.creator(), error => error.status === 429 && error.details.retry_after === '60');
  assert.equal(calls, 1);
  const network = new Publishing('secret', async () => {throw new Error('signed URL secret');});
  await assert.rejects(network.creator(), {code:'upstream_outcome_unknown'});
});
