import { escapeHtml, statusLabel } from "../format.js";
import { asArray, ui } from "../state.js";

export function renderAnalytics() {
  return `
    <section class="detail-grid">
      <article class="panel detail-panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">Analytics</p><h2>Planned official data sources</h2></div>
          <span class="mini-badge">No fabricated metrics</span>
        </div>
        <div class="analytics-grid">
          ${ui.appState.analyticsSources
            .map(
              (source) => `
                <div class="analytics-card">
                  <div>
                    <strong>${escapeHtml(source.name)}</strong>
                    <span>${escapeHtml(statusLabel(source.status))} · ${escapeHtml(source.lastSync || "Never")}</span>
                  </div>
                  <div class="metric-chip-list">
                    ${asArray(source.metrics)
                      .map((metric) => `<small>${escapeHtml(metric)}</small>`)
                      .join("")}
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Current limitation</p><h2>Connections required</h2></div></div>
        <p>ProduDash will display social analytics only after approved OAuth access and official reporting APIs are implemented.</p>
      </article>
    </section>
  `;
}
