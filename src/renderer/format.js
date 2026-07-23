export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatUsd(value, currency = "USD") {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Unavailable";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : "USD",
      maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount);
  }
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown date";
}

export function statusLabel(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

export function heightClass(value, maximum) {
  const number = Number(value);
  const max = Number(maximum);
  if (!Number.isFinite(number) || !Number.isFinite(max) || max <= 0) return "bar-height-0";
  const bucket = Math.max(0, Math.min(100, Math.round((number / max) * 20) * 5));
  return `bar-height-${bucket}`;
}

export function levelClass(value) {
  const normalized = String(value || "").toLowerCase();
  return ["low", "medium", "high", "critical"].includes(normalized) ? normalized : "medium";
}

export function statusTone(value) {
  const normalized = String(value || "").toLowerCase();
  if (["connected", "complete", "completed", "enabled", "export_ready", "approved"].includes(normalized)) return "success";
  if (["degraded", "warning", "needs_approval", "stored", "pending"].includes(normalized)) return "warning";
  if (["error", "failed", "critical", "blocked"].includes(normalized)) return "danger";
  if (["disconnected", "missing", "planned", "waiting_for_connection", "unknown"].includes(normalized)) return "neutral";
  return "neutral";
}
