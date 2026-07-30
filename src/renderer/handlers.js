import { api } from "./api.js";
import { ADVISOR_CATEGORIES, renderAdvisor } from "./advisor.js";
import { acknowledgeAdvisor, celebrateAdvisor } from "./advisor-reactions.js";
import { renderApp } from "./render.js";
import {
  getConversations,
  getSelectedConversation,
  setActiveProject,
  setAdvisorHistory,
  setAnalyticsReport,
  setAppState,
  setClipLibrary,
  setProjects,
  ui
} from "./state.js";
import {
  addComment,
  addMarker,
  deleteSegment,
  duplicateSegment,
  editSegment,
  moveSegment,
  snapTime,
  sourceTimeAtPlayhead,
  splitSegment,
  updateTranscript
} from "./project-editor.js";
import {
  candidateValuesFromForm,
  captureCandidateDrafts,
  captureCandidateForm,
  confirmCandidateNavigation,
  hasUnsavedCandidateEdits,
  resetCandidateDraft,
  setCandidateDecision
} from "./views/candidate-review.js";

let handlersBound = false;

async function refreshProjects({ keepActive = true } = {}) {
  setProjects(await api.getProjects(ui.projectFilters));
  if (keepActive && ui.selectedProjectId) {
    try {
      setActiveProject(await api.getProject(ui.selectedProjectId), { resetHistory: false });
    } catch {
      setActiveProject(null);
    }
  }
}

async function refreshBrandTemplates() {
  [ui.brandTemplates, ui.brandAssets] = await Promise.all([api.getBrandTemplates(), api.getBrandAssets()]);
}

async function refreshAnalyticsReport() {
  setAnalyticsReport(await api.getAnalyticsReport(ui.selectedBusinessId, ui.analyticsRangeDays));
}

async function saveProjectPlan(nextPlan, trigger, key = "project-edit") {
  const project = ui.activeProject;
  if (!project) return;
  const previousPlan = globalThis.structuredClone(project.draft);
  return runAction(`${key}-${project.id}`, trigger, () => api.saveProjectDraft(project.id, nextPlan, project.revision), {
    applyResult: (nextProject) => {
      ui.projectUndo.push(previousPlan);
      ui.projectUndo = ui.projectUndo.slice(-100);
      ui.projectRedo = [];
      setActiveProject(nextProject, { resetHistory: false });
      const summary = ui.projects.projects.find((item) => item.id === nextProject.id);
      if (summary) Object.assign(summary, nextProject, { draft: undefined, versions: undefined, activity: undefined });
    }
  });
}

async function flushPendingProjectTranscript(trigger) {
  if (ui.activeSection !== "studio" || ui.studioTab !== "projects" || !ui.activeProject) return true;
  const fields = [...document.querySelectorAll("[data-project-transcript-form] [data-transcript-id]")];
  if (!fields.length) return true;
  const byId = new Map(ui.activeProject.draft.transcript.map((cue) => [cue.id, cue.text]));
  const changes = fields.map((field) => ({ id: field.dataset.transcriptId, text: field.value }));
  if (changes.every((change) => byId.get(change.id) === change.text)) return true;
  const previousPlan = globalThis.structuredClone(ui.activeProject.draft);
  const nextPlan = updateTranscript(ui.activeProject.draft, changes);
  return runAction(
    `project-transcript-flush-${ui.activeProject.id}`,
    trigger,
    () => api.saveProjectDraft(ui.activeProject.id, nextPlan, ui.activeProject.revision),
    {
      applyResult: (project) => {
        ui.projectUndo.push(previousPlan);
        ui.projectUndo = ui.projectUndo.slice(-100);
        ui.projectRedo = [];
        setActiveProject(project, { resetHistory: false });
      },
      render: false
    }
  );
}

export function bindHandlers() {
  if (handlersBound) return;
  handlersBound = true;
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("input", handleCandidateInput);
  document.addEventListener("change", handleCandidateInput);
  document.addEventListener("keydown", handleProjectKeydown);
}

function handleProjectKeydown(event) {
  if (!ui.activeProject || ui.studioTab !== "projects") return;
  const editing = event.target.matches?.("input, textarea, select");
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    document.querySelector(event.shiftKey ? "[data-project-redo]" : "[data-project-undo]")?.click();
    return;
  }
  if (editing) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    ui.projectPlayhead = Math.max(0, Math.min(ui.activeProject.draft.totalDuration, ui.projectPlayhead + direction / 30));
    const range = document.querySelector("[data-project-playhead]");
    if (range) {
      range.value = String(ui.projectPlayhead);
      range.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

async function runAction(key, trigger, action, options = {}) {
  if (ui.pending.has(key)) return;
  const focusTarget = describeFocusTarget(trigger);
  ui.pending.add(key);
  ui.error = null;
  const pendingUi = setPendingUi(trigger);
  let succeeded = false;
  let result;
  try {
    result = await action();
    if (options.applyResult) options.applyResult(result);
    else if (result) setAppState(result);
    succeeded = true;
  } catch (error) {
    if (options.refreshOnError) {
      try {
        setAppState(await api.getAppState());
      } catch {
        // Preserve the original controlled error.
      }
    }
    ui.error = error?.message || "ProduDash could not complete that request.";
  } finally {
    ui.pending.delete(key);
    restorePendingUi(pendingUi);
    if (options.render !== false || ui.error) {
      renderApp();
      if (!ui.error && trigger) {
        const restored = findFocusTarget(focusTarget);
        (restored || document.querySelector("#pageTitle"))?.focus();
      }
    }
    const shouldCelebrate = succeeded && (typeof options.celebrate === "function" ? options.celebrate(result) : options.celebrate === true);
    if (shouldCelebrate) celebrateAdvisor();
    if (succeeded && options.acknowledge === true) acknowledgeAdvisor();
  }
  return succeeded;
}

function describeFocusTarget(trigger) {
  if (!(trigger instanceof HTMLElement)) return null;
  if (trigger.id) return { id: trigger.id };
  const direct = Object.entries(trigger.dataset).find(([key]) => key !== "pendingLabel");
  if (direct) return { attribute: `data-${direct[0].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value: direct[1] };
  const form = trigger.closest("form");
  const formEntry = form ? Object.entries(form.dataset)[0] : null;
  return formEntry
    ? {
        formAttribute: `data-${formEntry[0].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
        formValue: formEntry[1]
      }
    : null;
}

function findFocusTarget(target) {
  if (!target) return null;
  if (target.id) return document.getElementById(target.id);
  if (target.attribute) {
    return [...document.querySelectorAll(`[${target.attribute}]`)].find(
      (element) => element.getAttribute(target.attribute) === target.value
    );
  }
  if (target.formAttribute) {
    const form = [...document.querySelectorAll(`[${target.formAttribute}]`)].find(
      (element) => element.getAttribute(target.formAttribute) === target.formValue
    );
    return form?.querySelector("button, input, select, textarea") || null;
  }
  return null;
}

function setPendingUi(trigger) {
  if (!trigger) return null;
  const container = trigger.closest("form");
  const controls = container ? [...container.querySelectorAll("button, input, select, textarea")] : [trigger];
  const states = controls.map((control) => ({ control, disabled: control.disabled }));
  const originalInlineSize = trigger.style.inlineSize;
  const originalAriaBusy = trigger.getAttribute("aria-busy");
  const originalAriaLabel = trigger.getAttribute("aria-label");
  const originalContainerBusy = container?.getAttribute("aria-busy") ?? null;
  const width = trigger.getBoundingClientRect().width;
  if (width > 0) trigger.style.inlineSize = `${Math.ceil(width)}px`;
  controls.forEach((control) => {
    control.disabled = true;
  });
  if (container) container.setAttribute("aria-busy", "true");
  const label = trigger.dataset.pendingLabel;
  const originalContent = [...trigger.childNodes].map((node) => node.cloneNode(true));
  trigger.setAttribute("aria-busy", "true");
  trigger.classList.add("is-pending");
  if (label) {
    const spinner = document.createElement("span");
    spinner.className = "button-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const pendingLabel = document.createElement("span");
    pendingLabel.className = "pending-label";
    pendingLabel.textContent = label;
    trigger.replaceChildren(spinner, pendingLabel);
    trigger.setAttribute("aria-label", label);
  }
  return {
    container,
    states,
    trigger,
    originalContent,
    labelApplied: Boolean(label),
    originalInlineSize,
    originalAriaBusy,
    originalAriaLabel,
    originalContainerBusy
  };
}

function restorePendingUi(pendingUi) {
  if (!pendingUi) return;
  pendingUi.states.forEach(({ control, disabled }) => {
    control.disabled = disabled;
  });
  if (pendingUi.container) {
    if (pendingUi.originalContainerBusy === null) pendingUi.container.removeAttribute("aria-busy");
    else pendingUi.container.setAttribute("aria-busy", pendingUi.originalContainerBusy);
  }
  if (pendingUi.originalAriaBusy === null) pendingUi.trigger.removeAttribute("aria-busy");
  else pendingUi.trigger.setAttribute("aria-busy", pendingUi.originalAriaBusy);
  pendingUi.trigger.classList.remove("is-pending");
  pendingUi.trigger.style.inlineSize = pendingUi.originalInlineSize;
  if (pendingUi.originalAriaLabel === null) pendingUi.trigger.removeAttribute("aria-label");
  else pendingUi.trigger.setAttribute("aria-label", pendingUi.originalAriaLabel);
  if (pendingUi.labelApplied) pendingUi.trigger.replaceChildren(...pendingUi.originalContent);
}

async function handleClick(event) {
  const advisorToggle = event.target.closest("[data-advisor-toggle]");
  if (advisorToggle) {
    ui.advisorOpen = !ui.advisorOpen;
    renderAdvisor();
    if (ui.advisorOpen) document.querySelector("#advisorPanel .icon-button")?.focus();
    return;
  }

  const advisorClose = event.target.closest("[data-advisor-close]");
  if (advisorClose) {
    ui.advisorOpen = false;
    renderAdvisor();
    document.querySelector("[data-advisor-toggle]")?.focus();
    return;
  }

  const advisorConsent = event.target.closest("[data-advisor-consent]");
  if (advisorConsent) {
    const profileId = advisorConsent.dataset.advisorConsent;
    await runAction(`advisor-consent-${profileId}`, advisorConsent, () => api.grantAdvisorConsent(profileId, ADVISOR_CATEGORIES), {
      applyResult: (status) => {
        ui.advisorHistory.status = status;
        ui.advisorError = null;
      }
    });
    return;
  }

  const advisorClear = event.target.closest("[data-advisor-clear]");
  if (advisorClear) {
    if (!window.confirm("Clear all visible Advisor history stored on this computer?")) return;
    await runAction("advisor-clear", advisorClear, () => api.clearAdvisorHistory(), {
      applyResult: (history) => {
        setAdvisorHistory(history);
        ui.advisorStatus = "idle";
        ui.advisorToolName = null;
        ui.advisorError = null;
      }
    });
    return;
  }

  const advisorSuggestion = event.target.closest("[data-advisor-suggestion]");
  if (advisorSuggestion) {
    const prompt = document.querySelector("#advisorPrompt");
    if (prompt) {
      prompt.value = advisorSuggestion.dataset.advisorSuggestion;
      prompt.focus();
    }
    return;
  }

  const advisorCancel = event.target.closest("[data-advisor-cancel]");
  if (advisorCancel) {
    await api.cancelAdvisorTurn(advisorCancel.dataset.advisorCancel).catch((error) => {
      ui.advisorError = error?.message || "Advisor cancellation could not be completed.";
    });
    return;
  }

  const advisorIntegrations = event.target.closest("[data-advisor-open-integrations]");
  if (advisorIntegrations) {
    ui.activeSection = "integrations";
    renderApp({ animateView: true });
    return;
  }

  const studioTab = event.target.closest("[data-studio-tab]");
  if (studioTab) {
    if (ui.studioTab !== studioTab.dataset.studioTab && !confirmCandidateNavigation()) return;
    if (ui.studioTab !== studioTab.dataset.studioTab && !(await flushPendingProjectTranscript(studioTab))) return;
    ui.studioTab = studioTab.dataset.studioTab;
    if (ui.studioTab === "templates") {
      await runAction("load-brand-templates", studioTab, refreshBrandTemplates, { acknowledge: true });
    } else if (ui.studioTab === "projects") {
      ui.brandAssets = await api.getBrandAssets();
    }
    renderApp();
    return;
  }

  const templateImport = event.target.closest("[data-template-import]");
  if (templateImport) {
    await runAction("import-brand-template", templateImport, () => api.importBrandTemplate(), {
      applyResult: (template) => {
        if (template) ui.brandTemplates = [template, ...ui.brandTemplates.filter((item) => item.id !== template.id)];
      },
      celebrate: true
    });
    return;
  }

  const assetImport = event.target.closest("[data-brand-asset-import]");
  if (assetImport) {
    await runAction(
      `import-brand-asset-${assetImport.dataset.brandAssetImport}`,
      assetImport,
      () => api.importBrandAsset(assetImport.dataset.brandAssetImport),
      {
        applyResult: (asset) => {
          if (asset) ui.brandAssets = [asset, ...ui.brandAssets.filter((item) => item.id !== asset.id)];
        },
        celebrate: true
      }
    );
    return;
  }

  const assetDelete = event.target.closest("[data-brand-asset-delete]");
  if (assetDelete) {
    if (!window.confirm("Remove this ProduDash-managed asset copy? Original files and completed renders are not changed.")) return;
    await runAction(
      `delete-brand-asset-${assetDelete.dataset.brandAssetDelete}`,
      assetDelete,
      () => api.deleteBrandAsset(assetDelete.dataset.brandAssetDelete),
      {
        applyResult: ({ id }) => {
          ui.brandAssets = ui.brandAssets.filter((item) => item.id !== id);
        }
      }
    );
    return;
  }

  const templateApply = event.target.closest("[data-template-apply]");
  if (templateApply && ui.activeProject) {
    if (!(await flushPendingProjectTranscript(templateApply))) return;
    await runAction(
      `apply-template-${templateApply.dataset.templateApply}`,
      templateApply,
      () => api.applyBrandTemplate(ui.activeProject.id, templateApply.dataset.templateApply),
      {
        applyResult: (project) => setActiveProject(project),
        celebrate: true
      }
    );
    return;
  }

  const templateExport = event.target.closest("[data-template-export]");
  if (templateExport) {
    await runAction(`export-template-${templateExport.dataset.templateExport}`, templateExport, () =>
      api.exportBrandTemplate(templateExport.dataset.templateExport)
    );
    return;
  }

  const templateDelete = event.target.closest("[data-template-delete]");
  if (templateDelete) {
    if (!window.confirm("Delete this ProduDash brand-template metadata? Existing project and render snapshots will remain unchanged."))
      return;
    await runAction(
      `delete-template-${templateDelete.dataset.templateDelete}`,
      templateDelete,
      () => api.deleteBrandTemplate(templateDelete.dataset.templateDelete),
      { applyResult: (templates) => (ui.brandTemplates = templates) }
    );
    return;
  }

  const projectOpen = event.target.closest("[data-project-open]");
  if (projectOpen) {
    if (!(await flushPendingProjectTranscript(projectOpen))) return;
    await runAction(`open-project-${projectOpen.dataset.projectOpen}`, projectOpen, () => api.getProject(projectOpen.dataset.projectOpen), {
      applyResult: (project) => setActiveProject(project),
      acknowledge: true
    });
    return;
  }

  const projectImport = event.target.closest("[data-project-import]");
  if (projectImport) {
    await runAction("import-project", projectImport, () => api.importProjectDocument(), {
      applyResult: (project) => {
        if (!project) return;
        setActiveProject(project);
        ui.selectedProjectId = project.id;
      },
      celebrate: true
    });
    await refreshProjects();
    return;
  }

  const projectExport = event.target.closest("[data-project-export]");
  if (projectExport) {
    if (!(await flushPendingProjectTranscript(projectExport))) return;
    await runAction(`export-project-${projectExport.dataset.projectExport}`, projectExport, () =>
      api.exportProjectDocument(projectExport.dataset.projectExport)
    );
    return;
  }

  const projectFromCandidate = event.target.closest("[data-project-from-candidate]");
  if (projectFromCandidate) {
    const jobId = projectFromCandidate.dataset.projectFromCandidate;
    const candidateId = projectFromCandidate.dataset.candidateId;
    await runAction(
      `project-from-candidate-${jobId}-${candidateId}`,
      projectFromCandidate,
      () => api.createProjectFromCandidate(jobId, candidateId),
      {
        applyResult: (project) => {
          ui.studioTab = "projects";
          setActiveProject(project);
        },
        celebrate: true
      }
    );
    await refreshProjects();
    return;
  }

  const projectFavorite = event.target.closest("[data-project-favorite]");
  if (projectFavorite) {
    if (!(await flushPendingProjectTranscript(projectFavorite))) return;
    const projectId = projectFavorite.dataset.projectFavorite;
    await runAction(
      `favorite-project-${projectId}`,
      projectFavorite,
      () => api.updateProject(projectId, { favorite: !ui.activeProject.favorite }),
      {
        applyResult: (project) => setActiveProject(project, { resetHistory: false })
      }
    );
    await refreshProjects();
    return;
  }

  const localizationDelete = event.target.closest("[data-project-localization-delete]");
  if (localizationDelete && ui.activeProject) {
    if (!window.confirm("Remove this localized caption draft? Source transcript cues and rendered files will not change.")) return;
    const variantId = localizationDelete.dataset.projectLocalizationDelete;
    const localization = ui.activeProject.draft.localization || { sourceLanguage: "und", activeVariantId: null, variants: [] };
    await saveProjectPlan(
      {
        ...ui.activeProject.draft,
        localization: {
          ...localization,
          activeVariantId: localization.activeVariantId === variantId ? null : localization.activeVariantId,
          variants: localization.variants.filter((variant) => variant.id !== variantId)
        }
      },
      localizationDelete,
      "project-localization-delete"
    );
    return;
  }

  const voiceoverDelete = event.target.closest("[data-project-voiceover-delete]");
  if (voiceoverDelete && ui.activeProject) {
    if (!window.confirm("Delete this generated voice preview? This removes ProduDash’s local audio copy and cannot be undone.")) return;
    await runAction(
      `project-voiceover-delete-${voiceoverDelete.dataset.projectVoiceoverDelete}`,
      voiceoverDelete,
      () =>
        api.deleteProjectVoiceover({
          projectId: ui.activeProject.id,
          voiceoverId: voiceoverDelete.dataset.projectVoiceoverDelete,
          expectedRevision: ui.activeProject.revision
        }),
      { applyResult: (project) => setActiveProject(project, { resetHistory: false }) }
    );
    await refreshBrandTemplates();
    renderApp();
    return;
  }

  const customVoiceOpen = event.target.closest("[data-custom-voice-open]");
  if (customVoiceOpen) {
    document.querySelector("[data-custom-voice-dialog]")?.showModal();
    return;
  }

  const rvcVoiceoverOpen = event.target.closest("[data-rvc-voiceover-open]");
  if (rvcVoiceoverOpen) {
    const dialog = document.querySelector("[data-rvc-voiceover-dialog]");
    if (dialog) {
      dialog.querySelector("[name='voiceoverId']").value = rvcVoiceoverOpen.dataset.rvcVoiceoverOpen;
      dialog.showModal();
    }
    return;
  }

  const rvcVoiceoverClose = event.target.closest("[data-rvc-voiceover-close]");
  if (rvcVoiceoverClose) {
    rvcVoiceoverClose.closest("dialog")?.close();
    return;
  }

  const customVoiceClose = event.target.closest("[data-custom-voice-close]");
  if (customVoiceClose) {
    customVoiceClose.closest("dialog")?.close();
    return;
  }

  const localLikenessOpen = event.target.closest("[data-local-likeness-open]");
  if (localLikenessOpen) {
    document.querySelector("[data-local-likeness-dialog]")?.showModal();
    return;
  }

  const localLikenessClose = event.target.closest("[data-local-likeness-close]");
  if (localLikenessClose) {
    localLikenessClose.closest("dialog")?.close();
    return;
  }

  const customVoiceRemove = event.target.closest("[data-custom-voice-remove]");
  if (customVoiceRemove) {
    const providerType = customVoiceRemove.dataset.providerType;
    const provider = ui.appState.aiProviders.find((item) => item.id === customVoiceRemove.dataset.providerProfileId);
    const providerEffect =
      providerType === "elevenlabs" && provider?.credentialStatus === "stored"
        ? "This permanently deletes the voice from ElevenLabs and removes ProduDash’s authorization."
        : providerType === "elevenlabs"
          ? "ElevenLabs credentials are unavailable, so this removes only ProduDash’s authorization. Delete the remaining voice from your ElevenLabs account separately."
          : providerType === "openai"
            ? "This removes ProduDash’s authorization and its stored consent reference. OpenAI may require separate account management for the remaining voice resource."
            : "This removes ProduDash’s authorization. Manage any remaining provider resource separately.";
    if (!window.confirm(`${providerEffect} Already generated audio and rendered files are not deleted. Continue?`)) return;
    await runAction(
      `custom-voice-remove-${customVoiceRemove.dataset.customVoiceRemove}`,
      customVoiceRemove,
      () =>
        api.removeCustomVoice({
          providerProfileId: customVoiceRemove.dataset.providerProfileId,
          voiceId: customVoiceRemove.dataset.customVoiceRemove
        }),
      { applyResult: setAppState }
    );
    renderApp();
    return;
  }

  const projectPrepare = event.target.closest("[data-project-prepare]");
  if (projectPrepare) {
    if (!(await flushPendingProjectTranscript(projectPrepare))) return;
    await runAction(`prepare-project-${projectPrepare.dataset.projectPrepare}`, projectPrepare, () =>
      api.prepareProject(projectPrepare.dataset.projectPrepare)
    );
    await refreshProjects();
    return;
  }

  const projectOutput = event.target.closest("[data-project-choose-output]");
  if (projectOutput) {
    if (!(await flushPendingProjectTranscript(projectOutput))) return;
    await runAction(
      "choose-project-output",
      projectOutput,
      async () => {
        ui.mediaOutputSelection = await api.chooseMediaOutputFolder();
        return null;
      },
      { applyResult: () => {} }
    );
    return;
  }

  const projectRender = event.target.closest("[data-project-render]");
  if (projectRender) {
    if (!ui.mediaOutputSelection) return;
    if (!(await flushPendingProjectTranscript(projectRender))) return;
    const projectId = projectRender.dataset.projectRender;
    await runAction(`render-project-${projectId}`, projectRender, () => api.renderProject(projectId, ui.mediaOutputSelection.id), {
      celebrate: true
    });
    ui.mediaOutputSelection = null;
    await refreshProjects();
    return;
  }

  const projectImportTranscript = event.target.closest("[data-project-import-transcript]");
  if (projectImportTranscript) {
    if (!(await flushPendingProjectTranscript(projectImportTranscript))) return;
    const projectId = projectImportTranscript.dataset.projectImportTranscript;
    await runAction(`import-project-transcript-${projectId}`, projectImportTranscript, () => api.importProjectTranscript(projectId), {
      applyResult: (project) => setActiveProject(project, { resetHistory: false })
    });
    return;
  }

  const projectSaveVersion = event.target.closest("[data-project-save-version]");
  if (projectSaveVersion) {
    if (!(await flushPendingProjectTranscript(projectSaveVersion))) return;
    const projectId = projectSaveVersion.dataset.projectSaveVersion;
    await runAction(`save-project-version-${projectId}`, projectSaveVersion, () => api.saveProjectVersion(projectId, ""), {
      applyResult: (project) => setActiveProject(project, { resetHistory: false }),
      celebrate: true
    });
    return;
  }

  const projectRestoreVersion = event.target.closest("[data-project-restore-version]");
  if (projectRestoreVersion) {
    const project = ui.activeProject;
    if (!project || !window.confirm("Restore this saved version as the current recoverable draft? Later versions will remain available."))
      return;
    if (!(await flushPendingProjectTranscript(projectRestoreVersion))) return;
    await runAction(
      `restore-project-version-${projectRestoreVersion.dataset.projectRestoreVersion}`,
      projectRestoreVersion,
      () => api.restoreProjectVersion(project.id, projectRestoreVersion.dataset.projectRestoreVersion),
      { applyResult: (next) => setActiveProject(next) }
    );
    return;
  }

  const projectLifecycle = event.target.closest(
    "[data-project-duplicate], [data-project-archive], [data-project-restore], [data-project-delete]"
  );
  if (projectLifecycle) {
    const projectId =
      projectLifecycle.dataset.projectDuplicate ||
      projectLifecycle.dataset.projectArchive ||
      projectLifecycle.dataset.projectRestore ||
      projectLifecycle.dataset.projectDelete;
    if (
      projectLifecycle.hasAttribute("data-project-delete") &&
      !window.confirm("Delete only this ProduDash project’s metadata? Source files, rendered media, and older job records will remain.")
    )
      return;
    if (!projectLifecycle.hasAttribute("data-project-delete") && !(await flushPendingProjectTranscript(projectLifecycle))) return;
    const action = projectLifecycle.hasAttribute("data-project-duplicate")
      ? () => api.duplicateProject(projectId)
      : projectLifecycle.hasAttribute("data-project-archive")
        ? () => api.archiveProject(projectId)
        : projectLifecycle.hasAttribute("data-project-restore")
          ? () => api.restoreProject(projectId)
          : () => api.deleteProject(projectId);
    await runAction(`project-lifecycle-${projectId}`, projectLifecycle, action, {
      applyResult: (result) => {
        if (projectLifecycle.hasAttribute("data-project-delete")) {
          setProjects(result);
          setActiveProject(null);
        } else {
          setActiveProject(result);
        }
      }
    });
    await refreshProjects();
    return;
  }

  const projectUndo = event.target.closest("[data-project-undo]");
  if (projectUndo && ui.activeProject && ui.projectUndo.length) {
    if (!(await flushPendingProjectTranscript(projectUndo))) return;
    const previous = ui.projectUndo.at(-1);
    const current = globalThis.structuredClone(ui.activeProject.draft);
    await runAction(
      `project-undo-${ui.activeProject.id}`,
      projectUndo,
      () => api.saveProjectDraft(ui.activeProject.id, previous, ui.activeProject.revision),
      {
        applyResult: (project) => {
          ui.projectUndo.pop();
          ui.projectRedo.push(current);
          ui.projectRedo = ui.projectRedo.slice(-100);
          setActiveProject(project, { resetHistory: false });
        }
      }
    );
    return;
  }

  const overlayDelete = event.target.closest("[data-project-overlay-delete]");
  if (overlayDelete && ui.activeProject) {
    const composition = {
      ...ui.activeProject.draft.composition,
      overlays: ui.activeProject.draft.composition.overlays.filter((overlay) => overlay.id !== overlayDelete.dataset.projectOverlayDelete)
    };
    await saveProjectPlan({ ...ui.activeProject.draft, composition }, overlayDelete, "project-overlay-delete");
    return;
  }

  const projectRedo = event.target.closest("[data-project-redo]");
  if (projectRedo && ui.activeProject && ui.projectRedo.length) {
    if (!(await flushPendingProjectTranscript(projectRedo))) return;
    const next = ui.projectRedo.at(-1);
    const current = globalThis.structuredClone(ui.activeProject.draft);
    await runAction(
      `project-redo-${ui.activeProject.id}`,
      projectRedo,
      () => api.saveProjectDraft(ui.activeProject.id, next, ui.activeProject.revision),
      {
        applyResult: (project) => {
          ui.projectRedo.pop();
          ui.projectUndo.push(current);
          ui.projectUndo = ui.projectUndo.slice(-100);
          setActiveProject(project, { resetHistory: false });
        }
      }
    );
    return;
  }

  const projectSegmentAction = event.target.closest(
    "[data-project-split], [data-project-duplicate-segment], [data-project-move-segment], [data-project-delete-segment]"
  );
  if (projectSegmentAction && ui.activeProject) {
    if (!(await flushPendingProjectTranscript(projectSegmentAction))) return;
    const segmentId =
      projectSegmentAction.dataset.projectSplit ||
      projectSegmentAction.dataset.projectDuplicateSegment ||
      projectSegmentAction.dataset.projectMoveSegment ||
      projectSegmentAction.dataset.projectDeleteSegment;
    let nextPlan;
    if (projectSegmentAction.hasAttribute("data-project-split")) {
      const mapped = sourceTimeAtPlayhead(ui.activeProject.draft, ui.projectPlayhead);
      nextPlan = splitSegment(ui.activeProject.draft, segmentId, snapTime(mapped.sourceTime, ui.activeProject));
    } else if (projectSegmentAction.hasAttribute("data-project-duplicate-segment")) {
      nextPlan = duplicateSegment(ui.activeProject.draft, segmentId);
    } else if (projectSegmentAction.hasAttribute("data-project-move-segment")) {
      nextPlan = moveSegment(ui.activeProject.draft, segmentId, Number(projectSegmentAction.dataset.direction));
    } else {
      nextPlan = deleteSegment(ui.activeProject.draft, segmentId);
    }
    await saveProjectPlan(nextPlan, projectSegmentAction);
    return;
  }

  const projectTimelineSegment = event.target.closest("[data-timeline-segment]");
  if (projectTimelineSegment) {
    if (!(await flushPendingProjectTranscript(projectTimelineSegment))) return;
    ui.selectedProjectSegmentId = projectTimelineSegment.dataset.timelineSegment;
    renderApp();
    return;
  }

  const projectPlayback = event.target.closest("[data-project-play], [data-project-pause], [data-project-frame-step]");
  if (projectPlayback && ui.activeProject) {
    const video = document.querySelector("[data-project-video]");
    if (!video) return;
    if (projectPlayback.hasAttribute("data-project-pause")) {
      video.pause();
    } else if (projectPlayback.hasAttribute("data-project-frame-step")) {
      video.pause();
      video.currentTime = Math.max(0, video.currentTime + Number(projectPlayback.dataset.projectFrameStep) / 30);
    } else if (ui.projectPreviewMode === "source") {
      video.ontimeupdate = null;
      await video.play().catch(() => {});
    } else {
      let index = ui.activeProject.draft.segments.findIndex(
        (segment) => ui.projectPlayhead >= segment.timelineStart && ui.projectPlayhead < segment.timelineStart + segment.duration
      );
      if (index < 0) index = 0;
      const playSegment = (segmentIndex) => {
        const segment = ui.activeProject.draft.segments[segmentIndex];
        if (!segment) {
          video.pause();
          return;
        }
        video.currentTime = segment.sourceStart;
        video.ontimeupdate = () => {
          const current = ui.activeProject.draft.segments[segmentIndex];
          ui.projectPlayhead = current.timelineStart + Math.max(0, video.currentTime - current.sourceStart);
          const range = document.querySelector("[data-project-playhead]");
          if (range) range.value = String(Math.min(ui.activeProject.draft.totalDuration, ui.projectPlayhead));
          if (video.currentTime >= current.sourceEnd) playSegment(segmentIndex + 1);
        };
      };
      playSegment(index);
      await video.play().catch(() => {});
    }
    return;
  }

  const projectPreviewMode = event.target.closest("[data-project-preview-mode]");
  if (projectPreviewMode) {
    if (!(await flushPendingProjectTranscript(projectPreviewMode))) return;
    ui.projectPreviewMode = projectPreviewMode.dataset.projectPreviewMode === "source" ? "source" : "edit";
    renderApp();
    document.querySelector(`[data-project-preview-mode="${ui.projectPreviewMode}"]`)?.focus();
    return;
  }

  const candidateControl = event.target.closest(
    "[data-candidate-play], [data-candidate-pause], [data-candidate-restart], [data-candidate-select], [data-candidate-reject], [data-candidate-reset]"
  );
  if (candidateControl) {
    const card = candidateControl.closest("[data-candidate-card]");
    const review = candidateControl.closest("[data-candidate-review]");
    const candidateId = card?.dataset.candidateCard;
    const jobId = review?.dataset.candidateReview;
    const video = card?.querySelector("[data-candidate-video]");
    const form = card?.querySelector("[data-candidate-edit-form]");
    const start = Number(form?.elements.start.value);
    const end = Number(form?.elements.end.value);
    if (candidateControl.hasAttribute("data-candidate-play") && video) {
      if (!Number.isFinite(video.currentTime) || video.currentTime < start || video.currentTime >= end) video.currentTime = start;
      video.ontimeupdate = () => {
        if (video.currentTime >= end) {
          video.pause();
          video.currentTime = end;
        }
      };
      await video.play().catch(() => {});
    } else if (candidateControl.hasAttribute("data-candidate-pause") && video) {
      video.pause();
    } else if (candidateControl.hasAttribute("data-candidate-restart") && video) {
      video.pause();
      video.currentTime = start;
      video.focus();
    } else if (candidateControl.hasAttribute("data-candidate-reset")) {
      captureCandidateDrafts();
      resetCandidateDraft(jobId, candidateId);
      renderApp();
    } else if (candidateControl.hasAttribute("data-candidate-select")) {
      captureCandidateDrafts();
      setCandidateDecision(jobId, candidateId, "selected");
      renderApp();
    } else if (candidateControl.hasAttribute("data-candidate-reject")) {
      captureCandidateDrafts();
      setCandidateDecision(jobId, candidateId, "rejected");
      renderApp();
    }
    return;
  }

  const clipButton = event.target.closest("[data-library-clip]");
  if (clipButton) {
    ui.selectedClipId = clipButton.dataset.libraryClip;
    renderApp();
    return;
  }

  const businessButton = event.target.closest("[data-business]");
  if (businessButton) {
    if (!(await flushPendingProjectTranscript(businessButton))) return;
    ui.selectedBusinessId = businessButton.dataset.business;
    ui.selectedConversationId = getConversations()[0]?.id || null;
    if (ui.activeSection === "analytics") {
      await runAction(`analytics-business-${ui.selectedBusinessId}`, businessButton, refreshAnalyticsReport, {
        acknowledge: true
      });
      return;
    }
    renderApp({ animateView: true });
    return;
  }

  const conversationButton = event.target.closest("[data-conversation]");
  if (conversationButton) {
    ui.selectedConversationId = conversationButton.dataset.conversation;
    if (conversationButton.dataset.section) ui.activeSection = conversationButton.dataset.section;
    renderApp();
    return;
  }

  const navButton = event.target.closest("[data-section]");
  if (navButton) {
    const changedSection = ui.activeSection !== navButton.dataset.section;
    if (changedSection && !confirmCandidateNavigation()) return;
    if (changedSection && !(await flushPendingProjectTranscript(navButton))) return;
    ui.activeSection = navButton.dataset.section;
    if (ui.activeSection === "analytics") {
      const loaded = await runAction("load-analytics", navButton, refreshAnalyticsReport, {
        acknowledge: true,
        render: false
      });
      if (!loaded) return;
    }
    renderApp({ animateView: changedSection });
    return;
  }

  const refreshAnalyticsButton = event.target.closest("[data-refresh-analytics]");
  if (refreshAnalyticsButton) {
    await runAction("refresh-analytics", refreshAnalyticsButton, refreshAnalyticsReport, { acknowledge: true });
    return;
  }

  const exportAnalyticsButton = event.target.closest("[data-export-analytics]");
  if (exportAnalyticsButton) {
    await runAction(
      `export-analytics-${exportAnalyticsButton.dataset.exportAnalytics}`,
      exportAnalyticsButton,
      () => api.exportAnalyticsReport(exportAnalyticsButton.dataset.exportAnalytics, ui.analyticsRangeDays),
      { applyResult: () => {}, celebrate: (result) => result?.exported === true }
    );
    return;
  }

  const approveButton = event.target.closest("[data-approve-approval]");
  if (approveButton) {
    await runAction(
      `approve-${approveButton.dataset.approveApproval}`,
      approveButton,
      () => api.approveAiAction(approveButton.dataset.approveApproval),
      { celebrate: true }
    );
    return;
  }

  const rejectButton = event.target.closest("[data-reject-approval]");
  if (rejectButton) {
    await runAction(`reject-${rejectButton.dataset.rejectApproval}`, rejectButton, () =>
      api.rejectAiAction(rejectButton.dataset.rejectApproval)
    );
    return;
  }

  const approvePostButton = event.target.closest("[data-approve-post]");
  if (approvePostButton) {
    await runAction(
      `approve-post-${approvePostButton.dataset.approvePost}`,
      approvePostButton,
      () => api.approvePostPlan(approvePostButton.dataset.approvePost, approvePostButton.dataset.approvalMode),
      { celebrate: true }
    );
    return;
  }

  const exportPostButton = event.target.closest("[data-export-post]");
  if (exportPostButton) {
    await runAction(
      `export-post-${exportPostButton.dataset.exportPost}`,
      exportPostButton,
      () => api.exportPostPackage(exportPostButton.dataset.exportPost),
      { celebrate: true }
    );
    return;
  }

  const refreshPublicationButton = event.target.closest("[data-refresh-publication]");
  if (refreshPublicationButton) {
    // Keyed by destination as well as plan: both controls render once per
    // destination, so a plan-only key made the second one a silent no-op --
    // no request, no error, no spinner.
    await runAction(
      `refresh-publication-${refreshPublicationButton.dataset.refreshPublication}-${refreshPublicationButton.dataset.refreshPlatform}`,
      refreshPublicationButton,
      () =>
        api.refreshPublicationStatus(refreshPublicationButton.dataset.refreshPublication, refreshPublicationButton.dataset.refreshPlatform)
    );
    return;
  }

  const discardSessionButton = event.target.closest("[data-discard-session]");
  if (discardSessionButton) {
    // The provider already said it cannot tell whether that upload published
    // anything. Discarding on the user's word is the only way forward, so the
    // confirmation has to state plainly what they are vouching for.
    if (
      !window.confirm(
        "Only discard this if you have checked the destination and no post from this plan appeared. Discarding lets ProduDash upload again, which would duplicate it if one did."
      )
    ) {
      return;
    }
    await runAction(
      `discard-session-${discardSessionButton.dataset.discardSession}-${discardSessionButton.dataset.discardPlatform}`,
      discardSessionButton,
      () => api.discardUploadSession(discardSessionButton.dataset.discardSession, discardSessionButton.dataset.discardPlatform)
    );
    return;
  }

  const dispatchPostButton = event.target.closest("[data-dispatch-post]");
  if (dispatchPostButton) {
    // Publishing sends media to a real account, so it needs its own explicit
    // confirmation even though the plan was already approved.
    if (
      !window.confirm("Publish this approved plan to every connected destination? This uploads the rendered video to your own account.")
    ) {
      return;
    }
    await runAction(
      `dispatch-post-${dispatchPostButton.dataset.dispatchPost}`,
      dispatchPostButton,
      () => api.dispatchPostPlan(dispatchPostButton.dataset.dispatchPost),
      { celebrate: true }
    );
    return;
  }

  const cancelPostButton = event.target.closest("[data-cancel-post]");
  if (cancelPostButton) {
    if (!window.confirm("Cancel this local post plan? Rendered media and exported files will not be deleted.")) return;
    await runAction(`cancel-post-${cancelPostButton.dataset.cancelPost}`, cancelPostButton, () =>
      api.cancelPostPlan(cancelPostButton.dataset.cancelPost)
    );
    return;
  }

  const refreshIntegrationButton = event.target.closest("[data-refresh-integration]");
  if (refreshIntegrationButton) {
    const integrationId = refreshIntegrationButton.dataset.refreshIntegration;
    await runAction(`refresh-${integrationId}`, refreshIntegrationButton, () => api.refreshIntegration(integrationId), {
      refreshOnError: true
    });
    return;
  }

  const authorizeIntegrationButton = event.target.closest("[data-authorize-integration]");
  if (authorizeIntegrationButton) {
    const integrationId = authorizeIntegrationButton.dataset.authorizeIntegration;
    // Authorization opens the system browser and then waits for the callback,
    // so it can take as long as the person takes. runAction already blocks a
    // second click on the same key while it is in flight.
    await runAction(`authorize-${integrationId}`, authorizeIntegrationButton, () => api.authorizeIntegration(integrationId), {
      refreshOnError: true
    });
    return;
  }

  const disconnectIntegrationButton = event.target.closest("[data-disconnect-integration]");
  if (disconnectIntegrationButton) {
    const integrationId = disconnectIntegrationButton.dataset.disconnectIntegration;
    if (
      !window.confirm(
        "Disconnect this authorization? ProduDash revokes its access at the provider. Your saved application configuration is kept so you can reauthorize."
      )
    ) {
      return;
    }
    await runAction(`disconnect-${integrationId}`, disconnectIntegrationButton, () => api.disconnectIntegration(integrationId), {
      refreshOnError: true
    });
    return;
  }

  const removeCredentialsButton = event.target.closest("[data-remove-credentials]");
  if (removeCredentialsButton) {
    const integrationId = removeCredentialsButton.dataset.removeCredentials;
    if (
      !window.confirm(
        "Remove all configuration and authorization for this platform? Imported snapshots remain but will be marked disconnected."
      )
    ) {
      return;
    }
    await runAction(`remove-${integrationId}`, removeCredentialsButton, () => api.removeIntegrationCredentials(integrationId));
    return;
  }

  const testProviderButton = event.target.closest("[data-test-ai-provider]");
  if (testProviderButton) {
    const profileId = testProviderButton.dataset.testAiProvider;
    await runAction(`test-ai-provider-${profileId}`, testProviderButton, () => api.testAiProvider(profileId), {
      refreshOnError: true
    });
    return;
  }

  const localVoiceScan = event.target.closest("[data-local-voice-scan]");
  if (localVoiceScan) {
    await runAction("local-voice-scan", localVoiceScan, () => api.scanLocalVoiceCompatibility(), {
      applyResult: (report) => {
        ui.localVoiceReport = report;
      }
    });
    renderApp();
    return;
  }

  const removeProviderButton = event.target.closest("[data-remove-ai-provider]");
  if (removeProviderButton) {
    const profileId = removeProviderButton.dataset.removeAiProvider;
    if (!window.confirm("Remove this AI provider’s encrypted credentials? Its public profile and workload assignments will remain."))
      return;
    await runAction(`remove-ai-provider-${profileId}`, removeProviderButton, () => api.removeAiProviderCredentials(profileId));
    return;
  }

  const localProviderFileButton = event.target.closest("[data-local-provider-file]");
  if (localProviderFileButton) {
    const fieldKey = localProviderFileButton.dataset.localProviderFile;
    const profileId = localProviderFileButton.dataset.profileId;
    await runAction(`local-provider-file-${profileId}-${fieldKey}`, localProviderFileButton, () =>
      api.chooseLocalProviderFile(profileId, fieldKey)
    );
    return;
  }

  const addFoldersButton = event.target.closest("[data-add-clip-folders]");
  if (addFoldersButton) {
    const existingIds = new Set([...ui.clipLibrary.folders, ...ui.clipLibrary.clips].map((item) => item.id));
    await runAction("add-clip-folders", addFoldersButton, () => api.chooseClipFolders(), {
      applyResult: setClipLibrary,
      celebrate: (library) => [...(library?.folders || []), ...(library?.clips || [])].some((item) => !existingIds.has(item.id))
    });
    return;
  }

  const addFilesButton = event.target.closest("[data-add-clip-files]");
  if (addFilesButton) {
    const existingIds = new Set([...ui.clipLibrary.folders, ...ui.clipLibrary.clips].map((item) => item.id));
    await runAction("add-clip-files", addFilesButton, () => api.chooseClipFiles(), {
      applyResult: setClipLibrary,
      celebrate: (library) => [...(library?.folders || []), ...(library?.clips || [])].some((item) => !existingIds.has(item.id))
    });
    return;
  }

  const chooseMediaOutputButton = event.target.closest("[data-choose-media-output]");
  if (chooseMediaOutputButton) {
    await runAction(
      "choose-media-output",
      chooseMediaOutputButton,
      async () => {
        ui.mediaOutputSelection = await api.chooseMediaOutputFolder();
        return null;
      },
      { applyResult: () => {} }
    );
    return;
  }

  const cancelMediaJobButton = event.target.closest("[data-cancel-media-job]");
  if (cancelMediaJobButton) {
    const jobId = cancelMediaJobButton.dataset.cancelMediaJob;
    if (!window.confirm("Cancel this local media job? Generated media already completed will not be deleted.")) return;
    await runAction(`cancel-media-${jobId}`, cancelMediaJobButton, () => api.cancelMediaJob(jobId));
    return;
  }

  const retryMediaJobButton = event.target.closest("[data-retry-media-job]");
  if (retryMediaJobButton) {
    const jobId = retryMediaJobButton.dataset.retryMediaJob;
    await runAction(`retry-media-${jobId}`, retryMediaJobButton, () => api.retryMediaJob(jobId));
    return;
  }

  const selectThumbnailButton = event.target.closest("[data-select-job-thumbnail]");
  if (selectThumbnailButton) {
    const jobId = selectThumbnailButton.dataset.selectJobThumbnail;
    const thumbnailId = selectThumbnailButton.dataset.thumbnailId;
    await runAction(`select-thumbnail-${jobId}`, selectThumbnailButton, () => api.selectMediaJobThumbnail(jobId, thumbnailId), {
      celebrate: true
    });
    return;
  }

  const addThumbnailButton = event.target.closest("[data-add-job-thumbnail]");
  if (addThumbnailButton) {
    const jobId = addThumbnailButton.dataset.addJobThumbnail;
    const groupId = addThumbnailButton.dataset.thumbnailGroup;
    await runAction(`add-thumbnail-${jobId}-${groupId}`, addThumbnailButton, () => api.addMediaJobThumbnail(jobId, groupId), {
      celebrate: true
    });
    return;
  }

  const revealMediaJobButton = event.target.closest("[data-reveal-media-job]");
  if (revealMediaJobButton) {
    const jobId = revealMediaJobButton.dataset.revealMediaJob;
    await runAction(`reveal-media-${jobId}`, revealMediaJobButton, () => api.openMediaJobOutput(jobId), {
      render: false,
      applyResult: () => {}
    });
    return;
  }

  const rescanFolderButton = event.target.closest("[data-rescan-clip-folder]");
  if (rescanFolderButton) {
    const folderId = rescanFolderButton.dataset.rescanClipFolder;
    await runAction(`rescan-folder-${folderId}`, rescanFolderButton, () => api.rescanClipFolder(folderId), {
      applyResult: setClipLibrary
    });
    return;
  }

  const relocateFolderButton = event.target.closest("[data-relocate-clip-folder]");
  if (relocateFolderButton) {
    const folderId = relocateFolderButton.dataset.relocateClipFolder;
    await runAction(`relocate-folder-${folderId}`, relocateFolderButton, () => api.relocateClipFolder(folderId), {
      applyResult: setClipLibrary
    });
    return;
  }

  const removeFolderButton = event.target.closest("[data-remove-clip-folder]");
  if (removeFolderButton) {
    const folderId = removeFolderButton.dataset.removeClipFolder;
    if (!window.confirm("Remove this folder from the Clip Library? ProduDash will not delete any media files.")) return;
    await runAction(`remove-folder-${folderId}`, removeFolderButton, () => api.removeClipFolder(folderId), {
      applyResult: setClipLibrary
    });
    return;
  }

  const removeClipButton = event.target.closest("[data-remove-clip]");
  if (removeClipButton) {
    const clipId = removeClipButton.dataset.removeClip;
    if (!window.confirm("Remove this video from the Clip Library index? ProduDash will not delete the media file.")) return;
    await runAction(`remove-clip-${clipId}`, removeClipButton, () => api.removeClip(clipId), {
      applyResult: setClipLibrary
    });
    return;
  }

  const revealClipButton = event.target.closest("[data-reveal-clip]");
  if (revealClipButton) {
    await runAction(
      `reveal-clip-${revealClipButton.dataset.revealClip}`,
      revealClipButton,
      () => api.openClipInFolder(revealClipButton.dataset.revealClip),
      { render: false, applyResult: () => {} }
    );
    return;
  }

  const libraryPageButton = event.target.closest("[data-library-offset]");
  if (libraryPageButton) {
    ui.libraryFilters.offset = Number(libraryPageButton.dataset.libraryOffset) || 0;
    await runAction("query-clip-library", libraryPageButton, () => api.getClipLibrary(ui.libraryFilters), {
      applyResult: setClipLibrary
    });
    return;
  }

  const rebuildSearchButton = event.target.closest("[data-rebuild-clip-search]");
  if (rebuildSearchButton) {
    await runAction(
      "rebuild-clip-search",
      rebuildSearchButton,
      async () => {
        await api.rebuildClipSearchIndex();
        return api.getClipLibrary(ui.libraryFilters);
      },
      {
        applyResult: setClipLibrary,
        celebrate: true
      }
    );
    return;
  }

  const resetButton = event.target.closest("[data-reset-dashboard]");
  if (resetButton) {
    if (!window.confirm("Reset imported dashboard data? Encrypted credentials will be retained.")) return;
    await runAction("reset-dashboard", resetButton, async () => {
      const state = await api.resetDashboardData();
      setClipLibrary(await api.getClipLibrary({ limit: ui.libraryFilters.limit }));
      await refreshProjects();
      setAdvisorHistory(await api.getAdvisorHistory());
      return state;
    });
    return;
  }

  const deleteButton = event.target.closest("[data-delete-all]");
  if (deleteButton) {
    if (!window.confirm("Permanently delete all ProduDash dashboard data and credentials from this computer?")) return;
    await runAction("delete-all", deleteButton, async () => {
      const state = await api.deleteAllLocalData();
      setClipLibrary(await api.getClipLibrary({ limit: ui.libraryFilters.limit }));
      setProjects(await api.getProjects(ui.projectFilters));
      setActiveProject(null);
      setAdvisorHistory(await api.getAdvisorHistory());
      return state;
    });
    return;
  }

  if (event.target.closest("#syncButton")) {
    await runAction("refresh-connections", event.target.closest("#syncButton"), () => api.refreshConnections());
    return;
  }

  if (event.target.closest("#trainButton")) {
    ui.activeSection = "integrations";
    renderApp({ animateView: true });
  }
}

function handleCandidateInput(event) {
  const projectPlayhead = event.target.closest?.("[data-project-playhead]");
  if (projectPlayhead) {
    ui.projectPlayhead = Number(projectPlayhead.value) || 0;
    const video = document.querySelector("[data-project-video]");
    if (video && ui.activeProject) {
      const mapped = sourceTimeAtPlayhead(ui.activeProject.draft, ui.projectPlayhead);
      video.currentTime = mapped.sourceTime;
    }
    return;
  }
  const projectZoom = event.target.closest?.("[data-project-zoom]");
  if (projectZoom) {
    ui.projectTimelineZoom = Number(projectZoom.value) || 1;
    const timeline = document.querySelector(".project-timeline");
    if (timeline) timeline.setAttribute("width", `${Math.round(1000 * ui.projectTimelineZoom)}`);
    return;
  }
  const transcriptSearch = event.target.closest?.("[data-project-transcript-search]");
  if (transcriptSearch) {
    ui.projectTranscriptQuery = transcriptSearch.value;
    return;
  }
  const seek = event.target.closest?.("[data-candidate-seek]");
  if (seek) {
    const video = seek.closest("[data-candidate-card]")?.querySelector("[data-candidate-video]");
    if (video) video.currentTime = Number(seek.value) || 0;
    return;
  }
  const form = event.target.closest?.("[data-candidate-edit-form]");
  if (!form) return;
  const draft = captureCandidateForm(form);
  const card = form.closest("[data-candidate-card]");
  const preview = card?.querySelector("[data-candidate-aspect-preview]");
  if (preview && draft) {
    preview.className = `candidate-aspect-preview aspect-${draft.targetAspect} treatment-${draft.aspectTreatment}`;
    const caption = preview.querySelector(".candidate-caption-preview");
    if (caption) {
      caption.className = `candidate-caption-preview style-${draft.captionStyle} position-${draft.captionPosition} safe-${draft.captionSafeArea}`;
      caption.textContent = draft.captionSegments[0]?.text || draft.manualCaptionText || "Caption preview";
    }
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLElement)) return;

  if (form.matches("[data-analytics-range-form]")) {
    event.preventDefault();
    const previousRangeDays = ui.analyticsRangeDays;
    ui.analyticsRangeDays = Number(form.elements.rangeDays.value);
    const succeeded = await runAction("analytics-range", event.submitter, refreshAnalyticsReport, { acknowledge: true });
    if (!succeeded) ui.analyticsRangeDays = previousRangeDays;
    return;
  }

  if (form.matches("[data-advisor-form]")) {
    event.preventDefault();
    if (ui.advisorRequest) return;
    const text = form.elements.text.value.trim();
    if (!text) return;
    const requestId = `advisor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    ui.advisorRequest = requestId;
    ui.advisorStatus = "thinking";
    ui.advisorToolName = null;
    ui.advisorError = null;
    ui.advisorHistory.turns = [
      ...ui.advisorHistory.turns,
      {
        id: `pending-${requestId}`,
        role: "user",
        text,
        at: new Date().toISOString(),
        providerId: ui.advisorHistory.status?.providerId || null,
        modelId: ui.advisorHistory.status?.modelId || null,
        usage: null,
        tools: []
      }
    ].slice(-50);
    renderAdvisor();
    try {
      await api.sendAdvisorTurn({
        requestId,
        text,
        context: {
          view: ui.activeSection,
          businessId: ui.selectedBusinessId,
          selectedRecord:
            ui.activeSection === "inbox" && ui.selectedConversationId
              ? { type: "conversation", id: ui.selectedConversationId }
              : ui.activeSection === "studio" && ui.studioTab === "projects" && ui.selectedProjectId
                ? { type: "project", id: ui.selectedProjectId }
                : ui.activeSection === "studio" && ui.selectedClipId
                  ? { type: "clip", id: ui.selectedClipId }
                  : ui.selectedBusinessId
                    ? { type: "business", id: ui.selectedBusinessId }
                    : null,
          safeError: typeof ui.error === "string" ? ui.error : null
        },
        dataCategories: ADVISOR_CATEGORIES
      });
    } catch (error) {
      if (error?.code !== "ADVISOR_CANCELED") {
        ui.advisorStatus = "warning";
        ui.advisorError = error?.message || "Advisor could not complete that request.";
      }
    } finally {
      ui.advisorRequest = null;
      try {
        setAdvisorHistory(await api.getAdvisorHistory());
      } catch {
        // The controlled Advisor error remains visible if history refresh fails.
      }
      renderAdvisor();
      if (!ui.advisorError) document.querySelector("#advisorPrompt")?.focus();
    }
    return;
  }

  if (form.matches("[data-advisor-settings-form]")) {
    event.preventDefault();
    await runAction(
      "advisor-settings",
      event.submitter,
      () => api.updateAdvisorSettings({ displayName: form.elements.displayName.value }),
      { applyResult: setAppState }
    );
    return;
  }

  if (form.matches("[data-template-create-form]")) {
    event.preventDefault();
    const positionY = { upper: 0.18, middle: 0.5, lower: 0.82 }[form.elements.overlayPosition.value] || 0.82;
    const overlayText = form.elements.overlayText.value.trim();
    await runAction(
      "create-brand-template",
      event.submitter,
      () =>
        api.createBrandTemplate({
          name: form.elements.name.value,
          description: form.elements.description.value,
          settings: {
            presentation: {
              targetAspect: form.elements.targetAspect.value,
              aspectTreatment: form.elements.aspectTreatment.value,
              captionMode: "srt_burned",
              captionStyle: form.elements.captionStyle.value,
              captionPosition: form.elements.captionPosition.value,
              captionSafeArea: "social",
              captionTextColor: form.elements.captionTextColor.value,
              captionBackgroundColor: form.elements.captionBackgroundColor.value,
              captionScale: Number(form.elements.captionScale.value)
            },
            composition: {
              transition: form.elements.transition.value,
              transitionDuration: Number(form.elements.transitionDuration.value),
              backgroundColor: form.elements.backgroundColor.value,
              music: form.elements.musicAssetId.value
                ? {
                    assetId: form.elements.musicAssetId.value,
                    volume: Number(form.elements.musicVolume.value),
                    fadeIn: 0.5,
                    fadeOut: 0.5
                  }
                : null,
              introAssetId: form.elements.introAssetId.value || null,
              outroAssetId: form.elements.outroAssetId.value || null,
              overlays: [
                ...(form.elements.logoAssetId.value
                  ? [
                      {
                        id: "brand-logo",
                        type: "logo",
                        assetId: form.elements.logoAssetId.value,
                        startRatio: 0,
                        endRatio: 1,
                        x: 0.88,
                        y: 0.12,
                        width: 0.18,
                        opacity: 0.95
                      }
                    ]
                  : []),
                ...(overlayText
                  ? [
                      {
                        id: "primary-overlay",
                        type: form.elements.overlayType.value,
                        text: overlayText,
                        startRatio: 0,
                        endRatio: 1,
                        x: 0.5,
                        y: positionY,
                        width: 0.72,
                        opacity: 1,
                        fontScale: 1,
                        textColor: "#ffffff",
                        backgroundColor: "#101214"
                      }
                    ]
                  : [])
              ]
            }
          }
        }),
      {
        applyResult: (template) => {
          form.reset();
          ui.brandTemplates = [template, ...ui.brandTemplates.filter((item) => item.id !== template.id)];
        },
        celebrate: true
      }
    );
    return;
  }

  if (form.matches("[data-project-create-form]")) {
    event.preventDefault();
    await runAction(
      "create-project",
      event.submitter,
      () =>
        api.createProject({
          title: form.elements.title.value,
          sourceMediaId: form.elements.sourceMediaId.value,
          description: form.elements.description.value,
          instructions: form.elements.instructions.value,
          businessId: ui.selectedBusinessId,
          desiredLengths: form.elements.desiredLengths.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          platforms: [...form.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value)
        }),
      {
        applyResult: (project) => {
          setActiveProject(project);
          ui.selectedProjectId = project.id;
          ui.studioTab = "projects";
        },
        celebrate: true
      }
    );
    await refreshProjects();
    return;
  }

  if (form.matches("[data-project-filter-form]")) {
    event.preventDefault();
    ui.projectFilters = {
      ...ui.projectFilters,
      query: form.elements.query.value,
      status: form.elements.status.value,
      sort: form.elements.sort.value,
      collectionId: form.elements.collectionId.value
    };
    await runAction("filter-projects", event.submitter, () => api.getProjects(ui.projectFilters), { applyResult: setProjects });
    return;
  }

  if (form.matches("[data-project-collection-form]")) {
    event.preventDefault();
    await runAction("create-project-collection", event.submitter, () => api.createProjectCollection(form.elements.name.value), {
      applyResult: setProjects
    });
    return;
  }

  if (form.matches("[data-project-transcript-search-form]")) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    ui.projectTranscriptQuery = form.elements.query.value;
    renderApp();
    document.querySelector("[data-project-transcript-search]")?.focus();
    return;
  }

  if (form.matches("[data-project-localization-create]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const localization = ui.activeProject.draft.localization || { sourceLanguage: "und", activeVariantId: null, variants: [] };
    const variant = {
      id: `language-${Date.now().toString(36)}`,
      language: form.elements.language.value,
      label: form.elements.label.value,
      status: "draft",
      cues: ui.activeProject.draft.transcript.map((cue) => ({ sourceId: cue.id, text: cue.text })),
      provenance: { source: "manual" }
    };
    await saveProjectPlan(
      {
        ...ui.activeProject.draft,
        localization: {
          ...localization,
          sourceLanguage: form.elements.sourceLanguage.value,
          variants: [...localization.variants, variant]
        }
      },
      event.submitter,
      "project-localization-create"
    );
    return;
  }

  if (form.matches("[data-project-localization-translate]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const [providerProfileId, modelId] = form.elements.providerSelection.value.split("::");
    const previousPlan = globalThis.structuredClone(ui.activeProject.draft);
    await runAction(
      `project-localization-translate-${ui.activeProject.id}`,
      event.submitter,
      () =>
        api.translateProjectTranscript({
          projectId: ui.activeProject.id,
          expectedRevision: ui.activeProject.revision,
          providerProfileId,
          modelId,
          sourceLanguage: ui.activeProject.draft.localization?.sourceLanguage || "und",
          targetLanguage: form.elements.targetLanguage.value,
          label: form.elements.label.value,
          consent: {
            approved: form.elements.consent.checked,
            providerProfileId,
            modelId,
            dataCategories: ["transcript"]
          }
        }),
      {
        applyResult: (nextProject) => {
          ui.projectUndo.push(previousPlan);
          ui.projectUndo = ui.projectUndo.slice(-100);
          ui.projectRedo = [];
          setActiveProject(nextProject, { resetHistory: false });
        }
      }
    );
    return;
  }

  if (form.matches("[data-project-localization-form]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const localization = ui.activeProject.draft.localization || { sourceLanguage: "und", activeVariantId: null, variants: [] };
    const variantId = form.dataset.localizationId;
    const reviewed = form.elements.reviewed.checked;
    const active = reviewed && form.elements.active.checked;
    const variants = localization.variants.map((variant) =>
      variant.id === variantId
        ? {
            ...variant,
            status: reviewed ? "reviewed" : "draft",
            cues: [...form.querySelectorAll("[data-localized-source-id]")].map((field) => ({
              sourceId: field.dataset.localizedSourceId,
              text: field.value
            }))
          }
        : variant
    );
    await saveProjectPlan(
      {
        ...ui.activeProject.draft,
        localization: {
          ...localization,
          activeVariantId: active ? variantId : localization.activeVariantId === variantId ? null : localization.activeVariantId,
          variants
        }
      },
      event.submitter,
      "project-localization-save"
    );
    return;
  }

  if (form.matches("[data-project-voiceover-create]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const [providerProfileId, modelId, voice] = form.elements.voiceSelection.value.split("::");
    await runAction(
      `project-voiceover-create-${ui.activeProject.id}`,
      event.submitter,
      () =>
        api.generateProjectVoiceover({
          projectId: ui.activeProject.id,
          expectedRevision: ui.activeProject.revision,
          sourceId: form.elements.sourceId.value,
          variantId: form.elements.variantId.value || null,
          providerProfileId,
          modelId,
          voice,
          instructions: form.elements.instructions.value,
          consent: {
            approved: form.elements.consent.checked,
            providerProfileId,
            modelId,
            voice,
            dataCategories: ["voiceover_text"],
            aiGeneratedDisclosureAccepted: form.elements.consent.checked
          }
        }),
      { applyResult: (project) => setActiveProject(project, { resetHistory: false }) }
    );
    await refreshBrandTemplates();
    renderApp();
    return;
  }

  if (form.matches("[data-project-speaker-voiceovers]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const [providerProfileId, modelId, voice] = form.elements.voiceSelection.value.split("::");
    await runAction(
      `project-speaker-voiceovers-${ui.activeProject.id}`,
      event.submitter,
      () =>
        api.generateProjectSpeakerVoiceovers({
          projectId: ui.activeProject.id,
          expectedRevision: ui.activeProject.revision,
          speaker: form.elements.speaker.value,
          variantId: form.elements.variantId.value || null,
          providerProfileId,
          modelId,
          voice,
          instructions: form.elements.instructions.value,
          consent: {
            approved: form.elements.consent.checked,
            providerProfileId,
            modelId,
            voice,
            dataCategories: ["voiceover_text"],
            aiGeneratedDisclosureAccepted: form.elements.consent.checked
          }
        }),
      { applyResult: (project) => setActiveProject(project, { resetHistory: false }) }
    );
    await refreshBrandTemplates();
    renderApp();
    return;
  }

  if (form.matches("[data-custom-voice-form]")) {
    event.preventDefault();
    const accepted = ui.appState.voiceLikeness?.acceptance?.termsVersion === "2026-07-24";
    const acceptance = accepted
      ? null
      : {
          termsVersion: "2026-07-24",
          legalName: form.elements.legalName.value,
          relationship: form.elements.relationship.value,
          adultConfirmed: form.elements.adultConfirmed.checked,
          rightsConfirmed: form.elements.rightsConfirmed.checked,
          consentConfirmed: form.elements.consentConfirmed.checked,
          syntheticDisclosureConfirmed: form.elements.syntheticDisclosureConfirmed.checked,
          misuseResponsibilityConfirmed: form.elements.misuseResponsibilityConfirmed.checked,
          providerTermsConfirmed: form.elements.providerTermsConfirmed.checked
        };
    await runAction(
      "custom-voice-create",
      event.submitter,
      () =>
        api.createCustomVoice({
          providerProfileId: form.elements.providerProfileId.value,
          name: form.elements.name.value,
          language: form.elements.language.value,
          acceptance
        }),
      {
        applyResult: (state) => {
          setAppState(state);
          form.closest("dialog")?.close();
        }
      }
    );
    renderApp();
    return;
  }

  if (form.matches("[data-rvc-voiceover-form]") && ui.activeProject) {
    event.preventDefault();
    const accepted = ui.appState.voiceLikeness?.acceptance?.termsVersion === "2026-07-24";
    const acceptance = accepted
      ? null
      : {
          termsVersion: "2026-07-24",
          legalName: form.elements.legalName.value,
          relationship: form.elements.relationship.value,
          adultConfirmed: form.elements.adultConfirmed.checked,
          rightsConfirmed: form.elements.rightsConfirmed.checked,
          consentConfirmed: form.elements.consentConfirmed.checked,
          syntheticDisclosureConfirmed: form.elements.syntheticDisclosureConfirmed.checked,
          misuseResponsibilityConfirmed: form.elements.misuseResponsibilityConfirmed.checked,
          providerTermsConfirmed: form.elements.providerTermsConfirmed.checked
        };
    const [providerProfileId, modelId] = form.elements.providerSelection.value.split("::");
    const approved = form.elements.conversionConsent.checked;
    await runAction(
      `project-rvc-convert-${form.elements.voiceoverId.value}`,
      event.submitter,
      () =>
        api.convertProjectVoiceover({
          projectId: ui.activeProject.id,
          expectedRevision: ui.activeProject.revision,
          voiceoverId: form.elements.voiceoverId.value,
          providerProfileId,
          modelId,
          voiceName: form.elements.voiceName.value,
          acceptance,
          consent: {
            approved,
            providerProfileId,
            modelId,
            sourceVoiceAuthorized: approved,
            syntheticDisclosureAccepted: approved,
            dataCategories: ["voice_audio"]
          }
        }),
      {
        applyResult: (project) => {
          setActiveProject(project, { resetHistory: false });
          form.closest("dialog")?.close();
        }
      }
    );
    await refreshBrandTemplates();
    renderApp();
    return;
  }

  if (form.matches("[data-local-likeness-form]")) {
    event.preventDefault();
    const accepted = ui.appState.voiceLikeness?.acceptance?.termsVersion === "2026-07-24";
    const acceptance = accepted
      ? null
      : {
          termsVersion: "2026-07-24",
          legalName: form.elements.legalName.value,
          relationship: form.elements.relationship.value,
          adultConfirmed: form.elements.adultConfirmed.checked,
          rightsConfirmed: form.elements.rightsConfirmed.checked,
          consentConfirmed: form.elements.consentConfirmed.checked,
          syntheticDisclosureConfirmed: form.elements.syntheticDisclosureConfirmed.checked,
          misuseResponsibilityConfirmed: form.elements.misuseResponsibilityConfirmed.checked,
          providerTermsConfirmed: form.elements.providerTermsConfirmed.checked
        };
    await runAction(
      "local-likeness-authorize",
      event.submitter,
      () =>
        api.authorizeConfiguredLocalVoice({
          providerProfileId: form.elements.providerProfileId.value,
          name: form.elements.name.value,
          acceptance
        }),
      {
        applyResult: (state) => {
          setAppState(state);
          form.closest("dialog")?.close();
        }
      }
    );
    renderApp();
    return;
  }

  if (form.matches("[data-project-voiceover-form]") && ui.activeProject) {
    event.preventDefault();
    const localization = ui.activeProject.draft.localization;
    const voiceoverId = form.dataset.voiceoverId;
    const voiceovers = localization.voiceovers.map((voiceover) =>
      voiceover.id === voiceoverId
        ? {
            ...voiceover,
            status: form.elements.reviewed.checked ? "reviewed" : "draft",
            originalAudio: form.elements.originalAudio.value,
            volume: Number(form.elements.volume.value)
          }
        : voiceover
    );
    await saveProjectPlan(
      { ...ui.activeProject.draft, localization: { ...localization, voiceovers } },
      event.submitter,
      "project-voiceover-save"
    );
    return;
  }

  if (form.matches("[data-project-settings-form]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const projectId = form.dataset.projectSettingsForm;
    const presentation = {
      ...ui.activeProject.draft.presentation,
      targetAspect: form.elements.targetAspect.value,
      aspectTreatment: form.elements.aspectTreatment.value,
      captionMode: form.elements.captionMode.value,
      captionStyle: form.elements.captionStyle.value,
      captionPosition: form.elements.captionPosition.value,
      captionScale: Number(form.elements.captionScale.value),
      captionTextColor: form.elements.captionTextColor.value,
      captionBackgroundColor: form.elements.captionBackgroundColor.value,
      enhancement: {
        mode: form.elements.enhancementMode.value,
        reviewed: form.elements.enhancementMode.value === "resize_hd" && form.elements.enhancementReviewed.checked
      }
    };
    const composition = {
      ...ui.activeProject.draft.composition,
      transition: form.elements.transition.value,
      transitionDuration: Number(form.elements.transitionDuration.value),
      backgroundColor: form.elements.backgroundColor.value,
      music: form.elements.musicAssetId.value
        ? {
            assetId: form.elements.musicAssetId.value,
            start: 0,
            end: ui.activeProject.draft.totalDuration,
            volume: Number(form.elements.musicVolume.value),
            fadeIn: 0.5,
            fadeOut: 0.5
          }
        : null,
      introAssetId: form.elements.introAssetId.value || null,
      outroAssetId: form.elements.outroAssetId.value || null,
      overlays: [
        ...ui.activeProject.draft.composition.overlays.filter((overlay) => overlay.type !== "logo"),
        ...(form.elements.logoAssetId.value
          ? [
              {
                id: "project-brand-logo",
                type: "logo",
                assetId: form.elements.logoAssetId.value,
                start: 0,
                end: ui.activeProject.draft.totalDuration,
                x: 0.88,
                y: 0.12,
                width: 0.18,
                opacity: 0.95
              }
            ]
          : [])
      ]
    };
    const intelligentTracks = {
      ...ui.activeProject.draft.intelligentTracks,
      subject:
        form.elements.subjectMode.value !== "off" && form.elements.subjectReviewed.checked
          ? [
              {
                id: "project-subject-focus",
                start: 0,
                end: ui.activeProject.draft.totalDuration,
                reviewed: true,
                mode: "keyframes",
                keyframes: [
                  {
                    at: 0,
                    x: Number(form.elements.subjectX.value),
                    y: Number(form.elements.subjectY.value),
                    scale: 1,
                    confidence: 1
                  }
                ]
              }
            ]
          : [],
      audio:
        form.elements.audioPreset.value !== "off" && form.elements.audioReviewed.checked
          ? [
              {
                id: "project-audio-treatment",
                start: 0,
                end: ui.activeProject.draft.totalDuration,
                reviewed: true,
                preset: form.elements.audioPreset.value,
                strength: Number(form.elements.audioStrength.value)
              }
            ]
          : [],
      broll:
        form.elements.brollMediaId.value && form.elements.brollReviewed.checked
          ? [
              {
                id: "project-broll",
                start: Number(form.elements.brollStart.value),
                end: Number(form.elements.brollEnd.value),
                reviewed: true,
                mediaId: form.elements.brollMediaId.value,
                sourceStart: Number(form.elements.brollSourceStart.value),
                sourceEnd:
                  Number(form.elements.brollSourceStart.value) +
                  (Number(form.elements.brollEnd.value) - Number(form.elements.brollStart.value)),
                fit: form.elements.brollFit.value,
                opacity: 1,
                provenance: {
                  source: "user_library",
                  mediaId: form.elements.brollMediaId.value,
                  fingerprint: form.elements.brollMediaId.selectedOptions[0]?.dataset.fingerprint || ""
                }
              }
            ]
          : [],
      sfx:
        form.elements.sfxAssetId.value && form.elements.sfxReviewed.checked
          ? [
              {
                id: "project-sfx",
                start: Number(form.elements.sfxStart.value),
                end: Number(form.elements.sfxEnd.value),
                reviewed: true,
                assetId: form.elements.sfxAssetId.value,
                volume: Number(form.elements.sfxVolume.value)
              }
            ]
          : []
    };
    await runAction(
      `project-settings-${projectId}`,
      event.submitter,
      async () => {
        const updated = await api.updateProject(projectId, {
          title: form.elements.title.value,
          description: form.elements.description.value,
          collectionId: form.elements.collectionId.value || null,
          tags: form.elements.tags.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          desiredLengths: form.elements.desiredLengths.value
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          instructions: form.elements.instructions.value,
          platforms: [...form.querySelectorAll('input[name="platforms"]:checked')].map((input) => input.value)
        });
        return api.saveProjectDraft(projectId, { ...updated.draft, presentation, composition, intelligentTracks }, updated.revision);
      },
      { applyResult: (project) => setActiveProject(project, { resetHistory: false }) }
    );
    await refreshProjects();
    return;
  }

  if (form.matches("[data-project-overlay-form]") && ui.activeProject) {
    event.preventDefault();
    const positionY = { upper: 0.18, middle: 0.5, lower: 0.82 }[form.elements.position.value] || 0.82;
    const overlay = {
      id: `overlay-${Date.now().toString(36)}`,
      type: form.elements.type.value,
      text: form.elements.text.value,
      start: Number(form.elements.start.value),
      end: Number(form.elements.end.value),
      x: 0.5,
      y: positionY,
      width: 0.72,
      opacity: 1,
      fontScale: 1,
      textColor: "#ffffff",
      backgroundColor: "#101214"
    };
    await saveProjectPlan(
      {
        ...ui.activeProject.draft,
        composition: {
          ...ui.activeProject.draft.composition,
          overlays: [...ui.activeProject.draft.composition.overlays, overlay]
        }
      },
      event.submitter,
      "project-overlay"
    );
    return;
  }

  if (form.matches("[data-project-relink-form]")) {
    event.preventDefault();
    await runAction(
      `project-relink-${form.dataset.projectRelinkForm}`,
      event.submitter,
      () => api.relinkProject(form.dataset.projectRelinkForm, form.elements.sourceMediaId.value),
      { applyResult: (project) => setActiveProject(project, { resetHistory: false }) }
    );
    await refreshProjects();
    return;
  }

  if (form.matches("[data-project-segment-form]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    const segmentId = form.dataset.segmentId;
    const projectWithPlayhead = { ...ui.activeProject, playhead: ui.projectPlayhead };
    const sourceStart = snapTime(Number(form.elements.sourceStart.value), projectWithPlayhead);
    const sourceEnd = snapTime(Number(form.elements.sourceEnd.value), projectWithPlayhead);
    await saveProjectPlan(editSegment(ui.activeProject.draft, segmentId, { sourceStart, sourceEnd }), event.submitter, "project-trim");
    return;
  }

  if (form.matches("[data-project-transcript-form]") && ui.activeProject) {
    event.preventDefault();
    const changes = [...form.querySelectorAll("[data-transcript-id]")].map((textarea) => ({
      id: textarea.dataset.transcriptId,
      text: textarea.value
    }));
    await saveProjectPlan(updateTranscript(ui.activeProject.draft, changes), event.submitter, "project-transcript");
    return;
  }

  if (form.matches("[data-project-marker-form]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    await saveProjectPlan(
      addMarker(ui.activeProject.draft, ui.projectPlayhead, form.elements.text.value),
      event.submitter,
      "project-marker"
    );
    return;
  }

  if (form.matches("[data-project-comment-form]") && ui.activeProject) {
    event.preventDefault();
    if (!(await flushPendingProjectTranscript(event.submitter))) return;
    await saveProjectPlan(
      addComment(ui.activeProject.draft, ui.projectPlayhead, form.elements.text.value),
      event.submitter,
      "project-comment"
    );
    return;
  }

  if (form.matches("[data-media-job-form]")) {
    event.preventDefault();
    const outputSelection = ui.mediaOutputSelection;
    if (!outputSelection) {
      ui.error = "Choose an output folder before creating the media job.";
      renderApp();
      return;
    }
    await runAction(
      "create-media-job",
      event.submitter,
      async () => {
        const analysisMode = form.elements.analysisMode.value;
        const analysisOption = form.elements.analysisMode.selectedOptions[0];
        const categories = (analysisOption.dataset.categories || "").split(",").filter(Boolean);
        const cloudConsent =
          analysisMode === "local_heuristics"
            ? null
            : {
                confirmed: form.elements.cloudConsent?.checked === true,
                providerId: analysisOption.dataset.providerId,
                modelId: analysisOption.dataset.modelId,
                transcriptionProviderId: analysisOption.dataset.transcriptionProviderId || null,
                transcriptionModelId: analysisOption.dataset.transcriptionModelId || null,
                dataCategories: categories
              };
        const state = await api.createMediaJob({
          sourceMediaId: form.elements.sourceMediaId.value,
          outputSelectionId: outputSelection.id,
          title: form.elements.title.value,
          goal: form.elements.goal.value,
          maxClips: form.elements.maxClips.value,
          targetDuration: form.elements.targetDuration.value,
          captionMode: form.elements.captionMode.value,
          captionText: form.elements.captionText.value,
          aspectTreatment: form.elements.aspectTreatment.value,
          targetAspect: form.elements.targetAspect.value,
          analysisMode,
          cloudConsent,
          platforms: getCheckedValues(form, "platforms")
        });
        ui.mediaOutputSelection = null;
        return state;
      },
      { acknowledge: true }
    );
    return;
  }

  if (form.matches("[data-candidate-edit-form]")) {
    event.preventDefault();
    const jobId = form.dataset.candidateEditForm;
    const candidateId = form.dataset.candidateId;
    const values = candidateValuesFromForm(form);
    await runAction(`edit-candidate-${jobId}-${candidateId}`, event.submitter, () => api.updateMediaCandidate(jobId, candidateId, values), {
      applyResult: (state) => {
        setAppState(state);
        resetCandidateDraft(jobId, candidateId);
      }
    });
    return;
  }

  if (form.matches("[data-media-candidates-form]")) {
    event.preventDefault();
    const jobId = form.dataset.mediaCandidatesForm;
    if (hasUnsavedCandidateEdits()) {
      ui.error = "Save or reset candidate edits before approving clips for rendering.";
      renderApp();
      return;
    }
    await runAction(
      `approve-media-${jobId}`,
      event.submitter,
      () => api.approveMediaCandidates(jobId, getCheckedValues(form, "candidateIds")),
      { acknowledge: true }
    );
    return;
  }

  if (form.matches("[data-post-form]")) {
    event.preventDefault();
    const submitter = event.submitter;
    const scheduleValue = form.elements.scheduledFor.value;
    await runAction(
      "create-post",
      submitter,
      () =>
        api.createPostPlan({
          clipJobId: form.elements.clipJobId.value,
          mediaJobId: form.elements.mediaJobId.value,
          title: form.elements.title.value,
          caption: form.elements.caption.value,
          scheduledFor: scheduleValue ? new Date(scheduleValue).toISOString() : "",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          platforms: getCheckedValues(form, "platforms")
        }),
      { celebrate: true }
    );
    return;
  }

  if (form.matches("[data-post-draft-form]")) {
    event.preventDefault();
    const submitter = event.submitter;
    const scheduleValue = form.elements.scheduledFor.value;
    const packages = [...form.querySelectorAll(".post-package-editor")].map((editor) => {
      // Provider-required choices are namespaced so they survive alongside the
      // copy fields without the handler knowing which platform declared them.
      const options = {};
      for (const select of editor.querySelectorAll('select[name^="option:"]')) {
        const key = select.name.slice("option:".length);
        // An untouched required choice stays unset rather than becoming a value
        // ProduDash picked; approval refuses the plan until it is made.
        if (select.value === "") continue;
        options[key] = select.value;
      }
      return {
        platformId: editor.elements.platformId.value,
        title: editor.elements.platformTitle.value,
        caption: editor.elements.platformCaption.value,
        options: Object.keys(options).length ? options : undefined
      };
    });
    await runAction(
      `update-post-${form.dataset.postDraftForm}`,
      submitter,
      () =>
        api.updatePostPlanDraft(form.dataset.postDraftForm, {
          platformPackages: packages,
          scheduledFor: scheduleValue ? new Date(scheduleValue).toISOString() : "",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        }),
      { celebrate: true }
    );
    return;
  }

  if (form.matches("[data-credentials-form]")) {
    event.preventDefault();
    const integrationId = form.dataset.credentialsForm;
    const values = {};
    for (const input of form.querySelectorAll("input[name], select[name]")) values[input.name] = input.value;
    await runAction(`credentials-${integrationId}`, event.submitter, () => api.saveIntegrationCredentials(integrationId, values), {
      refreshOnError: true,
      celebrate: true
    });
    return;
  }

  if (form.matches("[data-ai-provider-form]")) {
    event.preventDefault();
    const profileId = form.dataset.aiProviderForm;
    const values = {};
    for (const input of form.querySelectorAll("input[name], select[name]")) values[input.name] = input.value;
    await runAction(`ai-provider-${profileId}`, event.submitter, () => api.saveAiProviderCredentials(profileId, values), {
      refreshOnError: true,
      celebrate: true
    });
    return;
  }

  if (form.matches("[data-workload-form]")) {
    event.preventDefault();
    const workloadId = form.dataset.workloadForm;
    const value = form.elements.assignment.value;
    let selection;
    if (value === "same_as_advisor" || value === "unassigned") selection = { mode: value };
    else {
      const [profileId, modelId] = value.split("::");
      selection = { mode: "provider", profileId, modelId };
    }
    await runAction(`workload-${workloadId}`, event.submitter, () => api.setAiWorkload(workloadId, selection));
    return;
  }

  if (form.matches("[data-library-search-form]")) {
    event.preventDefault();
    ui.libraryFilters = {
      ...ui.libraryFilters,
      query: form.elements.query.value,
      folderId: form.elements.folderId.value,
      status: form.elements.status.value,
      sort: form.elements.sort.value,
      offset: 0
    };
    await runAction("query-clip-library", event.submitter, () => api.getClipLibrary(ui.libraryFilters), {
      applyResult: setClipLibrary
    });
    return;
  }

  if (form.matches("[data-clip-tags-form]")) {
    event.preventDefault();
    const clipId = form.dataset.clipTagsForm;
    const tags = form.elements.tags.value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    await runAction(`clip-tags-${clipId}`, event.submitter, () => api.updateClipTags(clipId, tags), {
      applyResult: setClipLibrary
    });
    return;
  }

  if (form.matches("[data-draft-form]")) {
    event.preventDefault();
    const conversation = getSelectedConversation() || getConversations()[0];
    if (!conversation) return;
    const prompt = form.elements.prompt.value.trim() || "Draft a safe approval-only customer response.";
    await runAction(
      `draft-${conversation.id}`,
      event.submitter,
      async () => {
        const result = await api.draftAiReply(conversation.id, prompt);
        ui.selectedConversationId = conversation.id;
        return result.state;
      },
      { celebrate: true }
    );
  }
}

function getCheckedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}
