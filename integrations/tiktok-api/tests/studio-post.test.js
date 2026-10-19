import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStudioAcknowledgement, publishStudioPost, prepareStudioPost } from '../src/studio-post.js';

const acknowledgement = {status_code:0, project_id:'7695907446916699150',project_status:1,
  single_post_resp_list:[{batch_index:0,item_id:'7695907541301103886',status_code:0,status_msg:''}]};
test('the observed Studio response yields a post URL without claiming moderation completion', () => {
  const result = parseStudioAcknowledgement(acknowledgement,'jamftest');
  assert.equal(result.item_id,'7695907541301103886');
  assert.equal(result.post_url,'https://www.tiktok.com/@jamftest/video/7695907541301103886');
  assert.equal(result.state,'submitted'); assert.equal(result.moderation_complete,false);
});
test('partial, failed, empty and malformed acknowledgements remain ambiguous', () => {
  for (const data of [null,{}, {status_code:1}, {...acknowledgement,single_post_resp_list:[]},
    {...acknowledgement,single_post_resp_list:[{status_code:1,item_id:'123'}]},
    {...acknowledgement,single_post_resp_list:[{status_code:0,item_id:'invalid'}]}]) {
    assert.throws(() => parseStudioAcknowledgement(data,'jamftest'),{code:'browser_post_outcome_unknown'});
  }
});
test('publish waits for the exact endpoint before clicking and never retries a lost response', async () => {
  const events = []; let matcher;
  const page = {waitForResponse:fn => {events.push('listen');matcher=fn;return Promise.reject(new Error('timeout'));}};
  const button = {click:async () => {events.push('click');}};
  await assert.rejects(publishStudioPost(page,button,'jamftest'),{code:'browser_post_outcome_unknown'});
  assert.deepEqual(events,['listen','click']);
  assert.equal(matcher({url:()=>'https://www.tiktok.com/tiktok/web/project/post/v1/?redacted',request:()=>({method:()=>'POST'})}),true);
  assert.equal(matcher({url:()=>'https://other.example/tiktok/web/project/post/v1/',request:()=>({method:()=>'POST'})}),false);
});
test('HTTP acceptance alone does not count as a successful Studio post', async () => {
  const page = {waitForResponse:async () => ({ok:()=>true,json:async ()=>({status_code:0})})};
  await assert.rejects(publishStudioPost(page,{click:async ()=>{}},'jamftest'),{code:'browser_post_outcome_unknown'});
});

function fakeStudio({reuseEnabled = false,reuseChecked = false,checkedPrivacy='Followers',optionAvailable=true} = {}) {
  const state = {privacy:checkedPrivacy,caption:'filename',comment:true,reuse:reuseChecked,upload:null,postClicks:0};
  const events = [];
  const simple = (extra = {}) => ({count:async()=>1,waitFor:async()=>{},click:async()=>{},...extra});
  const checkbox = (key,enabled=true) => simple({isChecked:async()=>state[key],isEnabled:async()=>enabled,
    setChecked:async value=>{state[key]=value;events.push('set-'+key);}});
  const post = simple({isEnabled:async()=>true,click:async()=>{state.postClicks++;}});
  const page = {
    goto:async()=>{events.push('navigate');},
    getByText:()=>simple({isVisible:async()=>false}),
    getByRole:(role)=>role==='option' ? simple({count:async()=>optionAvailable?1:0,
      click:async()=>{state.privacy='Only you';}}) : simple({count:async()=>0}),
    locator:selector=>{
      if(selector.startsWith('input[type=')) return simple({setInputFiles:async file=>{state.upload=file;events.push('upload');}});
      if(selector.includes('upload_status')) return {getByText:()=>simple()};
      if(selector.includes('caption_container')) return simple({fill:async text=>{state.caption=text;},innerText:async()=>state.caption});
      if(selector.includes('video_visibility')) return {getByRole:()=>simple({innerText:async()=>state.privacy})};
      if(selector.includes('schedule_container')) return simple({isChecked:async()=>true});
      if(selector.includes('advanced_settings')) return simple({innerText:async()=> 'Show more'});
      if(selector.includes('user_perm')) return {getByRole:(role,{name})=>name==='Comment' ? checkbox('comment') : checkbox('reuse',reuseEnabled)};
      if(selector.includes('input[role="switch"]')) return simple({isChecked:async()=>false});
      if(selector.includes('post_video_button')) return post;
      throw new Error('Unexpected selector '+selector);
    }
  };
  return {page,state,events};
}
const body = {title:'Test caption',privacy_level:'SELF_ONLY',disable_comment:false,disable_duet:true,
  disable_stitch:true,brand_content_toggle:false,brand_organic_toggle:false,is_aigc:false};
test('Studio preparation uploads a local file and verifies settings without submitting', async () => {
  const f = fakeStudio();
  const post = await prepareStudioPost(f.page,body,'/allowed/clip.mp4');
  assert.equal(f.state.upload,'/allowed/clip.mp4'); assert.equal(f.state.privacy,'Only you');
  assert.equal(f.state.caption,'Test caption'); assert.equal(f.state.postClicks,0);
  assert.ok(post); assert.ok(!f.events.some(e=>e.startsWith('set-')));
});
test('an unavailable privacy or disabled interaction fails before publication', async () => {
  const missing = fakeStudio({optionAvailable:false});
  await assert.rejects(prepareStudioPost(missing.page,body,'clip.mp4'),{code:'privacy_unavailable'});
  const disabled = fakeStudio();
  await assert.rejects(prepareStudioPost(disabled.page,{...body,disable_duet:false,disable_stitch:false},'clip.mp4'),{code:'studio_setting_unavailable'});
  assert.equal(missing.state.postClicks,0); assert.equal(disabled.state.postClicks,0);
});
