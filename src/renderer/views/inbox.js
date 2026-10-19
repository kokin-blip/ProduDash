import { escapeHtml, formatUsd, statusLabel } from "../format.js";
import { asArray, getApprovals, getConversations, getSelectedConversation, isPending, ui, workloadReady } from "../state.js";
import { renderApprovals } from "./dashboard.js";
import { renderStatusBadge } from "./shared.js";

export function renderInbox() {
  const conversations = getConversations();
  const selected = getSelectedConversation() || conversations[0] || null;
  const approvals = selected ? getApprovals().filter((approval) => approval.conversationId === selected.id) : [];
  const messages = asArray(selected?.messages);
  const drafting = selected ? isPending(`draft-${selected.id}`) : false;
  const tikTok = ui.appState.customApis?.find((item) => item.id === "tiktok");
  const browserThread = selected?.source === "tiktok";
  const sends = asArray(ui.appState.messageDispatches).filter((item) => item.conversationId === selected?.id);
  const unresolved = sends.some((item) => ["sending", "outcome_unknown"].includes(item.status));
  const canSend = browserThread && tikTok?.state === "running" && tikTok.account?.id === selected.accountId && !unresolved;
  const providerReady = workloadReady("inboxDrafting");
  return `
    <section class="inbox-view">
      <aside class="panel conversation-pane">
        <div class="section-heading">
          <div><h2>Imported conversations</h2><p>Provider imports and loaded TikTok browser chats.</p></div>
          ${renderStatusBadge("neutral", `${conversations.length} threads`)}
        </div>
        <button class="ghost-button small" type="button" data-refresh-tiktok-chats ${tikTok?.state === "running" && tikTok.account ? "" : "disabled"}>Refresh TikTok chats</button>
        <div class="conversation-list">
          ${
            conversations.length
              ? conversations
                  .map(
                    (conversation) => `
                      <button class="conversation-item ${conversation.id === selected?.id ? "active" : ""}" type="button" data-conversation="${escapeHtml(
                        conversation.id
                      )}">
                        <span>
                          <strong>${escapeHtml(conversation.customer || "Customer")}</strong>
                          <small>${escapeHtml(conversation.accountId ? `TikTok @${conversation.accountId}` : conversation.channel || "Unknown")} · ${escapeHtml(
                            conversation.intent || "Unclassified"
                          )}</small>
                        </span>
                        ${renderStatusBadge(conversation.status || "unknown")}
                      </button>
                    `
                  )
                  .join("")
              : `<div class="quiet-state"><p>No conversations loaded. Start the TikTok API and check its account in Integrations, then refresh chats.</p></div>`
          }
        </div>
      </aside>
      <article class="panel conversation-detail">
        ${
          selected
            ? `
              <div class="section-heading">
                <div><h2>${escapeHtml(selected.customer || "Customer")}</h2><p>${escapeHtml(
                  selected.channel || "Unknown channel"
                )} · ${escapeHtml(selected.risk || "Human review")}</p></div>
                ${renderStatusBadge(selected.status || "unknown")}
              </div>
              <div class="chat-window" aria-label="Conversation messages">
                ${
                  messages.length
                    ? messages
                        .map(
                          (message) => `
                            <div class="message ${message.role === "customer" ? "customer" : "ai"}">
                              <span>${escapeHtml(
                                message.role === "ai_draft"
                                  ? "Approved draft — not sent"
                                  : message.role === "unknown"
                                    ? "Browser snapshot"
                                    : statusLabel(message.role || "message")
                              )}</span>
                              <p>${escapeHtml(message.text)}</p>
                            </div>
                          `
                        )
                        .join("")
                    : `<div class="quiet-state compact"><p>No messages were imported for this conversation.</p></div>`
                }
              </div>
              ${
                browserThread
                  ? `<p class="security-note">Partial browser snapshot · currently loaded messages only${selected.snapshotAt ? ` · ${escapeHtml(selected.snapshotAt)}` : ""}</p>
                <button class="ghost-button small" type="button" data-refresh-tiktok-messages="${escapeHtml(selected.id)}" ${tikTok?.state === "running" ? "" : "disabled"}>Refresh messages</button>`
                  : renderOrderDraft(selected.orderDraft, selected.currency)
              }
              ${browserThread ? renderTikTokSending(selected, sends, canSend) : ""}
              <form class="chat-composer" data-draft-form aria-busy="${drafting}">
                <label class="sr-only" for="draftPrompt">Draft instructions</label>
                <input id="draftPrompt" name="prompt" type="text" maxlength="2000" autocomplete="off" placeholder="${
                  providerReady ? "Tell your assigned AI provider what to draft" : "Assign and validate an Inbox Drafting provider"
                }" ${providerReady && !drafting ? "" : "disabled"} />
                <button type="submit" data-pending-label="Drafting…" ${providerReady && !drafting ? "" : "disabled"}>${
                  drafting ? "Drafting…" : "Draft for approval"
                }</button>
              </form>
              <section class="approval-stack" aria-label="Draft approvals">${renderApprovals(approvals)}</section>
            `
            : `<div class="quiet-state conversation-empty"><p>Select an imported conversation to draft a reply or send a manual TikTok message.</p></div>`
        }
      </article>
    </section>
  `;
}

function renderOrderDraft(orderDraft, currency = "USD") {
  if (!orderDraft || typeof orderDraft !== "object") {
    return `<div class="order-draft"><strong>No order detected</strong><span>The assigned AI provider has not extracted an order from this conversation.</span></div>`;
  }
  return `
    <div class="order-draft">
      <strong>Potential order — verify manually</strong>
      <span>${escapeHtml(orderDraft.item || "Unknown item")} · ${escapeHtml(orderDraft.variant || "No variant")} · ${formatUsd(
        orderDraft.value,
        orderDraft.currency || currency
      )} · ${escapeHtml(orderDraft.paymentStatus || "Unverified payment")}</span>
    </div>
  `;
}

function renderTikTokSending(thread, sends, canSend) {
  const approved = getApprovals().filter((item) => item.conversationId === thread.id && item.status === "approved");
  const pending = isPending(`message-${thread.id}`);
  return `<section aria-label="TikTok message sending">
    ${sends
      .map(
        (
          item
        ) => `<div class="message ai"><strong>${item.status === "submitted" ? "Submitted — delivery unconfirmed" : item.status === "outcome_unknown" ? "Outcome unknown — inspect TikTok before another send" : escapeHtml(statusLabel(item.status))}</strong><p>${escapeHtml(item.text)}</p>
      ${item.status === "outcome_unknown" ? `<button type="button" class="ghost-button small" data-inspect-message="${escapeHtml(item.id)}">I checked TikTok — do not resend</button>` : ""}</div>`
      )
      .join("")}
    <form class="chat-composer" data-tiktok-send-form="${escapeHtml(thread.id)}">
      <label class="sr-only" for="tiktokMessage">Manual TikTok message</label>
      <textarea id="tiktokMessage" name="message" maxlength="1000" placeholder="Write a message to ${escapeHtml(thread.customer)}" ${!canSend || pending ? "disabled" : ""}></textarea>
      <button type="submit" ${!canSend || pending ? "disabled" : ""}>Send message</button>
    </form>
    ${!canSend ? "<p>Start the API, verify this account, and resolve uncertain sends before sending.</p>" : ""}
    ${approved.map((draft) => `<button class="ghost-button small" type="button" data-send-tiktok-draft="${escapeHtml(draft.id)}" data-message-thread="${escapeHtml(thread.id)}" ${!canSend || pending || sends.some((s) => s.approvalId === draft.id) ? "disabled" : ""}>Send approved draft</button>`).join("")}
  </section>`;
}
