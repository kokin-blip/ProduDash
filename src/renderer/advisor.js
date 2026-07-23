import { escapeHtml, formatDate, statusLabel } from "./format.js";
import { asArray, resolveWorkload, ui } from "./state.js";
import { renderStatusBadge } from "./views/shared.js";

export const ADVISOR_CATEGORIES = ["dashboard_summary", "commerce_aggregates", "integration_health", "media_summaries"];

const SUGGESTED_QUESTIONS = [
  "What needs my attention today?",
  "Summarize my verified commerce performance.",
  "Are my integrations healthy?"
];

const ADVISOR_ART = Object.freeze({
  idle: "./assets/advisor/states/advisor-idle.png",
  thinking: "./assets/advisor/states/advisor-thinking.png",
  success: "./assets/advisor/states/advisor-success.png",
  warning: "./assets/advisor/states/advisor-warning.png"
});
const ADVISOR_AVATAR = "./assets/advisor/states/advisor-avatar.png";

function advisorArtSource() {
  return ADVISOR_ART[ui.advisorStatus] || ADVISOR_ART.idle;
}

function advisorProvider() {
  const assignment = resolveWorkload("advisor");
  if (!assignment || assignment.mode !== "provider") return null;
  const profile = ui.appState.aiProviders.find((item) => item.id === assignment.profileId);
  if (!profile) return null;
  const model = asArray(profile.models).find((item) => item.id === assignment.modelId);
  return {
    id: profile.id,
    name: profile.name || profile.id,
    modelId: assignment.modelId,
    ready:
      profile.status === "connected" &&
      asArray(model?.capabilities).includes("text_generation") &&
      asArray(model?.capabilities).includes("tool_calling")
  };
}

function hasCurrentConsent(provider) {
  const status = ui.advisorHistory.status || {};
  return Boolean(
    provider &&
    status.providerId === provider.id &&
    ADVISOR_CATEGORIES.every((category) => asArray(status.consentedCategories).includes(category))
  );
}

function renderTurns() {
  const turns = asArray(ui.advisorHistory.turns);
  if (!turns.length) {
    return `
      <div class="advisor-empty">
        <strong>Ask about the workspace</strong>
        <p>Advisor can summarize verified local data with a small, read-only tool set.</p>
      </div>
    `;
  }
  return turns
    .map(
      (turn) => `
        <article class="advisor-turn ${turn.role === "user" ? "user" : "assistant"}">
          <div>
            <strong>${turn.role === "user" ? "You" : escapeHtml(ui.appState.advisorSettings?.displayName || "Advisor")}</strong>
            <time datetime="${escapeHtml(turn.at || "")}">${escapeHtml(formatDate(turn.at))}</time>
          </div>
          <p>${escapeHtml(turn.text)}</p>
          ${
            turn.role === "assistant" && asArray(turn.tools).length
              ? `<small>Read-only tools: ${turn.tools.map((tool) => escapeHtml(statusLabel(tool))).join(", ")}</small>`
              : ""
          }
        </article>
      `
    )
    .join("");
}

function renderConsent(provider) {
  return `
    <section class="advisor-consent">
      <div>
        <strong>Cloud access for this session</strong>
        <p>
          ${escapeHtml(provider.name)} · ${escapeHtml(provider.modelId)} may receive bounded dashboard summaries, commerce aggregates,
          integration health, and media-job summaries. Customer identity, addresses, emails, raw messages, credentials, and files are excluded.
        </p>
      </div>
      <button
        class="primary-button small"
        type="button"
        data-advisor-consent="${escapeHtml(provider.id)}"
        data-pending-label="Confirming…"
      >Allow for this session</button>
    </section>
  `;
}

export function renderAdvisor() {
  const root = document.querySelector("#advisorRoot");
  if (!root) return;
  const provider = advisorProvider();
  const consented = hasCurrentConsent(provider);
  const busy = Boolean(ui.advisorRequest);
  const displayName = ui.appState.advisorSettings?.displayName || "Advisor";
  const providerLabel = provider ? `${provider.name} · ${provider.modelId}` : "No provider assigned";
  const stateLabel =
    ui.advisorStatus === "thinking"
      ? ui.advisorToolName
        ? `Reading ${statusLabel(ui.advisorToolName)}…`
        : "Thinking…"
      : ui.advisorStatus === "success"
        ? "Response ready"
        : ui.advisorStatus === "warning"
          ? "Needs attention"
          : provider?.ready
            ? "Ready"
            : "Connection required";

  root.innerHTML = `
    <button
      class="advisor-launcher"
      type="button"
      data-advisor-toggle
      aria-expanded="${ui.advisorOpen}"
      aria-controls="advisorPanel"
      aria-label="${escapeHtml(ui.advisorOpen ? `Close ${displayName}` : `Open ${displayName}`)}"
    >
      <img class="advisor-launcher-avatar" src="${ADVISOR_AVATAR}" alt="" />
      <span>${escapeHtml(displayName)}</span>
    </button>
    <aside
      class="advisor-panel${ui.advisorOpen ? " is-open" : ""}"
      id="advisorPanel"
      aria-label="${escapeHtml(displayName)}"
      aria-hidden="${!ui.advisorOpen}"
    >
      <header class="advisor-header">
        <div class="advisor-identity">
          <img class="advisor-state-art" src="${advisorArtSource()}" alt="" />
          <div>
            <span class="advisor-kicker">Read-only operations assistant</span>
            <h2>${escapeHtml(displayName)}</h2>
            <p>${escapeHtml(providerLabel)}</p>
          </div>
        </div>
        <button class="icon-button" type="button" data-advisor-close aria-label="Close ${escapeHtml(displayName)}">×</button>
      </header>
      <div class="advisor-state">
        ${renderStatusBadge(
          ui.advisorStatus === "warning" ? "warning" : provider?.ready ? (busy ? "pending" : "connected") : "disconnected",
          stateLabel,
          "advisor-state"
        )}
        <button class="text-button" type="button" data-advisor-clear ${busy ? "disabled" : ""}>Clear history</button>
      </div>
      ${ui.advisorError ? `<div class="inline-message error" role="alert" tabindex="-1"><strong>Advisor paused</strong><span>${escapeHtml(ui.advisorError)}</span></div>` : ""}
      <div class="advisor-history" id="advisorHistory" aria-live="polite">${renderTurns()}</div>
      ${
        !provider
          ? `<div class="advisor-blocked"><strong>Assign an Advisor model</strong><p>Choose a tool-capable provider in Integrations.</p><button class="ghost-button small" type="button" data-advisor-open-integrations>Open integrations</button></div>`
          : !provider.ready
            ? `<div class="advisor-blocked"><strong>Validate ${escapeHtml(provider.name)}</strong><p>The selected model must be genuinely connected before Advisor can use it.</p><button class="ghost-button small" type="button" data-advisor-open-integrations>Open integrations</button></div>`
            : !consented
              ? renderConsent(provider)
              : `
                <div class="advisor-suggestions" aria-label="Suggested questions">
                  ${SUGGESTED_QUESTIONS.map(
                    (question) =>
                      `<button type="button" data-advisor-suggestion="${escapeHtml(question)}" ${busy ? "disabled" : ""}>${escapeHtml(question)}</button>`
                  ).join("")}
                </div>
                <form class="advisor-composer" data-advisor-form aria-busy="${busy}">
                  <label for="advisorPrompt">Ask ${escapeHtml(displayName)}</label>
                  <textarea id="advisorPrompt" name="text" maxlength="4000" rows="3" placeholder="Ask about verified workspace data…" ${
                    busy ? "disabled" : ""
                  }></textarea>
                  <div>
                    <small>Responses are advisory and cannot change or publish data.</small>
                    ${
                      busy
                        ? `<button class="ghost-button small" type="button" data-advisor-cancel="${escapeHtml(
                            ui.advisorRequest
                          )}">Cancel</button>`
                        : `<button class="primary-button small" type="submit" data-pending-label="Thinking…">Ask Advisor</button>`
                    }
                  </div>
                </form>
              `
      }
      <details class="advisor-privacy disclosure">
        <summary>
          <span><strong>Privacy and tool boundary</strong><small>Visible history and bounded summaries only</small></span>
          <span class="disclosure-icon" aria-hidden="true">+</span>
        </summary>
        <div class="disclosure-content">
          <p>Up to 50 visible turns are stored locally. ProduDash never stores provider reasoning or credentials in Advisor history.</p>
          <p>Cloud consent ends when the app closes or the selected provider changes. Hosted web, code, MCP, and computer-use tools are disabled.</p>
          <form class="advisor-name-form" data-advisor-settings-form>
            <label>
              <span>Display name</span>
              <input name="displayName" maxlength="40" value="${escapeHtml(displayName)}" required />
            </label>
            <button class="ghost-button small" type="submit" data-pending-label="Saving…">Save name</button>
          </form>
        </div>
      </details>
    </aside>
  `;
  if (ui.advisorOpen) {
    window.requestAnimationFrame(() => {
      const history = root.querySelector("#advisorHistory");
      if (history) history.scrollTop = history.scrollHeight;
      root.querySelector('.advisor-panel [role="alert"]')?.focus();
    });
  }
}

export function applyAdvisorEvent(event) {
  if (!event || event.requestId !== ui.advisorRequest) return;
  if (event.type === "started") {
    ui.advisorStatus = "thinking";
    ui.advisorToolName = null;
  } else if (event.type === "tool") {
    ui.advisorStatus = "thinking";
    ui.advisorToolName = event.name;
  } else if (event.type === "message") {
    ui.advisorHistory.turns = [...asArray(ui.advisorHistory.turns), event.turn].slice(-50);
    ui.advisorStatus = "success";
    ui.advisorToolName = null;
  } else if (event.type === "error") {
    ui.advisorStatus = "warning";
    ui.advisorError = event.error?.message || "Advisor could not complete that request.";
    ui.advisorToolName = null;
  } else if (event.type === "canceled") {
    ui.advisorStatus = "idle";
    ui.advisorToolName = null;
  }
  renderAdvisor();
}
