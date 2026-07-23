import { api } from "./api.js";
import { renderApp } from "./render.js";
import { getConversations, getSelectedConversation, setAppState, setClipLibrary, ui } from "./state.js";

let handlersBound = false;

export function bindHandlers() {
  if (handlersBound) return;
  handlersBound = true;
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
}

async function runAction(key, trigger, action, options = {}) {
  if (ui.pending.has(key)) return;
  ui.pending.add(key);
  ui.error = null;
  const pendingUi = setPendingUi(trigger);
  try {
    const result = await action();
    if (options.applyResult) options.applyResult(result);
    else if (result) setAppState(result);
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
      if (!ui.error && trigger) document.querySelector("#pageTitle")?.focus();
    }
  }
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
  const originalLabel = trigger.textContent;
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
    originalLabel,
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
  pendingUi.trigger.textContent = pendingUi.originalLabel;
}

async function handleClick(event) {
  const studioTab = event.target.closest("[data-studio-tab]");
  if (studioTab) {
    ui.studioTab = studioTab.dataset.studioTab;
    renderApp();
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
    ui.selectedBusinessId = businessButton.dataset.business;
    ui.selectedConversationId = getConversations()[0]?.id || null;
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
    ui.activeSection = navButton.dataset.section;
    renderApp({ animateView: changedSection });
    return;
  }

  const approveButton = event.target.closest("[data-approve-approval]");
  if (approveButton) {
    await runAction(`approve-${approveButton.dataset.approveApproval}`, approveButton, () =>
      api.approveAiAction(approveButton.dataset.approveApproval)
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
    await runAction(`approve-post-${approvePostButton.dataset.approvePost}`, approvePostButton, () =>
      api.approvePostPlan(approvePostButton.dataset.approvePost, approvePostButton.dataset.approvalMode)
    );
    return;
  }

  const exportPostButton = event.target.closest("[data-export-post]");
  if (exportPostButton) {
    await runAction(`export-post-${exportPostButton.dataset.exportPost}`, exportPostButton, () =>
      api.markPostExported(exportPostButton.dataset.exportPost)
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

  const removeCredentialsButton = event.target.closest("[data-remove-credentials]");
  if (removeCredentialsButton) {
    const integrationId = removeCredentialsButton.dataset.removeCredentials;
    if (!window.confirm("Remove these credentials? Imported snapshots will remain but will be marked disconnected.")) return;
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

  const removeProviderButton = event.target.closest("[data-remove-ai-provider]");
  if (removeProviderButton) {
    const profileId = removeProviderButton.dataset.removeAiProvider;
    if (!window.confirm("Remove this AI provider’s encrypted credentials? Its public profile and workload assignments will remain."))
      return;
    await runAction(`remove-ai-provider-${profileId}`, removeProviderButton, () => api.removeAiProviderCredentials(profileId));
    return;
  }

  const addFoldersButton = event.target.closest("[data-add-clip-folders]");
  if (addFoldersButton) {
    await runAction("add-clip-folders", addFoldersButton, () => api.chooseClipFolders(), {
      applyResult: setClipLibrary
    });
    return;
  }

  const addFilesButton = event.target.closest("[data-add-clip-files]");
  if (addFilesButton) {
    await runAction("add-clip-files", addFilesButton, () => api.chooseClipFiles(), {
      applyResult: setClipLibrary
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

  const resetButton = event.target.closest("[data-reset-dashboard]");
  if (resetButton) {
    if (!window.confirm("Reset imported dashboard data? Encrypted credentials will be retained.")) return;
    await runAction("reset-dashboard", resetButton, async () => {
      const state = await api.resetDashboardData();
      setClipLibrary(await api.getClipLibrary({ limit: ui.libraryFilters.limit }));
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
      return state;
    });
    return;
  }

  const browseVideoButton = event.target.closest("[data-browse-video]");
  if (browseVideoButton) {
    await runAction(
      "choose-video",
      browseVideoButton,
      async () => {
        const filePath = await api.chooseSourceVideo();
        if (filePath) browseVideoButton.closest("[data-clip-form]").elements.source.value = filePath;
        return null;
      },
      { render: false }
    );
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

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLElement)) return;

  if (form.matches("[data-clip-form]")) {
    event.preventDefault();
    const submitter = event.submitter;
    await runAction("create-clip", submitter, () =>
      api.createClipJob({
        title: form.elements.title.value,
        source: form.elements.source.value,
        goal: form.elements.goal.value,
        targetLength: form.elements.targetLength.value,
        platforms: getCheckedValues(form, "platforms")
      })
    );
    return;
  }

  if (form.matches("[data-post-form]")) {
    event.preventDefault();
    const submitter = event.submitter;
    await runAction("create-post", submitter, () =>
      api.createPostPlan({
        clipJobId: form.elements.clipJobId.value,
        title: form.elements.title.value,
        caption: form.elements.caption.value,
        scheduledFor: form.elements.scheduledFor.value,
        platforms: getCheckedValues(form, "platforms")
      })
    );
    return;
  }

  if (form.matches("[data-credentials-form]")) {
    event.preventDefault();
    const integrationId = form.dataset.credentialsForm;
    const values = {};
    for (const input of form.querySelectorAll("input[name]")) values[input.name] = input.value;
    await runAction(`credentials-${integrationId}`, event.submitter, () => api.saveIntegrationCredentials(integrationId, values), {
      refreshOnError: true
    });
    return;
  }

  if (form.matches("[data-ai-provider-form]")) {
    event.preventDefault();
    const profileId = form.dataset.aiProviderForm;
    const values = {};
    for (const input of form.querySelectorAll("input[name]")) values[input.name] = input.value;
    await runAction(`ai-provider-${profileId}`, event.submitter, () => api.saveAiProviderCredentials(profileId, values), {
      refreshOnError: true
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
    await runAction(`draft-${conversation.id}`, event.submitter, async () => {
      const result = await api.draftAiReply(conversation.id, prompt);
      ui.selectedConversationId = conversation.id;
      return result.state;
    });
  }
}

function getCheckedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}
