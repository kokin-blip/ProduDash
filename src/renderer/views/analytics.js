import { escapeHtml, statusLabel } from "../format.js";
import { asArray, ui } from "../state.js";
import { renderStatusBadge } from "./shared.js";

export function renderAnalytics() {
  return `
    <section class="analytics-view">
      <div class="unavailable-state">
        <span class="unavailable-icon" aria-hidden="true">↗</span>
        <div>
          <h2>Connect official reporting sources</h2>
          <p>ProduDash will display social analytics only after approved OAuth access and official reporting APIs are implemented.</p>
        </div>
        ${renderStatusBadge("planned", "Planned")}
      </div>
      <section class="section-block">
        <div class="section-heading">
          <div><h2>Planned data sources</h2><p>Expected metrics are listed for transparency; no values are fabricated.</p></div>
        </div>
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
      </section>
    </section>
  `;
}
