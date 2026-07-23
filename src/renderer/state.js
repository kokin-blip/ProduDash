import { api } from "./api.js";

export const ui = {
  appState: emptyAppState(),
  selectedBusinessId: null,
  selectedConversationId: null,
  selectedMode: "today",
  activeSection: "overview",
  pending: new Set(),
  error: null
};

function emptyAppState() {
  return {
    businesses: [],
    conversations: [],
    approvals: [],
    integrations: [],
    credentialSettings: [],
    creatorPlatforms: [],
    analyticsSources: [],
    clipperJobs: [],
    postQueue: [],
    auditLog: [],
    systemNotices: []
  };
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeAppState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    ...emptyAppState(),
    ...state,
    businesses: asArray(state.businesses),
    conversations: asArray(state.conversations),
    approvals: asArray(state.approvals),
    integrations: asArray(state.integrations),
    credentialSettings: asArray(state.credentialSettings),
    creatorPlatforms: asArray(state.creatorPlatforms),
    analyticsSources: asArray(state.analyticsSources),
    clipperJobs: asArray(state.clipperJobs),
    postQueue: asArray(state.postQueue),
    auditLog: asArray(state.auditLog),
    systemNotices: asArray(state.systemNotices)
  };
}

export async function loadInitialState() {
  setAppState(await api.getAppState());
}

export function setAppState(nextState) {
  ui.appState = normalizeAppState(nextState);
  if (!getBusiness(ui.selectedBusinessId)) ui.selectedBusinessId = ui.appState.selectedBusinessId || ui.appState.businesses[0]?.id || null;
  if (!getSelectedConversation()) ui.selectedConversationId = getConversations()[0]?.id || null;
}

export function getBusiness(businessId = ui.selectedBusinessId) {
  return ui.appState.businesses.find((business) => business?.id === businessId) || null;
}

export function getConversations(businessId = ui.selectedBusinessId) {
  return ui.appState.conversations.filter((conversation) => conversation?.businessId === businessId);
}

export function getSelectedConversation() {
  const conversation = ui.appState.conversations.find((item) => item?.id === ui.selectedConversationId);
  return conversation?.businessId === ui.selectedBusinessId ? conversation : null;
}

export function getApprovals(businessId = ui.selectedBusinessId) {
  return ui.appState.approvals.filter((approval) => approval?.businessId === businessId);
}

export function integrationReady(integrationId) {
  return ui.appState.integrations.some((integration) => integration?.id === integrationId && integration.status === "connected");
}

export function credentialStored(integrationId) {
  return ui.appState.credentialSettings.some((setting) => setting?.id === integrationId && setting.status === "stored");
}

export function isPending(key) {
  return ui.pending.has(key);
}
