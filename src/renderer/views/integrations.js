import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { credentialStored, ui } from "../state.js";
import { renderCompliancePanel, renderIntegrationCards } from "./shared.js";

export function renderIntegrations() {
  return `
    <section class="detail-grid">
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Integrations</p><h2>Verified connection state</h2></div></div>
        <div class="integration-grid">${renderIntegrationCards()}</div>
      </article>
      ${renderCredentialSettings()}
      <article class="panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">Local data</p><h2>Reset and deletion controls</h2></div>
        </div>
        <p>Resetting removes imported dashboard snapshots but retains encrypted credentials. Deleting all data removes both.</p>
        <div class="approval-actions">
          <button class="text-button" type="button" data-reset-dashboard>Reset dashboard data</button>
          <button class="text-button danger-button" type="button" data-delete-all>Delete all data and credentials</button>
        </div>
      </article>
      ${renderCompliancePanel()}
    </section>
  `;
}

function renderCredentialSettings() {
  return `
    <article class="panel detail-panel">
      <div class="panel-heading compact">
        <div><p class="eyebrow">Secure settings</p><h2>User-supplied credentials</h2></div>
        <span class="mini-badge">OS protected</span>
      </div>
      <div class="credential-stack">
        ${ui.appState.credentialSettings
          .map((setting) => {
            const integration = ui.appState.integrations.find((item) => item.id === setting.id);
            const liveConnector = ["shopify", "gemini"].includes(setting.id);
            if (!liveConnector) {
              return `
                <div class="credential-card">
                  <div class="credential-heading">
                    <div>
                      <strong>${escapeHtml(setting.name)}</strong>
                      <span>${escapeHtml(setting.note)}</span>
                    </div>
                    <small>Planned · credentials not accepted</small>
                  </div>
                  <p class="planned-note">ProduDash will request credentials only after an official connector and its required approval flow are implemented.</p>
                  ${
                    credentialStored(setting.id)
                      ? `<div class="credential-actions"><span>Legacy credentials are stored securely.</span><button class="text-button" type="button" data-remove-credentials="${escapeHtml(
                          setting.id
                        )}">Remove legacy credentials</button></div>`
                      : ""
                  }
                </div>
              `;
            }
            return `
              <form class="credential-card" data-credentials-form="${escapeHtml(setting.id)}">
                <div class="credential-heading">
                  <div>
                    <strong>${escapeHtml(setting.name)}</strong>
                    <span>${escapeHtml(setting.note)}</span>
                  </div>
                  <small>${escapeHtml(statusLabel(setting.status))} · ${escapeHtml(statusLabel(integration?.status))}</small>
                </div>
                <div class="credential-fields">
                  ${(Array.isArray(setting.fields) ? setting.fields : [])
                    .map((field) => {
                      const configured = (setting.configuredFields || []).includes(field.key);
                      const publicValue = field.sensitive ? "" : setting.publicValues?.[field.key] || "";
                      return `
                        <label class="credential-field">
                          <span>${escapeHtml(field.label)}</span>
                          <input
                            name="${escapeHtml(field.key)}"
                            type="${field.sensitive ? "password" : "text"}"
                            maxlength="${field.sensitive ? "4096" : "253"}"
                            autocomplete="off"
                            spellcheck="false"
                            value="${escapeHtml(publicValue)}"
                            placeholder="${escapeHtml(configured && field.sensitive ? "Stored securely. Enter a replacement value." : field.placeholder)}"
                          />
                        </label>
                      `;
                    })
                    .join("")}
                </div>
                <div class="credential-actions">
                  <span>${setting.updatedAt ? `Updated ${escapeHtml(formatDate(setting.updatedAt))}` : "No credentials stored"}</span>
                  <div>
                    ${
                      credentialStored(setting.id)
                        ? `<button class="text-button" type="button" data-remove-credentials="${escapeHtml(setting.id)}">Remove</button>`
                        : ""
                    }
                    ${
                      credentialStored(setting.id) && liveConnector
                        ? `<button class="text-button" type="button" data-refresh-integration="${escapeHtml(setting.id)}">Refresh</button>`
                        : ""
                    }
                    <button class="primary-button small" type="submit">Save and validate</button>
                  </div>
                </div>
              </form>
            `;
          })
          .join("")}
      </div>
    </article>
  `;
}
