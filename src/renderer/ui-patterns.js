import { escapeHtml, formatUsd } from "./format.js";

const KIT_ICONS = new Set(["close", "play", "pause", "plus", "clock"]);

export function kitIcon(name) {
  if (!KIT_ICONS.has(name)) return "";
  return `<span class="kit-icon" aria-hidden="true"><img src="./src/assets/kit/${name}.svg" alt="" /></span>`;
}

export function renderToolbar(title, description, actions = "", className = "") {
  return `<header class="section-heading workspace-toolbar ${escapeHtml(className)}">
    <div><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div>
    ${actions ? `<div class="button-row">${actions}</div>` : ""}
  </header>`;
}

export function renderStudioTabs(tabs, selected) {
  return `<div class="studio-tabs" role="tablist" aria-label="Content Studio">${tabs
    .map(
      ([id, label]) => `<button type="button" role="tab" id="studio-tab-${id}" data-studio-tab="${id}"
        aria-controls="studioPanel" aria-selected="${selected === id}" tabindex="${selected === id ? "0" : "-1"}"
        class="${selected === id ? "active" : ""}">${escapeHtml(label)}</button>`
    )
    .join("")}</div>`;
}

// Fields are trusted renderer markup. Labels and native inputs retain their
// existing form contracts; the group supplies Numbers-style property alignment.
export function renderPropertyGroup(title, fields) {
  return `<section class="property-group" aria-label="${escapeHtml(title)}">
    <h4>${escapeHtml(title)}</h4><div class="property-rows">${fields}</div>
  </section>`;
}

function chartCurrency(value, currency) {
  if (value === null) return "Unavailable";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
      notation: Math.abs(value) >= 1e15 ? "scientific" : "compact",
      maximumFractionDigits: 1
    }).format(value);
  } catch {
    return formatUsd(value, currency);
  }
}

// The caller supplies its own series and definition. Sharing presentation never
// merges the Dashboard snapshot with the independently built Analytics report.
export function renderRevenueBars(points, currency = "USD", label = "Weekly revenue trend", { includeTable = true } = {}) {
  if (!points.length) return `<div class="quiet-state compact"><p>No dated revenue is available yet.</p></div>`;
  const values = points.map(({ revenue }) =>
    revenue === null || revenue === undefined || revenue === "" || !Number.isFinite(Number(revenue)) ? null : Number(revenue)
  );
  const magnitude = Math.max(1, ...values.filter((value) => value !== null).map(Math.abs));
  const low = Math.min(0, ...values.map((value) => (value ?? 0) / magnitude));
  const high = Math.max(0, ...values.map((value) => (value ?? 0) / magnitude)) || 1;
  const y = (value) => 180 - ((value - low) / (high - low)) * 152;
  const baseline = y(0);
  const dense = points.length > 8;
  const plotWidth = dense ? points.length * 96 : 720;
  const step = plotWidth / points.length;
  const allZero = values.every((value) => value === null || value === 0);
  const grid = Array.from({ length: allZero ? 1 : 4 }, (_, index) => {
    const value = allZero ? 0 : low + ((high - low) * index) / 3;
    return `<line x1="94" x2="${plotWidth + 102}" y1="${y(value)}" y2="${y(value)}" class="revenue-gridline" />
      <text x="82" y="${y(value) + 4}" text-anchor="end">${escapeHtml(chartCurrency(value * magnitude, currency))}</text>`;
  }).join("");
  const bars = points
    .map((point, index) => {
      const value = values[index];
      const center = 100 + step * (index + 0.5);
      const width = Math.min(44, step * 0.55);
      const top = value === null ? baseline : y(Math.max(0, value / magnitude));
      const height = value === null ? 0 : Math.abs(y(value / magnitude) - baseline);
      return `<g><title>${escapeHtml(point.period)}: ${escapeHtml(formatUsd(value, currency))}</title>
      ${value === null ? "" : `<rect x="${center - width / 2}" y="${top}" width="${width}" height="${height}" rx="3" class="revenue-bar" />`}
      <text x="${center}" y="${value !== null && value < 0 ? baseline - 8 : top - 8}" text-anchor="middle" class="revenue-value">${escapeHtml(chartCurrency(value, currency))}</text>
      <text x="${center}" y="208" text-anchor="middle">${escapeHtml(point.period)}</text></g>`;
    })
    .join("");
  return `<figure class="revenue-chart"><div class="revenue-chart-scroll" ${dense ? `tabindex="0" role="region" aria-label="Scrollable ${escapeHtml(label)}"` : ""}>
    <svg viewBox="0 0 ${plotWidth + 120} 224" width="${plotWidth + 120}" height="224" role="img" aria-label="${escapeHtml(label)}" class="revenue-chart-plot${dense ? " is-dense" : ""}">
      ${grid}<line x1="94" x2="${plotWidth + 102}" y1="${baseline}" y2="${baseline}" class="revenue-baseline" />${bars}
    </svg></div><figcaption>${escapeHtml(label)} · ${escapeHtml(currency)} · imported snapshot</figcaption>
    ${includeTable ? `<table class="sr-only"><caption>${escapeHtml(label)}</caption><thead><tr><th scope="col">Period</th><th scope="col">Revenue</th></tr></thead><tbody>${points.map((point, index) => `<tr><th scope="row">${escapeHtml(point.period)}</th><td>${escapeHtml(formatUsd(values[index], currency))}</td></tr>`).join("")}</tbody></table>` : ""}</figure>`;
}
