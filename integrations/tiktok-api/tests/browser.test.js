import test from 'node:test';
import assert from 'node:assert/strict';
import { TikTokBrowser } from '../src/browser.js';

test('a pinned conversation is required before any browser action', async () => {
  const browser = new TikTokBrowser({profileDir:'.runtime/test', expectedUsername:'owner'});
  let opened = false; browser.open = async () => {opened = true;};
  await assert.rejects(browser.message({recipient:'user602phx', text:'Test'}), {code:'conversation_not_pinned'});
  assert.equal(opened, false);
});
test('account verification rejects a different signed-in account', async () => {
  const browser = new TikTokBrowser({profileDir:'.runtime/test', expectedUsername:'owner'});
  const page = {locator:() => ({waitFor:async () => {}, getAttribute:async () => '/@someoneelse'})};
  await assert.rejects(browser.checkAccount(page), {code:'account_mismatch'});
});
test('one failed browser task does not break serialization of subsequent tasks', async () => {
  const browser = new TikTokBrowser({profileDir:'.runtime/test'}); const order = [];
  const a = browser.exclusive(async () => {order.push('a'); throw new Error('failed');});
  const b = browser.exclusive(async () => {order.push('b'); return 42;});
  await assert.rejects(a); assert.equal(await b, 42); assert.deepEqual(order, ['a','b']);
});
