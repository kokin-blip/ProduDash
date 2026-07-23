import { escapeHtml, formatUsd, statusLabel } from "../format.js";
import { asArray, getApprovals, getConversations, getSelectedConversation, integrationReady } from "../state.js";
import { renderApprovals } from "./dashboard.js";

export function renderInbox() {
  const conversations = getConversations();
  const selected = getSelectedConversation() || conversations[0] || null;
  const approvals = selected ? getApprovals().filter((approval) => approval.conversationId === selected.id) : [];
  const messages = asArray(selected?.messages);
  return `
    <section class="detail-grid">
      <article class="panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">AI Inbox</p><h2>Officially imported threads</h2></div>
          <span class="mini-badge">${conversations.length} threads</span>
        </div>
        <div class="conversation-list">
          ${
            conversations.length
              ? conversations
                  .map(
                    (conversation) => `
                      <button class="conversation-item ${conversation.id === selected?.id ? "active" : ""}" type="button" data-conversation="${escapeHtml(
                        conversation.id
                      )}">
                        <span>${escapeHtml(conversation.channel || "Unknown")} · ${escapeHtml(statusLabel(conversation.status))}</span>
                        <strong>${escapeHtml(conversation.customer || "Customer")}</strong>
                        <p>${escapeHtml(conversation.intent || "Unclassified")} · ${escapeHtml(conversation.risk || "Human review")}</p>
                      </button>
                    `
                  )
                  .join("")
              : `<div class="empty-state">No social provider is connected. ProduDash does not scrape or invent conversations.</div>`
          }
        </div>
      </article>
      <article class="panel detail-panel">
        ${
          selected
            ? `
              <div class="panel-heading compact">
                <div><p class="eyebrow">${escapeHtml(selected.channel || "Unknown")}</p><h2>${escapeHtml(selected.customer || "Customer")}</h2></div>
                <span class="mini-badge">${escapeHtml(statusLabel(selected.status))}</span>
              </div>
              <div class="chat-window detail-chat">
                ${messages
                  .map(
                    (message) => `
                      <div class="message ${message.role === "customer" ? "customer" : "ai"}">
                        <span>${escapeHtml(message.role === "ai_draft" ? "Approved draft — not sent" : message.role || "message")}</span>
                        <p>${escapeHtml(message.text)}</p>
                      </div>
                    `
                  )
                  .join("")}
              </div>
              ${renderOrderDraft(selected.orderDraft, selected.currency)}
              <form class="chat-composer" data-draft-form>
                <input name="prompt" type="text" maxlength="2000" autocomplete="off" placeholder="${
                  integrationReady("gemini") ? "Tell Gemini what to draft" : "Validate Gemini before drafting"
                }" ${integrationReady("gemini") ? "" : "disabled"} />
                <button type="submit" ${integrationReady("gemini") ? "" : "disabled"}>Draft for approval</button>
              </form>
              <div class="approval-stack">${renderApprovals(approvals)}</div>
            `
            : `<div class="empty-state">Select an imported conversation to create an approval-only draft.</div>`
        }
      </article>
    </section>
  `;
}

function renderOrderDraft(orderDraft, currency = "USD") {
  if (!orderDraft || typeof orderDraft !== "object") {
    return `<div class="order-draft"><strong>No order detected</strong><span>Gemini has not extracted an order from this conversation.</span></div>`;
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
