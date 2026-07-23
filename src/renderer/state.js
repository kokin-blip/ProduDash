import { api } from "./api.js";

export const ui = {
  appState: null,
  selectedBusinessId: null,
  selectedConversationId: null,
  selectedMode: "today",
  activeSection: "overview",
  pending: false
};

export async function loadInitialState() {
  ui.appState = await api.getAppState();
  ui.selectedBusinessId = ui.appState.selectedBusinessId || ui.appState.businesses[0]?.id;
  ui.selectedConversationId =
    ui.appState.selectedConversationId ||
    ui.appState.conversations.find((conversation) => conversation.businessId === ui.selectedBusinessId)?.id ||
    null;
}

export function setAppState(nextState) {
  ui.appState = nextState;
  if (!getBusiness(ui.selectedBusinessId) && nextState.businesses.length) {
    ui.selectedBusinessId = nextState.businesses[0]?.id;
  }
  if (!nextState.businesses.length) ui.selectedBusinessId = null;
  if (!getSelectedConversation()) {
    ui.selectedConversationId = getConversations()[0]?.id || null;
  }
}

export function getBusiness(businessId = ui.selectedBusinessId) {
  return ui.appState.businesses.find((business) => business.id === businessId);
}

export function getConversations(businessId = ui.selectedBusinessId) {
  return ui.appState.conversations.filter((conversation) => conversation.businessId === businessId);
}

export function getSelectedConversation() {
  return ui.appState.conversations.find((conversation) => conversation.id === ui.selectedConversationId);
}

export function getApprovals(businessId = ui.selectedBusinessId) {
  return ui.appState.approvals.filter((approval) => approval.businessId === businessId);
}

export function getPendingApprovals(businessId = ui.selectedBusinessId) {
  return getApprovals(businessId).filter((approval) => approval.status === "pending");
}
