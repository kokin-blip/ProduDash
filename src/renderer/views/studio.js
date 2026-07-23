import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { asArray, integrationReady, isPending, ui } from "../state.js";
import { renderStatusBadge } from "./shared.js";

const STUDIO_TABS = [
  ["library", "Library"],
  ["create", "Create clips"],
  ["publishing", "Publishing"]
];

export function renderStudio() {
  return `
    <div class="inline-message neutral planning-banner">
      <strong>Read-only media library</strong>
      <span>ProduDash can index and preview local videos. Clip processing and publishing remain local planning only in this milestone.</span>
    </div>
    <div class="studio-tabs" role="tablist" aria-label="Content Studio">
      ${STUDIO_TABS.map(
        ([id, label]) => `
          <button type="button" role="tab" data-studio-tab="${id}" aria-selected="${ui.studioTab === id}" class="${
            ui.studioTab === id ? "active" : ""
          }">${label}</button>
        `
      ).join("")}
    </div>
    <section role="tabpanel" class="studio-tab-panel">
      ${ui.studioTab === "create" ? renderCreateClips() : ui.studioTab === "publishing" ? renderPublishing() : renderLibrary()}
    </section>
  `;
}

function renderLibrary() {
  const library = ui.clipLibrary;
  const selected = library.clips.find((clip) => clip.id === ui.selectedClipId) || library.clips[0] || null;
  const previousOffset = Math.max(0, library.offset - library.limit);
  const nextOffset = library.offset + library.limit;
  return `
    ${library.notices
      .map(
        (notice) => `<div class="inline-message warning"><strong>Library recovered</strong><span>${escapeHtml(notice.message)}</span></div>`
      )
      .join("")}
    <div class="library-actions">
      <div>
        <h2>Clip Library</h2>
        <p>${library.total} indexed video${library.total === 1 ? "" : "s"} · source files remain in place</p>
      </div>
      <div>
        <button class="ghost-button" type="button" data-add-clip-files data-pending-label="Inspecting…" ${
          isPending("add-clip-files") ? "disabled" : ""
        }>Add videos</button>
        <button class="primary-button" type="button" data-add-clip-folders data-pending-label="Scanning…" ${
          isPending("add-clip-folders") ? "disabled" : ""
        }>Add folder</button>
      </div>
    </div>
    <form class="library-filters" data-library-search-form>
      <label>
        <span class="sr-only">Search clips</span>
        <input name="query" type="search" maxlength="200" value="${escapeHtml(
          ui.libraryFilters.query
        )}" placeholder="Search names and tags" />
      </label>
      <label>
        <span class="sr-only">Folder</span>
        <select name="folderId">
          <option value="">All folders</option>
          ${library.folders
            .map(
              (folder) =>
                `<option value="${escapeHtml(folder.id)}" ${
                  ui.libraryFilters.folderId === folder.id ? "selected" : ""
                }>${escapeHtml(folder.name)}</option>`
            )
            .join("")}
        </select>
      </label>
      <label>
        <span class="sr-only">Status</span>
        <select name="status">
          ${[
            ["", "Any status"],
            ["available", "Available"],
            ["missing", "Missing"],
            ["offline", "Offline"],
            ["permission_denied", "Permission denied"],
            ["unsupported", "Unsupported"],
            ["corrupt", "Corrupt"]
          ]
            .map(([value, label]) => `<option value="${value}" ${ui.libraryFilters.status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </label>
      <label>
        <span class="sr-only">Sort clips</span>
        <select name="sort">
          ${[
            ["modified_desc", "Recently modified"],
            ["name", "Name"],
            ["duration_desc", "Longest"],
            ["size_desc", "Largest"]
          ]
            .map(([value, label]) => `<option value="${value}" ${ui.libraryFilters.sort === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </label>
      <button class="ghost-button" type="submit" data-pending-label="Searching…">Apply</button>
    </form>
    ${renderFolders(library.folders)}
    <div class="library-layout">
      <div class="clip-list" aria-label="Indexed videos">
        ${
          library.clips.length
            ? library.clips.map((clip) => renderClipRow(clip, selected?.id === clip.id)).join("")
            : `<div class="panel quiet-state"><strong>No matching videos</strong><p>Add a folder or loose video to build a local, read-only index.</p></div>`
        }
        ${
          library.total > library.limit
            ? `<div class="library-pagination">
                <button class="text-button" type="button" data-library-offset="${previousOffset}" ${
                  library.offset === 0 ? "disabled" : ""
                }>Previous</button>
                <span>${library.offset + 1}–${Math.min(library.offset + library.clips.length, library.total)} of ${library.total}</span>
                <button class="text-button" type="button" data-library-offset="${nextOffset}" ${
                  nextOffset >= library.total ? "disabled" : ""
                }>Next</button>
              </div>`
            : ""
        }
      </div>
      ${renderClipDetail(selected)}
    </div>
  `;
}

function renderFolders(folders) {
  if (!folders.length) return "";
  return `
    <details class="disclosure library-folders">
      <summary>
        <span><strong>Watched folders</strong><small>${folders.length} local folder${folders.length === 1 ? "" : "s"}</small></span>
        <span class="disclosure-icon" aria-hidden="true">+</span>
      </summary>
      <div class="disclosure-content folder-list">
        ${folders
          .map(
            (folder) => `
              <div class="folder-row">
                <div>
                  <strong>${escapeHtml(folder.name)}</strong>
                  <span>${folder.clipCount} clips · ${escapeHtml(
                    folder.lastScannedAt ? `Scanned ${formatDate(folder.lastScannedAt)}` : "Not scanned"
                  )}</span>
                  ${folder.error ? `<small>${escapeHtml(folder.error)}</small>` : ""}
                </div>
                ${renderStatusBadge(folder.status || "unknown")}
                <div>
                  <button class="text-button" type="button" data-rescan-clip-folder="${escapeHtml(
                    folder.id
                  )}" data-pending-label="Scanning…">Rescan</button>
                  <button class="text-button" type="button" data-relocate-clip-folder="${escapeHtml(
                    folder.id
                  )}" data-pending-label="Relocating…">Relocate</button>
                  <button class="text-button danger-text" type="button" data-remove-clip-folder="${escapeHtml(
                    folder.id
                  )}" data-pending-label="Removing…">Remove</button>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderClipRow(clip, selected) {
  return `
    <button class="clip-row ${selected ? "active" : ""}" type="button" data-library-clip="${escapeHtml(clip.id)}">
      <span class="clip-thumb">
        ${
          clip.thumbnailUrl
            ? `<img src="${escapeHtml(clip.thumbnailUrl)}" alt="" loading="lazy" />`
            : `<span aria-hidden="true">${escapeHtml((clip.extension || "video").toUpperCase())}</span>`
        }
      </span>
      <span class="clip-row-copy">
        <strong>${escapeHtml(clip.name)}</strong>
        <small>${formatDuration(clip.duration)} · ${escapeHtml(clip.aspectRatio || "Unknown")} · ${formatBytes(clip.size)}</small>
        <span>${
          asArray(clip.tags).length
            ? asArray(clip.tags)
                .map((tag) => `#${escapeHtml(tag)}`)
                .join(" ")
            : "No tags"
        }</span>
      </span>
      ${renderStatusBadge(clip.status || "unknown")}
    </button>
  `;
}

function renderClipDetail(clip) {
  if (!clip) return `<aside class="panel clip-detail quiet-state"><p>Select an indexed video to inspect it.</p></aside>`;
  return `
    <aside class="panel clip-detail">
      ${
        clip.previewUrl
          ? `<video controls preload="metadata" src="${escapeHtml(clip.previewUrl)}" poster="${escapeHtml(
              clip.thumbnailUrl || ""
            )}"></video>`
          : clip.thumbnailUrl
            ? `<img class="clip-detail-image" src="${escapeHtml(clip.thumbnailUrl)}" alt="" />`
            : `<div class="clip-preview-unavailable"><strong>Preview unavailable</strong><span>${escapeHtml(
                clip.error || "This container or codec cannot be previewed safely."
              )}</span></div>`
      }
      <div class="clip-detail-heading">
        <div><h3>${escapeHtml(clip.name)}</h3><p>${escapeHtml(statusLabel(clip.status))}</p></div>
        ${renderStatusBadge(clip.status || "unknown")}
      </div>
      <dl class="clip-metadata">
        <div><dt>Duration</dt><dd>${formatDuration(clip.duration)}</dd></div>
        <div><dt>Dimensions</dt><dd>${clip.width && clip.height ? `${clip.width} × ${clip.height}` : "Unknown"}</dd></div>
        <div><dt>Codec</dt><dd>${escapeHtml(clip.codec || "Unknown")}</dd></div>
        <div><dt>Modified</dt><dd>${escapeHtml(formatDate(clip.modifiedAt))}</dd></div>
      </dl>
      ${clip.error ? `<div class="inline-message error"><strong>File needs attention</strong><span>${escapeHtml(clip.error)}</span></div>` : ""}
      <form class="clip-tags-form" data-clip-tags-form="${escapeHtml(clip.id)}">
        <label><span>Tags</span><input name="tags" maxlength="620" value="${escapeHtml(asArray(clip.tags).join(", "))}" placeholder="campaign, product, favorite" /></label>
        <button class="ghost-button small" type="submit" data-pending-label="Saving…">Save tags</button>
      </form>
      <div class="clip-detail-actions">
        <button class="text-button" type="button" data-reveal-clip="${escapeHtml(clip.id)}">Show in folder</button>
        <button class="text-button danger-text" type="button" data-remove-clip="${escapeHtml(
          clip.id
        )}" data-pending-label="Removing…">Remove from library</button>
      </div>
    </aside>
  `;
}

function renderCreateClips() {
  const jobs = asArray(ui.appState.clipperJobs);
  return `
    <section class="studio-grid single-workflow">
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
        <div class="section-heading"><div><h2>Clip plans</h2><p>${jobs.length} local records</p></div></div>
        <div class="studio-list">${jobs.length ? jobs.map(renderClipJob).join("") : `<div class="quiet-state compact"><p>No clip plans yet.</p></div>`}</div>
      </article>
    </section>
  `;
}

function renderPublishing() {
  const jobs = asArray(ui.appState.clipperJobs);
  const posts = asArray(ui.appState.postQueue);
  return `
    <section class="studio-grid single-workflow">
      <article class="panel">
        <div class="section-heading">
          <div><h2>Prepare a post plan</h2><p>Create an approval-gated record for manual export.</p></div>
          ${renderStatusBadge("pending", "Approval required")}
        </div>
        <form class="studio-form" data-post-form>
          <label>
            <span>Clip plan</span>
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
      <div>${renderStatusBadge(job.status || "legacy_plan", job.legacy ? "Legacy plan" : undefined)}<small>${escapeHtml(
        formatDate(job.createdAt)
      )} · ${escapeHtml(job.targetLength || "No target")}</small></div>
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

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown duration";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
