import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { asArray, integrationReady, ui } from "../state.js";
import { renderStatusBadge } from "./shared.js";

export function renderStudio() {
  const jobs = asArray(ui.appState.clipperJobs);
  const posts = asArray(ui.appState.postQueue);
  return `
    <div class="inline-message neutral planning-banner">
      <strong>Local planning only</strong>
      <span>ProduDash does not process media, create export files, or publish externally in this MVP.</span>
    </div>
    <section class="studio-grid">
      <article class="panel">
        <div class="section-heading">
          <div><h2>Record a clip idea</h2><p>Describe a local plan without processing the source media.</p></div>
          ${renderStatusBadge("planned", "Planning only")}
        </div>
        <form class="studio-form" data-clip-form>
          <label><span>Clip title</span><input name="title" maxlength="120" required autocomplete="off" /></label>
          <label>
            <span>Source video</span>
            <div class="file-input-row">
              <input name="source" maxlength="2048" required autocomplete="off" placeholder="Local file path" />
              <button class="text-button" type="button" data-browse-video>Browse</button>
            </div>
          </label>
          <label><span>Clip goal</span><input name="goal" maxlength="500" autocomplete="off" /></label>
          <label><span>Target length</span><input name="targetLength" maxlength="80" value="30-45 seconds" required autocomplete="off" /></label>
          ${renderPlatformChecks()}
          <button class="primary-button" type="submit" data-pending-label="Creating…">Create local plan</button>
        </form>
      </article>
      <article class="panel">
        <div class="section-heading">
          <div><h2>Prepare a post plan</h2><p>Create an approval-gated record for manual export.</p></div>
          ${renderStatusBadge("pending", "Approval required")}
        </div>
        <form class="studio-form" data-post-form>
          <label>
            <span>Clip job</span>
            <select name="clipJobId">
              <option value="">No clip selected</option>
              ${jobs.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join("")}
            </select>
          </label>
          <label><span>Post title</span><input name="title" maxlength="120" required autocomplete="off" /></label>
          <label><span>Caption</span><textarea name="caption" maxlength="2200"></textarea></label>
          <label><span>Schedule target</span><input name="scheduledFor" type="datetime-local" /></label>
          ${renderPlatformChecks()}
          <button class="primary-button" type="submit" data-pending-label="Creating…">Create post plan</button>
        </form>
      </article>
    </section>
    <section class="queue-grid">
      <article class="panel">
        <div class="section-heading"><div><h2>Clip plans</h2><p>${jobs.length} local records</p></div></div>
        <div class="studio-list">${jobs.length ? jobs.map(renderClipJob).join("") : `<div class="quiet-state compact"><p>No clip plans yet.</p></div>`}</div>
      </article>
      <article class="panel">
        <div class="section-heading"><div><h2>Post plans</h2><p>${posts.length} approval-gated records</p></div></div>
        <div class="studio-list">${posts.length ? posts.map(renderPostPlan).join("") : `<div class="quiet-state compact"><p>No post plans yet.</p></div>`}</div>
      </article>
    </section>
  `;
}

function renderPlatformChecks() {
  return `
    <fieldset class="platform-checks">
      <legend>Destinations</legend>
      ${ui.appState.creatorPlatforms
        .map(
          (platform) => `
            <label><input name="platforms" type="checkbox" value="${escapeHtml(platform.id)}" /><span>${escapeHtml(platform.name)}</span></label>
          `
        )
        .join("")}
    </fieldset>
  `;
}

function renderClipJob(job) {
  return `
    <div class="studio-item">
      <div><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(job.goal || "No clip goal provided.")}</span></div>
      <div>${renderStatusBadge(job.status || "planned")}<small>${escapeHtml(formatDate(job.createdAt))} · ${escapeHtml(
        job.targetLength || "No target"
      )}</small></div>
    </div>
  `;
}

function renderPostPlan(plan) {
  const platforms = asArray(plan.platforms);
  const officialReady = platforms.length > 0 && platforms.every((platform) => integrationReady(platform));
  return `
    <div class="studio-item">
      <div><strong>${escapeHtml(plan.title)}</strong><span>${escapeHtml(plan.caption || "No caption yet.")}</span><small>${
        platforms.map((item) => escapeHtml(statusLabel(item))).join(", ") || "No destination"
      }</small></div>
      <div>${renderStatusBadge(plan.status || "pending")}<small>${escapeHtml(
        plan.scheduledFor ? formatDate(plan.scheduledFor) : "No schedule"
      )}</small></div>
      <div class="approval-actions">
        ${
          plan.status === "needs_approval"
            ? `<button class="primary-button small" type="button" data-approve-post="${escapeHtml(
                plan.id
              )}" data-approval-mode="manual_export" data-pending-label="Approving…">Approve manual export</button>`
            : ""
        }
        ${
          plan.status === "needs_approval" && officialReady
            ? `<button class="text-button" type="button" data-approve-post="${escapeHtml(
                plan.id
              )}" data-approval-mode="official_api" data-pending-label="Approving…">Approve official API path</button>`
            : ""
        }
        ${
          plan.status === "approved_for_manual_export"
            ? `<button class="text-button" type="button" data-export-post="${escapeHtml(
                plan.id
              )}" data-pending-label="Updating…">Mark export-ready</button>`
            : ""
        }
      </div>
    </div>
  `;
}
