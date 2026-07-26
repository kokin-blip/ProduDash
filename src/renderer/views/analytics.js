import { escapeHtml, formatDate, formatUsd, statusLabel } from "../format.js";
import { asArray, ui } from "../state.js";
import { renderStatusBadge } from "./shared.js";

export function renderAnalytics() {
  const report = ui.analyticsReport?.businessId === ui.selectedBusinessId ? ui.analyticsReport : null;
  return `
    <section class="analytics-view">
      ${report ? renderCommerceReport(report) : renderAnalyticsEmpty()}
      ${renderPlannedSources()}
    </section>
  `;
}

function renderAnalyticsEmpty() {
  const business = ui.appState.businesses.find((item) => item.id === ui.selectedBusinessId);
  return `
    <div class="unavailable-state">
      <span class="unavailable-icon" aria-hidden="true">↗</span>
      <div>
        <h2>${business ? "Load the verified commerce snapshot" : "Connect an official reporting source"}</h2>
        <p>${
          business
            ? "ProduDash can summarize supported metrics from this business’s latest local Shopify snapshot."
            : "Connect and synchronize Shopify to view supported commerce metrics. Social analytics still require future official OAuth connectors."
        }</p>
      </div>
      ${
        business
          ? `<button class="primary-button" type="button" data-refresh-analytics data-pending-label="Loading…">Load report</button>`
          : renderStatusBadge("planned", "Source required")
      }
    </div>
  `;
}

function renderCommerceReport(report) {
  const source = report.source || {};
  return `
    <section class="section-block analytics-report">
      <div class="section-heading">
        <div>
          <h2>${escapeHtml(report.businessName || "Shopify commerce snapshot")}</h2>
          <p>Evidence-backed commerce metrics from the latest local Shopify import.</p>
        </div>
        <div class="analytics-actions">
          <form data-analytics-range-form>
            <label class="analytics-range">
              <span class="sr-only">Comparison window</span>
              <select name="rangeDays" aria-label="Comparison window">
                ${[7, 30, 60]
                  .map(
                    (days) =>
                      `<option value="${days}" ${Number(report.comparison?.rangeDays || ui.analyticsRangeDays) === days ? "selected" : ""}>${days} days</option>`
                  )
                  .join("")}
              </select>
            </label>
            <button class="ghost-button" type="submit" data-pending-label="Comparing…">Compare</button>
          </form>
          <button class="ghost-button" type="button" data-refresh-analytics data-pending-label="Refreshing…">Refresh report</button>
          <button class="primary-button" type="button" data-export-analytics="${escapeHtml(
            report.businessId
          )}" data-pending-label="Exporting…">Export CSV…</button>
        </div>
      </div>
      <div class="analytics-source-row">
        <div>
          <strong>${escapeHtml(source.name || "Shopify Admin API")}</strong>
          <span>${escapeHtml(source.syncedAt ? `Synchronized ${formatDate(source.syncedAt)}` : "Sync time unavailable")}</span>
        </div>
        <div>
          ${renderStatusBadge(source.status || "unknown")}
          ${renderStatusBadge(source.freshness?.status || "unknown", source.freshness?.label || "Freshness unknown")}
        </div>
      </div>
      <div class="analytics-metric-grid" aria-label="Supported Shopify metrics">
        ${asArray(report.metrics)
          .map(
            (metric) => `
              <article class="analytics-metric">
                <span>${escapeHtml(metric.label)}</span>
                <strong>${escapeHtml(metricValue(metric, report.currency))}</strong>
                <small>${escapeHtml(metric.definition)}</small>
              </article>
            `
          )
          .join("")}
      </div>
      ${renderTrend(report)}
      ${renderComparison(report)}
      <div class="availability-note">
        <strong>Unavailable metrics stay unavailable</strong>
        <span>${asArray(report.unavailableMetrics)
          .map((metric) => `${escapeHtml(metric.label)} — ${escapeHtml(metric.reason)}`)
          .join(" · ")}</span>
      </div>
      <details class="disclosure analytics-definitions">
        <summary><span>Definitions and snapshot limits</span><span aria-hidden="true">+</span></summary>
        <div class="disclosure-content">
          <p>${escapeHtml(source.windowNote || "This report uses only the latest imported Shopify snapshot.")}</p>
          <p>Freshness describes when ProduDash last synchronized the source. It is not a guarantee that every upstream Shopify record changed at that time.</p>
          <p>No customer names, addresses, emails, credentials, source paths, or provider payloads are included in the CSV export.</p>
        </div>
      </details>
    </section>
  `;
}

function renderComparison(report) {
  const comparison = report.comparison;
  if (!comparison) return "";
  const currentPeriod =
    comparison.periods?.current?.start && comparison.periods?.current?.end
      ? `${formatDate(comparison.periods.current.start)} to ${formatDate(comparison.periods.current.end)}`
      : "Latest bounded window";
  const datedOrderCount = Number.isInteger(comparison.datedOrderCount) ? comparison.datedOrderCount : 0;
  const undatedOrderCount = Number.isInteger(comparison.undatedOrderCount) ? comparison.undatedOrderCount : 0;
  return `
    <section class="analytics-comparison">
      <div class="section-heading">
        <div>
          <h3>${escapeHtml(`${comparison.rangeDays}-day snapshot comparison`)}</h3>
          <p>${escapeHtml(`${currentPeriod}, compared with the immediately preceding equal window.`)}</p>
        </div>
      </div>
      <div class="inline-message warning">
        <strong>Bounded comparison</strong>
        <span>${escapeHtml(
          `${comparison.limitation} Dated records used: ${datedOrderCount}; records without usable dates: ${undatedOrderCount}.`
        )}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Metric</th><th scope="col">Latest</th><th scope="col">Preceding</th><th scope="col">Change</th></tr>
          </thead>
          <tbody>
            ${asArray(comparison.metrics)
              .map(
                (metric) => `
                  <tr>
                    <th scope="row">${escapeHtml(metric.label)}</th>
                    <td>${escapeHtml(comparisonValue(metric.current, metric.format, report.currency))}</td>
                    <td>${escapeHtml(comparisonValue(metric.previous, metric.format, report.currency))}</td>
                    <td>${escapeHtml(comparisonChange(metric))}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="analytics-observations">
        <strong>What the imported snapshot shows</strong>
        <ul>
          ${asArray(comparison.observations)
            .map((observation) => `<li>${escapeHtml(observation)}</li>`)
            .join("")}
        </ul>
        <small>These are deterministic comparisons, not causal explanations or forecasts.</small>
      </div>
    </section>
  `;
}

function renderTrend(report) {
  const trend = asArray(report.trend);
  if (!trend.length) {
    return `<div class="quiet-state compact"><p>No dated revenue trend was available in the latest snapshot.</p></div>`;
  }
  return `
    <div class="analytics-trend">
      <div class="section-heading"><div><h3>Imported revenue trend</h3><p>Weekly totals from the bounded recent-order snapshot.</p></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Period</th><th scope="col">Revenue</th></tr></thead>
          <tbody>
            ${trend
              .map(
                (point) => `<tr><td>${escapeHtml(point.period)}</td><td>${escapeHtml(formatUsd(point.revenue, report.currency))}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderPlannedSources() {
  return `
    <details class="disclosure">
      <summary><span>Planned social reporting sources</span><span aria-hidden="true">+</span></summary>
      <div class="disclosure-content">
        <p>These definitions are planning references only. ProduDash displays no social values until an official connector verifies them.</p>
        <div class="planned-list">
          ${ui.appState.analyticsSources
            .map(
              (source) => `
                <div class="planned-row analytics-row">
                  <div>
                    <strong>${escapeHtml(source.name)}</strong>
                    <span>${asArray(source.metrics)
                      .map((metric) => escapeHtml(metric))
                      .join(" · ")}</span>
                  </div>
                  <div>${renderStatusBadge(source.status || "planned")}<small>${escapeHtml(
                    statusLabel(source.lastSync || "Never")
                  )}</small></div>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    </details>
  `;
}

function metricValue(metric, currency) {
  if (metric.value === null || metric.value === undefined) return "Unavailable";
  if (metric.format === "currency") return formatUsd(metric.value, currency);
  if (metric.format === "percent") return `${Number(metric.value).toLocaleString()}%`;
  return Number(metric.value).toLocaleString();
}

function comparisonValue(value, format, currency) {
  if (value === null || value === undefined) return "Unavailable";
  if (format === "currency") return formatUsd(value, currency);
  if (format === "percent") return `${Number(value).toLocaleString()}%`;
  return Number(value).toLocaleString();
}

function comparisonChange(metric) {
  if (metric.delta === null || metric.delta === undefined) return "No baseline";
  if (metric.deltaPercent === null && metric.previous === 0) return "No baseline";
  if (metric.delta === 0) return "No change";
  if (metric.deltaPercent === null || metric.deltaPercent === undefined) return metric.delta > 0 ? "Higher" : "Lower";
  return `${metric.deltaPercent > 0 ? "+" : ""}${metric.deltaPercent.toLocaleString()}%`;
}
