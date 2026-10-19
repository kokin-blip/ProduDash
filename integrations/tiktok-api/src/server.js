import { mkdirSync } from 'node:fs';
import { Store } from './store.js';
import { TikTokBrowser } from './browser.js';
import { Publishing } from './publishing.js';
import { Service } from './service.js';
import { createApi } from './http.js';

if (!process.env.API_KEY || process.env.API_KEY.length < 32) throw new Error('Set API_KEY to at least 32 random characters in .env.');
mkdirSync('.runtime', {recursive:true, mode:0o700});
const store = new Store('.runtime/operations.sqlite');
const browser = new TikTokBrowser({profileDir:process.env.TIKTOK_PROFILE_DIR || '.runtime/tiktok-profile',
  expectedUsername:process.env.TIKTOK_EXPECTED_USERNAME,
  allowedRecipient:process.env.TIKTOK_MESSAGE_RECIPIENT || 'user602phx',
  conversationId:process.env.TIKTOK_MESSAGE_CONVERSATION_ID,
  mediaDir:process.env.TIKTOK_MEDIA_DIR || '.runtime/media'});
const service = new Service({store, browser, publishing:new Publishing(process.env.TIKTOK_ACCESS_TOKEN),
  writesEnabled:process.env.ENABLE_TIKTOK_WRITES === 'true', allowedRecipient:browser.allowedRecipient});
const server = createApi({service, apiKey:process.env.API_KEY});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log(`TikTok API listening on http://127.0.0.1:${server.address().port}; live writes ${service.writesEnabled ? 'enabled' : 'disabled'}.`));
async function shutdown() { server.close(); await browser.close(); store.close(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
