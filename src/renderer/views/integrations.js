import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { asArray, credentialStored, isPending, providerCredentialsStored, ui } from "../state.js";
import { renderCompliancePanel, renderStatusBadge } from "./shared.js";

const WORKLOADS = [
  { id: "advisor", name: "Advisor", required: ["text_generation"] },
  { id: "inboxDrafting", name: "Inbox Drafting", required: ["text_generation", "structured_output"] },
  { id: "clipAnalysis", name: "Clip Analysis", required: ["text_generation", "structured_output"], inherits: true },
  { id: "transcription", name: "Transcription", required: ["audio_transcription"], unassigned: true }
];

export function renderIntegrations() {
  return `
    <section class="integrations-view">
      <div class="section-intro">
        <div>
          <h2>Live connections</h2>
          <p>Credentials count as connected only after the store or AI provider validates them.</p>
        </div>
        <span class="security-note">Protected by OS encryption</span>
      </div>
      <div class="connection-stack">${renderShopifyConnection()}</div>
      ${renderAiProviders()}
      ${renderLocalVoiceOptions()}
      ${renderWorkloads()}
      ${renderPlannedConnections()}
      ${renderLocalDataControls()}
      ${renderCompliancePanel()}
    </section>
  `;
}

function renderLocalVoiceOptions() {
  const report = ui.localVoiceReport;
  const pending = isPending("local-voice-scan");
  return `
    <section class="section-block" aria-labelledby="localVoiceTitle">
      <div class="section-heading">
        <div>
          <h2 id="localVoiceTitle">Local voice engines</h2>
          <p>Compare six local speech, likeness, and voice-conversion engines against this computer without uploading device inventory.</p>
        </div>
        <button class="ghost-button small" type="button" data-local-voice-scan data-pending-label="Scanning…" ${
          pending ? "disabled" : ""
        }>${report ? "Scan again" : "Scan this computer"}</button>
      </div>
      ${
        report
          ? `<div class="panel connection-section">
              <div class="connection-heading">
                <div>
                  <div class="connection-title"><h3>Private compatibility report</h3>${renderStatusBadge(
                    report.bestEngineId ? "connected" : "warning",
                    report.bestEngineId ? "Recommendation ready" : "No strong recommendation"
                  )}</div>
                  <p>${escapeHtml(report.privacy)}</p>
                </div>
                <small>${escapeHtml(
                  `${report.device.platform} · ${report.device.architecture} · ${report.device.cpuCores} cores · ${report.device.memoryGb} GB · ${report.device.accelerator}`
                )}</small>
              </div>
              <div class="divided-list local-engine-list">
                ${asArray(report.engines)
                  .map(
                    (engine) => `<div class="compact-row static-row">
                      <span><strong>${escapeHtml(engine.name)}${
                        report.bestEngineId === engine.id ? " · Best match" : ""
                      }</strong><small>${escapeHtml(engine.description)} ${escapeHtml(engine.reason)}</small></span>
                      ${renderStatusBadge(
                        engine.status === "installed"
                          ? "connected"
                          : engine.status === "recommended"
                            ? "approved"
                            : engine.status === "compatible"
                              ? "planned"
                              : "warning",
                        engine.status.replaceAll("_", " ")
                      )}
                    </div>`
                  )
                  .join("")}
              </div>
              <div class="inline-message neutral"><strong>Setup remains explicit</strong><span>ProduDash does not download executables or model weights. License terms, disk use, and model provenance must be reviewed before configuring a local runtime.</span></div>
            </div>`
          : `<div class="empty-row"><strong>No scan has run</strong><span>The scan reports coarse hardware compatibility and installed commands only. It does not read personal files.</span></div>`
      }
    </section>
  `;
}

function renderShopifyConnection() {
  const integrationId = "shopify";
  const setting = ui.appState.credentialSettings.find((item) => item.id === integrationId);
  const integration = ui.appState.integrations.find((item) => item.id === integrationId);
  if (!setting) return "";
  const pending = isPending(`credentials-${integrationId}`) || isPending(`refresh-${integrationId}`);
  return `
    <form class="panel connection-section" data-credentials-form="${integrationId}" aria-busy="${pending}">
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
        ${setting.fields.map((field) => renderCredentialField(field, setting.configuredFields, setting.publicValues)).join("")}
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
              ? `<button class="text-button" type="button" data-remove-credentials="${integrationId}" data-pending-label="Removing…" ${
                  pending ? "disabled" : ""
                }>Remove</button>
                 <button class="ghost-button small" type="button" data-refresh-integration="${integrationId}" data-pending-label="Refreshing…" ${
                   pending ? "disabled" : ""
                 }>Refresh</button>`
              : ""
          }
          <button class="primary-button small" type="submit" data-pending-label="Validating…" ${
            pending ? "disabled" : ""
          }>Save and validate</button>
        </div>
      </div>
    </form>
  `;
}

function renderAiProviders() {
  return `
    <section class="section-block" aria-labelledby="aiProvidersTitle">
      <div class="section-heading">
        <div>
          <h2 id="aiProvidersTitle">AI providers</h2>
          <p>Provider profiles stay independent. Each profile is validated before a workload can use it.</p>
        </div>
        ${renderStatusBadge("neutral", `${ui.appState.aiProviders.length} profile${ui.appState.aiProviders.length === 1 ? "" : "s"}`)}
      </div>
      <div class="connection-stack">${ui.appState.aiProviders.map(renderAiProvider).join("")}</div>
    </section>
  `;
}

function renderAiProvider(profile) {
  const catalog = ui.providerCatalog.find((item) => item.id === profile.providerType);
  const pending = isPending(`ai-provider-${profile.id}`) || isPending(`test-ai-provider-${profile.id}`);
  const stored = providerCredentialsStored(profile.id);
  const model = profile.models.find((item) => item.id === profile.selectedModelId) || profile.models[0];
  return `
    <form class="panel connection-section" data-ai-provider-form="${escapeHtml(profile.id)}" aria-busy="${pending}">
      <div class="connection-heading">
        <div>
          <div class="connection-title">
            <h3>${escapeHtml(profile.name)}</h3>
            ${renderStatusBadge(profile.status || "disconnected", undefined, `ai-provider-${profile.id}`)}
          </div>
          <p>Structured provider access for assigned ProduDash workloads. No provider is used as a silent fallback.</p>
        </div>
        <small>${escapeHtml(profile.lastValidatedAt ? formatDate(profile.lastValidatedAt) : "Never validated")}</small>
      </div>
      ${
        profile.error
          ? `<div class="inline-message error"><strong>Provider needs attention</strong><span>${escapeHtml(profile.error)}</span></div>`
          : ""
      }
      <div class="provider-model-row">
        <div>
          ${
            profile.models.length > 1
              ? `<label class="credential-field compact-model-picker">
                  <span>Model used for connection testing</span>
                  <select name="selectedModelId">
                    ${profile.models
                      .map(
                        (item) =>
                          `<option value="${escapeHtml(item.id)}" ${item.id === model?.id ? "selected" : ""}>${escapeHtml(
                            item.name
                          )}</option>`
                      )
                      .join("")}
                  </select>
                </label>`
              : `<strong>${escapeHtml(model?.name || profile.selectedModelId || "Configure a model below")}</strong>`
          }
          <span>Verified capabilities</span>
        </div>
        <div class="capability-list">${asArray(model?.capabilities)
          .map((capability) => `<span>${escapeHtml(statusLabel(capability))}</span>`)
          .join("")}</div>
      </div>
      <fieldset class="credential-fields" ${pending ? "disabled" : ""}>
        ${asArray(catalog?.credentialFields)
          .map((field) => renderCredentialField(field, stored ? [field.key] : [], profile.publicValues, profile.id))
          .join("")}
      </fieldset>
      <div class="connection-actions">
        <span>${stored ? "Credentials stored securely" : "No credentials stored"}</span>
        <div>
          ${
            stored
              ? `<button class="text-button" type="button" data-remove-ai-provider="${escapeHtml(
                  profile.id
                )}" data-pending-label="Removing…" ${pending ? "disabled" : ""}>Remove</button>
                 <button class="ghost-button small" type="button" data-test-ai-provider="${escapeHtml(
                   profile.id
                 )}" data-pending-label="Testing…" ${pending ? "disabled" : ""}>Test connection</button>`
              : ""
          }
          <button class="primary-button small" type="submit" data-pending-label="Validating…" ${
            pending ? "disabled" : ""
          }>Save and validate</button>
        </div>
      </div>
    </form>
  `;
}

function renderCredentialField(field, configuredFields = [], publicValues = {}, profileId = "") {
  const configured = configuredFields.includes(field.key);
  if (field.type === "native-file") {
    return `
      <div class="credential-field native-file-field">
        <span>${escapeHtml(field.label)}</span>
        <button class="ghost-button small" type="button" data-local-whisper-file="${escapeHtml(field.key)}" data-profile-id="${escapeHtml(
          profileId
        )}" data-pending-label="Choosing…">${configured ? "Replace file" : "Choose file"}</button>
        <small>${configured ? "Stored as an encrypted local path" : "Not configured · ProduDash never downloads models"}</small>
      </div>
    `;
  }
  const publicValue = field.sensitive ? "" : publicValues?.[field.key] || "";
  return `
    <label class="credential-field">
      <span>${escapeHtml(field.label)}</span>
      <input
        name="${escapeHtml(field.key)}"
        type="${field.sensitive ? "password" : "text"}"
        maxlength="${field.sensitive ? "4096" : "2048"}"
        autocomplete="off"
        spellcheck="false"
        value="${escapeHtml(publicValue)}"
        placeholder="${escapeHtml(configured && field.sensitive ? "Stored securely. Enter a replacement value." : field.placeholder)}"
      />
    </label>
  `;
}

function renderWorkloads() {
  return `
    <section class="section-block" aria-labelledby="workloadTitle">
      <div class="section-heading">
        <div>
          <h2 id="workloadTitle">Workload assignments</h2>
          <p>Assignments are accepted only when the selected model reports every required capability.</p>
        </div>
      </div>
      <div class="workload-list">
        ${WORKLOADS.map(renderWorkload).join("")}
      </div>
    </section>
  `;
}

function renderWorkload(workload) {
  const current = ui.appState.aiWorkloads?.[workload.id] || { mode: "unassigned" };
  const currentValue = current.mode === "provider" ? `${current.profileId}::${current.modelId}` : current.mode || "unassigned";
  const compatibleModels = ui.appState.aiProviders.flatMap((profile) =>
    asArray(profile.models)
      .filter((model) => workload.required.every((capability) => asArray(model.capabilities).includes(capability)))
      .map((model) => ({ profile, model }))
  );
  const pending = isPending(`workload-${workload.id}`);
  return `
    <form class="workload-row" data-workload-form="${escapeHtml(workload.id)}" aria-busy="${pending}">
      <div>
        <strong>${escapeHtml(workload.name)}</strong>
        <span>Requires ${workload.required.map(statusLabel).join(", ")}</span>
      </div>
      <select name="assignment" aria-label="${escapeHtml(workload.name)} provider and model" ${pending ? "disabled" : ""}>
        ${workload.inherits ? `<option value="same_as_advisor" ${currentValue === "same_as_advisor" ? "selected" : ""}>Same as advisor</option>` : ""}
        ${workload.unassigned ? `<option value="unassigned" ${currentValue === "unassigned" ? "selected" : ""}>Unassigned</option>` : ""}
        ${compatibleModels
          .map(
            ({ profile, model }) =>
              `<option value="${escapeHtml(`${profile.id}::${model.id}`)}" ${
                currentValue === `${profile.id}::${model.id}` ? "selected" : ""
              }>${escapeHtml(profile.name)} · ${escapeHtml(model.name)}</option>`
          )
          .join("")}
      </select>
      <button class="ghost-button small" type="submit" data-pending-label="Saving…" ${pending ? "disabled" : ""}>Save</button>
    </form>
  `;
}

function renderPlannedConnections() {
  const settings = ui.appState.credentialSettings.filter((setting) => setting.id !== "shopify");
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
                <div><small>Unavailable</small></div>
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
    asArray(ui.appState.postQueue).length ||
    ui.clipLibrary.total;
  return `
    <details class="disclosure danger-zone">
      <summary>
        <span>
          <strong>Local data and deletion</strong>
          <small>Reset imported snapshots or permanently remove ProduDash metadata</small>
        </span>
        <span class="disclosure-icon" aria-hidden="true">+</span>
      </summary>
      <div class="disclosure-content local-data-content">
        <div>
          <strong>Reset dashboard data</strong>
          <p>Clear imported snapshots, plans, Clip Library index, and thumbnail cache. Provider profiles, assignments, and encrypted credentials remain. Source media is never deleted.</p>
          <button class="ghost-button" type="button" data-reset-dashboard data-pending-label="Resetting…" ${hasImportedData ? "" : "disabled"}>
            Reset dashboard data
          </button>
        </div>
        <div>
          <strong>Delete all ProduDash data</strong>
          <p>Remove local metadata, indexes, thumbnails, bookmarks, and every encrypted credential. User-owned source media remains untouched.</p>
          <button class="danger-button" type="button" data-delete-all data-pending-label="Deleting…">Delete all data and credentials</button>
        </div>
      </div>
    </details>
  `;
}
