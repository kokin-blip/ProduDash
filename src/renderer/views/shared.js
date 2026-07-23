import { escapeHtml, statusLabel } from "../format.js";
import { ui } from "../state.js";

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
      <div class="status-banner error" role="alert">
        <strong>Request blocked</strong>
        <span>${escapeHtml(ui.error)}</span>
      </div>
    `
    : "";
  return `<div class="status-stack">${error}${notices}</div>`;
}

export function renderConnectionFirst() {
  return `
    <section class="detail-grid">
      <article class="panel detail-panel">
        <div class="panel-heading compact">
          <div>
            <p class="eyebrow">Connection required</p>
            <h2>ProduDash is waiting for real accounts.</h2>
          </div>
          <span class="mini-badge">No demo data</span>
        </div>
        <div class="empty-state roomy">
          <strong>Start with Shopify, then connect Gemini.</strong>
          <p>Shopify uses the official GraphQL Admin API. Gemini remains draft-only, and saved credentials never count as a successful connection.</p>
        </div>
        <div class="policy-list">
          <div class="policy-item"><span>1</span><p>No scraping, password sharing, browser bots, or unofficial APIs.</p></div>
          <div class="policy-item"><span>2</span><p>Provider data is stored locally and secrets remain in operating-system protected storage.</p></div>
          <div class="policy-item"><span>3</span><p>Every AI reply and export stays behind explicit human approval.</p></div>
        </div>
      </article>
      ${renderCompliancePanel()}
    </section>
  `;
}

export function renderCompliancePanel() {
  return `
    <article class="panel">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Rules-first automation</p>
          <h2>Safe MVP boundaries</h2>
        </div>
        <span class="mini-badge">Draft + approval</span>
      </div>
      <div class="policy-list">
        <div class="policy-item"><span>API</span><p>Only official provider APIs and merchant-owned credentials are supported.</p></div>
        <div class="policy-item"><span>AI</span><p>Gemini drafts and classifies. It never sends, charges, fulfills, or refunds.</p></div>
        <div class="policy-item"><span>DATA</span><p>Profit and conversion stay unavailable until ProduDash has real cost and traffic inputs.</p></div>
      </div>
    </article>
  `;
}

export function renderIntegrationCards() {
  return ui.appState.integrations
    .map((integration) => {
      const credentials = ui.appState.credentialSettings.find((setting) => setting.id === integration.id);
      const stored = credentials?.status === "stored";
      return `
        <div class="integration-card">
          <strong>${escapeHtml(integration.name)}</strong>
          <span>${escapeHtml(integration.detail)}</span>
          <small>${escapeHtml(statusLabel(integration.status))} · ${escapeHtml(integration.lastSync || "Never")} · ${
            stored ? "credentials stored" : "credentials missing"
          }</small>
          ${integration.error ? `<p class="inline-error">${escapeHtml(integration.error)}</p>` : `<p>${escapeHtml(integration.compliance)}</p>`}
        </div>
      `;
    })
    .join("");
}
