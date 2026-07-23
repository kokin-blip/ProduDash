import { escapeHtml, statusLabel, statusTone } from "../format.js";
import { credentialStored, ui } from "../state.js";

export function renderStatusBadge(value, label = statusLabel(value), key = "") {
  const statusAttributes = key ? ` data-status-key="${escapeHtml(key)}" data-status-value="${escapeHtml(value || "unknown")}"` : "";
  return `<span class="status-badge ${statusTone(value)}"${statusAttributes}><span aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

export function renderStatusMessages() {
  const notices = ui.appState.systemNotices
    .map(
      (notice) => `
        <div class="status-banner notice" role="status">
          <strong>${escapeHtml(statusLabel(notice.code))}</strong>
          <span>${escapeHtml(notice.message)}</span>
        </div>
      `
    )
    .join("");
  const error = ui.error
    ? `
      <div class="status-banner error" role="alert" tabindex="-1">
        <strong>Request blocked</strong>
        <span>${escapeHtml(ui.error)}</span>
      </div>
    `
    : "";
  return `<div class="status-stack">${error}${notices}</div>`;
}

export function renderConnectionFirst() {
  const shopify = connectionState("shopify");
  const gemini = connectionState("gemini");
  const shopifyReady = shopify.status === "connected";
  return `
    <section class="setup-view">
      <article class="panel setup-panel">
        <div class="panel-heading">
          <div>
            <h2>Connect the essentials</h2>
            <p>Start with your store, then add draft-only AI assistance.</p>
          </div>
          ${renderStatusBadge(
            shopifyReady && gemini.status === "connected" ? "connected" : "pending",
            "Setup in progress",
            "setup-progress"
          )}
        </div>
        <ol class="setup-steps">
          ${renderSetupStep({
            number: "1",
            title: "Connect Shopify",
            description:
              shopify.status === "connected"
                ? "Store identity and recent commerce data were verified."
                : shopify.stored
                  ? "Credentials are encrypted locally but the store still needs verification."
                  : "Import up to 100 recent products and orders through Shopify’s official Admin API.",
            status: shopify.status,
            statusLabel: shopify.status === "connected" ? "Connected" : shopify.stored ? "Needs verification" : "Not connected",
            action: shopify.status === "connected" ? "Review Shopify" : shopify.stored ? "Review Shopify" : "Connect Shopify",
            primary: shopify.status !== "connected",
            statusKey: "setup-shopify"
          })}
          ${renderSetupStep({
            number: "2",
            title: "Connect Gemini",
            description:
              gemini.status === "connected"
                ? "Gemini is available for structured, approval-only drafts."
                : "Enable structured drafts, summaries, and recommendations after your store is connected.",
            status: gemini.status,
            statusLabel: gemini.status === "connected" ? "Connected" : gemini.stored ? "Needs verification" : "Not connected",
            action: gemini.status === "connected" ? "Review Gemini" : "Connect Gemini",
            disabled: !shopifyReady,
            disabledReason: "Connect Shopify first",
            statusKey: "setup-gemini"
          })}
          <li class="setup-step">
            <span class="step-number">3</span>
            <div class="step-copy">
              <strong>Human approval required</strong>
              <p>AI drafts and local export plans can never send or publish without an explicit decision.</p>
            </div>
            <div class="step-status">${renderStatusBadge("enabled", "Always on")}</div>
          </li>
        </ol>
      </article>
      ${renderCompliancePanel("How your data is handled")}
    </section>
  `;
}

function connectionState(id) {
  const integration = ui.appState.integrations.find((item) => item.id === id);
  return {
    status: integration?.status || "disconnected",
    stored: credentialStored(id)
  };
}

function renderSetupStep({
  number,
  title,
  description,
  status,
  statusLabel: label,
  action,
  primary = false,
  disabled = false,
  disabledReason = "",
  statusKey = ""
}) {
  return `
    <li class="setup-step">
      <span class="step-number">${number}</span>
      <div class="step-copy">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>
        ${disabledReason && disabled ? `<small>${escapeHtml(disabledReason)}</small>` : ""}
      </div>
      <div class="step-status">
        ${renderStatusBadge(status, label, statusKey)}
        <button class="${primary ? "primary-button" : "ghost-button"} small" type="button" data-section="integrations" ${
          disabled ? "disabled" : ""
        }>${escapeHtml(action)}</button>
      </div>
    </li>
  `;
}

export function renderCompliancePanel(title = "Security and workflow boundaries") {
  return `
    <details class="disclosure">
      <summary>
        <span>
          <strong>${escapeHtml(title)}</strong>
          <small>Local storage, official APIs, and mandatory approvals</small>
        </span>
        <span class="disclosure-icon" aria-hidden="true">+</span>
      </summary>
      <div class="disclosure-content">
        <div class="policy-row">
          <span aria-hidden="true">API</span>
          <div><strong>Official connections only</strong><p>ProduDash does not scrape provider websites or accept credentials for unfinished connectors.</p></div>
        </div>
        <div class="policy-row">
          <span aria-hidden="true">KEY</span>
          <div><strong>Secrets stay OS-protected</strong><p>Provider keys are encrypted by the operating system and are never returned to the renderer.</p></div>
        </div>
        <div class="policy-row">
          <span aria-hidden="true">OK</span>
          <div><strong>Actions remain approval-gated</strong><p>Gemini only drafts and classifies. Profit and conversion remain unavailable without real source data.</p></div>
        </div>
      </div>
    </details>
  `;
}

export function renderIntegrationCards() {
  return ui.appState.integrations
    .filter((integration) => ["shopify", "gemini"].includes(integration.id))
    .map((integration) => {
      const credentials = ui.appState.credentialSettings.find((setting) => setting.id === integration.id);
      const stored = credentials?.status === "stored";
      return `
        <div class="integration-row">
          <div class="integration-name">
            <strong>${escapeHtml(integration.name)}</strong>
            <span>${escapeHtml(integration.detail)}</span>
            ${integration.error ? `<p class="inline-error">${escapeHtml(integration.error)}</p>` : ""}
          </div>
          <div class="integration-meta">
            ${renderStatusBadge(integration.status, undefined, `health-${integration.id}`)}
            <small>${escapeHtml(integration.lastSync || "Never")} · ${stored ? "Credentials stored" : "Credentials missing"}</small>
          </div>
        </div>
      `;
    })
    .join("");
}
