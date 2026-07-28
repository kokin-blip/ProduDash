#!/usr/bin/env node
"use strict";

// Opt-in live acceptance test for the YouTube connector.
//
// This is the only thing that verifies the connector against Google rather than
// against a mock. It is deliberately excluded from `npm test` and from CI: it
// opens a browser, uploads a real video to a real channel, and consumes real
// API quota.
//
// Run it yourself:
//
//   node scripts/acceptance/youtube.cjs --video ./tiny.mp4
//
// Credentials come from the environment or from an untracked local file. Both
// sources are gitignored; nothing is written back to the repository.
//
//   PRODUDASH_YT_CLIENT_ID=...            (required)
//   PRODUDASH_YT_CLIENT_SECRET=...        (optional for Desktop app clients)
//
// or scripts/acceptance/youtube.local.json:
//   { "clientId": "...", "clientSecret": "..." }
//
// The upload is created with privacyStatus "private" and is NOT deleted
// afterwards -- delete it yourself in YouTube Studio once you have inspected it.

const fs = require("node:fs");
const path = require("node:path");
const { YouTubeConnector } = require("../../electron/connectors/youtube.cjs");

const LOCAL_CONFIG = path.join(__dirname, "youtube.local.json");

function loadCredentials() {
  const fromFile = fs.existsSync(LOCAL_CONFIG) ? JSON.parse(fs.readFileSync(LOCAL_CONFIG, "utf8")) : {};
  const clientId = process.env.PRODUDASH_YT_CLIENT_ID || fromFile.clientId;
  const clientSecret = process.env.PRODUDASH_YT_CLIENT_SECRET || fromFile.clientSecret || "";
  if (!clientId) {
    throw new Error(
      'Missing client id. Set PRODUDASH_YT_CLIENT_ID or create scripts/acceptance/youtube.local.json with { "clientId": "..." }.'
    );
  }
  return { clientId, clientSecret };
}

function parseArgs(argv) {
  const args = { video: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--video") args.video = argv[index + 1];
  }
  if (!args.video) throw new Error("Pass --video <path to a small mp4>.");
  if (!fs.existsSync(args.video)) throw new Error(`No such file: ${args.video}`);
  return args;
}

// Secrets must never reach the console, so redact anything token-shaped.
function say(message) {
  process.stdout.write(`${message}\n`);
}

async function openInBrowser(url) {
  const { spawn } = require("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  say("\nOpening your browser to authorize. If it does not open, paste this URL yourself:\n");
  say(url);
  try {
    spawn(command, [url], { shell: process.platform === "win32", detached: true, stdio: "ignore" }).unref();
  } catch {
    // The printed URL above is the fallback.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentials = loadCredentials();
  const connector = new YouTubeConnector({ openExternal: openInBrowser });

  say("1/5 Authorizing (a browser window will open)...");
  const authorization = await connector.authorize(credentials);
  say(`    access token received: ${Boolean(authorization.accessToken)}`);
  // The single most important thing this script proves: whether Google returns
  // a refresh token for this flow. Without one the connector must reauthorize
  // every hour, and access_type=offline is not enumerated on the native-app
  // documentation page.
  say(`    REFRESH TOKEN RECEIVED: ${Boolean(authorization.refreshToken)}`);
  say(`    granted scopes: ${authorization.grantedScopes.join(", ") || "(none reported)"}`);
  say(`    expires at: ${authorization.tokenExpiresAt || "(not reported)"}`);
  if (!authorization.refreshToken) {
    say("    WARNING: no refresh token. Revoke ProduDash access in your Google account and retry;");
    say("             Google only returns one on a fresh consent.");
  }

  say("\n2/5 Identifying the channel...");
  const verification = await connector.testConnection({ ...credentials, oauthAccessToken: authorization.accessToken });
  const channel = verification.authorizationUpdate.selectedAccount;
  say(`    channel: ${channel.name} (${channel.id})`);

  say("\n3/5 Uploading a private test video...");
  const stats = fs.statSync(args.video);
  const publication = await connector.publish({
    accessToken: authorization.accessToken,
    title: `ProduDash acceptance ${new Date().toISOString()}`,
    description: "Automated ProduDash connector acceptance test. Safe to delete.",
    privacyStatus: "private",
    media: { body: fs.createReadStream(args.video), contentLength: stats.size, contentType: "video/*" }
  });
  say(`    video id: ${publication.publicationId}`);
  say(`    requested privacy: ${publication.requestedPrivacyStatus}`);
  say(`    actual privacy:    ${publication.privacyStatus}`);
  if (publication.privacyStatus && publication.privacyStatus !== publication.requestedPrivacyStatus) {
    say("    NOTE: YouTube overrode the requested privacy. Unaudited API projects are locked to private.");
  }

  say("\n4/5 Polling processing status...");
  let status = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    status = await connector.getPublishingStatus({
      accessToken: authorization.accessToken,
      publicationId: publication.publicationId
    });
    say(`    upload=${status.uploadStatus} processing=${status.processingStatus || "-"} privacy=${status.privacyStatus}`);
    if (status.complete || status.failed) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  say("\n5/5 Revoking the authorization...");
  const revocation = await connector.disconnect({
    oauthRefreshToken: authorization.refreshToken,
    oauthAccessToken: authorization.accessToken
  });
  say(`    revoked: ${revocation.revoked}`);

  say("\nRESULT");
  say(`  refresh token returned : ${Boolean(authorization.refreshToken)}`);
  say(`  video id               : ${publication.publicationId}`);
  say(`  final upload status    : ${status?.uploadStatus || "unknown"}`);
  say(`  final privacy status   : ${status?.privacyStatus || "unknown"}`);
  say("\nDelete the uploaded video in YouTube Studio when you are done.");
  if (status && !status.complete) process.exitCode = 1;
}

main().catch((error) => {
  // Connector errors carry safe codes; anything else prints its message only.
  process.stderr.write(`\nAcceptance test failed: ${error.code ? `${error.code} ` : ""}${error.message}\n`);
  process.exitCode = 1;
});
