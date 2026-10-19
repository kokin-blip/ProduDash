import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TikTokBrowser } from './browser.js';

const browser = new TikTokBrowser({profileDir:process.env.TIKTOK_PROFILE_DIR || '.runtime/tiktok-profile',
  expectedUsername:process.env.TIKTOK_EXPECTED_USERNAME});
const terminal = createInterface({input:stdin, output:stdout});
try {
  const page = await browser.open();
  await page.goto('https://www.tiktok.com/', {waitUntil:'domcontentloaded'});
  await terminal.question('Sign in manually in the dedicated browser window, then press Enter here. ');
  await browser.checkAccount(page);
  console.log('The expected TikTok account is signed in. Profile saved locally.');
} finally { terminal.close(); await browser.close(); }
