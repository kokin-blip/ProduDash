import { escapeHtml, formatDate, statusLabel } from "../format.js";
import { asArray, ui } from "../state.js";
import { renderStatusBadge } from "./shared.js";

function seconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const minutes = Math.floor(number / 60);
  const remainder = number - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function renderProjectCreate() {
  const clips = asArray(ui.clipLibrary.clips).filter((clip) => clip.status === "available");
  return `
    <details class="disclosure project-create">
      <summary>Create project</summary>
      <div class="disclosure-content">
        <form data-project-create-form aria-busy="false">
          <div class="form-grid">
            <label><span>Project title</span><input name="title" maxlength="120" required /></label>
            <label><span>Source video</span><select name="sourceMediaId" required>
              <option value="">Choose from Clip Library</option>
              ${clips.map((clip) => `<option value="${escapeHtml(clip.id)}">${escapeHtml(clip.name)}</option>`).join("")}
            </select></label>
          </div>
          <label><span>Description</span><textarea name="description" maxlength="1000"></textarea></label>
          <label><span>Clip instructions</span><textarea name="instructions" maxlength="2000"></textarea></label>
          <label><span>Desired lengths</span><input name="desiredLengths" maxlength="120" placeholder="15s, 30s, 60s" /></label>
          <fieldset class="platform-fieldset">
            <legend>Target platforms</legend>
            ${asArray(ui.appState.creatorPlatforms)
              .map(
                (platform) =>
                  `<label><input type="checkbox" name="platforms" value="${escapeHtml(platform.id)}" /><span>${escapeHtml(
                    platform.name
                  )}</span></label>`
              )
              .join("")}
          </fieldset>
          <button class="primary-button small" type="submit" data-pending-label="Creating…">Create local project</button>
        </form>
      </div>
    </details>
  `;
}

function renderProjectList() {
  const projects = asArray(ui.projects.projects);
  const collections = asArray(ui.projects.collections);
  return `
    <aside class="project-browser" aria-label="Projects">
      <form class="project-filter-form" data-project-filter-form>
        <label><span class="sr-only">Search projects</span><input name="query" type="search" maxlength="200" value="${escapeHtml(
          ui.projectFilters.query
        )}" placeholder="Search projects" /></label>
        <select name="status" aria-label="Project status">
          <option value="">All projects</option>
          <option value="active" ${ui.projectFilters.status === "active" ? "selected" : ""}>Active</option>
          <option value="archived" ${ui.projectFilters.status === "archived" ? "selected" : ""}>Archived</option>
        </select>
        <select name="sort" aria-label="Sort projects">
          <option value="updated_desc" ${ui.projectFilters.sort === "updated_desc" ? "selected" : ""}>Recently edited</option>
          <option value="created_desc" ${ui.projectFilters.sort === "created_desc" ? "selected" : ""}>Recently created</option>
          <option value="title" ${ui.projectFilters.sort === "title" ? "selected" : ""}>Title</option>
        </select>
        <select name="collectionId" aria-label="Project collection">
          <option value="">All collections</option>
          ${collections
            .map(
              (collection) =>
                `<option value="${escapeHtml(collection.id)}" ${
                  ui.projectFilters.collectionId === collection.id ? "selected" : ""
                }>${escapeHtml(collection.name)}</option>`
            )
            .join("")}
        </select>
        <button class="ghost-button small" type="submit">Apply</button>
      </form>
      <form class="project-collection-form" data-project-collection-form>
        <label><span class="sr-only">New collection name</span><input name="name" maxlength="80" required placeholder="New collection" /></label>
        <button class="ghost-button small" type="submit" data-pending-label="Adding…">Add</button>
      </form>
      <div class="project-list">
        ${
          projects.length
            ? projects
                .map(
                  (project) => `
                    <button class="project-row ${project.id === ui.selectedProjectId ? "active" : ""}" type="button"
                      data-project-open="${escapeHtml(project.id)}" aria-current="${project.id === ui.selectedProjectId ? "true" : "false"}">
                      <span><strong>${escapeHtml(project.title)}</strong><small>${escapeHtml(
                        project.source?.name || "Missing source"
                      )} · ${escapeHtml(statusLabel(project.workflowStatus || "draft"))}</small></span>
                      <span>${project.favorite ? "★" : ""}${escapeHtml(String(project.segmentCount || 0))} cuts · ${Math.round(
                        Number(project.progress) || 0
                      )}%</span>
                    </button>
                  `
                )
                .join("")
            : `<div class="empty-row"><strong>No matching projects</strong><span>Create one from a video already in your Clip Library.</span></div>`
        }
      </div>
    </aside>
  `;
}

function renderWaveform(project) {
  const peaks = asArray(project.preparation?.waveform);
  if (!peaks.length) return `<div class="timeline-empty">Prepare locally to generate a waveform and scene boundaries.</div>`;
  const width = 1000;
  const center = 42;
  const step = width / peaks.length;
  const path = peaks
    .map((peak, index) => {
      const x = Number((index * step).toFixed(2));
      const height = Number((Math.max(0.02, Math.min(1, Number(peak) || 0)) * 36).toFixed(2));
      return `M${x} ${center - height}V${center + height}`;
    })
    .join("");
  return `<svg class="project-waveform" viewBox="0 0 1000 84" role="img" aria-label="Local source waveform"><path d="${path}" /></svg>`;
}

function renderTimeline(project) {
  const plan = project.draft;
  const zoom = Math.max(1, Math.min(4, Number(ui.projectTimelineZoom) || 1));
  const total = Math.max(0.001, Number(plan.totalDuration));
  const scale = 1000 / total;
  const sceneLines = asArray(project.preparation?.scenes)
    .flatMap((scene) =>
      plan.segments
        .filter((segment) => scene > segment.sourceStart && scene < segment.sourceEnd)
        .map((segment) => Number(((segment.timelineStart + scene - segment.sourceStart) * scale).toFixed(2)))
    )
    .map((x) => `<line x1="${x}" x2="${x}" y1="0" y2="130" class="scene-line" />`)
    .join("");
  const blocks = asArray(plan.segments)
    .map((segment, index) => {
      const x = Number((segment.timelineStart * scale).toFixed(2));
      const width = Math.max(2, Number((segment.duration * scale).toFixed(2)));
      return `<g data-timeline-segment="${escapeHtml(segment.id)}">
        <rect x="${x}" y="12" width="${width}" height="46" rx="6" class="timeline-segment ${
          ui.selectedProjectSegmentId === segment.id ? "selected" : ""
        }" />
        <text x="${x + 8}" y="40">Cut ${index + 1}</text>
      </g>`;
    })
    .join("");
  const transcriptBlocks = asArray(plan.segments)
    .flatMap((timelineSegment) =>
      asArray(plan.transcript)
        .map((cue) => {
          const start = Math.max(timelineSegment.sourceStart, cue.start);
          const end = Math.min(timelineSegment.sourceEnd, cue.end);
          if (end <= start) return "";
          const timelineStart = timelineSegment.timelineStart + start - timelineSegment.sourceStart;
          const x = Number((timelineStart * scale).toFixed(2));
          const width = Math.max(2, Number(((end - start) * scale).toFixed(2)));
          return `<rect x="${x}" y="70" width="${width}" height="18" rx="3" class="timeline-transcript" aria-label="${escapeHtml(
            cue.text
          )}" />`;
        })
        .filter(Boolean)
    )
    .join("");
  const markerLines = asArray(plan.markers)
    .map((marker) => {
      const x = Number((marker.at * scale).toFixed(2));
      return `<g><line x1="${x}" x2="${x}" y1="94" y2="124" class="marker-line" /><title>${escapeHtml(marker.text)}</title></g>`;
    })
    .join("");
  const commentLines = asArray(plan.comments)
    .map((comment) => {
      const x = Number((comment.at * scale).toFixed(2));
      return `<g><circle cx="${x}" cy="108" r="5" class="comment-point" /><title>${escapeHtml(comment.text)}</title></g>`;
    })
    .join("");
  const playhead = Number((Math.max(0, Math.min(total, ui.projectPlayhead)) * scale).toFixed(2));
  const composition = plan.composition || {};
  const intelligent = plan.intelligentTracks || {};
  const assetTrack = [
    composition.introAssetId
      ? `<rect x="0" y="132" width="${Math.max(6, Math.min(120, scale * 2))}" height="14" rx="3" class="timeline-brand-asset"><title>Intro asset</title></rect>`
      : "",
    composition.music
      ? `<rect x="${Number(composition.music.start * scale).toFixed(2)}" y="150" width="${Math.max(
          2,
          Number((composition.music.end - composition.music.start) * scale).toFixed(2)
        )}" height="14" rx="3" class="timeline-brand-music"><title>Music asset</title></rect>`
      : "",
    ...asArray(composition.overlays)
      .filter((overlay) => overlay.type === "logo")
      .map(
        (overlay) =>
          `<rect x="${Number(overlay.start * scale).toFixed(2)}" y="168" width="${Math.max(
            2,
            Number((overlay.end - overlay.start) * scale).toFixed(2)
          )}" height="14" rx="3" class="timeline-brand-logo"><title>Logo asset</title></rect>`
      ),
    composition.outroAssetId
      ? `<rect x="${Math.max(0, 1000 - Math.max(6, Math.min(120, scale * 2)))}" y="132" width="${Math.max(
          6,
          Math.min(120, scale * 2)
        )}" height="14" rx="3" class="timeline-brand-asset"><title>Outro asset</title></rect>`
      : "",
    ...asArray(intelligent.subject)
      .filter((item) => item.reviewed)
      .map(
        (item) =>
          `<rect x="${Number(item.start * scale).toFixed(2)}" y="186" width="${Math.max(
            2,
            Number((item.end - item.start) * scale).toFixed(2)
          )}" height="14" rx="3" class="timeline-intelligent-subject"><title>Reviewed subject framing</title></rect>`
      ),
    ...asArray(intelligent.audio)
      .filter((item) => item.reviewed)
      .map(
        (item) =>
          `<rect x="${Number(item.start * scale).toFixed(2)}" y="204" width="${Math.max(
            2,
            Number((item.end - item.start) * scale).toFixed(2)
          )}" height="14" rx="3" class="timeline-intelligent-audio"><title>Reviewed local audio treatment</title></rect>`
      ),
    ...asArray(intelligent.broll)
      .filter((item) => item.reviewed)
      .map(
        (item) =>
          `<rect x="${Number(item.start * scale).toFixed(2)}" y="222" width="${Math.max(
            2,
            Number((item.end - item.start) * scale).toFixed(2)
          )}" height="14" rx="3" class="timeline-intelligent-broll"><title>Reviewed Library B-roll</title></rect>`
      ),
    ...asArray(intelligent.sfx)
      .filter((item) => item.reviewed)
      .map(
        (item) =>
          `<rect x="${Number(item.start * scale).toFixed(2)}" y="240" width="${Math.max(
            2,
            Number((item.end - item.start) * scale).toFixed(2)
          )}" height="14" rx="3" class="timeline-intelligent-sfx"><title>Reviewed local sound effect</title></rect>`
      )
  ].join("");
  return `
    <div class="project-timeline-scroll" data-project-timeline-scroll>
      <svg class="project-timeline" viewBox="0 0 1000 260" width="${Math.round(
        1000 * zoom
      )}" role="img" aria-label="Non-destructive project timeline">
        ${sceneLines}${blocks}${transcriptBlocks}${markerLines}${commentLines}${assetTrack}
        <line x1="${playhead}" x2="${playhead}" y1="0" y2="260" class="playhead-line" />
      </svg>
    </div>
    <ol class="sr-only" aria-label="Timeline segments">
      ${asArray(plan.segments)
        .map(
          (segment, index) =>
            `<li>Cut ${index + 1}, source ${seconds(segment.sourceStart)} to ${seconds(segment.sourceEnd)}, timeline ${seconds(
              segment.timelineStart
            )}</li>`
        )
        .join("")}
    </ol>
  `;
}

function renderTranscript(project) {
  const query = ui.projectTranscriptQuery.trim().toLowerCase();
  const segments = asArray(project.draft.transcript).filter((segment) => !query || segment.text.toLowerCase().includes(query));
  return `
    <section class="project-transcript-panel">
      <div class="panel-heading">
        <div class="project-panel-title"><strong>Transcript</strong><span>${project.draft.transcript.length} local cues</span></div>
        <button class="ghost-button small" type="button" data-project-import-transcript="${escapeHtml(project.id)}">Import SRT/VTT</button>
      </div>
      <form class="project-transcript-search" data-project-transcript-search-form>
        <label><span class="sr-only">Search transcript</span><input type="search" name="query" data-project-transcript-search maxlength="200"
          value="${escapeHtml(ui.projectTranscriptQuery)}" placeholder="Search transcript" /></label>
        <button class="ghost-button small" type="submit">Search</button>
      </form>
      <form data-project-transcript-form="${escapeHtml(project.id)}" aria-busy="false">
        <div class="project-transcript-list">
          ${
            segments.length
              ? segments
                  .map(
                    (segment) => `
                      <label class="transcript-cue" data-transcript-cue="${escapeHtml(segment.id)}">
                        <span>${seconds(segment.start)}–${seconds(segment.end)}</span>
                        <textarea name="transcriptText" data-transcript-id="${escapeHtml(segment.id)}" maxlength="2000">${escapeHtml(
                          segment.text
                        )}</textarea>
                      </label>
                    `
                  )
                  .join("")
              : `<div class="empty-row"><strong>No transcript cues</strong><span>Import SRT or VTT to edit text and drive captions.</span></div>`
          }
        </div>
        ${
          project.draft.transcript.length
            ? `<button class="ghost-button small" type="submit" data-pending-label="Saving…">Save transcript corrections</button>`
            : ""
        }
      </form>
    </section>
  `;
}

function renderInspector(project) {
  const selected = project.draft.segments.find((segment) => segment.id === ui.selectedProjectSegmentId) || project.draft.segments[0];
  if (!selected) return "";
  return `
    <aside class="project-inspector">
      <div class="panel-heading"><div class="project-panel-title"><strong>Cut inspector</strong><span>${escapeHtml(
        selected.id
      )}</span></div></div>
      <form data-project-segment-form="${escapeHtml(project.id)}" data-segment-id="${escapeHtml(selected.id)}">
        <label><span>Source in</span><input name="sourceStart" type="number" min="0" max="${project.source.duration}" step="0.001"
          value="${escapeHtml(selected.sourceStart)}" /></label>
        <label><span>Source out</span><input name="sourceEnd" type="number" min="0" max="${project.source.duration}" step="0.001"
          value="${escapeHtml(selected.sourceEnd)}" /></label>
        <button class="ghost-button small" type="submit">Apply trim</button>
      </form>
      <div class="button-row wrap">
        <button class="text-button" type="button" data-project-split="${escapeHtml(selected.id)}">Split at playhead</button>
        <button class="text-button" type="button" data-project-duplicate-segment="${escapeHtml(selected.id)}">Duplicate</button>
        <button class="text-button" type="button" data-project-move-segment="${escapeHtml(selected.id)}" data-direction="-1">Move earlier</button>
        <button class="text-button" type="button" data-project-move-segment="${escapeHtml(selected.id)}" data-direction="1">Move later</button>
        <button class="text-button danger-text" type="button" data-project-delete-segment="${escapeHtml(selected.id)}">Ripple delete</button>
      </div>
      <form data-project-marker-form="${escapeHtml(project.id)}">
        <label><span>Marker at playhead</span><input name="text" maxlength="120" required /></label>
        <button class="ghost-button small" type="submit">Add marker</button>
      </form>
      <form data-project-comment-form="${escapeHtml(project.id)}">
        <label><span>Comment at playhead</span><textarea name="text" maxlength="500" required></textarea></label>
        <button class="ghost-button small" type="submit">Add comment</button>
      </form>
    </aside>
  `;
}

function renderProjectSettings(project) {
  const availableClips = asArray(ui.clipLibrary.clips).filter((clip) => clip.status === "available");
  const composition = project.draft.composition || {
    transition: "cut",
    transitionDuration: 0.25,
    backgroundColor: "#000000",
    overlays: []
  };
  const presentation = {
    captionScale: 1,
    captionTextColor: "#ffffff",
    captionBackgroundColor: "#000000",
    ...project.draft.presentation
  };
  const enhancement = presentation.enhancement || { mode: "off", reviewed: false };
  const assets = asArray(ui.brandAssets);
  const logoOverlay = asArray(composition.overlays).find((overlay) => overlay.type === "logo");
  const subjectTrack = asArray(project.draft.intelligentTracks?.subject).find((item) => item.reviewed);
  const subjectKeyframe = asArray(subjectTrack?.keyframes)[0];
  const audioTrack = asArray(project.draft.intelligentTracks?.audio).find((item) => item.reviewed);
  const brollTrack = asArray(project.draft.intelligentTracks?.broll).find((item) => item.reviewed);
  const sfxTrack = asArray(project.draft.intelligentTracks?.sfx).find((item) => item.reviewed);
  const brollChoices = [
    `<option value="">None</option>`,
    ...(brollTrack && !availableClips.some((clip) => clip.id === brollTrack.mediaId)
      ? [
          `<option value="${escapeHtml(brollTrack.mediaId)}" data-fingerprint="${escapeHtml(
            brollTrack.provenance?.fingerprint || ""
          )}" selected>Saved Library source — currently outside this page</option>`
        ]
      : []),
    ...availableClips
      .filter((clip) => clip.id !== project.source.mediaId)
      .map(
        (clip) =>
          `<option value="${escapeHtml(clip.id)}" data-fingerprint="${escapeHtml(clip.fingerprint || "")}" ${
            clip.id === brollTrack?.mediaId ? "selected" : ""
          }>${escapeHtml(clip.name)}</option>`
      )
  ].join("");
  const assetChoices = (kind, selected) =>
    [
      `<option value="">None</option>`,
      ...(selected && !assets.some((asset) => asset.id === selected && asset.kind === kind && asset.status === "available")
        ? [`<option value="${escapeHtml(selected)}" selected>Missing asset — replace or remove</option>`]
        : []),
      ...assets
        .filter((asset) => asset.kind === kind && asset.status === "available")
        .map(
          (asset) => `<option value="${escapeHtml(asset.id)}" ${asset.id === selected ? "selected" : ""}>${escapeHtml(asset.name)}</option>`
        )
    ].join("");
  return `
    <details class="disclosure">
      <summary>Project details and presentation</summary>
      <div class="disclosure-content">
        <form data-project-settings-form="${escapeHtml(project.id)}" aria-busy="false">
          <div class="form-grid">
            <label><span>Title</span><input name="title" maxlength="120" required value="${escapeHtml(project.title)}" /></label>
            <label><span>Collection</span><select name="collectionId">
              <option value="">No collection</option>
              ${asArray(ui.projects.collections)
                .map(
                  (collection) =>
                    `<option value="${escapeHtml(collection.id)}" ${
                      project.collectionId === collection.id ? "selected" : ""
                    }>${escapeHtml(collection.name)}</option>`
                )
                .join("")}
            </select></label>
          </div>
          <label><span>Description</span><textarea name="description" maxlength="1000">${escapeHtml(project.description)}</textarea></label>
          <label><span>Tags</span><input name="tags" maxlength="400" value="${escapeHtml(asArray(project.tags).join(", "))}" placeholder="launch, tutorial" /></label>
          <label><span>Desired lengths</span><input name="desiredLengths" maxlength="120"
            value="${escapeHtml(asArray(project.desiredLengths).join(", "))}" placeholder="15s, 30s, 60s" /></label>
          <label><span>Instructions</span><textarea name="instructions" maxlength="2000">${escapeHtml(project.instructions)}</textarea></label>
          <fieldset class="platform-fieldset">
            <legend>Target platforms</legend>
            ${asArray(ui.appState.creatorPlatforms)
              .map(
                (platform) =>
                  `<label><input type="checkbox" name="platforms" value="${escapeHtml(platform.id)}" ${
                    asArray(project.platforms).includes(platform.id) ? "checked" : ""
                  } /><span>${escapeHtml(platform.name)}</span></label>`
              )
              .join("")}
          </fieldset>
          <div class="form-grid">
            <label><span>Aspect</span><select name="targetAspect">
              ${["original", "vertical", "square", "landscape"]
                .map(
                  (value) =>
                    `<option value="${value}" ${project.draft.presentation.targetAspect === value ? "selected" : ""}>${escapeHtml(
                      value
                    )}</option>`
                )
                .join("")}
            </select></label>
            <label><span>Framing</span><select name="aspectTreatment">
              ${["original", "fit_pad", "center_crop"]
                .map(
                  (value) =>
                    `<option value="${value}" ${
                      project.draft.presentation.aspectTreatment === value ? "selected" : ""
                    }>${escapeHtml(value.replaceAll("_", " "))}</option>`
                )
                .join("")}
            </select></label>
            <label><span>Captions</span><select name="captionMode">
              <option value="off" ${project.draft.presentation.captionMode === "off" ? "selected" : ""}>Off</option>
              <option value="srt" ${project.draft.presentation.captionMode === "srt" ? "selected" : ""}>SRT</option>
              <option value="srt_burned" ${project.draft.presentation.captionMode === "srt_burned" ? "selected" : ""}>SRT + burned-in</option>
            </select></label>
            <label><span>Caption style</span><select name="captionStyle">
              ${["clean", "contrast", "notebook", "brand"]
                .map(
                  (value) =>
                    `<option value="${value}" ${project.draft.presentation.captionStyle === value ? "selected" : ""}>${escapeHtml(
                      value
                    )}</option>`
                )
                .join("")}
            </select></label>
            <label><span>Caption position</span><select name="captionPosition">
              ${["lower", "middle", "upper"]
                .map(
                  (value) =>
                    `<option value="${value}" ${
                      project.draft.presentation.captionPosition === value ? "selected" : ""
                    }>${escapeHtml(value)}</option>`
                )
                .join("")}
            </select></label>
            <label><span>Caption scale</span><input name="captionScale" type="number" min="0.5" max="2.5" step="0.1"
              value="${escapeHtml(presentation.captionScale)}" /></label>
            <label><span>Caption text</span><input name="captionTextColor" type="color"
              value="${escapeHtml(presentation.captionTextColor)}" /></label>
            <label><span>Caption background</span><input name="captionBackgroundColor" type="color"
              value="${escapeHtml(presentation.captionBackgroundColor)}" /></label>
            <label><span>Transition</span><select name="transition">
              <option value="cut" ${composition.transition === "cut" ? "selected" : ""}>Cut</option>
              <option value="fade" ${composition.transition === "fade" ? "selected" : ""}>Fade</option>
            </select></label>
            <label><span>Transition duration</span><input name="transitionDuration" type="number" min="0.05" max="1.5" step="0.05"
              value="${escapeHtml(composition.transitionDuration)}" /></label>
            <label><span>Canvas color</span><input name="backgroundColor" type="color"
              value="${escapeHtml(composition.backgroundColor)}" /></label>
            <label><span>Local video resize</span><select name="enhancementMode">
              <option value="off" ${enhancement.mode === "resize_hd" ? "" : "selected"}>Off</option>
              <option value="resize_hd" ${enhancement.mode === "resize_hd" ? "selected" : ""}>HD frame resize</option>
            </select></label>
            <label class="checkbox-label"><input name="enhancementReviewed" type="checkbox" ${
              enhancement.reviewed ? "checked" : ""
            } /><span>Apply reviewed local resize</span></label>
            <label><span>Logo track</span><select name="logoAssetId">${assetChoices("logo", logoOverlay?.assetId)}</select></label>
            <label><span>Music track</span><select name="musicAssetId">${assetChoices("music", composition.music?.assetId)}</select></label>
            <label><span>Music volume</span><input name="musicVolume" type="number" min="0.05" max="1" step="0.05"
              value="${escapeHtml(composition.music?.volume || 0.25)}" /></label>
            <label><span>Intro track</span><select name="introAssetId">${assetChoices("intro", composition.introAssetId)}</select></label>
            <label><span>Outro track</span><select name="outroAssetId">${assetChoices("outro", composition.outroAssetId)}</select></label>
            <label><span>Subject framing</span><select name="subjectMode">
              <option value="off" ${subjectTrack ? "" : "selected"}>Off</option>
              <option value="keyframes" ${subjectTrack ? "selected" : ""}>Reviewed focus point</option>
            </select></label>
            <label><span>Subject horizontal position</span><input name="subjectX" type="number" min="0" max="1" step="0.05"
              value="${escapeHtml(subjectKeyframe?.x ?? 0.5)}" /></label>
            <label><span>Subject vertical position</span><input name="subjectY" type="number" min="0" max="1" step="0.05"
              value="${escapeHtml(subjectKeyframe?.y ?? 0.5)}" /></label>
            <label class="checkbox-label"><input name="subjectReviewed" type="checkbox" ${
              subjectTrack ? "checked" : ""
            } /><span>Apply reviewed focus to center crop</span></label>
            <label><span>Audio treatment</span><select name="audioPreset">
              <option value="off" ${audioTrack ? "" : "selected"}>Off</option>
              <option value="voice_cleanup" ${audioTrack?.preset === "voice_cleanup" ? "selected" : ""}>Voice cleanup</option>
              <option value="balanced" ${audioTrack?.preset === "balanced" ? "selected" : ""}>Balanced</option>
              <option value="enhance" ${audioTrack?.preset === "enhance" ? "selected" : ""}>Enhance</option>
            </select></label>
            <label><span>Audio strength</span><input name="audioStrength" type="number" min="0" max="1" step="0.1"
              value="${escapeHtml(audioTrack?.strength ?? 0.5)}" /></label>
            <label class="checkbox-label"><input name="audioReviewed" type="checkbox" ${
              audioTrack ? "checked" : ""
            } /><span>Apply reviewed local audio treatment</span></label>
            <label><span>Library B-roll</span><select name="brollMediaId">${brollChoices}</select></label>
            <label><span>B-roll project start</span><input name="brollStart" type="number" min="0" max="${project.draft.totalDuration}"
              step="0.01" value="${escapeHtml(brollTrack?.start ?? 0)}" /></label>
            <label><span>B-roll project end</span><input name="brollEnd" type="number" min="0.04" max="${project.draft.totalDuration}"
              step="0.01" value="${escapeHtml(brollTrack?.end ?? Math.min(5, project.draft.totalDuration))}" /></label>
            <label><span>B-roll source in</span><input name="brollSourceStart" type="number" min="0" step="0.01"
              value="${escapeHtml(brollTrack?.sourceStart ?? 0)}" /></label>
            <label><span>B-roll fit</span><select name="brollFit">
              <option value="fit_pad" ${brollTrack?.fit === "center_crop" ? "" : "selected"}>Fit / pad</option>
              <option value="center_crop" ${brollTrack?.fit === "center_crop" ? "selected" : ""}>Center crop</option>
            </select></label>
            <label class="checkbox-label"><input name="brollReviewed" type="checkbox" ${
              brollTrack ? "checked" : ""
            } /><span>Apply reviewed Library B-roll</span></label>
            <label><span>Sound effect</span><select name="sfxAssetId">${assetChoices("music", sfxTrack?.assetId)}</select></label>
            <label><span>Sound-effect start</span><input name="sfxStart" type="number" min="0" max="${project.draft.totalDuration}"
              step="0.01" value="${escapeHtml(sfxTrack?.start ?? 0)}" /></label>
            <label><span>Sound-effect end</span><input name="sfxEnd" type="number" min="0.04" max="${project.draft.totalDuration}"
              step="0.01" value="${escapeHtml(sfxTrack?.end ?? Math.min(2, project.draft.totalDuration))}" /></label>
            <label><span>Sound-effect volume</span><input name="sfxVolume" type="number" min="0" max="1" step="0.05"
              value="${escapeHtml(sfxTrack?.volume ?? 0.5)}" /></label>
            <label class="checkbox-label"><input name="sfxReviewed" type="checkbox" ${
              sfxTrack ? "checked" : ""
            } /><span>Apply reviewed local sound effect</span></label>
          </div>
          <p class="form-note">Subject focus only adjusts center-crop framing. Audio treatment, sound effects, and HD resizing run locally. Resizing may upscale or downscale pixels but does not recover missing detail. B-roll is copied from your Library into the approved render snapshot. None are applied until reviewed.</p>
          <button class="ghost-button small" type="submit" data-pending-label="Saving…">Save project details</button>
        </form>
        <div class="project-overlay-editor">
          <div>
            <strong>Text and CTA overlays</strong>
            <span>${asArray(composition.overlays).length} local overlay${
              asArray(composition.overlays).length === 1 ? "" : "s"
            }${project.draft.templateRef ? ` · template v${project.draft.templateRef.version}` : ""}</span>
          </div>
          <form data-project-overlay-form="${escapeHtml(project.id)}">
            <label><span>Type</span><select name="type"><option value="text">Text</option><option value="cta">Call to action</option></select></label>
            <label><span>Text</span><input name="text" maxlength="240" required /></label>
            <label><span>Start</span><input name="start" type="number" min="0" max="${project.draft.totalDuration}" step="0.01" value="0" /></label>
            <label><span>End</span><input name="end" type="number" min="0.04" max="${project.draft.totalDuration}" step="0.01"
              value="${project.draft.totalDuration}" /></label>
            <label><span>Position</span><select name="position"><option value="upper">Upper</option><option value="middle">Middle</option>
              <option value="lower" selected>Lower</option></select></label>
            <button class="ghost-button small" type="submit">Add overlay</button>
          </form>
          <div class="divided-list">
            ${asArray(composition.overlays)
              .map(
                (overlay) => `<div class="compact-row static-row">
                  <span><strong>${escapeHtml(overlay.text || "Logo overlay")}</strong><small>${escapeHtml(overlay.type)} · ${seconds(
                    overlay.start
                  )}–${seconds(overlay.end)}</small></span>
                  <button class="text-button danger-text" type="button" data-project-overlay-delete="${escapeHtml(
                    overlay.id
                  )}">Remove</button>
                </div>`
              )
              .join("")}
          </div>
        </div>
      </div>
    </details>
    ${
      project.source.status === "available"
        ? ""
        : `<div class="inline-message warning"><strong>Source needs relinking</strong>
            <span>Choose the matching media already indexed in the Clip Library. ProduDash validates its duration first.</span>
            <form data-project-relink-form="${escapeHtml(project.id)}">
              <select name="sourceMediaId" required><option value="">Choose available Library media</option>
                ${availableClips.map((clip) => `<option value="${escapeHtml(clip.id)}">${escapeHtml(clip.name)}</option>`).join("")}
              </select>
              <button class="ghost-button small" type="submit" data-pending-label="Validating…">Relink source</button>
            </form>
          </div>`
    }
  `;
}

function renderLocalization(project) {
  const localization = project.draft.localization || { sourceLanguage: "und", activeVariantId: null, variants: [] };
  const transcript = asArray(project.draft.transcript);
  const translationProviders = asArray(ui.appState.aiProviders).flatMap((profile) =>
    profile.status === "connected"
      ? asArray(profile.models)
          .filter(
            (model) => asArray(model.capabilities).includes("text_generation") && asArray(model.capabilities).includes("structured_output")
          )
          .map((model) => ({ profile, model }))
      : []
  );
  const speechProviders = asArray(ui.appState.aiProviders).flatMap((profile) =>
    profile.status === "connected"
      ? asArray(profile.models)
          .filter((model) => asArray(model.capabilities).includes("speech_generation"))
          .map((model) => ({ profile, model }))
      : []
  );
  const conversionProviders = asArray(ui.appState.aiProviders).flatMap((profile) =>
    profile.status === "connected"
      ? asArray(profile.models)
          .filter((model) => asArray(model.capabilities).includes("voice_conversion"))
          .map((model) => ({ profile, model }))
      : []
  );
  const voiceovers = asArray(localization.voiceovers);
  const builtInVoices = ["marin", "cedar", "coral", "alloy", "ash", "ballad", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
  const customVoices = asArray(ui.appState.voiceLikeness?.voices);
  const speakers = [...new Set(transcript.map((cue) => String(cue.speaker || "").trim()).filter(Boolean))];
  const voiceOptions = speechProviders.flatMap(({ profile, model }) => {
    const options = [];
    if (profile.providerType === "openai") {
      options.push(...builtInVoices.map((voice) => ({ profile, model, voice, label: `${voice} — built-in` })));
    }
    if (profile.providerType === "openai-compatible" && profile.publicValues?.voiceId) {
      options.push({
        profile,
        model,
        voice: profile.publicValues.voiceId,
        label: `${profile.publicValues.voiceId} — configured runtime voice`
      });
    }
    if (profile.providerType === "piper-local") {
      options.push({
        profile,
        model,
        voice: "configured-model",
        label: "configured local model"
      });
    }
    if (profile.providerType === "kokoro-local" && profile.publicValues?.voiceId) {
      options.push({
        profile,
        model,
        voice: profile.publicValues.voiceId,
        label: `${profile.publicValues.voiceId} — configured local voice`
      });
    }
    options.push(
      ...customVoices
        .filter((voice) => voice.providerProfileId === profile.id)
        .map((voice) => ({ profile, model, voice: voice.id, label: `${voice.name} — custom likeness` }))
    );
    return options;
  });
  const customVoiceProfiles = [
    ...new Map(
      speechProviders
        .filter(({ profile }) => ["openai", "elevenlabs"].includes(profile.providerType))
        .map(({ profile }) => [profile.id, profile])
    ).values()
  ];
  const localLikenessProfiles = [
    ...new Map(
      speechProviders.filter(({ profile }) => ["xtts-local"].includes(profile.providerType)).map(({ profile }) => [profile.id, profile])
    ).values()
  ];
  const likenessAccepted = ui.appState.voiceLikeness?.acceptance?.termsVersion === "2026-07-24";
  return `
    <details class="disclosure project-localization">
      <summary>Localized captions (${asArray(localization.variants).length})</summary>
      <div class="disclosure-content">
        <div class="inline-message">
          <strong>Human review required</strong>
          <span>Language variants change caption text only. They do not create voiceovers or alter the source audio.</span>
        </div>
        ${
          transcript.length
            ? `<form class="localization-create-form" data-project-localization-create="${escapeHtml(project.id)}">
                <label><span>Source language</span><input name="sourceLanguage" maxlength="35" required
                  value="${escapeHtml(localization.sourceLanguage || "und")}" placeholder="en-US" /></label>
                <label><span>Variant language</span><input name="language" maxlength="35" required placeholder="es-MX" /></label>
                <label><span>Variant label</span><input name="label" maxlength="80" required placeholder="Spanish (Mexico)" /></label>
                <button class="ghost-button small" type="submit">Create manual draft</button>
              </form>
              <form class="localization-create-form" data-project-localization-translate="${escapeHtml(project.id)}">
                <label><span>Translation provider</span><select name="providerSelection" required>
                  <option value="">Choose a connected model</option>
                  ${translationProviders
                    .map(
                      ({ profile, model }) =>
                        `<option value="${escapeHtml(`${profile.id}::${model.id}`)}">${escapeHtml(profile.name)} · ${escapeHtml(
                          model.name || model.id
                        )}</option>`
                    )
                    .join("")}
                </select></label>
                <label><span>Target language</span><input name="targetLanguage" maxlength="35" required placeholder="es-MX" /></label>
                <label><span>Variant label</span><input name="label" maxlength="80" required placeholder="Spanish (Mexico)" /></label>
                <label class="checkbox-label localization-consent">
                  <input name="consent" type="checkbox" required />
                  <span>Send this project’s transcript text to the selected provider and model for this translation only.</span>
                </label>
                <button class="ghost-button small" type="submit" data-pending-label="Translating…" ${
                  translationProviders.length ? "" : "disabled"
                }>Create provider draft</button>
                ${
                  translationProviders.length
                    ? ""
                    : `<small>Connect and validate a model with text and structured-output capabilities in Integrations first.</small>`
                }
              </form>`
            : `<div class="empty-row"><strong>Transcript required</strong><span>Import or add transcript cues before creating a language variant.</span></div>`
        }
        <div class="localization-variants">
          ${
            asArray(localization.variants)
              .map(
                (variant) => `
                <form class="localization-variant" data-project-localization-form="${escapeHtml(project.id)}"
                  data-localization-id="${escapeHtml(variant.id)}">
                  <div class="panel-heading">
                    <span><strong>${escapeHtml(variant.label)}</strong><small>${escapeHtml(variant.language)} · ${
                      variant.provenance?.source === "provider" ? "Provider draft" : "Manual draft"
                    }</small></span>
                    ${renderStatusBadge(
                      localization.activeVariantId === variant.id ? "connected" : variant.status === "reviewed" ? "approved" : "pending",
                      localization.activeVariantId === variant.id ? "Selected for render" : variant.status
                    )}
                  </div>
                  <div class="localized-cue-list">
                    ${transcript
                      .map((cue) => {
                        const localized = asArray(variant.cues).find((item) => item.sourceId === cue.id);
                        return `<label class="localized-cue">
                          <span>${seconds(cue.start)}–${seconds(cue.end)} · ${escapeHtml(cue.text)}</span>
                          <textarea data-localized-source-id="${escapeHtml(cue.id)}" maxlength="2000" required>${escapeHtml(
                            localized?.text || ""
                          )}</textarea>
                        </label>`;
                      })
                      .join("")}
                  </div>
                  <div class="button-row wrap">
                    <label class="checkbox-label"><input name="reviewed" type="checkbox" ${
                      variant.status === "reviewed" ? "checked" : ""
                    } /><span>Reviewed by a person</span></label>
                    <label class="checkbox-label"><input name="active" type="checkbox" ${
                      localization.activeVariantId === variant.id ? "checked" : ""
                    } /><span>Use for next render</span></label>
                    <button class="ghost-button small" type="submit">Save language variant</button>
                    <button class="text-button danger-text" type="button" data-project-localization-delete="${escapeHtml(
                      variant.id
                    )}">Remove</button>
                  </div>
                </form>
              `
              )
              .join("") ||
            `<div class="empty-row"><strong>No language variants</strong><span>Create a manual caption draft to begin local review.</span></div>`
          }
        </div>
        <div class="project-voiceovers">
          <div class="panel-heading">
            <div class="project-panel-title"><strong>AI voice previews</strong><span>${voiceovers.length} local draft${
              voiceovers.length === 1 ? "" : "s"
            }</span></div>
          </div>
          <div class="inline-message warning">
            <strong>AI-generated voice</strong>
            <span>Every preview is synthetic, including voice-likeness previews. Review and disclose AI-generated audio before publishing.</span>
          </div>
          <div class="button-row wrap">
            <button class="ghost-button small" type="button" data-custom-voice-open ${
              customVoiceProfiles.length ? "" : "disabled"
            }>Create custom voice likeness</button>
            <button class="ghost-button small" type="button" data-local-likeness-open ${
              localLikenessProfiles.length ? "" : "disabled"
            }>Authorize configured local likeness</button>
            <small>${
              customVoiceProfiles.length
                ? `${customVoices.length} authorized custom voice${customVoices.length === 1 ? "" : "s"} in ProduDash`
                : "Connect and validate OpenAI or ElevenLabs speech first."
            }</small>
          </div>
          ${
            customVoices.length
              ? `<div class="divided-list">
                  ${customVoices
                    .map((voice) => {
                      const provider = ui.appState.aiProviders.find((item) => item.id === voice.providerProfileId);
                      return `<div class="compact-row">
                        <span><strong>${escapeHtml(voice.name)}</strong><small>${escapeHtml(
                          provider?.name || voice.providerType || "Voice provider"
                        )} · Synthetic likeness</small></span>
                        <button class="text-button danger-text" type="button"
                          data-custom-voice-remove="${escapeHtml(voice.id)}"
                          data-provider-profile-id="${escapeHtml(voice.providerProfileId)}"
                          data-provider-type="${escapeHtml(voice.providerType || provider?.providerType || "")}"
                          data-pending-label="Removing…">Remove voice</button>
                      </div>`;
                    })
                    .join("")}
                </div>`
              : ""
          }
          <dialog class="voice-likeness-dialog" data-custom-voice-dialog>
            <form method="dialog" data-custom-voice-form>
              <div class="panel-heading">
                <div><h2>Create a synthetic voice likeness</h2><p>This sends two recordings to the selected provider. ProduDash does not keep either source file.</p></div>
                <button class="icon-button" type="button" aria-label="Close" data-custom-voice-close>×</button>
              </div>
              ${
                likenessAccepted
                  ? `<div class="inline-message"><strong>First-use terms accepted</strong><span>The provider still requires a new matching consent recording for this voice.</span></div>`
                  : `<div class="voice-likeness-terms">
                      <p><strong>Read before continuing.</strong> Voice likenesses can be mistaken for real speech. Only create one for yourself or an adult who has expressly authorized you. Do not use it to impersonate, deceive, defraud, harass, bypass verification, or falsely imply an endorsement.</p>
                      <p>For OpenAI, the voice owner must personally read this exact provider sentence:</p>
                      <blockquote>I am the owner of this voice and I consent to OpenAI using this voice to create a synthetic voice model.</blockquote>
                      <p>For ElevenLabs, record the voice owner stating that they own the voice and expressly authorize ProduDash and ElevenLabs to create and use its synthetic likeness.</p>
                      <p>You will then choose a separate matching sample recording. Both files are handled under the selected provider’s terms and retention practices. Provider safeguards do not replace your responsibility to obtain permission, follow applicable publicity/privacy/biometric laws, and clearly disclose synthetic audio wherever required.</p>
                      <label><span>Consenting adult’s full legal name</span><input name="legalName" maxlength="120" required /></label>
                      <label><span>Your relationship to the voice</span><select name="relationship">
                        <option value="self">I am the voice owner</option>
                        <option value="authorized_representative">I am the authorized representative</option>
                      </select></label>
                      <label class="checkbox-label"><input name="adultConfirmed" type="checkbox" required /><span>The voice owner is an adult with capacity to consent.</span></label>
                      <label class="checkbox-label"><input name="rightsConfirmed" type="checkbox" required /><span>I own this voice or hold documented authority from its owner.</span></label>
                      <label class="checkbox-label"><input name="consentConfirmed" type="checkbox" required /><span>The voice owner knowingly agrees to creation and use of a synthetic likeness.</span></label>
                      <label class="checkbox-label"><input name="syntheticDisclosureConfirmed" type="checkbox" required /><span>I will clearly disclose AI-generated or synthetic audio when context requires it.</span></label>
                      <label class="checkbox-label"><input name="misuseResponsibilityConfirmed" type="checkbox" required /><span>I will not use this feature for impersonation, fraud, deception, harassment, or identity verification.</span></label>
                      <label class="checkbox-label"><input name="providerTermsConfirmed" type="checkbox" required /><span>I agree to the provider’s applicable terms, including its text-to-speech supplemental terms.</span></label>
                    </div>`
              }
              <label><span>Voice name</span><input name="name" maxlength="64" required placeholder="My authorized voice" /></label>
              <label><span>Voice provider</span><select name="providerProfileId" required>
                ${customVoiceProfiles
                  .map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`)
                  .join("")}
              </select></label>
              <input name="language" type="hidden" value="en" />
              <div class="inline-message neutral"><strong>Two file selections follow</strong><span>First choose the exact consent recording, then a separate matching sample. Each must be 30 seconds or less.</span></div>
              <div class="button-row">
                <button class="primary-button small" type="submit" data-pending-label="Creating voice…">Accept and choose recordings</button>
                <button class="ghost-button small" type="button" data-custom-voice-close>Cancel</button>
              </div>
            </form>
          </dialog>
          <dialog class="voice-likeness-dialog" data-local-likeness-dialog>
            <form method="dialog" data-local-likeness-form>
              <div class="panel-heading">
                <div>
                  <h2>Authorize a configured local voice likeness</h2>
                  <p>The selected reference WAV stays on this computer. ProduDash retains its encrypted path, not a copy of the recording.</p>
                </div>
                <button class="icon-button" type="button" aria-label="Close" data-local-likeness-close>×</button>
              </div>
              ${
                likenessAccepted
                  ? `<div class="inline-message"><strong>First-use terms accepted</strong><span>Authorization remains limited to the configured local reference and your intended lawful use.</span></div>`
                  : `<div class="voice-likeness-terms">
                      <p><strong>Read every term before continuing.</strong> Local voice cloning can produce speech that listeners may mistake for a real recording. Only configure and use a reference voice that belongs to you or an adult who has expressly authorized this synthetic use.</p>
                      <p>Do not use this feature to impersonate, deceive, defraud, harass, evade verification, fabricate consent, create false endorsements, or misrepresent who said something. Local execution and model safeguards do not replace your responsibility.</p>
                      <p>Voice data may be protected by privacy, publicity, biometric, employment, consumer-protection, election, or criminal laws. Keep written authorization, honor withdrawal requests, review every runtime/model license, and disclose synthetic audio whenever context or law requires it.</p>
                      <label><span>Consenting adult’s full legal name</span><input name="legalName" maxlength="120" required /></label>
                      <label><span>Your relationship to the voice</span><select name="relationship">
                        <option value="self">I am the voice owner</option>
                        <option value="authorized_representative">I am the authorized representative</option>
                      </select></label>
                      <label class="checkbox-label"><input name="adultConfirmed" type="checkbox" required /><span>The voice owner is an adult with capacity to consent.</span></label>
                      <label class="checkbox-label"><input name="rightsConfirmed" type="checkbox" required /><span>I own or have documented authority to use the configured reference and likeness.</span></label>
                      <label class="checkbox-label"><input name="consentConfirmed" type="checkbox" required /><span>The voice owner knowingly authorizes local synthetic voice generation and its intended use.</span></label>
                      <label class="checkbox-label"><input name="syntheticDisclosureConfirmed" type="checkbox" required /><span>I will clearly disclose synthetic audio wherever context or law requires it.</span></label>
                      <label class="checkbox-label"><input name="misuseResponsibilityConfirmed" type="checkbox" required /><span>I will not use this feature for impersonation, fraud, deception, harassment, false endorsement, or verification bypass.</span></label>
                      <label class="checkbox-label"><input name="providerTermsConfirmed" type="checkbox" required /><span>I have reviewed and agree to the selected runtime, model, and applicable third-party terms and licenses.</span></label>
                    </div>`
              }
              <label><span>Configured local provider</span><select name="providerProfileId" required>
                ${localLikenessProfiles
                  .map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`)
                  .join("")}
              </select></label>
              <label><span>Authorized voice name</span><input name="name" maxlength="64" required placeholder="My authorized local voice" /></label>
              <div class="button-row">
                <button class="primary-button small" type="submit" data-pending-label="Authorizing…">Accept and authorize locally</button>
                <button class="ghost-button small" type="button" data-local-likeness-close>Cancel</button>
              </div>
            </form>
          </dialog>
          ${
            transcript.length
              ? `<form class="localization-create-form" data-project-voiceover-create="${escapeHtml(project.id)}">
                  <label><span>Transcript cue</span><select name="sourceId" required>
                    ${transcript
                      .map(
                        (cue) =>
                          `<option value="${escapeHtml(cue.id)}">${seconds(cue.start)}–${seconds(cue.end)} · ${escapeHtml(
                            cue.text.slice(0, 80)
                          )}</option>`
                      )
                      .join("")}
                  </select></label>
                  <label><span>Language text</span><select name="variantId">
                    <option value="">Source transcript</option>
                    ${asArray(localization.variants)
                      .filter((variant) => variant.status === "reviewed")
                      .map((variant) => `<option value="${escapeHtml(variant.id)}">${escapeHtml(variant.label)}</option>`)
                      .join("")}
                  </select></label>
                  <label><span>Provider, model, and voice</span><select name="voiceSelection" required>
                    <option value="">Choose a compatible voice</option>
                    ${voiceOptions
                      .map(
                        ({ profile, model, voice, label }) =>
                          `<option value="${escapeHtml(`${profile.id}::${model.id}::${voice}`)}">${escapeHtml(
                            `${profile.name} · ${model.name || model.id} · ${label}`
                          )}</option>`
                      )
                      .join("")}
                  </select></label>
                  <label><span>Voice direction</span><input name="instructions" maxlength="500" placeholder="Speak clearly and naturally." /></label>
                  <label class="checkbox-label localization-consent">
                    <input name="consent" type="checkbox" required />
                    <span>Provide this cue to the selected local or cloud speech provider for this preview and acknowledge the result is AI-generated, not a human recording.</span>
                  </label>
                  <button class="ghost-button small" type="submit" data-pending-label="Generating…" ${
                    voiceOptions.length ? "" : "disabled"
                  }>Generate preview</button>
                </form>`
              : ""
          }
          ${
            speakers.length && transcript.length
              ? `<form class="localization-create-form" data-project-speaker-voiceovers="${escapeHtml(project.id)}">
                  <label><span>Transcript speaker</span><select name="speaker" required>
                    ${speakers.map((speaker) => `<option value="${escapeHtml(speaker)}">${escapeHtml(speaker)}</option>`).join("")}
                  </select></label>
                  <label><span>Language text</span><select name="variantId">
                    <option value="">Source transcript</option>
                    ${asArray(localization.variants)
                      .filter((variant) => variant.status === "reviewed")
                      .map((variant) => `<option value="${escapeHtml(variant.id)}">${escapeHtml(variant.label)}</option>`)
                      .join("")}
                  </select></label>
                  <label><span>Provider, model, and voice</span><select name="voiceSelection" required>
                    <option value="">Choose a compatible voice</option>
                    ${voiceOptions
                      .map(
                        ({ profile, model, voice, label }) =>
                          `<option value="${escapeHtml(`${profile.id}::${model.id}::${voice}`)}">${escapeHtml(
                            `${profile.name} · ${model.name || model.id} · ${label}`
                          )}</option>`
                      )
                      .join("")}
                  </select></label>
                  <label><span>Voice direction</span><input name="instructions" maxlength="500" placeholder="Keep this speaker consistent." /></label>
                  <label class="checkbox-label localization-consent">
                    <input name="consent" type="checkbox" required />
                    <span>Provide up to 12 unvoiced cues from this speaker to the selected local or cloud provider. Every result remains a draft requiring individual review.</span>
                  </label>
                  <button class="ghost-button small" type="submit" data-pending-label="Generating speaker drafts…" ${
                    voiceOptions.length ? "" : "disabled"
                  }>Generate speaker drafts</button>
                </form>`
              : ""
          }
          <div class="localization-variants">
            ${
              voiceovers
                .map((voiceover) => {
                  const asset = asArray(ui.brandAssets).find((item) => item.id === voiceover.assetId);
                  return `<form class="localization-variant" data-project-voiceover-form="${escapeHtml(project.id)}"
                    data-voiceover-id="${escapeHtml(voiceover.id)}">
                    <div class="panel-heading">
                      <span><strong>${escapeHtml(voiceover.provenance.voice)} voice</strong><small>${seconds(
                        voiceover.start
                      )}–${seconds(voiceover.end)} · AI-generated</small></span>
                      ${renderStatusBadge(voiceover.status === "reviewed" ? "approved" : "pending", voiceover.status)}
                    </div>
                    ${
                      asset?.previewUrl
                        ? `<audio controls preload="metadata" src="${escapeHtml(asset.previewUrl)}">Voice preview playback is unavailable.</audio>`
                        : `<div class="inline-message error"><span>The generated audio is missing. Remove this preview and generate it again.</span></div>`
                    }
                    <div class="button-row wrap">
                      <label class="checkbox-label"><input name="reviewed" type="checkbox" ${
                        voiceover.status === "reviewed" ? "checked" : ""
                      } /><span>Reviewed for render</span></label>
                      <label><span>Original audio</span><select name="originalAudio">
                        <option value="mix" ${voiceover.originalAudio === "replace" ? "" : "selected"}>Mix underneath</option>
                        <option value="replace" ${voiceover.originalAudio === "replace" ? "selected" : ""}>Replace during preview</option>
                      </select></label>
                      <label><span>Volume</span><input name="volume" type="number" min="0" max="1" step="0.05"
                        value="${escapeHtml(voiceover.volume)}" /></label>
                      <button class="ghost-button small" type="submit">Save voice preview</button>
                      <button class="ghost-button small" type="button" data-rvc-voiceover-open="${escapeHtml(voiceover.id)}" ${
                        conversionProviders.length ? "" : "disabled"
                      }>Convert with RVC</button>
                      <button class="text-button danger-text" type="button" data-project-voiceover-delete="${escapeHtml(
                        voiceover.id
                      )}">Delete audio</button>
                    </div>
                  </form>`;
                })
                .join("") ||
              `<div class="empty-row"><strong>No voice previews</strong><span>Generate a disclosed built-in voice draft for one transcript cue.</span></div>`
            }
          </div>
          <dialog class="voice-likeness-dialog" data-rvc-voiceover-dialog>
            <form method="dialog" data-rvc-voiceover-form>
              <input name="voiceoverId" type="hidden" />
              <div class="panel-heading">
                <div>
                  <h2>Convert a voice preview with RVC</h2>
                  <p>RVC transforms the selected local WAV preview through your configured local model. The original preview remains unchanged.</p>
                </div>
                <button class="icon-button" type="button" aria-label="Close" data-rvc-voiceover-close>×</button>
              </div>
              ${
                likenessAccepted
                  ? `<div class="inline-message"><strong>First-use terms accepted</strong><span>You must still confirm authorization and disclosure for this conversion.</span></div>`
                  : `<div class="voice-likeness-terms">
                      <p><strong>Read every term before continuing.</strong> RVC can make speech sound like another person and the result may be mistaken for a real recording. Only use a model and source audio that belong to you or that an adult has expressly authorized you to use.</p>
                      <p>Do not use voice conversion to impersonate, deceive, defraud, harass, evade identity or security checks, fabricate consent, create false endorsements, or misrepresent who said something. Provider or model safeguards do not replace your legal and ethical responsibility.</p>
                      <p>Depending on where you and the voice owner live, voice data may be protected by privacy, publicity, biometric, employment, consumer-protection, election, or criminal laws. Keep written authorization, honor withdrawal requests, follow the RVC model/runtime licenses, and clearly disclose synthetic or converted audio whenever context requires it.</p>
                      <label><span>Consenting adult’s full legal name</span><input name="legalName" maxlength="120" required /></label>
                      <label><span>Your relationship to the voice</span><select name="relationship">
                        <option value="self">I am the voice owner</option>
                        <option value="authorized_representative">I am the authorized representative</option>
                      </select></label>
                      <label class="checkbox-label"><input name="adultConfirmed" type="checkbox" required /><span>The voice owner is an adult with capacity to consent.</span></label>
                      <label class="checkbox-label"><input name="rightsConfirmed" type="checkbox" required /><span>I own or have documented authority to use the source audio, voice likeness, and configured model.</span></label>
                      <label class="checkbox-label"><input name="consentConfirmed" type="checkbox" required /><span>The voice owner knowingly authorizes synthetic voice conversion and its intended use.</span></label>
                      <label class="checkbox-label"><input name="syntheticDisclosureConfirmed" type="checkbox" required /><span>I will clearly disclose converted or synthetic audio wherever context or law requires it.</span></label>
                      <label class="checkbox-label"><input name="misuseResponsibilityConfirmed" type="checkbox" required /><span>I will not use this feature for impersonation, fraud, deception, harassment, false endorsement, or verification bypass.</span></label>
                      <label class="checkbox-label"><input name="providerTermsConfirmed" type="checkbox" required /><span>I have reviewed and agree to the runtime, model, and applicable third-party terms and licenses.</span></label>
                    </div>`
              }
              <label><span>Local RVC provider</span><select name="providerSelection" required>
                ${conversionProviders
                  .map(
                    ({ profile, model }) =>
                      `<option value="${escapeHtml(`${profile.id}::${model.id}`)}">${escapeHtml(profile.name)} · ${escapeHtml(
                        model.name || model.id
                      )}</option>`
                  )
                  .join("")}
              </select></label>
              <label><span>Authorized converted voice name</span><input name="voiceName" maxlength="64" required placeholder="My authorized RVC voice" /></label>
              <label class="checkbox-label">
                <input name="conversionConsent" type="checkbox" required />
                <span>I confirm this source audio and model are authorized, and I will review and disclose the synthetic result before use.</span>
              </label>
              <div class="button-row">
                <button class="primary-button small" type="submit" data-pending-label="Converting…">Accept and convert locally</button>
                <button class="ghost-button small" type="button" data-rvc-voiceover-close>Cancel</button>
              </div>
            </form>
          </dialog>
        </div>
      </div>
    </details>
  `;
}

function renderVersions(project) {
  return `
    <details class="disclosure">
      <summary>Version history (${project.versions.length})</summary>
      <div class="disclosure-content divided-list">
        ${asArray(project.versions)
          .slice()
          .reverse()
          .map(
            (version) => `<div class="compact-row static-row">
              <span><strong>${escapeHtml(version.label)}</strong><small>Revision ${version.revision} · ${formatDate(version.savedAt)}</small></span>
              <button class="text-button" type="button" data-project-restore-version="${escapeHtml(version.id)}">Restore as draft</button>
            </div>`
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderEditor(project) {
  const composition = project.draft.composition || { overlays: [] };
  const staleJobs = asArray(project.jobs).filter(
    (job) => job.jobType === "project_render" && job.renderPlanHash && job.renderPlanHash !== project.renderPlanHash
  );
  return `
    <section class="project-editor" data-project-editor="${escapeHtml(project.id)}">
      <header class="project-editor-header">
        <div>
          <span class="eyebrow">Local project</span>
          <h2>${escapeHtml(project.title)}</h2>
          <p>${escapeHtml(project.source.name)} · ${project.segmentCount} cuts · ${seconds(project.duration)}</p>
          <small>${project.revision === project.savedRevision ? "Saved version" : "Recoverable draft"} · revision ${project.revision}</small>
        </div>
        <div class="project-editor-actions">
          ${renderStatusBadge(project.source.status, statusLabel(project.source.status), `project-source-${project.id}`)}
          <button class="ghost-button small" type="button" data-project-favorite="${escapeHtml(project.id)}">${
            project.favorite ? "★ Favorited" : "☆ Favorite"
          }</button>
          <button class="ghost-button small" type="button" data-project-save-version="${escapeHtml(project.id)}">Save version</button>
          <button class="ghost-button small" type="button" data-project-undo ${ui.projectUndo.length ? "" : "disabled"}>Undo</button>
          <button class="ghost-button small" type="button" data-project-redo ${ui.projectRedo.length ? "" : "disabled"}>Redo</button>
        </div>
      </header>
      ${
        staleJobs.length
          ? `<div class="inline-message warning"><strong>Older render revision queued</strong><span>A queued render keeps its approved snapshot and will not silently use newer edits.</span></div>`
          : ""
      }
      <div class="project-editor-grid">
        <section class="project-preview-panel">
          <div class="project-preview-stage">
            <video src="${escapeHtml(project.source.previewUrl || "")}" preload="metadata" playsinline data-project-video></video>
            ${asArray(composition.overlays)
              .filter((overlay) => overlay.type === "logo")
              .map((overlay) => {
                const asset = asArray(ui.brandAssets).find((item) => item.id === overlay.assetId);
                return asset?.previewUrl
                  ? `<img class="project-preview-logo" src="${escapeHtml(asset.previewUrl)}" alt="Brand logo preview" />`
                  : "";
              })
              .join("")}
            ${asArray(composition.overlays)
              .filter((overlay) => ["text", "cta"].includes(overlay.type))
              .map((overlay) => {
                const position = Number(overlay.y) < 0.34 ? "upper" : Number(overlay.y) < 0.67 ? "middle" : "lower";
                return `<span class="project-preview-overlay overlay-${position} overlay-${escapeHtml(overlay.type)}">${escapeHtml(
                  overlay.text
                )}</span>`;
              })
              .join("")}
          </div>
          <div class="candidate-playback-controls">
            <button class="${ui.projectPreviewMode === "edit" ? "ghost-button" : "text-button"} small" type="button"
              data-project-preview-mode="edit">After: edited timeline</button>
            <button class="${ui.projectPreviewMode === "source" ? "ghost-button" : "text-button"} small" type="button"
              data-project-preview-mode="source">Before: source</button>
            <button class="ghost-button small" type="button" data-project-play>Play ${ui.projectPreviewMode === "source" ? "source" : "edit"}</button>
            <button class="text-button" type="button" data-project-pause>Pause</button>
            <button class="text-button" type="button" data-project-frame-step="-1">Previous frame</button>
            <button class="text-button" type="button" data-project-frame-step="1">Next frame</button>
            <label><span>Playhead</span><input type="range" data-project-playhead min="0" max="${project.draft.totalDuration}" step="0.001"
              value="${Math.min(project.draft.totalDuration, ui.projectPlayhead)}" /></label>
          </div>
          <div class="project-waveform-wrap">${renderWaveform(project)}</div>
          ${renderTimeline(project)}
          <div class="timeline-toolbar">
            <label><span>Timeline zoom</span><input type="range" data-project-zoom min="1" max="4" step="0.25" value="${ui.projectTimelineZoom}" /></label>
            <span>Snap: cuts, scenes, transcript, playhead</span>
          </div>
        </section>
        ${renderInspector(project)}
        ${renderTranscript(project)}
      </div>
      ${renderProjectSettings(project)}
      ${renderLocalization(project)}
      <div class="project-footer-actions">
        <button class="ghost-button small" type="button" data-project-prepare="${escapeHtml(project.id)}" data-pending-label="Preparing…">${
          project.prepared ? "Rebuild local signals" : "Prepare local signals"
        }</button>
        <button class="ghost-button small" type="button" data-project-choose-output>Choose render folder</button>
        <button class="primary-button small" type="button" data-project-render="${escapeHtml(project.id)}"
          data-pending-label="Approving…" ${project.prepared && ui.mediaOutputSelection ? "" : "disabled"}>Approve plan and render</button>
        <span>${ui.mediaOutputSelection ? `Output: ${escapeHtml(ui.mediaOutputSelection.name)}` : "Choose an output folder before rendering."}</span>
      </div>
      ${renderVersions(project)}
      <details class="disclosure">
        <summary>Markers, comments, and activity</summary>
        <div class="disclosure-content divided-list">
          ${
            [
              ...asArray(project.draft.markers).map((item) => ({ ...item, kind: "Marker" })),
              ...asArray(project.draft.comments).map((item) => ({ ...item, kind: "Comment" }))
            ]
              .sort((left, right) => left.at - right.at)
              .map(
                (item) =>
                  `<div class="compact-row static-row"><span><strong>${escapeHtml(item.kind)} · ${seconds(item.at)}</strong><small>${escapeHtml(
                    item.text
                  )}</small></span></div>`
              )
              .join("") ||
            `<div class="empty-row"><strong>No notes yet</strong><span>Add markers or comments from the cut inspector.</span></div>`
          }
          ${asArray(project.activity)
            .slice(0, 20)
            .map(
              (item) =>
                `<div class="compact-row static-row"><span><strong>${escapeHtml(item.detail)}</strong><small>${formatDate(
                  item.at
                )}</small></span></div>`
            )
            .join("")}
          ${asArray(project.audit)
            .slice(0, 20)
            .map(
              (item) =>
                `<div class="compact-row static-row"><span><strong>Audit · ${escapeHtml(
                  statusLabel(item.type)
                )}</strong><small>${escapeHtml(item.detail)} · ${formatDate(item.at)}</small></span></div>`
            )
            .join("")}
        </div>
      </details>
      <details class="disclosure danger-zone">
        <summary>Project lifecycle</summary>
        <div class="disclosure-content button-row wrap">
          <button class="ghost-button small" type="button" data-project-duplicate="${escapeHtml(project.id)}">Duplicate project</button>
          <button class="ghost-button small" type="button" data-project-export="${escapeHtml(
            project.id
          )}" data-pending-label="Exporting…">Export portable project</button>
          <button class="ghost-button small" type="button" data-project-${project.status === "archived" ? "restore" : "archive"}="${escapeHtml(
            project.id
          )}">${project.status === "archived" ? "Restore project" : "Archive project"}</button>
          <button class="ghost-button small danger" type="button" data-project-delete="${escapeHtml(project.id)}">Delete project metadata</button>
        </div>
      </details>
    </section>
  `;
}

export function renderProjects() {
  return `
    <section class="studio-tab-panel projects-workspace" role="tabpanel" aria-label="Projects">
      <div class="section-heading">
        <div><span class="eyebrow">Local-first editing</span><h2>Projects</h2><p>Recoverable, non-destructive edits that reference your Clip Library media in place.</p></div>
        <div class="button-row wrap"><span>${ui.projects.total} projects</span>
          <button class="ghost-button small" type="button" data-project-import data-pending-label="Importing…">Import project</button>
        </div>
      </div>
      ${renderProjectCreate()}
      <div class="projects-layout">
        ${renderProjectList()}
        ${
          ui.activeProject
            ? renderEditor(ui.activeProject)
            : `<div class="empty-state compact"><strong>Select a project</strong><p>Open a project to edit its transcript and timeline.</p></div>`
        }
      </div>
    </section>
  `;
}
