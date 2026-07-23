import { escapeHtml, formatDate, formatUsd, heightClass, levelClass, statusLabel } from "../format.js";
import { asArray, getApprovals, getBusiness, getConversations, ui } from "../state.js";
import { renderIntegrationCards, renderStatusBadge } from "./shared.js";

function metricValue(value) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "Unavailable";
}

export function renderDashboard() {
  const business = getBusiness();
  if (!business) return "";
  const metrics = business.metrics || {};
  const orders = asArray(business.orders);
  const signals = asArray(business.signals);
  const conversations = getConversations();
  const pendingApprovals = getApprovals().filter((approval) => approval.status === "pending");
  const trends = validTrends(business.financeTrend);
  const maxRevenue = Math.max(0, ...trends.map((item) => Number(item.revenue)));
  const averageOrderValue = orders.length ? orders.reduce((total, order) => total + (Number(order.value) || 0), 0) / orders.length : null;

  return `
    <section class="dashboard-view">
      ${renderAttention(signals, pendingApprovals)}
      <section class="metric-grid" aria-label="Supported commerce metrics">
        ${renderMetric("Revenue", formatUsd(metrics.revenue, business.currency), "Imported recent orders")}
        ${renderMetric("Orders", metricValue(metrics.orderCount ?? orders.length), "Current local snapshot")}
        ${
          averageOrderValue === null
            ? ""
            : renderMetric("Average order value", formatUsd(averageOrderValue, business.currency), "Derived from imported orders")
        }
        ${renderMetric("Store health", statusLabel(business.health || business.connectionStatus), "Latest verified connection")}
      </section>
      <p class="availability-note">Profit and conversion are unavailable until real cost and traffic data are connected.</p>

      <div class="dashboard-grid">
        <div class="dashboard-main">
          <article class="panel chart-panel">
            <div class="section-heading">
              <div><h2>Revenue trend</h2><p>Weekly totals supported by the current Shopify snapshot.</p></div>
              ${renderStatusBadge(business.connectionStatus || "unknown")}
            </div>
            ${renderRevenueChart(trends, maxRevenue, business.currency)}
          </article>
          <article class="panel">
            <div class="section-heading">
              <div><h2>Recent orders</h2><p>The latest orders returned by Shopify.</p></div>
              <button class="text-button" type="button" data-section="orders">View all</button>
            </div>
            ${renderOrders(orders.slice(0, 6), business.currency)}
          </article>
        </div>
        <aside class="dashboard-rail" aria-label="Secondary dashboard information">
          <section class="section-block">
            <div class="section-heading">
              <div><h2>Recent conversations</h2><p>Official social connectors only.</p></div>
              <button class="text-button" type="button" data-section="inbox">Open inbox</button>
            </div>
            ${renderConversationRows(conversations.slice(0, 4))}
          </section>
          <section class="section-block">
            <div class="section-heading"><div><h2>Connection health</h2><p>Provider validation and sync state.</p></div></div>
            <div class="integration-list">${renderIntegrationCards()}</div>
          </section>
          <section class="section-block">
            <div class="section-heading"><div><h2>Recent activity</h2><p>Local, auditable actions.</p></div></div>
            ${renderAuditRows(asArray(ui.appState.auditLog).slice(0, 5))}
          </section>
        </aside>
      </div>
    </section>
  `;
}

function renderAttention(signals, approvals) {
  const signalRows = signals.slice(0, 3).map((signal) => ({ type: "signal", item: signal }));
  const approvalRows = approvals.slice(0, 3).map((approval) => ({ type: "approval", item: approval }));
  const rows = [...approvalRows, ...signalRows];
  return `
    <section class="attention-section" aria-labelledby="attentionTitle">
      <div class="section-heading">
        <div><h2 id="attentionTitle">Needs attention</h2><p>Verified issues and decisions waiting for you.</p></div>
        ${renderStatusBadge(rows.length ? "warning" : "connected", rows.length ? `${rows.length} open` : "All clear")}
      </div>
      ${
        rows.length
          ? `<div class="attention-list">${rows
              .map(({ type, item }) =>
                type === "approval"
                  ? `<button class="attention-row" type="button" data-section="inbox">
                      <span class="attention-icon warning" aria-hidden="true">!</span>
                      <span><strong>${escapeHtml(item.nextAction || "Review AI draft")}</strong><small>${escapeHtml(
                        item.draft || "A draft is waiting for approval."
                      )}</small></span>
                      <span>Review</span>
                    </button>`
                  : `<button class="attention-row" type="button" data-section="signals">
                      <span class="attention-icon ${levelClass(item.level)}" aria-hidden="true">!</span>
                      <span><strong>${escapeHtml(item.title || "Verified signal")}</strong><small>${escapeHtml(item.detail || "")}</small></span>
                      <span>Review</span>
                    </button>`
              )
              .join("")}</div>`
          : `<div class="quiet-state"><span aria-hidden="true">✓</span><p>No verified issues or pending approvals need attention.</p></div>`
      }
    </section>
  `;
}

function renderMetric(label, value, note) {
  return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function validTrends(value) {
  return asArray(value).filter(
    (item) => item && typeof item.week === "string" && item.week.trim() && Number.isFinite(Number(item.revenue))
  );
}

function renderRevenueChart(trends, maxRevenue, currency) {
  if (!trends.length) return `<div class="quiet-state compact"><p>No dated revenue is available yet.</p></div>`;
  return `
    <div class="trend-chart" role="img" aria-label="Weekly revenue trend">
      ${trends
        .map(
          (item) => `
            <div class="trend-column">
              <strong>${formatUsd(item.revenue, currency)}</strong>
              <div class="bar-track"><span class="bar revenue ${heightClass(item.revenue, maxRevenue)}"></span></div>
              <small>${escapeHtml(item.week)}</small>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderConversationRows(conversations) {
  if (!conversations.length) {
    return `<div class="quiet-state compact"><p>No official social inbox connector is active.</p></div>`;
  }
  return `<div class="compact-list">${conversations
    .map(
      (conversation) => `
        <button class="compact-row" type="button" data-section="inbox" data-conversation="${escapeHtml(conversation.id)}">
          <span><strong>${escapeHtml(conversation.customer || "Customer")}</strong><small>${escapeHtml(
            conversation.intent || "Unclassified"
          )}</small></span>
          ${renderStatusBadge(conversation.status || "unknown")}
        </button>
      `
    )
    .join("")}</div>`;
}

function renderAuditRows(entries) {
  if (!entries.length) return `<div class="quiet-state compact"><p>No local activity has been recorded.</p></div>`;
  return `<div class="compact-list">${entries
    .map(
      (entry) => `
        <div class="compact-row static">
          <span><strong>${escapeHtml(entry.detail)}</strong><small>${escapeHtml(formatDate(entry.at))}</small></span>
        </div>
      `
    )
    .join("")}</div>`;
}

export function renderOrdersView() {
  const business = getBusiness();
  const orders = asArray(business?.orders);
  return `
    <section class="single-view">
      <article class="panel">
        <div class="section-heading">
          <div><h2>Recent Shopify orders</h2><p>${escapeHtml(business?.name || "Connected business")} commerce snapshot</p></div>
          ${renderStatusBadge("neutral", `${orders.length} orders`)}
        </div>
        ${renderOrders(orders, business?.currency)}
      </article>
    </section>
  `;
}

export function renderSignalsView() {
  const business = getBusiness();
  const signals = asArray(business?.signals);
  const audit = asArray(ui.appState.auditLog).slice(0, 20);
  return `
    <section class="split-view">
      <article class="panel">
        <div class="section-heading"><div><h2>Verified attention items</h2><p>Issues supported by the current Shopify snapshot.</p></div></div>
        <div class="signal-list">${renderSignals(signals)}</div>
      </article>
      <article class="panel">
        <div class="section-heading"><div><h2>Recent local actions</h2><p>Audit history for this workspace.</p></div></div>
        ${renderAuditRows(audit)}
      </article>
    </section>
  `;
}

export function renderApprovals(approvals) {
  if (!approvals.length) return `<div class="quiet-state compact"><p>No pending approvals.</p></div>`;
  return approvals
    .map(
      (approval) => `
        <div class="approval-item">
          <div class="approval-heading">
            <div><strong>${escapeHtml(approval.nextAction || "Review draft")}</strong><span>${escapeHtml(
              statusLabel(approval.type)
            )}</span></div>
            ${renderStatusBadge(approval.status || "pending")}
          </div>
          <p>${escapeHtml(approval.draft)}</p>
          ${
            approval.status === "pending"
              ? `<div class="approval-actions">
                  <button class="text-button" type="button" data-reject-approval="${escapeHtml(
                    approval.id
                  )}" data-pending-label="Rejecting…">Reject</button>
                  <button class="primary-button small" type="button" data-approve-approval="${escapeHtml(
                    approval.id
                  )}" data-pending-label="Approving…">Approve draft</button>
                </div>`
              : ""
          }
        </div>
      `
    )
    .join("");
}

export function renderOrders(orders, currency = "USD") {
  if (!orders.length) return `<div class="quiet-state compact"><p>No orders were returned by Shopify.</p></div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Payment</th><th scope="col">Fulfillment</th><th scope="col">Total</th></tr></thead>
        <tbody>
          ${orders
            .map(
              (order) => `
                <tr>
                  <th scope="row">${escapeHtml(order.id)}</th>
                  <td>${escapeHtml(order.customer || "Customer")}</td>
                  <td>${renderStatusBadge(order.paymentStatus || "unknown")}</td>
                  <td>${escapeHtml(statusLabel(order.fulfillmentStatus))}</td>
                  <td>${formatUsd(order.value, order.currency || currency)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSignals(signals) {
  if (!signals.length) return `<div class="quiet-state compact"><p>No verified issues in the current snapshot.</p></div>`;
  return signals
    .map(
      (signal) => `
        <div class="signal-item">
          <span class="attention-icon ${levelClass(signal.level)}" aria-hidden="true">!</span>
          <div><strong>${escapeHtml(signal.title)}</strong><p>${escapeHtml(signal.detail)}</p></div>
          ${renderStatusBadge(signal.level || "warning")}
        </div>
      `
    )
    .join("");
}
