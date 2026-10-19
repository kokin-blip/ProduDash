import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, safeError } from './errors.js';
import { text } from './validation.js';

export function createApi({service, apiKey}) {
  if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('API_KEY must contain at least 32 characters.');
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new ApiError(403, 'host_not_allowed', 'Use the loopback API address.');
      if (req.headers.origin && ![`http://${host}`, `https://${host}`].includes(req.headers.origin)) throw new ApiError(403, 'origin_not_allowed', 'Cross-origin browser calls are not allowed.');
      const token = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${apiKey}`);
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new ApiError(401, 'unauthorized', 'Provide the local API bearer key.');
      const url = new URL(req.url, `http://${host}`);
      let result;
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        result = {status:200, body:{writes_enabled:service.writesEnabled,
          posting:{provider:'browser', token_required:false, ui_workflow_verified:true, standalone_live_verified:true,
            optional_official_api:{token_configured:!!service.publishing.token}},
          comments:{provider:'browser', selectors_observed:true, live_verified:false,
            private_test_result:'upstream_rejected_2209', replies_live_verified:false},
          messaging:{provider:'browser', allowed_recipient:service.allowedRecipient, live_verified:true,
            verification:'self-message persisted in separate browser session', delivery_protocol_verified:false},
          extension_bridge:false}};
      } else if (req.method === 'GET' && url.pathname === '/v1/creator') {
        result = {status:200, body:await service.publishing.creator()};
      } else if (req.method === 'GET' && url.pathname === '/v1/posts/status') {
        result = {status:200, body:await service.publishing.status(text(url.searchParams.get('publish_id'), 'publish_id', 64))};
      } else if (req.method === 'GET' && url.pathname === '/v1/conversations') {
        result = {status:200, body:await service.browser.conversations()};
      } else if (req.method === 'POST') {
        if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw new ApiError(415, 'json_required', 'Use Content-Type: application/json.');
        }
        let bytes = 0, chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) throw new ApiError(413, 'body_too_large', 'Request bodies are limited to 64 KiB.');
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ApiError(400, 'invalid_json', 'Malformed JSON.'); }
        result = await service.execute(url.pathname, body, req.headers['idempotency-key']);
      } else { throw new ApiError(404, 'not_found', 'Unknown endpoint.'); }
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    } catch (error) {
      const result = safeError(error);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    }
  });
}
