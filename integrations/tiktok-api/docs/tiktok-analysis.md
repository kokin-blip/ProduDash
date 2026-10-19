# TikTok investigation ledger — October 12, 2026

## Scope and result

Requested: use REA to analyze TikTok and build a local API for publishing, comments, and messaging. The target was the public TikTok web application, followed by the user's signed-in Chrome session through the ChatGPT extension. The workspace initially contained only `review/` artifacts and no application source.

Implemented: a local REST service with browser Studio posting as the default, optional documented Content Posting API publishing, browser comment/reply automation, and browser messaging restricted by default to `user602phx`. This is **not a complete reconstruction of TikTok's private API**. Two private synthetic test clips were submitted to `@jamftest`: one through the connected UI and one through the actual HTTP API with its dedicated Chrome profile. No comments or messages were sent. The API is left stopped and local live writes disabled.

## Evidence

| Evidence | Observation and boundary |
| --- | --- |
| REA `ev_42979f891615f0dae9432808028c6951c37b6e1ec8afef9590e35134e8835c17` | Controlled, logged-out Chrome capture of `https://www.tiktok.com/`. Feed traffic included `msToken`, `X-Bogus`, `X-Gnarly`, and `X-Dynosaur` parameter names. Values are omitted from the saved network summary. Some requests were unfinished at capture end; event coverage is incomplete. |
| Chrome extension CDP and DOM observation | After user sign-in, opening a comment panel produced GET requests to `/api/comment/list/`, `/api/mention/recent/contact/list/v1/`, and `/api/at/default/list/`. This was extension observation, not a REA runtime attachment. Only endpoint paths and parameter names were retained in the report. |
| Chrome extension DOM observation | Profile link: `[data-e2e="nav-profile"]`. Comment composer: a visible contenteditable textbox. Comment body: `comment-level-1`; reply control: `comment-reply-1`. The parent row class contains `DivCommentItemWrapper`. These are observed selectors, subject to TikTok UI changes. |
| Chrome extension DOM observation | Messaging uses `nav-messages`, `dm-new-conversation-list`, `dm-new-conversation-item`, `data-conv-id`, `dm-new-chat-nickname`, `dm-new-message-list`, and `dm-new-chat-item`. The textbox has accessible name `Send a message...`. Conversation IDs and contents are not included in this report. |
| Chrome extension DOM observation | Studio upload at `/tiktokstudio/upload?from=webapp&tab=video` exposes a `video/*` file input and `select_video_button`. The workflow after upload was not inspected; no file was uploaded. |
| REA parent `ev_53a225c2b741fe49389790147525a49302406d1c4b79a7c54be6f69f612678e8`; summary `ev_8852bba76acf32b4ca019c192f920424f4e3fda15e8290bb218be4121702bcdc` | Static analysis of two downloaded public JavaScript chunks, 371,925 bytes; two parsed files, 103,651 visited AST nodes, no parse failures. Semantic coverage is partial and truncated at the 100,000-node ceiling, with 21,939 semantic unknowns. The full application and all dependent chunks were not acquired. Static parsing did not execute the downloaded code. |

The two bundles were acquired from exact public CDN URLs observed through `Debugger.scriptParsed` in the signed-in tab:

- `https://lf16-tiktok-web.tiktokcdn-us.com/obj/tiktok-web-tx/tiktok/webapp/main/react-v18/webapp-desktop/static/js/async/comment-sidebar.d02799f2.js`
- `https://lf16-tiktok-web.tiktokcdn-us.com/obj/tiktok-web-tx/tiktok/webapp/main/react-v18/webapp-desktop/static/js/async/instance.4693fdb7.js`

Downloaded byte hashes are saved in `docs/evidence/bundle-manifest.json`. URL identity was matched to the runtime inventory; downloaded bytes were not independently compared to the debugger's in-memory source bytes. These chunks are retained locally under an ignored directory and are not part of the implementation source.

REA inspection of the Business docs also returned `ev_0e0c4aad58de1275f1d12955408ee93f812af2d8e08e7a8eef91d600e57d117d`, confirming the guide lists app registration, authorization, and Business Messaging access prerequisites. A legacy numeric docs link resolved to a "doc is not found" state (`ev_d4d2c13e23cbb63e6b24a5ae4fff75432b1360f2408b6112ed5ad8ab3eba7b10`), so it was not treated as an endpoint contract.

## Observations, inferences and unknowns

**Observed:** request parameter names, read endpoint paths, account link and browser controls described above. Official documentation specifies creator-info lookup, publish initialization, URL-domain verification, publish status, and visibility restrictions for unaudited apps. [Direct Post documentation](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [creator info](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info), [sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines).

**Inference:** using TikTok's own browser UI lets its client prepare requests through its normal code. The observed signature-like parameters alone do not establish the algorithm, its security purpose, or whether all writes share it. No independent signer was built.

**Candidate:** `/api/comment/publish/` and the response containing `status_code` and `comment.cid` are used as a conservative acknowledgement matcher in the adapter. This write contract was not observed in a live publish trace. If it differs, the adapter reports an unknown outcome and blocks duplicate execution with the same key.

**Newly observed in the test account:** the Studio upload/settings flow and successful POST `/tiktok/web/project/post/v1/`. A response with root `status_code: 0` and one successful `single_post_resp_list` entry returns the video `item_id` and root `project_id`. The content list showed the synthetic clip with Only me privacy. The adapter now uses this exact endpoint and response contract, without reproducing a signer.

**Still unknown:** the full low-level upload protocol, private IM send protocol, message delivery acknowledgement, private-write rate limits, and account-specific permissions. Browser branded-content choices and live interaction/AI-label changes have not been verified. The optional public API and browser can act as different accounts if configured incorrectly; browser identity is checked, while official-provider creator identity must be reviewed through `/v1/creator`.

## Checklist

| Question | Status |
| --- | --- |
| Is REA connected and able to analyze acquired TikTok code? | Answered; static analysis saved with coverage limits. |
| Can the existing extension inspect signed-in TikTok? | Answered; observed authenticated browser controls and read requests. |
| Can that extension be used directly by an unattended local service? | Unresolved bridge; no such bridge was exposed or implemented. The service uses a separate Chrome profile. |
| Can our API publish videos? | Actual HTTP API end-to-end test passed on jamftest without a token; dedicated Chrome session configured; private post verified in Studio. Official provider remains optional. |
| Can our API create/reply to comments? | Browser adapter implemented; selectors observed; live submit/acknowledgement unverified. |
| Can our API send messages? | Browser adapter implemented; exact allowed recipient and pinned conversation required; no send was performed. |
| Have credentials or signing tokens been extracted for replay? | Only the authorized TikTok-domain encrypted cookies from the user-selected Profile 2 were imported locally for Chrome's normal sign-in. No cookie values were decrypted/printed and no independent request signer or raw Cookie-header replay was built. |
| Has live write behavior been proven? | Actual API posting returned HTTP 202 and a successful acknowledgement, then Studio showed the resulting clip as Only me. Replaying its idempotency key returned the saved item ID without submitting again. No message/comment test was performed. |

## Design choices and verification

- Dry runs perform no browser or TikTok network action. Both an explicit live request and server configuration are required for real writes.
- SQLite records duplicate keys before executing. Same-body requests replay the previous result; conflicts and abandoned operations are blocked. Errors and ambiguous results are retained without automatic retry.
- Browser actions serialize in one dedicated profile and check the expected account. Message selection requires both a pinned conversation ID and the allowed displayed recipient.
- A visible message bubble can be optimistic UI; the API returns `delivery_confirmed: false` instead of claiming delivery.
- Loopback-only HTTP, bearer authentication, Host and Origin checks, and bounded JSON requests protect the local API. Errors do not echo raw signed URLs, browser exceptions, or upstream credential text.

Validation: `npm test` passes 26 tests. Added browser-provider routing, constrained local media lookup including symlink escapes, Studio preparation without publication, privacy/disabled-control checks, parsing the observed acknowledgement, and non-retry after a lost publish response. Existing HTTP, idempotency, account, recipient, official-provider and error tests also pass.

The test account was identified as `jamftest` in the kokinjamf Chrome instance. The earlier upload attempt on the personal profile was blocked and was not worked around. After explicit authorization for the test account and enabling file access on that extension, the synthetic video uploaded and was submitted with Only you privacy. Automatic checks were declined rather than changing account defaults. Automatic approval review rejected disabling comments, so that setting was left at its existing value for the test. No messages were sent.

For the subsequent actual API test, the user supplied `/Users/kokinmartinez/Library/Application Support/Google/Chrome/Profile 2` as kokinjamf's profile path. A read-only SQLite snapshot was filtered in memory to 37 TikTok-domain cookies and imported into the API's local profile; no unrelated cookie rows were persisted. Chrome's mock-keychain/password-store overrides were omitted so its native keychain could read the same-machine encrypted cookies. The actual service checked `jamftest`, uploaded the synthetic clip, set Only you privacy, submitted once, and returned video `7695910788313271566` with HTTP 202. The repeated identical HTTP request returned the cached result. Studio was refreshed independently to verify the new clip's Only me setting. The service was shut down, and a loopback connection check confirmed port 8787 was closed. `.env` retained `ENABLE_TIKTOK_WRITES=false` throughout; live writes were enabled only in the temporary test process.
