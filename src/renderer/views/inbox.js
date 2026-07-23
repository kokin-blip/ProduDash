import { escapeHtml, formatUsd, statusLabel } from "../format.js";
import { asArray, getApprovals, getConversations, getSelectedConversation, isPending, workloadReady } from "../state.js";
import { renderApprovals } from "./dashboard.js";
import { renderStatusBadge } from "./shared.js";

export function renderInbox() {
  const conversations = getConversations();
  const selected = getSelectedConversation() || conversations[0] || null;
  const approvals = selected ? getApprovals().filter((approval) => approval.conversationId === selected.id) : [];
  const messages = asArray(selected?.messages);
  const drafting = selected ? isPending(`draft-${selected.id}`) : false;
  const providerReady = workloadReady("inboxDrafting");
  return `
    <section class="inbox-view">
      <aside class="panel conversation-pane">
        <div class="section-heading">
          <div><h2>Imported conversations</h2><p>Official social providers only.</p></div>
          ${renderStatusBadge("neutral", `${conversations.length} threads`)}
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
                        <span>
                          <strong>${escapeHtml(conversation.customer || "Customer")}</strong>
                          <small>${escapeHtml(conversation.channel || "Unknown")} · ${escapeHtml(
                            conversation.intent || "Unclassified"
                          )}</small>
                        </span>
                        ${renderStatusBadge(conversation.status || "unknown")}
                      </button>
                    `
                  )
                  .join("")
              : `<div class="quiet-state"><p>No social provider is connected. ProduDash does not scrape or invent conversations.</p></div>`
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
                                message.role === "ai_draft" ? "Approved draft — not sent" : statusLabel(message.role || "message")
                              )}</span>
                              <p>${escapeHtml(message.text)}</p>
                            </div>
                          `
                        )
                        .join("")
                    : `<div class="quiet-state compact"><p>No messages were imported for this conversation.</p></div>`
                }
              </div>
              ${renderOrderDraft(selected.orderDraft, selected.currency)}
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
            : `<div class="quiet-state conversation-empty"><p>Select an imported conversation to create an approval-only draft.</p></div>`
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
