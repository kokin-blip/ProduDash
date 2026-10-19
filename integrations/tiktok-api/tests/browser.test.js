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

test('chat selection waits for the clicked conversation header before exposing its composer', async () => {
  const browser = new TikTokBrowser({profileDir:'.runtime/test',expectedUsername:'jamftest',managed:true});
  let loaded = false, selected = false, sent = false;
  const header = {waitFor:async () => {},innerText:async () => loaded ? 'jamftest' : ''};
  const item = {waitFor:async () => {},count:async () => 1,click:async () => {selected = true;},
    locator:() => ({innerText:async () => 'jamftest'})};
  const page = {locator:selector => selector.includes('chat-nickname') ? header : selector.includes('conversation-list')
    ? {waitFor:async () => {},locator:() => item} : selector.includes('message-list')
    ? {count:async () => 0} : {click:async () => {}},
    waitForFunction:async (_fn,arg) => {if (arg === 'jamftest') {assert.equal(selected,true); loaded = true;}},
    getByRole:() => ({fill:async () => {assert.equal(loaded,true);},press:async () => {sent = true;}})};
  browser.home = async () => page;
  const result = await browser.message({conversation_id:'0:1:123:123',text:'Fixture'});
  assert.equal(sent,true); assert.equal(result.conversation_id,'0:1:123:123');
  assert.equal(result.delivery_confirmed,false);
});
test('a mismatching chat header rejects before any composer action', async () => {
  const browser = new TikTokBrowser({profileDir:'.runtime/test',expectedUsername:'jamftest',managed:true});
  const item = {waitFor:async () => {},count:async () => 1,click:async () => {},locator:() => ({innerText:async () => 'Expected'})};
  const page = {locator:selector => selector.includes('chat-nickname') ? {waitFor:async () => {},innerText:async () => 'Different'}
    : selector.includes('conversation-list') ? {waitFor:async () => {},locator:() => item} : {click:async () => {}},
    waitForFunction:async (_fn,arg) => {if (arg === 'Expected') throw new Error('header never loaded');},getByRole:() => {throw new Error('Must not reach composer');}};
  browser.home = async () => page;
  await assert.rejects(browser.message({conversation_id:'0:1:123:456',text:'Fixture'}),{code:'recipient_mismatch'});
});
