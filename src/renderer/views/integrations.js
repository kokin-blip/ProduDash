import { escapeHtml, formatDate } from "../format.js";
import { asArray, credentialStored, isPending, ui } from "../state.js";
import { renderCompliancePanel, renderStatusBadge } from "./shared.js";

const LIVE_CONNECTORS = ["shopify", "gemini"];

export function renderIntegrations() {
  return `
    <section class="integrations-view">
      <div class="section-intro">
        <div>
          <h2>Live connections</h2>
          <p>Credentials are stored separately from dashboard data and count as connected only after provider validation succeeds.</p>
        </div>
        <span class="security-note">Protected by OS encryption</span>
      </div>
      <div class="connection-stack">${renderLiveConnections()}</div>
      ${renderPlannedConnections()}
      ${renderLocalDataControls()}
      ${renderCompliancePanel()}
    </section>
  `;
}

function renderLiveConnections() {
  return LIVE_CONNECTORS.map((integrationId) => {
    const setting = ui.appState.credentialSettings.find((item) => item.id === integrationId);
    const integration = ui.appState.integrations.find((item) => item.id === integrationId);
    if (!setting) return "";
    const pending = isPending(`credentials-${integrationId}`) || isPending(`refresh-${integrationId}`);
    return `
      <form class="panel connection-section" data-credentials-form="${escapeHtml(integrationId)}" aria-busy="${pending}">
        <div class="connection-heading">
          <div>
            <div class="connection-title">
              <h2>${escapeHtml(setting.name)}</h2>
              ${renderStatusBadge(integration?.status || "disconnected", undefined, `integration-${integrationId}`)}
            </div>
            <p>${escapeHtml(setting.note)}</p>
          </div>
          <small>${escapeHtml(integration?.lastSync || "Never validated")}</small>
        </div>
        ${
          integration?.error
            ? `<div class="inline-message error"><strong>Connection needs attention</strong><span>${escapeHtml(integration.error)}</span></div>`
            : ""
        }
        <fieldset class="credential-fields" ${pending ? "disabled" : ""}>
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
        </fieldset>
        <div class="connection-actions">
          <span>${
            setting.updatedAt
              ? `Updated ${escapeHtml(formatDate(setting.updatedAt))}`
              : credentialStored(integrationId)
                ? "Credentials stored securely"
                : "No credentials stored"
          }</span>
          <div>
            ${
              credentialStored(integrationId)
                ? `<button class="text-button" type="button" data-remove-credentials="${escapeHtml(integrationId)}" data-pending-label="Removing…" ${
                    pending ? "disabled" : ""
                  }>Remove</button>
                   <button class="ghost-button small" type="button" data-refresh-integration="${escapeHtml(
                     integrationId
                   )}" data-pending-label="Refreshing…" ${pending ? "disabled" : ""}>Refresh</button>`
                : ""
            }
            <button class="primary-button small" type="submit" data-pending-label="Validating…" ${pending ? "disabled" : ""}>Save and validate</button>
          </div>
        </div>
      </form>
    `;
  }).join("");
}

function renderPlannedConnections() {
  const settings = ui.appState.credentialSettings.filter((setting) => !LIVE_CONNECTORS.includes(setting.id));
  return `
    <section class="section-block" aria-labelledby="plannedConnectionsTitle">
      <div class="section-heading">
        <div>
          <h2 id="plannedConnectionsTitle">Planned connectors</h2>
          <p>These integrations remain unavailable until official provider flows are implemented and approved.</p>
        </div>
        ${renderStatusBadge("planned", "Planned")}
      </div>
      <div class="planned-list">
        ${settings
          .map((setting) => {
            const integration = ui.appState.integrations.find((item) => item.id === setting.id);
            return `
              <div class="planned-row">
                <div><strong>${escapeHtml(setting.name)}</strong><span>${escapeHtml(integration?.detail || setting.note)}</span></div>
                <div>
                  <small>Unavailable</small>
                  ${
                    credentialStored(setting.id)
                      ? `<button class="text-button" type="button" data-remove-credentials="${escapeHtml(
                          setting.id
                        )}" data-pending-label="Removing…">Remove legacy credentials</button>`
                      : ""
                  }
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderLocalDataControls() {
  const hasImportedData =
    ui.appState.businesses.length ||
    ui.appState.conversations.length ||
    ui.appState.approvals.length ||
    asArray(ui.appState.clipperJobs).length ||
    asArray(ui.appState.postQueue).length;
  return `
    <details class="disclosure danger-zone">
      <summary>
        <span>
          <strong>Local data and deletion</strong>
          <small>Reset imported snapshots or permanently remove everything</small>
        </span>
        <span class="disclosure-icon" aria-hidden="true">+</span>
      </summary>
      <div class="disclosure-content local-data-content">
        <div>
          <strong>Reset dashboard data</strong>
          <p>Remove imported snapshots and local plans while retaining encrypted provider credentials.</p>
          <button class="ghost-button" type="button" data-reset-dashboard data-pending-label="Resetting…" ${hasImportedData ? "" : "disabled"}>
            Reset dashboard data
          </button>
        </div>
        <div>
          <strong>Delete all ProduDash data</strong>
          <p>Permanently remove dashboard data, local plans, and every encrypted credential from this computer.</p>
          <button class="danger-button" type="button" data-delete-all data-pending-label="Deleting…">Delete all data and credentials</button>
        </div>
      </div>
    </details>
  `;
}
