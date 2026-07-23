import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { asArray, integrationReady, ui } from "../state.js";

export function renderStudio() {
  const jobs = asArray(ui.appState.clipperJobs);
  const posts = asArray(ui.appState.postQueue);
  return `
    <section class="hero-grid">
      <article class="panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">Clip planning</p><h2>Record a local clip idea</h2></div>
          <span class="mini-badge">No media processing</span>
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
          <button class="primary-button" type="submit">Create local plan</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading compact">
          <div><p class="eyebrow">Post planning</p><h2>Prepare an approval-gated export</h2></div>
          <span class="mini-badge">No external publishing</span>
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
          <button class="primary-button" type="submit">Create post plan</button>
        </form>
      </article>
    </section>
    <section class="operations-grid">
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Clip queue</p><h2>${jobs.length} local plans</h2></div></div>
        <div class="studio-list">${jobs.length ? jobs.map(renderClipJob).join("") : `<div class="empty-state">No clip plans yet.</div>`}</div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Export queue</p><h2>${posts.length} post plans</h2></div></div>
        <div class="studio-list">${posts.length ? posts.map(renderPostPlan).join("") : `<div class="empty-state">No post plans yet.</div>`}</div>
      </article>
      <article class="panel">
        <div class="panel-heading compact"><div><p class="eyebrow">Truthful capability</p><h2>Planning only</h2></div></div>
        <p>ProduDash does not clip media or publish externally in this MVP. “Export-ready” records human approval; it does not create a file or upload a post.</p>
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
      <span>${escapeHtml(statusLabel(job.status))} · ${escapeHtml(formatDate(job.createdAt))}</span>
      <strong>${escapeHtml(job.title)}</strong>
      <p>${escapeHtml(job.goal || "No clip goal provided.")}</p>
      <small>${escapeHtml(job.targetLength || "No target")} · ${
        asArray(job.platforms)
          .map((item) => escapeHtml(statusLabel(item)))
          .join(", ") || "No destination"
      }</small>
    </div>
  `;
}

function renderPostPlan(plan) {
  const platforms = asArray(plan.platforms);
  const officialReady = platforms.length > 0 && platforms.every((platform) => integrationReady(platform));
  return `
    <div class="studio-item">
      <span>${escapeHtml(statusLabel(plan.status))} · ${escapeHtml(formatDate(plan.createdAt))}</span>
      <strong>${escapeHtml(plan.title)}</strong>
      <p>${escapeHtml(plan.caption || "No caption yet.")}</p>
      <small>${escapeHtml(plan.scheduledFor ? formatDate(plan.scheduledFor) : "No schedule")} · ${
        platforms.map((item) => escapeHtml(statusLabel(item))).join(", ") || "No destination"
      }</small>
      <div class="approval-actions">
        ${
          plan.status === "needs_approval"
            ? `<button class="primary-button small" type="button" data-approve-post="${escapeHtml(plan.id)}" data-approval-mode="manual_export">Approve manual export</button>`
            : ""
        }
        ${
          plan.status === "needs_approval" && officialReady
            ? `<button class="text-button" type="button" data-approve-post="${escapeHtml(plan.id)}" data-approval-mode="official_api">Approve official API path</button>`
            : ""
        }
        ${
          plan.status === "approved_for_manual_export"
            ? `<button class="text-button" type="button" data-export-post="${escapeHtml(plan.id)}">Mark export-ready</button>`
            : ""
        }
      </div>
    </div>
  `;
}
