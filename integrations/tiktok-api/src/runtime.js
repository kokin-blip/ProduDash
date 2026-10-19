import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { TikTokBrowser } from './browser.js';
import { Publishing } from './publishing.js';
import { Service } from './service.js';
import { createApi } from './http.js';

// Shared by CLI and desktop workers. A profile is exclusively owned even before
// Chrome opens, so two servers cannot queue writes against the same sign-in.
export function lockProfile(profileDir) {
  mkdirSync(profileDir, {recursive:true, mode:0o700});
  const file = join(profileDir, '.produdash-worker.lock');
  try {
    const fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = true;
    try { if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0); }
    catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('The dedicated browser profile is already in use.');
    unlinkSync(file);
    return lockProfile(profileDir);
  }
  return () => { try { unlinkSync(file); } catch {} };
}

export async function startApi(options = {}) {
  const runtimeDir = resolve(options.runtimeDir || '.runtime');
  const profileDir = resolve(options.profileDir || join(runtimeDir, 'tiktok-profile'));
  mkdirSync(runtimeDir, {recursive:true, mode:0o700});
  const release = lockProfile(profileDir);
  let store, browser, server;
  try {
    store = new Store(join(runtimeDir, 'operations.sqlite'));
    browser = options.browser || new TikTokBrowser({profileDir,
      expectedUsername:options.expectedUsername, allowedRecipient:options.allowedRecipient || 'user602phx',
      conversationId:options.conversationId, managed:options.managed === true,
      mediaDir:options.mediaDir || join(runtimeDir, 'media')});
    const service = new Service({store, browser, publishing:new Publishing(options.accessToken),
      writesEnabled:options.writesEnabled === true, allowedRecipient:browser.allowedRecipient,
      managed:options.managed === true});
    server = createApi({service, apiKey:options.apiKey});
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(options.port ?? 8787, '127.0.0.1', done);
    });
    let stopping;
    return {port:server.address().port, service,
      stop() {
        if (!stopping) stopping = (async () => {
          service.stopping = true;
          await new Promise((done) => {server.close(done); server.closeIdleConnections();});
          await browser.queue;
          await browser.close(); store.close(); release();
        })();
        return stopping;
      }};
  } catch (error) {
    server?.close(); await browser?.close(); store?.close(); release(); throw error;
  }
}
