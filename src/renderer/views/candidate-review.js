import { escapeHtml, statusLabel } from "../format.js";
import { asArray, ui } from "../state.js";

const ASPECTS = new Set(["original", "vertical", "square", "landscape"]);
const TREATMENTS = new Set(["original", "fit_pad", "center_crop"]);
const CAPTION_STYLES = new Set(["clean", "contrast", "notebook"]);
const CAPTION_POSITIONS = new Set(["lower", "middle", "upper"]);
const SAFE_AREAS = new Set(["standard", "social"]);

function draftKey(jobId, candidateId) {
  return `${jobId}:${candidateId}`;
}

function allowed(value, values, fallback) {
  return values.has(value) ? value : fallback;
}

function baseDraft(job, candidate) {
  const edit = candidate.edit || {};
  return {
    title: edit.title || candidate.title || "Untitled candidate",
    start: Number(edit.start ?? candidate.start) || 0,
    end: Number(edit.end ?? candidate.end) || 0,
    manualCaptionText: edit.manualCaptionText || "",
    captionSegments: asArray(edit.captionSegments).map((segment) => ({ ...segment })),
    captionStyle: allowed(edit.captionStyle, CAPTION_STYLES, "clean"),
    captionPosition: allowed(edit.captionPosition, CAPTION_POSITIONS, "lower"),
    captionSafeArea: allowed(edit.captionSafeArea, SAFE_AREAS, "standard"),
    aspectTreatment: allowed(edit.aspectTreatment || job.settings?.aspectTreatment, TREATMENTS, "fit_pad"),
    targetAspect: allowed(edit.targetAspect || job.settings?.targetAspect, ASPECTS, "original"),
    selected: asArray(job.selectedCandidateIds).includes(candidate.id),
    rejected: false,
    dirty: false
  };
}

function getDraft(job, candidate) {
  return ui.candidateDrafts.get(draftKey(job.id, candidate.id)) || baseDraft(job, candidate);
}

function editableValues(draft) {
  return {
    title: draft.title,
    start: draft.start,
    end: draft.end,
    manualCaptionText: draft.manualCaptionText,
    captionSegments: draft.captionSegments,
    captionStyle: draft.captionStyle,
    captionPosition: draft.captionPosition,
    captionSafeArea: draft.captionSafeArea,
    aspectTreatment: draft.aspectTreatment,
    targetAspect: draft.targetAspect
  };
}

function formatSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(3)}s` : "Invalid";
}

function renderScores(scores) {
  const entries = Object.entries(scores && typeof scores === "object" ? scores : {}).slice(0, 12);
  if (!entries.length) return `<p class="candidate-score-empty">No component scores were supplied.</p>`;
  return `<dl class="candidate-scores">${entries
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(statusLabel(key))}</dt><dd>${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%</dd></div>`
    )
    .join("")}</dl>`;
}

function renderCaptionEditor(job, candidate, draft) {
  if (job.settings?.captionMode === "off") return `<p class="candidate-caption-note">Captions are off for this job.</p>`;
  if (!draft.captionSegments.length) {
    return `
      <div class="inline-message warning compact">
        <strong>No timestamped transcript</strong>
        <span>Timed captions require transcription. Entering text below is an intentional single-cue manual fallback.</span>
      </div>
      <label><span>Manual caption fallback</span><textarea name="manualCaptionText" maxlength="2000">${escapeHtml(
        draft.manualCaptionText
      )}</textarea></label>
    `;
  }
  return `
    <div class="caption-segment-list" aria-label="Timed caption edits">
      ${draft.captionSegments
        .map(
          (segment, index) => `
            <div class="caption-segment-row" data-caption-segment="${escapeHtml(segment.id || `caption-${index + 1}`)}">
              <label><span>Start</span><input name="captionStart" type="number" min="0" max="${draft.end - draft.start}" step="0.001" value="${escapeHtml(
                segment.start
              )}" /></label>
              <label><span>End</span><input name="captionEnd" type="number" min="0" max="${draft.end - draft.start}" step="0.001" value="${escapeHtml(
                segment.end
              )}" /></label>
              <label class="caption-copy"><span>Caption ${index + 1}</span><textarea name="captionSegmentText" maxlength="240">${escapeHtml(
                segment.text
              )}</textarea></label>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderCandidate(job, candidate) {
  const draft = getDraft(job, candidate);
  const original = candidate.original || candidate;
  const duration = Number(draft.end) - Number(draft.start);
  const previewUrl =
    typeof job.sourcePreviewUrl === "string" && job.sourcePreviewUrl.startsWith("produdash-media://clip/") ? job.sourcePreviewUrl : null;
  const sourceDuration = Math.max(Number(job.sourceDuration) || Number(original.end) || 5, 5);
  return `
    <article class="candidate-editor${draft.rejected ? " is-rejected" : ""}" data-candidate-card="${escapeHtml(candidate.id)}">
      <header>
        <div>
          <span class="eyebrow">Candidate ${escapeHtml(candidate.id.replace(/^candidate-/, ""))}</span>
          <strong>${escapeHtml(draft.title)}</strong>
          <small>${formatSeconds(draft.start)}–${formatSeconds(draft.end)} · ${formatSeconds(duration)}</small>
        </div>
        <span>Confidence ${Math.round(Math.max(0, Math.min(1, Number(candidate.confidence) || 0)) * 100)}%</span>
      </header>
      <div class="candidate-editor-grid">
        <div class="candidate-preview-column">
          <div class="candidate-aspect-preview aspect-${escapeHtml(draft.targetAspect)} treatment-${escapeHtml(
            draft.aspectTreatment
          )}" data-candidate-aspect-preview>
            ${
              previewUrl
                ? `<video preload="metadata" src="${escapeHtml(previewUrl)}" data-candidate-video="${escapeHtml(
                    candidate.id
                  )}" playsinline></video>`
                : `<div class="clip-preview-unavailable"><strong>Preview unavailable</strong><span>The opaque source preview is unavailable.</span></div>`
            }
            ${
              job.settings?.captionMode !== "off"
                ? `<div class="candidate-caption-preview style-${escapeHtml(draft.captionStyle)} position-${escapeHtml(
                    draft.captionPosition
                  )} safe-${escapeHtml(draft.captionSafeArea)}" aria-hidden="true">${escapeHtml(
                    draft.captionSegments[0]?.text || draft.manualCaptionText || "Caption preview"
                  ).replace(/\n/g, "<br />")}</div>`
                : ""
            }
          </div>
          <div class="candidate-playback-controls">
            <button class="ghost-button small" type="button" data-candidate-play="${escapeHtml(candidate.id)}">Play range</button>
            <button class="text-button" type="button" data-candidate-pause="${escapeHtml(candidate.id)}">Pause</button>
            <button class="text-button" type="button" data-candidate-restart="${escapeHtml(candidate.id)}">Restart</button>
          </div>
          <div class="candidate-timeline">
            <label><span>Seek preview</span><input type="range" name="previewSeek" min="0" max="${sourceDuration}" step="0.01" value="${Math.min(
              sourceDuration,
              draft.start
            )}" data-candidate-seek="${escapeHtml(candidate.id)}" /></label>
            <div class="candidate-range-track" aria-label="Suggested and edited candidate range">
              <span>Original ${formatSeconds(original.start)}–${formatSeconds(original.end)}</span>
              <strong>Edited ${formatSeconds(draft.start)}–${formatSeconds(draft.end)}</strong>
            </div>
          </div>
        </div>
        <form class="candidate-edit-form" data-candidate-edit-form="${escapeHtml(job.id)}" data-candidate-id="${escapeHtml(candidate.id)}">
          <label><span>Candidate title</span><input name="title" maxlength="120" required value="${escapeHtml(draft.title)}" /></label>
          <div class="candidate-time-fields">
            <label><span>In point (seconds)</span><input name="start" type="number" min="0" max="${sourceDuration}" step="0.001" required value="${escapeHtml(
              draft.start
            )}" /></label>
            <label><span>Out point (seconds)</span><input name="end" type="number" min="0" max="${sourceDuration}" step="0.001" required value="${escapeHtml(
              draft.end
            )}" /></label>
          </div>
          <div class="candidate-presentation-grid">
            <label><span>Aspect preview</span><select name="targetAspect">
              <option value="original" ${draft.targetAspect === "original" ? "selected" : ""}>Original</option>
              <option value="vertical" ${draft.targetAspect === "vertical" ? "selected" : ""}>9:16</option>
              <option value="square" ${draft.targetAspect === "square" ? "selected" : ""}>1:1</option>
              <option value="landscape" ${draft.targetAspect === "landscape" ? "selected" : ""}>16:9</option>
            </select></label>
            <label><span>Framing</span><select name="aspectTreatment">
              <option value="fit_pad" ${draft.aspectTreatment === "fit_pad" ? "selected" : ""}>Fit and pad</option>
              <option value="center_crop" ${draft.aspectTreatment === "center_crop" ? "selected" : ""}>Center crop</option>
              <option value="original" ${draft.aspectTreatment === "original" ? "selected" : ""}>Original</option>
            </select></label>
          </div>
          ${
            job.settings?.captionMode === "srt_burned"
              ? `<div class="candidate-presentation-grid">
                  <label><span>Caption style</span><select name="captionStyle">
                    <option value="clean" ${draft.captionStyle === "clean" ? "selected" : ""}>Clean</option>
                    <option value="contrast" ${draft.captionStyle === "contrast" ? "selected" : ""}>High contrast</option>
                    <option value="notebook" ${draft.captionStyle === "notebook" ? "selected" : ""}>Notebook</option>
                  </select></label>
                  <label><span>Position</span><select name="captionPosition">
                    <option value="lower" ${draft.captionPosition === "lower" ? "selected" : ""}>Lower</option>
                    <option value="middle" ${draft.captionPosition === "middle" ? "selected" : ""}>Middle</option>
                    <option value="upper" ${draft.captionPosition === "upper" ? "selected" : ""}>Upper</option>
                  </select></label>
                  <label><span>Safe area</span><select name="captionSafeArea">
                    <option value="standard" ${draft.captionSafeArea === "standard" ? "selected" : ""}>Standard</option>
                    <option value="social" ${draft.captionSafeArea === "social" ? "selected" : ""}>Social UI safe</option>
                  </select></label>
                </div>`
              : ""
          }
          ${renderCaptionEditor(job, candidate, draft)}
          <details class="candidate-score-details">
            <summary>Why this candidate</summary>
            <p>${escapeHtml(candidate.rationale || "A deterministic local interval that requires human review.")}</p>
            ${renderScores(candidate.scores)}
          </details>
          <div class="candidate-actions">
            <button class="ghost-button small" type="submit" data-pending-label="Saving…">Save edits</button>
            <button class="text-button" type="button" data-project-from-candidate="${escapeHtml(job.id)}"
              data-candidate-id="${escapeHtml(candidate.id)}">Open as project</button>
            <button class="text-button" type="button" data-candidate-reset="${escapeHtml(candidate.id)}">Reset to suggestion</button>
            <button class="text-button" type="button" data-candidate-select="${escapeHtml(candidate.id)}">Select</button>
            <button class="text-button danger-text" type="button" data-candidate-reject="${escapeHtml(candidate.id)}">Reject</button>
          </div>
        </form>
      </div>
    </article>
  `;
}

export function renderCandidateReview(job) {
  return `
    <section class="candidate-review" data-candidate-review="${escapeHtml(job.id)}">
      <div class="candidate-review-heading">
        <div><strong>Human review required</strong><p>Edit non-destructively, save each candidate, then explicitly select what may render.</p></div>
        <span>Source video is never modified.</span>
      </div>
      <div class="candidate-editor-list">${asArray(job.candidates)
        .map((candidate) => renderCandidate(job, candidate))
        .join("")}</div>
      <form class="candidate-approval-form" data-media-candidates-form="${escapeHtml(job.id)}">
        <fieldset>
          <legend>Approved render selection · choose up to ${Number(job.settings?.maxClips) || 1}</legend>
          ${asArray(job.candidates)
            .map((candidate) => {
              const draft = getDraft(job, candidate);
              return `<label><input type="checkbox" name="candidateIds" value="${escapeHtml(candidate.id)}" ${
                draft.selected && !draft.rejected ? "checked" : ""
              } /><span>${escapeHtml(draft.title)}</span></label>`;
            })
            .join("")}
        </fieldset>
        <button class="primary-button small" type="submit" data-pending-label="Approving…">Approve selected and render</button>
      </form>
    </section>
  `;
}

export function captureCandidateForm(form) {
  if (!(form instanceof HTMLElement) || !form.matches("[data-candidate-edit-form]")) return null;
  const jobId = form.dataset.candidateEditForm;
  const candidateId = form.dataset.candidateId;
  const existing = ui.candidateDrafts.get(draftKey(jobId, candidateId)) || {};
  const captionSegments = [...form.querySelectorAll("[data-caption-segment]")].map((row, index) => ({
    id: row.dataset.captionSegment || `caption-${index + 1}`,
    start: Number(row.querySelector("[name='captionStart']")?.value),
    end: Number(row.querySelector("[name='captionEnd']")?.value),
    text: row.querySelector("[name='captionSegmentText']")?.value || ""
  }));
  const job = asArray(ui.appState.mediaJobs).find((item) => item.id === jobId);
  const candidate = asArray(job?.candidates).find((item) => item.id === candidateId);
  const draft = {
    ...existing,
    title: form.elements.title.value,
    start: Number(form.elements.start.value),
    end: Number(form.elements.end.value),
    manualCaptionText: form.elements.manualCaptionText?.value || "",
    captionSegments,
    captionStyle: allowed(form.elements.captionStyle?.value, CAPTION_STYLES, "clean"),
    captionPosition: allowed(form.elements.captionPosition?.value, CAPTION_POSITIONS, "lower"),
    captionSafeArea: allowed(form.elements.captionSafeArea?.value, SAFE_AREAS, "standard"),
    aspectTreatment: allowed(form.elements.aspectTreatment?.value, TREATMENTS, "fit_pad"),
    targetAspect: allowed(form.elements.targetAspect?.value, ASPECTS, "original"),
    dirty: true
  };
  if (job && candidate) {
    draft.dirty = JSON.stringify(editableValues(draft)) !== JSON.stringify(editableValues(baseDraft(job, candidate)));
  }
  ui.candidateDrafts.set(draftKey(jobId, candidateId), draft);
  return draft;
}

export function captureCandidateDrafts() {
  document.querySelectorAll("[data-candidate-edit-form]").forEach(captureCandidateForm);
}

export function candidateValuesFromForm(form) {
  const draft = captureCandidateForm(form);
  const duration = Math.max(0, Number(draft.end) - Number(draft.start));
  return {
    title: draft.title,
    start: draft.start,
    end: draft.end,
    manualCaptionText: draft.manualCaptionText,
    captionSegments: draft.captionSegments
      .map((segment) => ({
        ...segment,
        start: Math.max(0, Number(segment.start)),
        end: Math.min(duration, Number(segment.end))
      }))
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start),
    captionStyle: draft.captionStyle,
    captionPosition: draft.captionPosition,
    captionSafeArea: draft.captionSafeArea,
    aspectTreatment: draft.aspectTreatment,
    targetAspect: draft.targetAspect
  };
}

export function markCandidateSaved(jobId, candidateId) {
  const key = draftKey(jobId, candidateId);
  const draft = ui.candidateDrafts.get(key);
  if (draft) ui.candidateDrafts.set(key, { ...draft, dirty: false });
}

export function resetCandidateDraft(jobId, candidateId) {
  ui.candidateDrafts.delete(draftKey(jobId, candidateId));
}

export function setCandidateDecision(jobId, candidateId, decision) {
  const job = asArray(ui.appState.mediaJobs).find((item) => item.id === jobId);
  const candidate = asArray(job?.candidates).find((item) => item.id === candidateId);
  if (!job || !candidate) return;
  const current = getDraft(job, candidate);
  const draft = { ...current, selected: decision === "selected", rejected: decision === "rejected", dirty: current.dirty };
  ui.candidateDrafts.set(draftKey(jobId, candidateId), draft);
}

export function hasUnsavedCandidateEdits() {
  return [...ui.candidateDrafts.values()].some((draft) => draft.dirty);
}

export function confirmCandidateNavigation() {
  return !hasUnsavedCandidateEdits() || window.confirm("Leave candidate review and discard unsaved clip edits?");
}
