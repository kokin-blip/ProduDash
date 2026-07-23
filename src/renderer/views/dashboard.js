import { escapeHtml, formatDate, formatUsd, heightClass, levelClass, statusLabel } from "../format.js";
import { asArray, getApprovals, getBusiness, getConversations, integrationReady, ui } from "../state.js";
import { renderIntegrationCards } from "./shared.js";

function metricValue(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "Unavailable";
  return Number.isFinite(Number(value)) ? `${Number(value).toLocaleString()}${suffix}` : "Unavailable";
}

export function renderDashboard() {
  const business = getBusiness();
  if (!business) return "";
  const metrics = business.metrics || {};
  const trends = asArray(business.financeTrend);
  const orders = asArray(business.orders);
  const signals = asArray(business.signals);
  const conversations = getConversations();
  const pendingApprovals = getApprovals().filter((approval) => approval.status === "pending");
  const maxRevenue = Math.max(0, ...trends.map((item) => Number(item.revenue) || 0));

  return `
    <section class="cockpit-bar" aria-label="Business cockpit">
      <div>
        <p class="eyebrow">${escapeHtml(business.category || "Connected business")}</p>
        <h2>${escapeHtml(business.name || "Unnamed business")}</h2>
      </div>
      <div class="quick-stats">
        <div class="quick-stat"><span>Connection</span><strong>${escapeHtml(statusLabel(business.connectionStatus))}</strong></div>
        <div class="quick-stat"><span>Orders</span><strong>${orders.length}</strong></div>
        <div class="quick-stat"><span>Approvals</span><strong>${pendingApprovals.length}</strong></div>
      </div>
    </section>
    <section class="hero-grid">
      <article class="panel metrics-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Verified Shopify snapshot</p><h2>Commerce metrics</h2></div>
          <span class="health-pill">${escapeHtml(business.health || "Unknown")}</span>
        </div>
        <div class="metric-grid">
          <div class="metric-card"><span>Revenue</span><strong>${formatUsd(metrics.revenue, business.currency)}</strong><small>Imported recent orders</small></div>
          <div class="metric-card"><span>Profit</span><strong>${formatUsd(metrics.profit, business.currency)}</strong><small>Requires cost data</small></div>
          <div class="metric-card"><span>Orders</span><strong>${metricValue(metrics.orderCount)}</strong><small>Current local snapshot</small></div>
          <div class="metric-card"><span>Conversion</span><strong>${metricValue(metrics.conversion, "%")}</strong><small>Requires traffic data</small></div>
        </div>
        <div class="trend-block">
          <div class="panel-heading compact"><div><p class="eyebrow">Finance trend</p><h2>Revenue by week</h2></div></div>
          ${
            trends.length
              ? `<div class="trend-chart" aria-label="Weekly revenue trend">
                  ${trends
                    .map(
                      (item) => `
                        <div class="trend-column">
                          <div class="bars"><span class="bar revenue ${heightClass(item.revenue, maxRevenue)}"></span></div>
                          <small>${escapeHtml(item.week || "Unknown")}</small>
                        </div>
                      `
                    )
                    .join("")}
                </div>`
              : `<div class="empty-state">No dated revenue is available yet.</div>`
          }
        </div>
      </article>
      <article class="panel assistant-panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">AI clerk</p><h2>Approval-only assist</h2></div>
          <span class="mini-badge">${integrationReady("gemini") ? "Gemini connected" : "Gemini required"}</span>
        </div>
        ${
          conversations.length
            ? `<p>${conversations.length} imported conversation${conversations.length === 1 ? "" : "s"} available for drafting.</p>`
            : `<div class="empty-state">No official social inbox connector is active. ProduDash does not fabricate customer conversations.</div>`
        }
        <div class="notification-list">${renderApprovals(pendingApprovals)}</div>
      </article>
    </section>
    <section class="operations-grid">
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Signals</p><h2>Verified attention items</h2></div></div>
        <div class="signal-list">${renderSignals(signals)}</div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Orders</p><h2>Recent Shopify orders</h2></div></div>
        <div class="order-list">${renderOrders(orders.slice(0, 8), business.currency)}</div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Audit</p><h2>Recent local actions</h2></div></div>
        <div class="audit-list">
          ${asArray(ui.appState.auditLog)
            .slice(0, 8)
            .map(
              (entry) => `
                <div class="audit-item">
                  <span>${escapeHtml(statusLabel(entry.type))} · ${escapeHtml(formatDate(entry.at))}</span>
                  <p>${escapeHtml(entry.detail)}</p>
                </div>
              `
            )
            .join("")}
        </div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Integrations</p><h2>Connection health</h2></div></div>
        <div class="integration-grid">${renderIntegrationCards()}</div>
      </article>
    </section>
  `;
}

export function renderOrdersView() {
  const business = getBusiness();
  const orders = asArray(business?.orders);
  return `
    <section class="single-view">
      <article class="panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">Orders</p><h2>${escapeHtml(business?.name || "Connected business")} commerce snapshot</h2></div>
          <span class="mini-badge">${orders.length} orders</span>
        </div>
        <div class="order-list">${renderOrders(orders, business?.currency)}</div>
      </article>
    </section>
  `;
}

export function renderSignalsView() {
  const business = getBusiness();
  return `
    <section class="detail-grid">
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Signals</p><h2>Verified Shopify attention items</h2></div></div>
        <div class="signal-list">${renderSignals(asArray(business?.signals))}</div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Audit</p><h2>Recent local actions</h2></div></div>
        <div class="audit-list">
          ${asArray(ui.appState.auditLog)
            .slice(0, 20)
            .map(
              (entry) => `
                <div class="audit-item">
                  <span>${escapeHtml(statusLabel(entry.type))} · ${escapeHtml(formatDate(entry.at))}</span>
                  <p>${escapeHtml(entry.detail)}</p>
                </div>
              `
            )
            .join("")}
        </div>
      </article>
    </section>
  `;
}

export function renderApprovals(approvals) {
  if (!approvals.length) return `<div class="empty-state">No pending approvals.</div>`;
  return approvals
    .map(
      (approval) => `
        <div class="approval-item">
          <span>${escapeHtml(statusLabel(approval.type))}</span>
          <strong>${escapeHtml(approval.nextAction || "Review draft")}</strong>
          <p>${escapeHtml(approval.draft)}</p>
          <div class="approval-actions">
            <button class="text-button" type="button" data-reject-approval="${escapeHtml(approval.id)}">Reject</button>
            <button class="primary-button small" type="button" data-approve-approval="${escapeHtml(approval.id)}">Approve draft</button>
          </div>
        </div>
      `
    )
    .join("");
}

export function renderOrders(orders, currency = "USD") {
  if (!orders.length) return `<div class="empty-state">No orders were returned by Shopify.</div>`;
  return orders
    .map(
      (order) => `
        <div class="order-item">
          <div>
            <strong>${escapeHtml(order.id)} · ${escapeHtml(order.customer || "Customer")}</strong>
            <span>${escapeHtml(statusLabel(order.paymentStatus))} · ${escapeHtml(statusLabel(order.fulfillmentStatus))}</span>
          </div>
          <div><strong>${formatUsd(order.value, order.currency || currency)}</strong><small>${escapeHtml(order.risk || "Not assessed")}</small></div>
        </div>
      `
    )
    .join("");
}

function renderSignals(signals) {
  if (!signals.length) return `<div class="empty-state">No verified issues in the current snapshot.</div>`;
  return signals
    .map(
      (signal) => `
        <div class="signal-item ${levelClass(signal.level)}">
          <span>${escapeHtml(signal.level || "Medium")}</span>
          <div><strong>${escapeHtml(signal.title)}</strong><p>${escapeHtml(signal.detail)}</p></div>
        </div>
      `
    )
    .join("");
}
