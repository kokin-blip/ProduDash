import { escapeHtml, statusLabel } from "./format.js";
import { getBusiness, integrationReady, providerCredentialsStored, ui, workloadReady } from "./state.js";
import { renderAnalytics } from "./views/analytics.js";
import { renderDashboard, renderOrdersView, renderSignalsView } from "./views/dashboard.js";
import { renderInbox } from "./views/inbox.js";
import { renderIntegrations } from "./views/integrations.js";
import { renderConnectionFirst, renderStatusMessages } from "./views/shared.js";
import { renderStudio } from "./views/studio.js";

const VIEW_META = {
  overview: ["Dashboard", "Operations overview", "Monitor verified commerce data and items that need attention."],
  inbox: ["AI Inbox", "Approval-only drafts", "Review imported conversations and prepare replies that always require human approval."],
  orders: ["Orders", "Shopify snapshot", "Review the most recent orders returned by your connected store."],
  signals: ["Signals", "Attention and activity", "Review verified issues and recent local actions."],
  studio: [
    "Content Studio",
    "Local media workspace",
    "Index videos, create human-approved clips locally, and prepare post plans without publishing externally."
  ],
  analytics: ["Analytics", "Official sources required", "Social reporting remains unavailable until approved connectors are implemented."],
  integrations: [
    "Integrations",
    "Connections and local data",
    "Validate Shopify and AI providers, assign workloads, and manage local data."
  ]
};

let activeViewTransition = null;
let viewRenderVersion = 0;

export function renderFatalError(error) {
  document.querySelector("#viewRoot").innerHTML = `
    <article class="panel empty-state">
      <p class="eyebrow">Startup blocked</p>
      <h2>${escapeHtml(error?.message || "ProduDash could not start.")}</h2>
      <p>Run the desktop app with <strong>npm run app</strong>. Browser preview cannot access secure local storage.</p>
    </article>
  `;
}

export function renderApp({ animateView = false } = {}) {
  const renderVersion = ++viewRenderVersion;
  const shouldAnimate = animateView && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (shouldAnimate && typeof document.startViewTransition === "function") {
    if (activeViewTransition) activeViewTransition.skipTransition();
    const transition = document.startViewTransition(() => {
      if (renderVersion === viewRenderVersion) renderAppContents(false);
    });
    activeViewTransition = transition;
    const clearTransition = () => {
      if (activeViewTransition === transition) activeViewTransition = null;
    };
    transition.finished.then(clearTransition, clearTransition);
    return transition;
  }
  renderAppContents(shouldAnimate);
  return null;
}

function renderAppContents(animateFallback) {
  renderNav();
  renderBusinesses();
  renderHeader();
  renderActiveView(animateFallback);
}

function renderNav() {
  document.querySelector(".nav-list").dataset.activeSection = ui.activeSection;
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.section === ui.activeSection;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const footer = document.querySelector(".sidebar-footer");
  const connected = integrationReady("shopify") && workloadReady("inboxDrafting");
  footer.querySelector("strong").textContent = connected ? "Core apps connected" : "Connections required";
  document.querySelector(".sidebar-footer span:last-child").textContent = "Official APIs only";
  footer.querySelector(".status-dot").classList.toggle("connected", connected);
}

function renderBusinesses() {
  const root = document.querySelector("#businessStrip");
  root.hidden = ui.appState.businesses.length < 2;
  root.innerHTML =
    ui.appState.businesses.length > 1
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
      : "";
}

function renderHeader() {
  const business = getBusiness();
  const needsSetup = !business && !["integrations", "studio", "analytics"].includes(ui.activeSection);
  const [eyebrow, title, subtitle] = needsSetup
    ? ["Getting started", "Set up ProduDash", "Connect your store and AI assistant to begin."]
    : VIEW_META[ui.activeSection] || VIEW_META.overview;
  document.querySelector("#pageEyebrow").textContent = eyebrow;
  document.querySelector("#pageTitle").textContent = business && ui.activeSection === "overview" ? business.name || title : title;
  document.querySelector("#pageSubtitle").textContent =
    business && ui.activeSection === "overview"
      ? `${subtitle} Connection status: ${statusLabel(business.connectionStatus || "unknown")}.`
      : subtitle;

  const syncButton = document.querySelector("#syncButton");
  const connectButton = document.querySelector("#trainButton");
  const hasRefreshable =
    ui.appState.credentialSettings.some((setting) => setting.id === "shopify" && setting.status === "stored") ||
    ui.appState.aiProviders.some((profile) => providerCredentialsStored(profile.id));
  syncButton.textContent = ui.pending.has("refresh-connections") ? "Refreshing…" : "Refresh connections";
  syncButton.disabled = !hasRefreshable || ui.pending.has("refresh-connections");
  syncButton.title = hasRefreshable ? "" : "Store Shopify or AI provider credentials first.";
  syncButton.hidden = needsSetup || !["overview", "orders", "signals", "integrations"].includes(ui.activeSection);
  syncButton.className = ui.activeSection === "integrations" ? "primary-button" : "ghost-button";

  connectButton.hidden = ui.activeSection === "integrations";
  connectButton.textContent = needsSetup ? "Connect Shopify" : "Manage connections";
  connectButton.className = needsSetup ? "primary-button" : "ghost-button";
}

function renderActiveView(animateFallback) {
  const root = document.querySelector("#viewRoot");
  const previousStatuses = new Map(
    [...root.querySelectorAll("[data-status-key]")].map((badge) => [badge.dataset.statusKey, badge.dataset.statusValue])
  );
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
  root.innerHTML = `<div class="view-transition${animateFallback ? " is-entering" : ""}">${renderStatusMessages()}${markup}</div>`;
  root.querySelectorAll("[data-status-key]").forEach((badge) => {
    const previousValue = previousStatuses.get(badge.dataset.statusKey);
    if (previousValue !== undefined && previousValue !== badge.dataset.statusValue) badge.classList.add("status-changed");
  });
  const alert = root.querySelector('[role="alert"]');
  if (alert) window.requestAnimationFrame(() => alert.focus());
}
