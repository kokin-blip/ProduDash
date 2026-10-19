# Local TikTok automation API

Node 24 API for ProduDash, built after REA analysis and inspection of TikTok. **Browser posting needs no TikTok publishing token.** Posting passed an actual HTTP API end-to-end test using the dedicated `jamftest` browser profile, and the created clip was verified as Only me in Studio. One self-message through the actual API was independently verified in the kokinjamf browser. TikTok rejected comments on both private test posts with status 2209, "This video does not exist"; a reply request stopped because its parent comment was absent. The API is left stopped, and live writes remain disabled in `.env`.

| Endpoint                            | Implementation                                                     | Current verification                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/posts`                    | Browser Studio upload of a local video; optional official provider | Actual HTTP API → dedicated Chrome → upload → private post passed; idempotency replay returned the saved result          |
| `POST /v1/comments`                 | Browser UI; new comment or an exact selected reply                 | Publish endpoint observed; private test comments rejected upstream (2209); successful comments/replies remain unverified |
| `POST /v1/messages`                 | Browser UI; existing conversation                                  | HTTP 202 self-message to jamftest; persisted in a separate browser session; idempotency replay did not resend            |
| `GET /v1/conversations`             | Browser UI                                                         | Returns currently loaded conversation IDs and names                                                                      |
| `GET /v1/creator`                   | Optional official API creator info                                 | Requires token; not used for browser posting                                                                             |
| `GET /v1/posts/status?publish_id=…` | Optional official API publish status                               | Requires token; browser posts are inspected in Studio using their returned post URL                                      |
| `GET /v1/capabilities`              | Local configuration                                                | Reports prerequisites and verification limits                                                                            |

Messages default to the previously configured **`user602phx`** and require a pinned conversation ID. The self-message test used process-only overrides for `jamftest` and its inspected self-conversation ID; it did not change the saved recipient configuration. No background or scheduled sends run automatically.

## Start and validate

```sh
npm install --ignore-scripts
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Put the generated value in API_KEY in .env.
npm test
# Start only when needed; Ctrl-C stops the API.
npm start
```

The service listens on `127.0.0.1:8787`. Every endpoint requires `Authorization: Bearer <API_KEY>`. It rejects remote Host headers and cross-origin browser calls. Keep `.env` and `.runtime` local; `.runtime` contains browser sign-in state and operation results. There is no remote hosting configuration.

## Browser setup

The standalone service launches its own visible Chrome profile and does not depend on a browser extension. In the desktop app, sign in through the dedicated profile and verify the expected account. Regular Chrome profiles are not imported by the desktop controls. Historical acceptance evidence remains local and is not included in the repository or installer.

The dedicated profile is configured and authenticated as `jamftest`; the end-to-end test verified that account before uploading. When its session expires, run `npm run login` and sign in manually. Complete any TikTok login or verification yourself, then close the login process before browser API calls. Requests fail if the signed-in account differs from `TIKTOK_EXPECTED_USERNAME`. This local cookie import is not a portable cloud credential: authenticate again on a different deployment host.

To prepare messaging, call `GET /v1/conversations`, inspect the entry for `user602phx`, and set `TIKTOK_MESSAGE_CONVERSATION_ID` to that exact ID. Restart the API after changing configuration. The ID and displayed recipient must both match before a send action. Only already loaded conversations are supported; no cold-start conversation or bulk messaging implementation exists.

## Dry-run example

```sh
curl http://127.0.0.1:8787/v1/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"video_path":"clip.mp4","title":"Example caption","privacy_level":"SELF_ONLY","disable_comment":false,"disable_duet":true,"disable_stitch":true,"brand_content_toggle":false,"brand_organic_toggle":false,"is_aigc":false,"consent":true,"dry_run":true}'
```

The value of `$API_KEY` must be exported in your shell for these examples; `.env` is loaded by npm scripts, not by curl. Dry runs validate the request and return its plan without contacting TikTok or launching Chrome. They do not prove account permissions, target availability or delivery.

For a new comment, send `video_url` and `text` to `/v1/comments`. Use a canonical URL like `https://www.tiktok.com/@creator/video/12345`. For a reply, also supply `reply_to: {"username":"comment-author","text":"Exact existing comment text"}`. An absent or nonunique target causes an error. Replies are limited to the comments currently loaded in the UI.

An explicit TikTok comment rejection returns HTTP 422 with `comment_rejected` and `upstream_status_code`. A missing or malformed acknowledgement remains `comment_outcome_unknown`. The private test posts stayed private; successful comment/reply validation requires an authorized post that TikTok permits commenting on.

For a browser video post, put the clip under `TIKTOK_MEDIA_DIR` (default `.runtime/media`) and use `/v1/posts` with this body. `video_path` is relative to that directory; absolute paths are accepted only within that same directory. Traversal and symlink escape are rejected.

```json
{
  "dry_run": true,
  "provider": "browser",
  "video_path": "clip.mp4",
  "title": "Your caption",
  "privacy_level": "SELF_ONLY",
  "disable_comment": false,
  "disable_duet": true,
  "disable_stitch": true,
  "brand_content_toggle": false,
  "brand_organic_toggle": false,
  "is_aigc": false,
  "consent": true
}
```

The browser provider is the default and does not use `TIKTOK_ACCESS_TOKEN`. It verifies the expected account, uploads the video, fills the caption, selects the requested privacy, verifies interactions/disclosures, and submits once. The response contains `item_id`, `project_id`, and `post_url` from Studio's acknowledgement.

Privacy choices are `PUBLIC_TO_EVERYONE` (Everyone), `MUTUAL_FOLLOW_FRIENDS` (Friends), `FOLLOWER_OF_CREATOR` (Followers), and `SELF_ONLY` (Only you). Only choices offered by the current account are accepted. Studio has one Reuse of content setting, so `disable_duet` and `disable_stitch` must match. If a disabled control conflicts with the request, the adapter stops before submission. The live private test kept the existing comment setting; changing interaction settings and the AI label is implemented but not live-tested. Browser branded-content choices remain unsupported and are rejected during validation. No scheduling, cover editing or location editing is implemented.

The original official provider remains available only when explicitly selected with `"provider":"official"`. It uses `video_url` and `duration_seconds` instead of `video_path`, requires a token granting `video.publish`, and requires TikTok verification of the media domain/prefix. The caller must supply the required creator export UI and consent. These requirements do not apply to the browser provider.

## Live execution and retries

Live execution requires both `ENABLE_TIKTOK_WRITES=true` and `"dry_run":false` in the request. Include a unique `Idempotency-Key` header. Repeating the same key and body returns the saved result. Reusing a key with another body returns `409`. Failed, incomplete and ambiguous attempts are retained, including across restarts; **do not create a new key to blindly retry an unknown outcome**. Inspect TikTok first. There is no automatic retry of writes.

A browser post response with `state: submitted` means Studio returned a successful post acknowledgement; it does not prove moderation completion (`moderation_complete: false`). Inspect the returned post URL or Studio content list. For an official-provider post, poll its publish ID. A message with `verification: visible_in_ui` can be an optimistic insertion and is explicitly returned with `delivery_confirmed: false`. This is not a delivery guarantee. Browser UI changes can break selectors; errors fail closed or report an unknown outcome after a submit action.

Run automation clients against these endpoints when configured. The API has no built-in scheduler, webhook-triggered auto-replies, or mass outreach loop.

## Evidence and limitations

See [the investigation ledger](docs/tiktok-analysis.md). Private files under `docs/evidence/` are intentionally ignored by Git. The report distinguishes runtime observations, static candidates, and unresolved private write protocols. REA's semantic analysis reached a node ceiling, and two downloaded chunks do not represent the complete TikTok application. The implementation does not independently reproduce TikTok's signing algorithm or IM protocol.

`npm test` passes 31 tests. Local acceptance records cover posting, idempotency replay, comment/reply failure handling and self-message verification. Those records and screenshots can contain account or conversation data and remain outside the source repository.

## Future hosting

No tunnel, cloud service, daemon, or auto-start task is configured. A future Cloudflare or similar gateway can sit in front of a host running this API and its browser worker. Plan persistent profile/media storage, a single worker per account, authenticated ingress, and graceful shutdown before exposing it. The current Host/Origin checks deliberately accept only loopback and would need an explicit reviewed ingress configuration. Deployment remains future work.

## ProduDash managed mode

The desktop development app owns this service through an Electron utility worker. It passes an ephemeral bearer key, port zero, explicit runtime/profile/media paths, and `managed: true` to `startApi`. No Chrome window opens until a sign-in, account check, or browser action is requested. The authenticated `/v1/health` handshake is side-effect free.

Managed messaging accepts `conversation_id` instead of the CLI-only pinned `recipient`. `GET /v1/conversations/:id/messages` reads up to 50 currently loaded message rows. Every chat selection is checked against the loaded conversation ID and current browser account; display names are not identifiers. The CLI retains its original pinned-recipient restriction. Comments are unavailable in managed mode. Session operations are `POST /v1/session/open` and `POST /v1/session/check`, with JSON `{}` bodies.

Managed state lives under ProduDash user data. Profile locking applies to both CLI and desktop instances. Stopping rejects new work and drains in-progress requests before closing Chrome and SQLite. Forced interruption preserves uncertain operations for inspection rather than automatic resubmission.
