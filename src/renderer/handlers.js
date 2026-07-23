import { api } from "./api.js";
import { renderApp } from "./render.js";
import { getConversations, getSelectedConversation, setAppState, ui } from "./state.js";

export function bindHandlers() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
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

  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) {
    ui.selectedMode = modeButton.dataset.mode;
    renderApp();
    return;
  }

  const conversationButton = event.target.closest("[data-conversation]");
  if (conversationButton) {
    ui.selectedConversationId = conversationButton.dataset.conversation;
    renderApp();
    return;
  }

  const completeButton = event.target.closest("[data-complete-command]");
  if (completeButton) {
    setAppState(await api.completeCommand(completeButton.dataset.completeCommand));
    renderApp();
    return;
  }

  const approveButton = event.target.closest("[data-approve-approval]");
  if (approveButton) {
    setAppState(await api.approveAiAction(approveButton.dataset.approveApproval));
    renderApp();
    return;
  }

  const rejectButton = event.target.closest("[data-reject-approval]");
  if (rejectButton) {
    setAppState(await api.rejectAiAction(rejectButton.dataset.rejectApproval));
    renderApp();
    return;
  }

  const approvePostButton = event.target.closest("[data-approve-post]");
  if (approvePostButton) {
    setAppState(await api.approvePostPlan(approvePostButton.dataset.approvePost));
    renderApp();
    return;
  }

  const exportPostButton = event.target.closest("[data-export-post]");
  if (exportPostButton) {
    setAppState(await api.markPostExported(exportPostButton.dataset.exportPost));
    renderApp();
    return;
  }

  const browseVideoButton = event.target.closest("[data-browse-video]");
  if (browseVideoButton) {
    const filePath = await api.chooseSourceVideo();
    if (filePath) {
      const form = browseVideoButton.closest("[data-clip-form]");
      form.elements.source.value = filePath;
    }
    return;
  }

  const removeCredentialsButton = event.target.closest("[data-remove-credentials]");
  if (removeCredentialsButton) {
    setAppState(await api.removeIntegrationCredentials(removeCredentialsButton.dataset.removeCredentials));
    renderApp();
    return;
  }

  if (event.target.closest("[data-reset-local]") || event.target.closest("#trainButton")?.textContent === "Clear local state") {
    setAppState(await api.resetLocalData());
    ui.selectedBusinessId = ui.appState.selectedBusinessId;
    ui.selectedConversationId = ui.appState.selectedConversationId;
    renderApp();
    return;
  }

  if (event.target.closest("#syncButton")) {
    setAppState(await api.getAppState());
    renderApp();
    return;
  }

  if (event.target.closest("#trainButton")) {
    ui.activeSection = "integrations";
    ui.selectedConversationId = getSelectedConversation()?.id || getConversations()[0]?.id;
    renderApp();
  }
}

async function handleSubmit(event) {
  const clipForm = event.target.closest("[data-clip-form]");
  if (clipForm) {
    event.preventDefault();
    setAppState(
      await api.createClipJob({
        title: clipForm.elements.title.value,
        source: clipForm.elements.source.value,
        goal: clipForm.elements.goal.value,
        targetLength: clipForm.elements.targetLength.value,
        platforms: getCheckedValues(clipForm, "platforms")
      })
    );
    clipForm.reset();
    renderApp();
    return;
  }

  const postForm = event.target.closest("[data-post-form]");
  if (postForm) {
    event.preventDefault();
    setAppState(
      await api.createPostPlan({
        clipJobId: postForm.elements.clipJobId.value,
        title: postForm.elements.title.value,
        caption: postForm.elements.caption.value,
        scheduledFor: postForm.elements.scheduledFor.value,
        platforms: getCheckedValues(postForm, "platforms")
      })
    );
    postForm.reset();
    renderApp();
    return;
  }

  const credentialsForm = event.target.closest("[data-credentials-form]");
  if (credentialsForm) {
    event.preventDefault();
    const values = {};
    for (const input of credentialsForm.querySelectorAll("input[name]")) {
      values[input.name] = input.value;
    }
    setAppState(await api.saveIntegrationCredentials(credentialsForm.dataset.credentialsForm, values));
    credentialsForm.reset();
    renderApp();
    return;
  }

  const form = event.target.closest("[data-draft-form]");
  if (!form) return;
  event.preventDefault();
  const input = form.elements.prompt;
  const prompt = input.value.trim() || "Draft a safe approval-only customer response.";
  const conversation = getSelectedConversation() || getConversations()[0];
  if (!conversation) return;
  const result = await api.draftAiReply(conversation.id, prompt);
  setAppState(result.state);
  ui.selectedConversationId = conversation.id;
  input.value = "";
  renderApp();
}

function getCheckedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}
