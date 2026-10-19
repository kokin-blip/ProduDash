import { ApiError, safeError } from './errors.js';
import { validate } from './validation.js';

export class Service {
  constructor({store, browser, publishing, writesEnabled = false, allowedRecipient = 'user602phx'}) {
    Object.assign(this, {store, browser, publishing, writesEnabled, allowedRecipient});
  }
  async execute(route, input, key) {
    const body = validate(route, input, this.allowedRecipient);
    if (body.dry_run) return {status:200, body:{state:'dry_run', action:route,
      network_performed:false, browser_performed:false, request:body}};
    if (!this.writesEnabled) throw new ApiError(403, 'writes_disabled', 'Set ENABLE_TIKTOK_WRITES=true to enable live writes.');
    const prior = this.store.reserve(key, route, body);
    if (prior) return {...prior, replayed:true};
    let result;
    try {
      const data = route === '/v1/posts' ? await (body.provider === 'official' ? this.publishing.post(body) : this.browser.post(body))
        : route === '/v1/comments' ? await this.browser.comment(body) : await this.browser.message(body);
      result = {status:202, body:data};
    } catch (error) { result = safeError(error); }
    // Failed and ambiguous attempts are retained too; this prevents blind replay.
    this.store.finish(key, result);
    return result;
  }
}
