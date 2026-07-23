import { api } from "./api.js";

export const ui = {
  appState: emptyAppState(),
  selectedBusinessId: null,
  selectedConversationId: null,
  selectedMode: "today",
  activeSection: "overview",
  studioTab: "library",
  providerCatalog: [],
  clipLibrary: emptyClipLibrary(),
  libraryFilters: { query: "", folderId: "", status: "", sort: "modified_desc", offset: 0, limit: 40 },
  selectedClipId: null,
  mediaOutputSelection: null,
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
    aiProviders: [],
    aiWorkloads: {},
    advisorSettings: { displayName: "Advisor" },
    creatorPlatforms: [],
    analyticsSources: [],
    mediaJobs: [],
    clipperJobs: [],
    postQueue: [],
    auditLog: [],
    systemNotices: []
  };
}

function emptyClipLibrary() {
  return { folders: [], clips: [], total: 0, offset: 0, limit: 40, notices: [] };
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
    aiProviders: asArray(state.aiProviders),
    aiWorkloads: state.aiWorkloads && typeof state.aiWorkloads === "object" && !Array.isArray(state.aiWorkloads) ? state.aiWorkloads : {},
    advisorSettings:
      state.advisorSettings && typeof state.advisorSettings === "object" && !Array.isArray(state.advisorSettings)
        ? state.advisorSettings
        : { displayName: "Advisor" },
    creatorPlatforms: asArray(state.creatorPlatforms),
    analyticsSources: asArray(state.analyticsSources),
    mediaJobs: asArray(state.mediaJobs),
    clipperJobs: asArray(state.clipperJobs),
    postQueue: asArray(state.postQueue),
    auditLog: asArray(state.auditLog),
    systemNotices: asArray(state.systemNotices)
  };
}

export async function loadInitialState() {
  const [appState, providerCatalog, clipLibrary] = await Promise.all([
    api.getAppState(),
    api.getAiProviderCatalog(),
    api.getClipLibrary({ limit: ui.libraryFilters.limit })
  ]);
  setAppState(appState);
  ui.providerCatalog = asArray(providerCatalog);
  setClipLibrary(clipLibrary);
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

export function providerReady(profileId) {
  return ui.appState.aiProviders.some((profile) => profile?.id === profileId && profile.status === "connected");
}

export function providerCredentialsStored(profileId) {
  return ui.appState.aiProviders.some((profile) => profile?.id === profileId && profile.credentialStatus === "stored");
}

export function resolveWorkload(workloadId) {
  const selection = ui.appState.aiWorkloads?.[workloadId];
  if (selection?.mode === "same_as_advisor") return ui.appState.aiWorkloads?.advisor || null;
  return selection || null;
}

export function workloadReady(workloadId) {
  const selection = resolveWorkload(workloadId);
  return selection?.mode === "provider" && providerReady(selection.profileId);
}

export function setClipLibrary(value) {
  const library = value && typeof value === "object" ? value : {};
  ui.clipLibrary = {
    ...emptyClipLibrary(),
    ...library,
    folders: asArray(library.folders),
    clips: asArray(library.clips),
    notices: asArray(library.notices)
  };
  if (!ui.clipLibrary.clips.some((clip) => clip.id === ui.selectedClipId)) {
    ui.selectedClipId = ui.clipLibrary.clips[0]?.id || null;
  }
}

export function credentialStored(integrationId) {
  return ui.appState.credentialSettings.some((setting) => setting?.id === integrationId && setting.status === "stored");
}

export function isPending(key) {
  return ui.pending.has(key);
}
