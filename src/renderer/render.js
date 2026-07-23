import { escapeHtml, statusLabel } from "./format.js";
import { getBusiness, integrationReady, ui } from "./state.js";
import { renderAnalytics } from "./views/analytics.js";
import { renderDashboard, renderOrdersView, renderSignalsView } from "./views/dashboard.js";
import { renderInbox } from "./views/inbox.js";
import { renderIntegrations } from "./views/integrations.js";
import { renderConnectionFirst, renderStatusMessages } from "./views/shared.js";
import { renderStudio } from "./views/studio.js";

export function renderFatalError(error) {
  document.querySelector("#viewRoot").innerHTML = `
    <article class="panel empty-state">
      <p class="eyebrow">Startup blocked</p>
      <h2>${escapeHtml(error?.message || "ProduDash could not start.")}</h2>
      <p>Run the desktop app with <strong>npm run app</strong>. Browser preview cannot access secure local storage.</p>
    </article>
  `;
}

export function renderApp() {
  renderNav();
  renderBusinesses();
  renderTopActions();
  renderActiveView();
}

function renderNav() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.section === ui.activeSection);
  });
  document.querySelector(".sidebar-footer strong").textContent = integrationReady("gemini") ? "Gemini connected" : "Connections required";
  document.querySelector(".sidebar-footer span:last-child").textContent = "Official APIs only";
}

function renderBusinesses() {
  const root = document.querySelector("#businessStrip");
  root.innerHTML = ui.appState.businesses.length
    ? ui.appState.businesses
        .map(
          (business) => `
            <button class="business-card ${business.id === ui.selectedBusinessId ? "active" : ""}" type="button" data-business="${escapeHtml(
              business.id
            )}">
              <span>${escapeHtml(business.type || "Connected business")}</span>
              <strong>${escapeHtml(business.name || "Unnamed business")}</strong>
              <small>${escapeHtml(statusLabel(business.connectionStatus || business.aiMode))}</small>
            </button>
          `
        )
        .join("")
    : `
      <button class="business-card active" type="button" data-section="integrations">
        <span>No businesses connected</span>
        <strong>Connect Shopify first</strong>
        <small>Official APIs only. No demo data.</small>
      </button>
    `;
}

function renderTopActions() {
  const syncButton = document.querySelector("#syncButton");
  const hasRefreshable = ui.appState.credentialSettings.some(
    (setting) => ["shopify", "gemini"].includes(setting.id) && setting.status === "stored"
  );
  syncButton.textContent = ui.pending.has("refresh-connections") ? "Refreshing…" : "Refresh connections";
  syncButton.disabled = !hasRefreshable || ui.pending.has("refresh-connections");
  syncButton.title = hasRefreshable ? "" : "Store Shopify or Gemini credentials first.";
  document.querySelector("#trainButton").textContent = "Connect apps";
}

function renderActiveView() {
  const root = document.querySelector("#viewRoot");
  const standalone = ["integrations", "studio", "analytics"];
  let markup;
  if (!getBusiness() && !standalone.includes(ui.activeSection)) {
    markup = renderConnectionFirst();
  } else {
    const views = {
      overview: renderDashboard,
      inbox: renderInbox,
      orders: renderOrdersView,
      signals: renderSignalsView,
      studio: renderStudio,
      analytics: renderAnalytics,
      integrations: renderIntegrations
    };
    markup = (views[ui.activeSection] || renderDashboard)();
  }
  root.innerHTML = `<div class="view-transition">${renderStatusMessages()}${markup}</div>`;
}
