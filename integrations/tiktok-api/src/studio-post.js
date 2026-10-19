import { ApiError } from './errors.js';

export const studioPrivacy = {
  PUBLIC_TO_EVERYONE:'Everyone', MUTUAL_FOLLOW_FRIENDS:'Friends',
  FOLLOWER_OF_CREATOR:'Followers', SELF_ONLY:'Only you'
};

async function setCheckbox(control, checked, name) {
  if (await control.count() !== 1) throw new ApiError(409,'studio_control_unavailable',`Studio's ${name} control is unavailable or ambiguous.`);
  if (await control.isChecked() === checked) return;
  if (!await control.isEnabled()) throw new ApiError(409,'studio_setting_unavailable',`Studio does not allow the requested ${name} setting.`);
  await control.setChecked(checked);
  if (await control.isChecked() !== checked) throw new ApiError(409,'studio_setting_mismatch',`Studio did not retain the requested ${name} setting.`);
}

async function setSwitch(page, container, checked, name) {
  await setCheckbox(page.locator(`[data-e2e="${container}"] input[role="switch"]`),checked,name);
}

export async function prepareStudioPost(page, body, file) {
  await page.goto('https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video',{waitUntil:'domcontentloaded'});
  const input = page.locator('input[type="file"][accept="video/*"]');
  await input.waitFor({state:'attached'});
  if (await input.count() !== 1) throw new ApiError(409,'studio_upload_unavailable','Expected one Studio video input.');
  await input.setInputFiles(file);
  await page.locator('[data-e2e="upload_status_container"]').getByText(/^Uploaded/).waitFor({state:'visible',timeout:180000});

  // Cancel the optional global-settings prompt; do not change account defaults.
  if (await page.getByText('Turn on automatic content checks?',{exact:true}).isVisible()) {
    const cancel = page.getByRole('button',{name:'Cancel',exact:true});
    if (await cancel.count() !== 1) throw new ApiError(409,'studio_prompt_unavailable','Dismiss the automatic-checks prompt manually.');
    await cancel.click();
  }
  const gotIt = page.getByRole('button',{name:'Got it',exact:true});
  if (await gotIt.count() === 1 && await gotIt.isVisible()) await gotIt.click();

  const caption = page.locator('[data-e2e="caption_container"] [contenteditable="true"]');
  await caption.fill(body.title);
  const visibility = page.locator('[data-e2e="video_visibility_container"]').getByRole('combobox');
  const choice = studioPrivacy[body.privacy_level];
  if ((await visibility.innerText()).trim() !== choice) {
    await visibility.click();
    const option = page.getByRole('option',{name:new RegExp(`^${choice}(?:$|\\s|Followers)`) });
    if (await option.count() !== 1) throw new ApiError(409,'privacy_unavailable','The requested privacy option is unavailable for this account.');
    await option.click();
  }
  if ((await visibility.innerText()).trim() !== choice) throw new ApiError(409,'privacy_mismatch','Studio did not retain the requested privacy.');

  const now = page.locator('[data-e2e="schedule_container"] input[value="post_now"]');
  await setCheckbox(now,true,'post now');
  const advanced = page.locator('[data-e2e="advanced_settings_container"]');
  if ((await advanced.innerText()).includes('Show more')) await advanced.click();
  const interactions = page.locator('[data-e2e="user_perm_container"]');
  await setCheckbox(interactions.getByRole('checkbox',{name:'Comment',exact:true}),!body.disable_comment,'comments');
  await setCheckbox(interactions.getByRole('checkbox',{name:'Reuse of content',exact:true}),!body.disable_duet,'reuse of content');

  // False is verified against the observed switches. Brand disclosure details
  // vary by account; fail before publication rather than invent their controls.
  if (body.brand_content_toggle || body.brand_organic_toggle) throw new ApiError(409,'brand_disclosure_unsupported',
    'Browser brand-disclosure choices have not been verified. Prepare branded posts manually or select the official provider.');
  await setSwitch(page,'disclose_content_container',false,'content disclosure');
  await setSwitch(page,'aigc_container',body.is_aigc,'AI-generated content');

  if ((await caption.innerText()).trim() !== body.title.trim()) throw new ApiError(409,'caption_mismatch','Studio did not retain the requested caption.');
  const post = page.locator('[data-e2e="post_video_button"]');
  if (await post.count() !== 1 || !await post.isEnabled()) throw new ApiError(409,'studio_post_unavailable','Studio has not enabled posting; resolve its visible checks first.');
  return post;
}

export function parseStudioAcknowledgement(data, expectedUsername) {
  const posts = data?.single_post_resp_list;
  if (data?.status_code !== 0 || !Array.isArray(posts) || posts.length !== 1 || posts[0].status_code !== 0
    || !/^\d+$/.test(String(posts[0].item_id || ''))) {
    throw new ApiError(502,'browser_post_outcome_unknown','Studio did not acknowledge one successful video post. Inspect the account before retrying.');
  }
  const itemId = String(posts[0].item_id);
  return {state:'submitted',provider:'browser',item_id:itemId,project_id:String(data.project_id || ''),
    post_url:`https://www.tiktok.com/@${expectedUsername}/video/${itemId}`,
    verification:'upstream_acknowledgement',moderation_complete:false};
}

export async function publishStudioPost(page, postButton, expectedUsername) {
  const responsePromise = page.waitForResponse(r => {
    const url = new URL(r.url());
    return url.hostname === 'www.tiktok.com' && url.pathname === '/tiktok/web/project/post/v1/' && r.request().method() === 'POST';
  },{timeout:60000}).then(async response => response.ok() ? response.json() : null).catch(() => null);
  await postButton.click();
  // Never click the submit button a second time after an ambiguous result.
  return parseStudioAcknowledgement(await responsePromise,expectedUsername);
}
