import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { asArray, integrationReady, isPending, platformEntry, ui } from "../state.js";
import { renderStatusBadge } from "./shared.js";
import { renderCandidateReview } from "./candidate-review.js";
import { renderProjects } from "./projects.js";
import { renderBrandTemplates } from "./templates.js";

const STUDIO_TABS = [
  ["projects", "Projects"],
  ["library", "Library"],
  ["create", "Create clips"],
  ["templates", "Brand templates"],
  ["publishing", "Publishing"]
];

export function renderStudio() {
  return `
    <div class="inline-message neutral planning-banner">
      <strong>Local media workspace</strong>
      <span>ProduDash processes media locally by default. A cloud analysis mode uploads only the categories named in a separate per-job consent; publishing requires a connected platform and explicit approval.</span>
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
    ${
      ui.studioTab === "projects"
        ? renderProjects()
        : ui.studioTab === "templates"
          ? renderBrandTemplates()
          : `<section role="tabpanel" class="studio-tab-panel">${
              ui.studioTab === "create" ? renderCreateClips() : ui.studioTab === "publishing" ? renderPublishing() : renderLibrary()
            }</section>`
    }
  `;
}

function resolveWorkload(workloadId) {
  let assignment = ui.appState.aiWorkloads?.[workloadId];
  if (assignment?.mode === "same_as_advisor") assignment = ui.appState.aiWorkloads?.advisor;
  if (!assignment || assignment.mode !== "provider") return null;
  const profile = asArray(ui.appState.aiProviders).find((item) => item.id === assignment.profileId);
  const model = asArray(profile?.models).find((item) => item.id === assignment.modelId);
  if (!profile || !model || profile.status !== "connected") return null;
  return { profile, model };
}

function supports(model, ...capabilities) {
  const available = new Set(asArray(model?.capabilities));
  return capabilities.every((capability) => available.has(capability));
}

function getCloudAnalysisOptions() {
  const analysis = resolveWorkload("clipAnalysis");
  const transcription = resolveWorkload("transcription");
  if (!analysis) return [];
  const base = {
    profileId: analysis.profile.id,
    modelId: analysis.model.id,
    providerName: analysis.profile.name,
    modelName: analysis.model.name
  };
  const options = [];
  if (supports(analysis.model, "native_video_understanding")) {
    options.push({ ...base, id: "native_video", label: "Native video analysis", categories: ["complete_video"] });
  }
  if (transcription && supports(analysis.model, "structured_output")) {
    const transcriptionUsesCloud = transcription.profile.providerType !== "whisper-cpp";
    const transcriptionData = {
      transcriptionProfileId: transcription.profile.id,
      transcriptionModelId: transcription.model.id,
      transcriptionName: `${transcription.profile.name} / ${transcription.model.name}`
    };
    options.push({
      ...base,
      ...transcriptionData,
      id: "transcript_only",
      label: "Transcript-only analysis",
      categories: [...(transcriptionUsesCloud ? ["audio"] : []), "transcript"]
    });
    if (supports(analysis.model, "image_understanding")) {
      options.push({
        ...base,
        ...transcriptionData,
        id: "transcript_frames",
        label: "Transcript + sampled frames",
        categories: [...(transcriptionUsesCloud ? ["audio"] : []), "transcript", "frames"]
      });
    }
  }
  return options;
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
        <button class="ghost-button" type="button" data-rebuild-clip-search data-pending-label="Indexing…">Rebuild smart index</button>
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
        )}" placeholder="Search names, tags, metadata, and local transcripts" />
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
        ${
          clip.search
            ? `<span class="clip-search-match">Local match ${Math.round(clip.search.score * 100)}% · ${
                clip.search.timestampMatches?.length
                  ? `${formatDuration(clip.search.timestampMatches[0].start)} · “${escapeHtml(clip.search.timestampMatches[0].excerpt)}”`
                  : escapeHtml(clip.search.matchedTerms.join(", ") || "metadata")
              }</span>`
            : ""
        }
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
  const jobs = asArray(ui.appState.mediaJobs);
  const legacyPlans = asArray(ui.appState.clipperJobs);
  const availableClips = asArray(ui.clipLibrary.clips).filter((clip) => clip.status === "available");
  const secureStorageUnavailable = asArray(ui.appState.systemNotices).some((notice) => notice.code === "SECURE_STORAGE_UNAVAILABLE");
  const cloudOptions = getCloudAnalysisOptions();
  return `
    <section class="studio-grid single-workflow">
      <article class="panel">
        <div class="section-heading">
          <div><h2>Create clips</h2><p>Choose Smart local cuts or an explicitly consented provider, review every candidate, then render approved clips locally.</p></div>
          ${renderStatusBadge(
            secureStorageUnavailable ? "error" : "available",
            secureStorageUnavailable ? "Secure storage required" : "Local processing"
          )}
        </div>
        <form class="studio-form" data-media-job-form>
          <label>
            <span>Source video</span>
            <select name="sourceMediaId" required>
              <option value="">Choose from Clip Library</option>
              ${availableClips.map((clip) => `<option value="${escapeHtml(clip.id)}">${escapeHtml(clip.name)}</option>`).join("")}
            </select>
          </label>
          <label><span>Job title</span><input name="title" maxlength="120" required autocomplete="off" /></label>
          <label><span>Clip goal</span><input name="goal" maxlength="500" autocomplete="off" placeholder="Optional local context" /></label>
          <div class="media-settings-grid">
            <label><span>Maximum final clips</span><input name="maxClips" type="number" min="1" max="20" value="3" required /></label>
            <label><span>Target seconds</span><input name="targetDuration" type="number" min="5" max="180" value="30" required /></label>
            <label><span>Aspect</span><select name="targetAspect">
              <option value="original">Original</option><option value="vertical">Vertical 9:16</option>
              <option value="square">Square 1:1</option><option value="landscape">Landscape 16:9</option>
            </select></label>
            <label><span>Aspect treatment</span><select name="aspectTreatment">
              <option value="fit_pad">Fit and pad</option><option value="original">Keep original</option>
              <option value="center_crop">Center crop</option>
            </select></label>
          </div>
          <label><span>Captions</span><select name="captionMode">
            <option value="off">Off</option><option value="srt">SRT file</option><option value="srt_burned">SRT + burned in</option>
          </select></label>
          <label><span>Manual caption fallback</span><textarea name="captionText" maxlength="2000" placeholder="Optional when no timestamped transcript is available"></textarea></label>
          <label>
            <span>Analysis mode</span>
            <select name="analysisMode">
              <option value="local_heuristics">Smart local cuts — no upload</option>
              ${cloudOptions
                .map(
                  (option) =>
                    `<option value="${escapeHtml(option.id)}"
                      data-provider-id="${escapeHtml(option.profileId)}"
                      data-model-id="${escapeHtml(option.modelId)}"
                      data-transcription-provider-id="${escapeHtml(option.transcriptionProfileId || "")}"
                      data-transcription-model-id="${escapeHtml(option.transcriptionModelId || "")}"
                      data-categories="${escapeHtml(option.categories.join(","))}">${escapeHtml(option.label)} — ${escapeHtml(
                        option.providerName
                      )} / ${escapeHtml(option.modelName)}</option>`
                )
                .join("")}
            </select>
          </label>
          ${
            cloudOptions.length
              ? `<label class="approval-check cloud-consent-check">
                  <input type="checkbox" name="cloudConsent" />
                  <span><strong>Consent for this job only</strong><small>If I choose a cloud mode, upload the named audio, transcript, sampled frames, or complete video to the displayed provider/model. No automatic provider or mode fallback is allowed.</small></span>
                </label>`
              : `<div class="inline-message neutral"><strong>Cloud analysis is not ready</strong><span>Connect and assign compatible Clip Analysis and Transcription models in Integrations to enable consented cloud modes.</span></div>`
          }
          ${renderPlatformChecks()}
          <div class="media-output-picker">
            <div><strong>Output folder</strong><span>${escapeHtml(
              ui.mediaOutputSelection?.name || "Choose where ProduDash should create a collision-free job folder."
            )}</span></div>
            <button class="ghost-button" type="button" data-choose-media-output data-pending-label="Choosing…" ${
              secureStorageUnavailable ? "disabled" : ""
            }>Choose folder</button>
          </div>
          ${
            availableClips.length && !secureStorageUnavailable
              ? `<button class="primary-button" type="submit" data-pending-label="Queueing…">Create analysis job</button>`
              : secureStorageUnavailable
                ? `<div class="inline-message error"><strong>Local jobs are unavailable</strong><span>ProduDash requires secure OS encryption before it can remember protected media paths.</span></div>`
                : `<div class="inline-message warning"><strong>Add a source first</strong><span>Add an available video in the Library tab before creating a job.</span></div>`
          }
        </form>
      </article>
      <article class="panel">
        <div class="section-heading"><div><h2>Media jobs</h2><p>${jobs.length} durable local job${jobs.length === 1 ? "" : "s"} · one runs at a time</p></div></div>
        <div class="studio-list">${jobs.length ? jobs.map(renderMediaJob).join("") : `<div class="quiet-state compact"><p>No media jobs yet.</p></div>`}</div>
      </article>
    </section>
    ${
      legacyPlans.length
        ? `<details class="disclosure legacy-plans">
            <summary><span><strong>Legacy clip plans</strong><small>${legacyPlans.length} planning-only record${
              legacyPlans.length === 1 ? "" : "s"
            } · recreate with a library source to render</small></span><span class="disclosure-icon" aria-hidden="true">+</span></summary>
            <div class="disclosure-content studio-list">${legacyPlans.map(renderClipJob).join("")}</div>
          </details>`
        : ""
    }
  `;
}

function renderMediaJob(job) {
  const status = job.status || "queued";
  const canCancel = ["queued", "render_queued", "processing", "awaiting_review", "failed", "interrupted"].includes(status);
  const canRetry = ["failed", "interrupted", "canceled"].includes(status) && (job.retryable || status === "canceled");
  const fileArtifacts = asArray(job.artifacts).filter((artifact) => artifact.kind !== "thumbnail");
  return `
    <div class="media-job" data-media-job="${escapeHtml(job.id)}">
      <div class="media-job-heading">
        <div><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(job.sourceName || "Indexed source")} → ${escapeHtml(
          job.outputFolderName
        )}</span><small>${escapeHtml(statusLabel(job.settings?.analysisMode || "local_heuristics"))}</small></div>
        ${renderStatusBadge(status)}
      </div>
      <div class="media-progress" aria-label="${escapeHtml(statusLabel(job.stage || status))}: ${Math.round(Number(job.progress || 0))}%">
        <progress max="100" value="${Math.max(0, Math.min(100, Number(job.progress || 0)))}"></progress>
        <span>${escapeHtml(statusLabel(job.stage || status))} · ${Math.round(Number(job.progress || 0))}%</span>
      </div>
      ${job.error ? `<div class="inline-message error"><strong>Job needs attention</strong><span>${escapeHtml(job.error)}</span></div>` : ""}
      ${
        asArray(job.warnings).length
          ? `<ul class="media-warnings">${asArray(job.warnings)
              .map((warning) => `<li>${escapeHtml(warning)}</li>`)
              .join("")}</ul>`
          : ""
      }
      ${status === "awaiting_review" ? renderCandidateReview(job) : ""}
      ${status === "completed" ? renderThumbnailReview(job) : ""}
      ${
        fileArtifacts.length
          ? `<div class="artifact-list">${fileArtifacts
              .map((artifact) => `<span>${escapeHtml(artifact.kind)} · ${escapeHtml(artifact.name)}</span>`)
              .join("")}</div>`
          : ""
      }
      <div class="approval-actions">
        ${canCancel ? `<button class="text-button danger-text" type="button" data-cancel-media-job="${escapeHtml(job.id)}" data-pending-label="Canceling…">Cancel</button>` : ""}
        ${canRetry ? `<button class="ghost-button small" type="button" data-retry-media-job="${escapeHtml(job.id)}" data-pending-label="Queueing…">Retry</button>` : ""}
        ${status === "completed" ? `<button class="text-button" type="button" data-reveal-media-job="${escapeHtml(job.id)}">Show output</button>` : ""}
      </div>
    </div>
  `;
}

function safeJobThumbnailUrl(value) {
  return typeof value === "string" && /^produdash-media:\/\/job-thumbnail\/artifact-[a-f0-9]{24}$/.test(value) ? value : null;
}

function thumbnailPositionLabel(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return "Frame";
  if (ratio < 0.35) return "Early";
  if (ratio > 0.65) return "Late";
  return "Middle";
}

function thumbnailChoiceLabel(thumbnail) {
  return thumbnail.source === "user_import" ? "Custom" : thumbnailPositionLabel(thumbnail.positionRatio);
}

function renderThumbnailPlatformPreview(job, thumbnail) {
  if (!thumbnail) return "";
  const names = new Map(asArray(ui.appState.creatorPlatforms).map((platform) => [platform.id, platform.name]));
  const platformIds = asArray(job.settings?.platforms).filter((id) => names.has(id));
  if (!platformIds.length) return "";
  return `
    <div class="thumbnail-platform-review">
      <div><strong>Platform framing check</strong><span>Approximate edge-clearance preview only—not an official publishing preview.</span></div>
      <div class="thumbnail-platform-grid">
        ${platformIds
          .map(
            (platformId) => `
              <figure class="thumbnail-platform-card">
                <div class="thumbnail-platform-frame">
                  <img src="${escapeHtml(thumbnail.previewUrl)}" alt="${escapeHtml(
                    `${names.get(platformId) || statusLabel(platformId)} thumbnail framing preview`
                  )}" loading="lazy" />
                  <span class="thumbnail-safe-region" aria-hidden="true"></span>
                </div>
                <figcaption>${escapeHtml(names.get(platformId) || statusLabel(platformId))}</figcaption>
              </figure>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderThumbnailReview(job) {
  const thumbnails = asArray(job.artifacts).filter(
    (artifact) => artifact.kind === "thumbnail" && artifact.id && artifact.groupId && safeJobThumbnailUrl(artifact.previewUrl)
  );
  if (!thumbnails.length) return "";
  const groups = new Map();
  for (const thumbnail of thumbnails) {
    if (!groups.has(thumbnail.groupId)) groups.set(thumbnail.groupId, []);
    groups.get(thumbnail.groupId).push(thumbnail);
  }
  const selectedIds = new Set(asArray(job.thumbnailSelections).map((selection) => selection.artifactId));
  return `
    <section class="thumbnail-review" aria-label="Thumbnail choices">
      <div class="thumbnail-review-heading">
        <div><strong>Choose a preferred thumbnail</strong><span>Real frames from the local render. Your choice does not edit, upload, or publish anything.</span></div>
        ${renderStatusBadge(selectedIds.size === groups.size ? "connected" : "pending", selectedIds.size === groups.size ? "Chosen" : "Needs choice")}
      </div>
      ${[...groups.values()]
        .map(
          (items, index) => `
            <fieldset class="thumbnail-group">
              <legend><span>${groups.size > 1 ? `Rendered clip ${index + 1}` : "Rendered clip"}</span><button
                class="text-button"
                type="button"
                data-add-job-thumbnail="${escapeHtml(job.id)}"
                data-thumbnail-group="${escapeHtml(items[0].groupId)}"
                data-pending-label="Adding…"
              >Add custom image</button></legend>
              <div class="thumbnail-grid">
                ${items
                  .sort(
                    (left, right) =>
                      (left.source === "user_import" ? 2 : Number(left.positionRatio ?? 0)) -
                      (right.source === "user_import" ? 2 : Number(right.positionRatio ?? 0))
                  )
                  .map((thumbnail) => {
                    const selected = selectedIds.has(thumbnail.id);
                    return `
                      <button
                        class="thumbnail-choice${selected ? " selected" : ""}"
                        type="button"
                        aria-pressed="${selected}"
                        data-select-job-thumbnail="${escapeHtml(job.id)}"
                        data-thumbnail-id="${escapeHtml(thumbnail.id)}"
                        data-pending-label="Saving…"
                      >
                        <img src="${escapeHtml(thumbnail.previewUrl)}" alt="${escapeHtml(
                          `${thumbnailChoiceLabel(thumbnail)} frame thumbnail`
                        )}" loading="lazy" />
                        <span><strong>${escapeHtml(thumbnailChoiceLabel(thumbnail))}</strong><small>${
                          selected ? "Preferred" : "Choose"
                        }</small></span>
                      </button>
                    `;
                  })
                  .join("")}
              </div>
              ${renderThumbnailPlatformPreview(
                job,
                items.find((thumbnail) => selectedIds.has(thumbnail.id))
              )}
            </fieldset>
          `
        )
        .join("")}
    </section>
  `;
}

function renderPublishing() {
  const jobs = asArray(ui.appState.clipperJobs);
  const renderedJobs = asArray(ui.appState.mediaJobs).filter(
    (job) => job.status === "completed" && asArray(job.artifacts).some((artifact) => artifact.kind === "video")
  );
  const posts = asArray(ui.appState.postQueue);
  const scheduledPosts = posts
    .filter((plan) => Number.isFinite(Date.parse(plan.schedule?.scheduledFor)))
    .sort((left, right) => Date.parse(left.schedule.scheduledFor) - Date.parse(right.schedule.scheduledFor));
  const now = Date.now();
  const overdue = scheduledPosts.filter(
    (plan) => Date.parse(plan.schedule.scheduledFor) < now && !["export_ready", "canceled"].includes(plan.status)
  ).length;
  const upcoming = scheduledPosts.filter(
    (plan) => Date.parse(plan.schedule.scheduledFor) >= now && !["export_ready", "canceled"].includes(plan.status)
  ).length;
  const awaitingApproval = posts.filter((plan) => plan.status === "needs_approval").length;
  const completed = posts.filter((plan) => plan.status === "export_ready").length;
  return `
    <div class="inline-message neutral">
      <strong>Publishing outbox</strong>
      <span>ProduDash can publish through connected, implemented platform APIs after explicit approval. Platforms without a connector remain export-only.</span>
    </div>
    <section class="studio-grid single-workflow">
      <article class="panel">
        <div class="section-heading">
          <div><h2>Prepare a publishing package</h2><p>Attach completed media, review shared copy, and preserve an immutable approval snapshot.</p></div>
          ${renderStatusBadge("pending", "Approval required")}
        </div>
        <form class="studio-form" data-post-form>
          <label>
            <span>Rendered media</span>
            <select name="mediaJobId">
              <option value="">No rendered media selected</option>
              ${renderedJobs.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Legacy clip plan</span>
            <select name="clipJobId">
              <option value="">No clip selected</option>
              ${jobs.map((job) => `<option value="${escapeHtml(job.id)}">${escapeHtml(job.title)}</option>`).join("")}
            </select>
          </label>
          <label><span>Post title</span><input name="title" maxlength="120" required autocomplete="off" /></label>
          <label><span>Caption</span><textarea name="caption" maxlength="2200"></textarea></label>
          <label><span>Planning target</span><input name="scheduledFor" type="datetime-local" /><small>Saved with your current time zone. This does not automatically publish.</small></label>
          ${renderPlatformChecks()}
          <button class="primary-button" type="submit" data-pending-label="Creating…">Create publishing package</button>
        </form>
      </article>
      <article class="panel">
        <div class="section-heading"><div><h2>Schedule and outbox</h2><p>${posts.length} local approval-gated records</p></div></div>
        <div class="publishing-summary" aria-label="Publishing outbox summary">
          ${renderPublishingSummaryItem("Awaiting approval", awaitingApproval)}
          ${renderPublishingSummaryItem("Upcoming", upcoming)}
          ${renderPublishingSummaryItem("Past target", overdue)}
          ${renderPublishingSummaryItem("Exported", completed)}
        </div>
        ${
          scheduledPosts.length
            ? `<div class="publishing-schedule" aria-label="Local publishing schedule">
                ${scheduledPosts
                  .map(
                    (plan) => `
                      <div class="compact-row">
                        <span><strong>${escapeHtml(plan.title)}</strong><small>${escapeHtml(
                          `${formatDate(plan.schedule.scheduledFor)} · ${plan.schedule.timeZone}`
                        )}</small></span>
                        ${renderStatusBadge(plan.status || "pending")}
                      </div>
                    `
                  )
                  .join("")}
              </div>`
            : `<p class="compact-note">No local planning targets yet.</p>`
        }
        <div class="studio-list">${posts.length ? posts.map(renderPostPlan).join("") : `<div class="quiet-state compact"><p>No post plans yet.</p></div>`}</div>
      </article>
    </section>
  `;
}

function renderPublishingSummaryItem(label, count) {
  return `<div><strong>${count}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderPlatformChecks() {
  return `
    <fieldset class="platform-checks">
      <legend>Destinations</legend>
      ${ui.appState.creatorPlatforms
        .map((platform) => {
          // Every publish destination is offered, but only some can be
          // published to. Saying so here is the difference between an informed
          // choice and picking a destination that silently removes the
          // approve-for-publishing button later with no explanation.
          const live = platformEntry(platform.id)?.hasLiveConnector;
          return `
            <label data-destination="${escapeHtml(platform.id)}"><input name="platforms" type="checkbox" value="${escapeHtml(
              platform.id
            )}" /><span>${escapeHtml(platform.name)}${live ? "" : " · export only"}</span></label>
          `;
        })
        .join("")}
      <small class="compact-note">Destinations marked export only have no connector yet. They can be planned and exported for a manual upload, but ProduDash cannot publish to them.</small>
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

// Shows what actually happened per destination. Never claims a publication the
// provider did not confirm, and never renders anything but a safe error code.
function receiptsOf(plan) {
  return asArray(plan.publicationReceipts);
}

// Human wording for the codes a receipt can carry.
//
// Receipts store a code and never a provider message, which is what keeps
// tokens and paths out of them -- but it meant the code itself was rendered, so
// a failure read "Failed · APPROVAL_PREDATES_REQUIRED_OPTIONS". Anything not
// listed here still shows its raw code rather than being swallowed, so a new
// one is merely ugly instead of invisible.
const RECEIPT_ERROR_COPY = {
  UPLOAD_SESSION_UNRESOLVED: "An earlier upload could not be accounted for",
  UPLOAD_SESSION_DISCARDED: "Earlier upload discarded at your request",
  APPROVAL_PREDATES_REQUIRED_OPTIONS: "This approval predates required publishing choices",
  PROVIDER_REJECTED_PUBLICATION: "The provider rejected the upload after accepting it",
  MEDIA_JOB_NOT_READY: "This plan has no rendered video",
  MEDIA_FILE_MISSING: "The rendered video could not be found",
  PUBLISHING_UNSUPPORTED: "This destination cannot publish from ProduDash",
  SECURE_STORAGE_UNAVAILABLE: "Secure storage is unavailable",
  REAUTHORIZATION_REQUIRED: "Reauthorize this destination to continue",
  INTEGRATION_UNAVAILABLE: "This destination has no live connector",
  PUBLISH_FAILED: "The upload did not complete",
  YOUTUBE_AUTH_FAILED: "YouTube rejected the stored authorization",
  YOUTUBE_FORBIDDEN: "YouTube refused this request",
  YOUTUBE_RATE_LIMITED: "YouTube is rate limiting uploads",
  YOUTUBE_SERVER_ERROR: "YouTube had a server error",
  YOUTUBE_REQUEST_REJECTED: "YouTube rejected the request",
  YOUTUBE_TIMEOUT: "YouTube did not respond in time",
  YOUTUBE_NETWORK_ERROR: "The connection to YouTube failed",
  YOUTUBE_NOT_AUTHORIZED: "Authorize YouTube before publishing",
  YOUTUBE_NO_ACCESS_TOKEN: "No YouTube access token is stored",
  YOUTUBE_NO_REFRESH_TOKEN: "No YouTube refresh token is stored",
  YOUTUBE_NO_UPLOAD_SESSION: "YouTube did not open an upload session",
  YOUTUBE_AUDIENCE_DECLARATION_REQUIRED: "The audience declaration is missing",
  YOUTUBE_MEDIA_UNREADABLE: "The rendered video could not be read",
  YOUTUBE_UPLOAD_OFFSET_INVALID: "The resume position was out of bounds",
  YOUTUBE_UPLOAD_CANCELED: "The upload was canceled",
  YOUTUBE_UPLOAD_INTERRUPTED: "The upload was interrupted",
  YOUTUBE_UPLOAD_COMMIT_PENDING: "YouTube has the whole video and is finalizing it",
  YOUTUBE_NO_VIDEO_ID: "YouTube did not return a video id",
  YOUTUBE_VIDEO_NOT_FOUND: "YouTube no longer reports that video",
  YOUTUBE_STATUS_UNAVAILABLE: "The publication status could not be read",
  CONNECTOR_NOT_CONFIGURED: "This destination is not configured"
};

function receiptErrorText(errorCode) {
  if (!errorCode) return "Unknown error";
  return RECEIPT_ERROR_COPY[errorCode] || errorCode;
}

function renderPublicationReceipts(planId, receipts) {
  if (!receipts.length) return "";
  return `
    <div class="publication-receipts">
      <strong>Publication record</strong>
      ${receipts
        .map((receipt) => {
          const outcome =
            receipt.status === "published" && receipt.providerPublicationId
              ? `Published · ${escapeHtml(receipt.providerPublicationId)}`
              : receipt.status === "processing" && receipt.providerPublicationId
                ? `Uploaded · ${escapeHtml(receipt.providerPublicationId)} · the provider is still finalizing it`
                : receipt.status === "failed"
                  ? `Failed · ${escapeHtml(receiptErrorText(receipt.errorCode))}${
                      receipt.retryable ? " · retry available" : " · not retryable"
                    }`
                  : escapeHtml(statusLabel(receipt.status));
          // A processing destination is the one case where asking the provider
          // again changes anything, so the control appears only there.
          const refreshable = receipt.status === "processing" && receipt.providerPublicationId;
          const attempts = asArray(receipt.attempts);
          const last = attempts[attempts.length - 1];
          // The provider could not say whether the earlier attempt published
          // anything, so ProduDash will not guess. Only the person who can look
          // at the destination is able to settle it.
          const unresolved = receipt.status === "failed" && receipt.errorCode === "UPLOAD_SESSION_UNRESOLVED";
          // Offered for every blocked destination, not only the unresolved one:
          // a blocked receipt with no way to clear it is a dead end, and there
          // are several ways to reach one. Never offered once a publication
          // exists -- that id is what stops a retry duplicating the video.
          const discardable = receipt.status === "failed" && receipt.retryable === false && !receipt.providerPublicationId;
          return `<div class="publication-receipt">
            <span>${escapeHtml(platformName(receipt.platformId))}</span>
            <span>${outcome}</span>
            <small>${escapeHtml(
              `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}${last?.endedAt ? ` · last ${formatDate(last.endedAt)}` : ""}`
            )}</small>
            ${
              refreshable
                ? `<button class="ghost-button small" type="button" data-refresh-publication="${escapeHtml(
                    planId
                  )}" data-refresh-platform="${escapeHtml(receipt.platformId)}" data-pending-label="Checking…">Check status</button>`
                : ""
            }
            ${
              discardable && !unresolved
                ? `<button class="ghost-button small" type="button" data-discard-session="${escapeHtml(
                    planId
                  )}" data-discard-platform="${escapeHtml(receipt.platformId)}" data-pending-label="Clearing…">Clear and allow another attempt</button>`
                : ""
            }
            ${
              unresolved
                ? `<small class="compact-note">An earlier upload could not be accounted for. Check ${escapeHtml(
                    platformName(receipt.platformId)
                  )} before retrying.</small>
                   <button class="ghost-button small" type="button" data-discard-session="${escapeHtml(planId)}" data-discard-platform="${escapeHtml(
                     receipt.platformId
                   )}" data-pending-label="Discarding…">Discard and allow a new upload</button>`
                : ""
            }
          </div>`;
        })
        .join("")}
    </div>`;
}

function renderPostPlan(plan) {
  const platforms = asArray(plan.platforms);
  const officialReady = platforms.length > 0 && platforms.every((platform) => integrationReady(platform));
  // Mirrors electron/publishing/post-status.cjs. A dispatch in flight cannot be
  // canceled locally, and published plans are terminal.
  const canCancel = ["needs_approval", "approved_for_manual_export", "approved_for_official_api", "dispatch_failed"].includes(plan.status);
  const editable = plan.status === "needs_approval";
  // A destination the dispatcher marked non-retryable is not made retryable by
  // clicking again. Offering the button anyway meant every click appended an
  // attempt that pushed the genuine early history out of the capped array,
  // destroying the record of what actually happened.
  //
  // Judged across the plan rather than per receipt, because the control is
  // plan-level: it is withheld only when no destination could still make
  // progress. Blocking on `some` stranded a sibling destination that had failed
  // transiently and was perfectly resumable.
  const outstanding = receiptsOf(plan).filter((receipt) => receipt.status !== "published" && receipt.status !== "processing");
  const blocked = outstanding.length > 0 && outstanding.every((receipt) => receipt.status === "failed" && !receipt.retryable);
  const canDispatch = ["approved_for_official_api", "dispatch_failed"].includes(plan.status) && Boolean(plan.approvalSnapshot) && !blocked;
  const receipts = asArray(plan.publicationReceipts);
  const packages = platforms.map(
    (platformId) =>
      asArray(plan.platformPackages).find((item) => item.platformId === platformId) || {
        platformId,
        title: plan.title,
        caption: plan.caption || ""
      }
  );
  return `
    <div class="studio-item post-plan-card">
      <div><strong>${escapeHtml(plan.title)}</strong><span>${escapeHtml(plan.caption || "No caption yet.")}</span><small>${
        platforms.map((item) => escapeHtml(statusLabel(item))).join(", ") || "No destination"
      }</small><small>${escapeHtml(
        plan.mediaSnapshot
          ? `${plan.mediaSnapshot.videos?.length || 0} approved media filename${plan.mediaSnapshot.videos?.length === 1 ? "" : "s"} · ${plan.mediaSnapshot.outputFolderName}`
          : "Copy-only package"
      )}</small></div>
      <div>${renderStatusBadge(plan.status || "pending")}<small>${escapeHtml(
        plan.schedule?.scheduledFor ? `${formatDate(plan.schedule.scheduledFor)} · ${plan.schedule.timeZone}` : "No planning target"
      )}</small></div>
      ${
        editable
          ? renderPostDraftForm(plan, packages)
          : `<div class="post-plan-locked">
              <div class="inline-message neutral">
                <strong>${plan.approvalSnapshot ? "Approved snapshot locked" : "Plan locked"}</strong>
                <span>${
                  plan.approvalSnapshot
                    ? "Destination copy and schedule are read-only after approval. Create a new plan to make changes."
                    : "This plan is no longer editable. Create a new plan to make changes."
                }</span>
              </div>
              ${renderPostPackages(packages)}
            </div>`
      }
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
          plan.status === "approved_for_manual_export" && plan.approvalSnapshot
            ? `<button class="primary-button small" type="button" data-export-post="${escapeHtml(
                plan.id
              )}" data-pending-label="Exporting…">Export approved package…</button>`
            : ""
        }
        ${
          plan.status === "approved_for_manual_export" && !plan.approvalSnapshot
            ? `<span class="compact-note">Recreate this legacy plan to produce a verifiable export snapshot.</span>`
            : ""
        }
        ${
          plan.status === "export_ready" && plan.exportReceipt
            ? `<span class="compact-note">Exported from approval ${escapeHtml(String(plan.exportReceipt.snapshotHash || "").slice(0, 10))}</span>`
            : ""
        }
        ${
          canDispatch
            ? `<button class="primary-button small" type="button" data-dispatch-post="${escapeHtml(plan.id)}" data-pending-label="Publishing…">${
                plan.status === "dispatch_failed" ? "Retry publishing" : "Publish to approved destinations"
              }</button>`
            : ""
        }
        ${
          plan.status === "dispatching"
            ? `<span class="compact-note">Publishing in progress. Do not close ProduDash until it finishes.</span>`
            : ""
        }
        ${
          canCancel
            ? `<button class="text-button danger-text" type="button" data-cancel-post="${escapeHtml(
                plan.id
              )}" data-pending-label="Canceling…">Cancel plan</button>`
            : ""
        }
      </div>
      ${renderPublicationReceipts(plan.id, receipts)}
    </div>
  `;
}

// Per-destination choices the provider requires, rendered from the registry
// definitions carried on the platform catalog. An option with no registry
// default renders with no preselection, so the person has to actually choose.
function renderPublishingOptionFields(item) {
  const definitions = platformEntry(item.platformId)?.publishingOptions;
  if (!definitions) return "";
  return Object.entries(definitions)
    .map(([key, definition]) => {
      const current = item.options?.[key];
      const unset = current === undefined || current === null;
      return `
        <label class="publishing-option" data-publishing-option="${escapeHtml(key)}">
          <span>${escapeHtml(definition.label)}${definition.default === null ? " (required)" : ""}</span>
          <select name="option:${escapeHtml(key)}" ${unset && definition.default === null ? "required" : ""}>
            ${definition.default === null ? `<option value="" ${unset ? "selected" : ""} disabled>Choose…</option>` : ""}
            ${definition.choices
              .map(
                (choice) =>
                  `<option value="${escapeHtml(String(choice.value))}" ${
                    String(choice.value) === String(current) ? "selected" : ""
                  }>${escapeHtml(choice.label)}</option>`
              )
              .join("")}
          </select>
          <small>${escapeHtml(definition.help)}</small>
        </label>
      `;
    })
    .join("");
}

function renderPostDraftForm(plan, packages) {
  return `
    <form class="post-draft-form" data-post-draft-form="${escapeHtml(plan.id)}">
      <div class="post-package-grid">
        ${
          packages.length
            ? packages
                .map(
                  (item) => `
                    <fieldset class="post-package-editor">
                      <legend>${escapeHtml(platformName(item.platformId))}</legend>
                      <input name="platformId" type="hidden" value="${escapeHtml(item.platformId)}" />
                      <label><span>Title</span><input name="platformTitle" maxlength="120" required value="${escapeHtml(
                        item.title
                      )}" /></label>
                      <label><span>Caption</span><textarea name="platformCaption" maxlength="2200">${escapeHtml(
                        item.caption
                      )}</textarea></label>
                      ${renderPublishingOptionFields(item)}
                    </fieldset>
                  `
                )
                .join("")
            : `<p class="compact-note">Add a destination by creating a new plan.</p>`
        }
      </div>
      <label>
        <span>Local planning target</span>
        <input name="scheduledFor" type="datetime-local" value="${escapeHtml(localDateTimeValue(plan.schedule?.scheduledFor))}" />
        <small>Editable until approval. This does not schedule a provider upload.</small>
      </label>
      <button class="ghost-button small" type="submit" data-pending-label="Saving…">Save copy and schedule</button>
    </form>
  `;
}

// The choices frozen into the approval, shown on a locked plan so the approved
// audience and visibility stay visible after editing is closed.
function renderApprovedOptions(item) {
  const definitions = platformEntry(item.platformId)?.publishingOptions;
  if (!definitions || !item.options) return "";
  const parts = Object.entries(definitions).map(([key, definition]) => {
    const value = item.options[key];
    const choice = definition.choices.find((option) => String(option.value) === String(value));
    return `${definition.label}: ${choice ? choice.label : "not chosen"}`;
  });
  return `<small class="approved-options" data-approved-options="${escapeHtml(item.platformId)}">${escapeHtml(parts.join(" · "))}</small>`;
}

function renderPostPackages(packages) {
  if (!packages.length) return `<p class="compact-note">No destination copy is attached.</p>`;
  return `
    <div class="post-package-list">
      ${packages
        .map(
          (item) => `
            <div>
              <strong>${escapeHtml(platformName(item.platformId))}</strong>
              <span>${escapeHtml(item.title)}</span>
              <small>${escapeHtml(item.caption || "No caption.")}</small>
              ${renderApprovedOptions(item)}
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function platformName(platformId) {
  return asArray(ui.appState.creatorPlatforms).find((item) => item.id === platformId)?.name || statusLabel(platformId);
}

function localDateTimeValue(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
