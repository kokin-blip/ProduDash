import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { createApi } from '../src/http.js';
import { ApiError } from '../src/errors.js';
import { request as httpRequest } from 'node:http';

const key = 'local-test-key-'.repeat(4);
const comment = {video_url:'https://www.tiktok.com/@creator/video/12345', text:'Test comment'};
function fixture(options = {}) {
  const store = new Store(':memory:');
  const calls = [];
  const browser = {post:async b => {calls.push(b); return {state:'submitted', provider:'browser'};},
    comment:async b => {calls.push(b); return {state:'submitted', comment_id:'42'};},
    message:async b => {calls.push(b); return {state:'submitted', delivery_confirmed:false};},
    conversations:async () => ({conversations:[]})};
  const service = new Service({store, browser, publishing:{token:null}, ...options});
  return {store, calls, browser, service};
}

test('default dry run performs no browser action, even when live writes are enabled', async () => {
  const f = fixture({writesEnabled:true});
  const r = await f.service.execute('/v1/comments', comment);
  assert.equal(r.body.state, 'dry_run');
  assert.equal(f.calls.length, 0);
  f.store.close();
});
test('live browser posts use the browser adapter and never require the official publishing client', async () => {
  const f = fixture({writesEnabled:true, publishing:{post:() => {throw new Error('Official API must not be called');}}});
  const body = {video_path:'clip.mp4', title:'Test', privacy_level:'SELF_ONLY', consent:true, dry_run:false,
    disable_comment:true, disable_duet:true, disable_stitch:true, brand_content_toggle:false,
    brand_organic_toggle:false, is_aigc:false};
  const result = await f.service.execute('/v1/posts',body,'browser-post');
  assert.equal(result.status,202); assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].provider,'browser'); f.store.close();
});
test('live writes must be explicitly enabled', async () => {
  const f = fixture();
  await assert.rejects(f.service.execute('/v1/comments', {...comment, dry_run:false}, 'test'), {code:'writes_disabled'});
  assert.equal(f.calls.length, 0); f.store.close();
});
test('same key replays the prior result without duplicating the external action', async () => {
  const f = fixture({writesEnabled:true});
  const body = {...comment, dry_run:false};
  const a = await f.service.execute('/v1/comments', body, 'one');
  const b = await f.service.execute('/v1/comments', {dry_run:false, text:body.text, video_url:body.video_url}, 'one');
  assert.equal(a.status, 202); assert.equal(b.replayed, true); assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.execute('/v1/comments', {...body, text:'Other text'}, 'one'), {code:'idempotency_conflict'});
  f.store.close();
});
test('concurrent duplicates cannot launch two browser actions', async () => {
  const f = fixture({writesEnabled:true});
  let done;
  f.browser.comment = () => new Promise(resolve => {done = resolve;});
  const first = f.service.execute('/v1/comments', {...comment, dry_run:false}, 'race');
  await assert.rejects(f.service.execute('/v1/comments', {...comment, dry_run:false}, 'race'), {code:'outcome_unknown'});
  done({state:'submitted'}); await first; f.store.close();
});
test('ambiguous send outcome is replayed as an error without another attempt', async () => {
  const f = fixture({writesEnabled:true}); let attempts = 0;
  f.browser.message = async () => {attempts++; throw new ApiError(502, 'message_outcome_unknown', 'Unknown outcome.');};
  const body = {recipient:'user602phx', text:'Test', dry_run:false};
  assert.equal((await f.service.execute('/v1/messages', body, 'send')).status, 502);
  assert.equal((await f.service.execute('/v1/messages', body, 'send')).replayed, true);
  assert.equal(attempts, 1); f.store.close();
});
test('recipient restriction also applies to dry runs', async () => {
  const f = fixture();
  await assert.rejects(f.service.execute('/v1/messages', {recipient:'someone-else', text:'Test'}), {code:'recipient_not_allowed'});
  assert.equal(f.calls.length, 0); f.store.close();
});
test('stale in-progress record remains blocked after database reopen', async t => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tiktok-store-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  let store = new Store(join(dir, 'ops.sqlite'));
  store.reserve('crash', '/v1/messages', {text:'Test'}); store.close();
  store = new Store(join(dir, 'ops.sqlite'));
  assert.throws(() => store.reserve('crash', '/v1/messages', {text:'Test'}), {code:'outcome_unknown'});
  store.close();
});
test('HTTP authentication, JSON validation, origin protection, and dry run work end to end', async t => {
  const f = fixture(); const server = createApi({service:f.service, apiKey:key});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); f.store.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/v1/capabilities')).status, 401);
  const headers = {Authorization:`Bearer ${key}`, 'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/v1/capabilities', {headers:{...headers, Origin:'https://attacker.example'}})).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base+'/v1/capabilities', {headers:{...headers, Host:'attacker.example'}}, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(base+'/v1/comments', {method:'POST', headers, body:'{'})).status, 400);
  const result = await fetch(base+'/v1/comments', {method:'POST', headers, body:JSON.stringify(comment)});
  assert.equal(result.status, 200); assert.equal((await result.json()).state, 'dry_run');
  assert.equal(f.calls.length, 0);
});
test('browser errors cannot leak cookies, signed URLs, or message bodies through HTTP', async () => {
  const f = fixture({writesEnabled:true});
  f.browser.comment = async () => {throw new Error('secret cookie /?msToken=secret private message');};
  const r = await f.service.execute('/v1/comments', {...comment, dry_run:false}, 'error');
  assert.equal(r.status, 500); assert.doesNotMatch(JSON.stringify(r), /secret|msToken|private message/);
  f.store.close();
});
