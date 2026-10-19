import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ApiError } from './errors.js';
import { resolveMediaFile } from './media.js';
import { prepareStudioPost, publishStudioPost } from './studio-post.js';
import { commentResult } from './comment-result.js';

export class TikTokBrowser {
  constructor({ profileDir, expectedUsername, allowedRecipient = 'user602phx', conversationId, managed = false, mediaDir = '.runtime/media' }) {
    this.profileDir = resolve(profileDir);
    this.expectedUsername = expectedUsername;
    this.allowedRecipient = allowedRecipient;
    this.conversationId = conversationId;
    this.managed = managed;
    this.mediaDir = mediaDir;
    this.queue = Promise.resolve();
  }
  async open() {
    if (!this.context) {
      await mkdir(this.profileDir, {recursive:true, mode:0o700});
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        channel:'chrome', headless:false, chromiumSandbox:true, viewport:null,
        // Keep Chrome's native credential storage so same-machine imported
        // TikTok cookies can be read using the macOS Chrome keychain.
        ignoreDefaultArgs:['--use-mock-keychain','--password-store=basic'],
        locale:'en-US', timezoneId:'America/Phoenix'
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.setDefaultTimeout(15000);
      this.page.setDefaultNavigationTimeout(30000);
    }
    return this.page;
  }
  exclusive(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  async checkAccount(page) {
    try {
      await page.locator('[data-e2e="nav-profile"]').waitFor({state:'visible'});
      const href = await page.locator('[data-e2e="nav-profile"]').getAttribute('href');
      const username = new URL(href, 'https://www.tiktok.com').pathname.slice(2);
      if (!this.expectedUsername || username !== this.expectedUsername) {
        throw new ApiError(409, 'account_mismatch', 'The browser account does not match TIKTOK_EXPECTED_USERNAME.');
      }
      return username;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, 'browser_login_required', 'Run npm run login and sign in to the dedicated TikTok profile.');
    }
  }
  async home() {
    const page = await this.open();
    await page.goto('https://www.tiktok.com/', {waitUntil:'domcontentloaded'});
    await this.checkAccount(page);
    return page;
  }
  async openSession() {
    return this.exclusive(async () => {
      const page = await this.open();
      await page.goto('https://www.tiktok.com/', {waitUntil:'domcontentloaded'});
      return {state:'sign_in_in_browser'};
    });
  }
  async verifySession() {
    return this.exclusive(async () => {
      const page = await this.home();
      return {state:'verified', account:{id:await this.checkAccount(page), name:this.expectedUsername}};
    });
  }
  async selectConversation(id) {
    if (!/^[\d:]{1,128}$/.test(id)) throw new ApiError(400, 'invalid_conversation', 'Choose a loaded conversation.');
    const page = await this.home();
    await page.locator('[data-e2e="nav-messages"]').click();
    const list = page.locator('[data-e2e="dm-new-conversation-list"]');
    await list.waitFor({state:'visible'});
    const item = list.locator(`[data-e2e="dm-new-conversation-item"][data-conv-id="${id}"]`);
    await item.waitFor({state:'visible'}).catch(() => {});
    if (await item.count() !== 1) throw new ApiError(409, 'recipient_ambiguous', 'The selected conversation is not uniquely loaded. Refresh conversations.');
    await page.waitForFunction(id => document.querySelector(`[data-e2e="dm-new-conversation-item"][data-conv-id="${id}"] [data-e2e="dm-new-conversation-nickname"]`)?.innerText?.trim().length > 0, id, {timeout:15000}).catch(() => {throw new ApiError(409, 'recipient_ambiguous', 'The selected conversation has not finished loading. Refresh conversations.');});
    const name = (await item.locator('[data-e2e="dm-new-conversation-nickname"]').innerText()).trim();
    await item.click();
    const header = page.locator('[data-e2e="dm-new-chat-nickname"]');
    await header.waitFor({state:'visible'});
    await page.waitForFunction(expected => document.querySelector('[data-e2e="dm-new-chat-nickname"]')?.innerText?.trim() === expected, name, {timeout:15000}).catch(() => {});
    if ((await header.innerText()).trim() !== name) throw new ApiError(409, 'recipient_mismatch', 'The selected chat changed. Refresh conversations.');
    return {page, name};
  }
  async readMessages(id) {
    if (!this.managed) throw new ApiError(403, 'managed_only', 'Chat snapshots require managed mode.');
    return this.exclusive(async () => {
      const {page, name} = await this.selectConversation(id);
      const list = page.locator('[data-e2e="dm-new-message-list"]');
      await list.waitFor({state:'visible'});
      await list.locator('[data-e2e="dm-new-chat-item"]').first().waitFor({state:'visible',timeout:10000}).catch(() => {});
      return {conversation_id:id, name, coverage:'currently loaded messages only', messages:
        await list.locator('[data-e2e="dm-new-chat-item"]').evaluateAll(items => items.slice(-50).map(e => ({
          text:(e.innerText || '').slice(0,4000), role:'unknown'
        })))};
    });
  }
  async conversations() {
    return this.exclusive(async () => {
      const page = await this.home();
      await page.locator('[data-e2e="nav-messages"]').click();
      await page.locator('[data-e2e="dm-new-conversation-list"]').waitFor({state:'visible'});
      // The list container becomes visible before its asynchronously loaded rows.
      await page.locator('[data-e2e="dm-new-conversation-item"]').first().waitFor({state:'visible',timeout:10000}).catch(() => {});
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-e2e="dm-new-conversation-nickname"]')).some(e => e.innerText?.trim()), null, {timeout:15000}).catch(() => {});
      return {conversations:await page.locator('[data-e2e="dm-new-conversation-item"]').evaluateAll(items =>
        items.map(e => ({id:e.getAttribute('data-conv-id'),
          name:e.querySelector('[data-e2e="dm-new-conversation-nickname"]')?.innerText?.trim()})).filter(e => e.name)),
        coverage:'currently loaded conversations only'};
    });
  }
  async post(body) {
    const file = await resolveMediaFile(this.mediaDir,body.video_path);
    return this.exclusive(async () => {
      const page = await this.home();
      const postButton = await prepareStudioPost(page,body,file);
      return publishStudioPost(page,postButton,this.expectedUsername);
    });
  }
  async comment(body) {
    return this.exclusive(async () => {
      const page = await this.open();
      await page.goto(body.video_url, {waitUntil:'domcontentloaded'});
      await this.checkAccount(page);
      const icon = page.locator('article').first().locator('[data-e2e="comment-icon"]');
      await icon.waitFor({state:'visible'});
      if (await icon.count() !== 1) throw new ApiError(409, 'video_target_ambiguous', 'Expected one comment button on the current video.');
      await icon.click();
      if (body.reply_to) {
        const author = page.locator(`a[href="/@${body.reply_to.username}"]`);
        const targetText = page.locator('[data-e2e="comment-level-1"]')
          .and(page.getByText(body.reply_to.text, {exact:true}));
        const reply = targetText.locator('xpath=ancestor::div[contains(@class,"DivCommentItemWrapper")]')
          .filter({has:author});
        await targetText.first().waitFor({state:'visible',timeout:10000}).catch(() => {});
        if (await reply.count() !== 1) throw new ApiError(409, 'reply_target_ambiguous', 'The requested comment is absent or not unique in the loaded comments.');
        await reply.getByRole('button', {name:'Reply', exact:true}).click();
      }
      const editor = page.locator('[contenteditable="true"][role="textbox"]:visible');
      await editor.waitFor({state:'visible'});
      if (await editor.count() !== 1) throw new ApiError(409, 'composer_ambiguous', 'Expected one visible comment composer.');
      await editor.fill(body.text);
      const post = page.getByRole('button', {name:'Post', exact:true});
      if (await post.count() !== 1 || !await post.isEnabled()) throw new ApiError(409, 'comment_unavailable', 'Posting is unavailable for this video.');
      // Observed in the live API test; ignore the endpoint's HEAD preflight.
      const responsePromise = page.waitForResponse(r => {
        const u = new URL(r.url());
        return u.hostname === 'www.tiktok.com' && u.pathname === '/api/comment/publish/' && r.request().method() === 'POST';
      }, {timeout:20000}).then(async r => ({ok:r.ok(), data:await r.json()})).catch(() => null);
      await post.click();
      const response = await responsePromise;
      return commentResult(response);
    });
  }
  async message(body) {
    if (!this.managed && body.recipient !== this.allowedRecipient) throw new ApiError(403, 'recipient_not_allowed', 'Recipient is not allowed.');
    if (!this.managed && (!this.conversationId || !/^[\d:]+$/.test(this.conversationId))) throw new ApiError(503,
      'conversation_not_pinned', 'Set TIKTOK_MESSAGE_CONVERSATION_ID to the inspected conversation ID for the allowed recipient.');
    return this.exclusive(async () => {
      const conversationId = this.managed ? body.conversation_id : this.conversationId;
      const {page, name} = await this.selectConversation(conversationId);
      if (!this.managed && name !== body.recipient) {
        throw new ApiError(409, 'recipient_mismatch', 'The pinned conversation has a different displayed recipient.');
      }
      const messages = page.locator('[data-e2e="dm-new-message-list"] [data-e2e="dm-new-chat-item"]');
      const before = await messages.count();
      const editor = page.getByRole('textbox', {name:'Send a message...', exact:true});
      await editor.fill(body.text);
      await editor.press('Enter');
      try {
        await page.waitForFunction(({before, text}) => {
          const items = Array.from(document.querySelectorAll('[data-e2e="dm-new-message-list"] [data-e2e="dm-new-chat-item"]'));
          return items.length > before && items.at(-1)?.textContent?.includes(text);
        }, {before, text:body.text}, {timeout:15000});
      } catch {
        throw new ApiError(502, 'message_outcome_unknown', 'The send action ran, but a new visible message was not confirmed. Inspect the conversation before retrying.');
      }
      // An optimistic UI insertion is not proof of server delivery.
      return {state:'submitted', conversation_id:conversationId, verification:'visible_in_ui', delivery_confirmed:false};
    });
  }
  async close() { if (this.context) await this.context.close(); }
}
