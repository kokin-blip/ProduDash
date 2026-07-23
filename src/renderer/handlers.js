import { api } from "./api.js";
import { renderApp } from "./render.js";
import { getConversations, getSelectedConversation, setAppState, ui } from "./state.js";

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
  if (trigger) trigger.disabled = true;
  try {
    const nextState = await action();
    if (nextState) setAppState(nextState);
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
    if (options.render === false && !ui.error) {
      if (trigger) trigger.disabled = false;
    } else {
      renderApp();
    }
  }
}

async function handleClick(event) {
  const businessButton = event.target.closest("[data-business]");
  if (businessButton) {
    ui.selectedBusinessId = businessButton.dataset.business;
    ui.selectedConversationId = getConversations()[0]?.id || null;
    renderApp();
    return;
  }

  const navButton = event.target.closest("[data-section]");
  if (navButton) {
    ui.activeSection = navButton.dataset.section;
    renderApp();
    return;
  }

  const conversationButton = event.target.closest("[data-conversation]");
  if (conversationButton) {
    ui.selectedConversationId = conversationButton.dataset.conversation;
    renderApp();
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

  const resetButton = event.target.closest("[data-reset-dashboard]");
  if (resetButton) {
    if (!window.confirm("Reset imported dashboard data? Encrypted credentials will be retained.")) return;
    await runAction("reset-dashboard", resetButton, () => api.resetDashboardData());
    return;
  }

  const deleteButton = event.target.closest("[data-delete-all]");
  if (deleteButton) {
    if (!window.confirm("Permanently delete all ProduDash dashboard data and credentials from this computer?")) return;
    await runAction("delete-all", deleteButton, () => api.deleteAllLocalData());
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
    renderApp();
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
