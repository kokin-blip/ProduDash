import { startApi } from './runtime.js';
const runtime = await startApi({apiKey:process.env.API_KEY, port:Number(process.env.PORT || 8787),
  runtimeDir:process.env.TIKTOK_RUNTIME_DIR, profileDir:process.env.TIKTOK_PROFILE_DIR,
  expectedUsername:process.env.TIKTOK_EXPECTED_USERNAME,
  allowedRecipient:process.env.TIKTOK_MESSAGE_RECIPIENT, conversationId:process.env.TIKTOK_MESSAGE_CONVERSATION_ID,
  mediaDir:process.env.TIKTOK_MEDIA_DIR, accessToken:process.env.TIKTOK_ACCESS_TOKEN,
  writesEnabled:process.env.ENABLE_TIKTOK_WRITES === 'true'});
console.log(`TikTok API listening on http://127.0.0.1:${runtime.port}; live writes ${runtime.service.writesEnabled ? 'enabled' : 'disabled'}.`);
process.once('SIGINT', () => runtime.stop());
process.once('SIGTERM', () => runtime.stop());
