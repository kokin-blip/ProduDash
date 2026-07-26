import { escapeHtml } from "../format.js";
import { asArray, ui } from "../state.js";

function options(values, selected) {
  return values.map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function assetOptions(assets, kind, selected = "") {
  return [
    `<option value="">None</option>`,
    ...assets
      .filter((asset) => asset.kind === kind && asset.status === "available")
      .map(
        (asset) => `<option value="${escapeHtml(asset.id)}" ${asset.id === selected ? "selected" : ""}>${escapeHtml(asset.name)}</option>`
      )
  ].join("");
}

export function renderBrandTemplates() {
  const templates = asArray(ui.brandTemplates);
  const project = ui.activeProject;
  const assets = asArray(ui.brandAssets);
  return `
    <section role="tabpanel" class="studio-tab-panel template-workspace">
      <div class="library-actions">
        <div>
          <h2>Brand templates</h2>
          <p>Reusable local composition settings. Applying one snapshots its exact version into the selected project.</p>
        </div>
        <button class="ghost-button" type="button" data-template-import data-pending-label="Importing…">Import template</button>
      </div>
      <div class="inline-message neutral">
        <strong>Local composition</strong>
        <span>Templates can now snapshot validated local logos, music, intros, and outros alongside captions and composition settings. No media is uploaded.</span>
      </div>
      <details class="disclosure">
        <summary>Brand asset library</summary>
        <div class="template-asset-workspace">
          <div class="button-row wrap">
            ${["logo", "music", "intro", "outro"]
              .map(
                (kind) =>
                  `<button class="ghost-button small" type="button" data-brand-asset-import="${kind}" data-pending-label="Validating…">Add ${kind}</button>`
              )
              .join("")}
          </div>
          <div class="compact-list">
            ${
              assets.length
                ? assets
                    .map(
                      (asset) => `<div class="compact-row">
                        <div><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.kind)} · ${escapeHtml(
                          asset.status
                        )}${asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ""}</span></div>
                        <button class="text-button danger-text" type="button" data-brand-asset-delete="${escapeHtml(asset.id)}">Remove</button>
                      </div>`
                    )
                    .join("")
                : `<div class="empty-row"><strong>No local brand assets</strong><span>Add a validated file to use it in templates.</span></div>`
            }
          </div>
        </div>
      </details>
      <details class="disclosure" open>
        <summary>Create template</summary>
        <form class="template-form" data-template-create-form aria-busy="false">
          <label><span>Name</span><input name="name" maxlength="100" required placeholder="Product launch" /></label>
          <label><span>Description</span><input name="description" maxlength="500" placeholder="Vertical launch clips" /></label>
          <label><span>Aspect</span><select name="targetAspect">${options(
            [
              ["original", "Original"],
              ["vertical", "Vertical 9:16"],
              ["square", "Square 1:1"],
              ["landscape", "Landscape 16:9"]
            ],
            "vertical"
          )}</select></label>
          <label><span>Layout</span><select name="aspectTreatment">${options(
            [
              ["fit_pad", "Fit and pad"],
              ["center_crop", "Center crop"],
              ["original", "Original"]
            ],
            "fit_pad"
          )}</select></label>
          <label><span>Caption style</span><select name="captionStyle">${options(
            [
              ["brand", "Brand"],
              ["clean", "Clean"],
              ["contrast", "Contrast"],
              ["notebook", "Notebook"]
            ],
            "brand"
          )}</select></label>
          <label><span>Caption position</span><select name="captionPosition">${options(
            [
              ["lower", "Lower"],
              ["middle", "Middle"],
              ["upper", "Upper"]
            ],
            "lower"
          )}</select></label>
          <label><span>Caption text</span><input name="captionTextColor" type="color" value="#ffffff" /></label>
          <label><span>Caption background</span><input name="captionBackgroundColor" type="color" value="#000000" /></label>
          <label><span>Caption scale</span><input name="captionScale" type="number" min="0.5" max="2.5" step="0.1" value="1" /></label>
          <label><span>Transition</span><select name="transition">${options(
            [
              ["cut", "Cut"],
              ["fade", "Fade"]
            ],
            "cut"
          )}</select></label>
          <label><span>Transition duration</span><input name="transitionDuration" type="number" min="0.05" max="1.5" step="0.05" value="0.25" /></label>
          <label><span>Canvas color</span><input name="backgroundColor" type="color" value="#000000" /></label>
          <label><span>Logo</span><select name="logoAssetId">${assetOptions(assets, "logo")}</select></label>
          <label><span>Music</span><select name="musicAssetId">${assetOptions(assets, "music")}</select></label>
          <label><span>Music volume</span><input name="musicVolume" type="number" min="0.05" max="1" step="0.05" value="0.25" /></label>
          <label><span>Intro</span><select name="introAssetId">${assetOptions(assets, "intro")}</select></label>
          <label><span>Outro</span><select name="outroAssetId">${assetOptions(assets, "outro")}</select></label>
          <label class="template-overlay-copy"><span>Optional text or CTA</span><input name="overlayText" maxlength="240" placeholder="Shop the collection" /></label>
          <label><span>Overlay type</span><select name="overlayType">${options(
            [
              ["cta", "Call to action"],
              ["text", "Text"]
            ],
            "cta"
          )}</select></label>
          <label><span>Overlay position</span><select name="overlayPosition">${options(
            [
              ["lower", "Lower"],
              ["middle", "Middle"],
              ["upper", "Upper"]
            ],
            "lower"
          )}</select></label>
          <button class="primary-button" type="submit" data-pending-label="Creating…">Create template</button>
        </form>
      </details>
      <div class="template-grid">
        ${
          templates.length
            ? templates
                .map(
                  (template) => `
                    <article class="template-card">
                      <div>
                        <span class="eyebrow">Version ${template.version}</span>
                        <h3>${escapeHtml(template.name)}</h3>
                        <p>${escapeHtml(template.description || "Local ProduDash brand template")}</p>
                      </div>
                      <dl class="compact-definition-list">
                        <div><dt>Aspect</dt><dd>${escapeHtml(template.settings.presentation.targetAspect)}</dd></div>
                        <div><dt>Captions</dt><dd>${escapeHtml(template.settings.presentation.captionStyle)}</dd></div>
                        <div><dt>Transition</dt><dd>${escapeHtml(template.settings.composition.transition)}</dd></div>
                        <div><dt>Overlays</dt><dd>${template.settings.composition.overlays.length}</dd></div>
                        <div><dt>Media</dt><dd>${
                          [
                            template.settings.composition.music,
                            template.settings.composition.introAssetId,
                            template.settings.composition.outroAssetId,
                            template.settings.composition.overlays.some((overlay) => overlay.type === "logo")
                          ].filter(Boolean).length
                        } assets</dd></div>
                      </dl>
                      <div class="button-row wrap">
                        <button class="primary-button small" type="button" data-template-apply="${escapeHtml(template.id)}" ${
                          project ? "" : "disabled"
                        } data-pending-label="Applying…">Apply to project</button>
                        <button class="ghost-button small" type="button" data-template-export="${escapeHtml(
                          template.id
                        )}" data-pending-label="Exporting…">Export</button>
                        <button class="text-button danger-text" type="button" data-template-delete="${escapeHtml(
                          template.id
                        )}">Delete</button>
                      </div>
                      ${
                        project
                          ? `<span class="muted">Selected project: ${escapeHtml(project.title)}</span>`
                          : `<span class="muted">Open a project before applying a template.</span>`
                      }
                    </article>
                  `
                )
                .join("")
            : `<div class="empty-row"><strong>No brand templates</strong><span>Create or import a local template to keep composition consistent.</span></div>`
        }
      </div>
    </section>
  `;
}
