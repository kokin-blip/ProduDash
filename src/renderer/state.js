import { api } from "./api.js";

export const ui = {
  appState: emptyAppState(),
  selectedBusinessId: null,
  selectedConversationId: null,
  selectedMode: "today",
  activeSection: "overview",
  studioTab: "library",
  projects: { projects: [], collections: [], total: 0, notices: [] },
  brandTemplates: [],
  brandAssets: [],
  projectFilters: { query: "", status: "active", sort: "updated_desc", collectionId: "" },
  selectedProjectId: null,
  activeProject: null,
  selectedProjectSegmentId: null,
  projectUndo: [],
  projectRedo: [],
  projectTimelineZoom: 1,
  projectPlayhead: 0,
  projectTranscriptQuery: "",
  projectPreviewMode: "edit",
  providerCatalog: [],
  localVoiceReport: null,
  analyticsReport: null,
  analyticsRangeDays: 30,
  clipLibrary: emptyClipLibrary(),
  libraryFilters: { query: "", folderId: "", status: "", sort: "modified_desc", offset: 0, limit: 40 },
  selectedClipId: null,
  mediaOutputSelection: null,
  candidateDrafts: new Map(),
  advisorOpen: false,
  advisorHistory: { turns: [], status: { ready: false, providerId: null, modelId: null, consentedCategories: [] } },
  advisorRequest: null,
  advisorStatus: "idle",
  advisorToolName: null,
  advisorError: null,
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
    advisorSettings: { displayName: "Juanito" },
    voiceLikeness: { acceptance: null, voices: [] },
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
        : { displayName: "Juanito" },
    voiceLikeness:
      state.voiceLikeness && typeof state.voiceLikeness === "object" && !Array.isArray(state.voiceLikeness)
        ? {
            acceptance: state.voiceLikeness.acceptance || null,
            voices: asArray(state.voiceLikeness.voices)
          }
        : { acceptance: null, voices: [] },
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
  const [appState, providerCatalog, clipLibrary, projects, advisorHistory] = await Promise.all([
    api.getAppState(),
    api.getAiProviderCatalog(),
    api.getClipLibrary({ limit: ui.libraryFilters.limit }),
    api.getProjects(ui.projectFilters),
    api.getAdvisorHistory()
  ]);
  setAppState(appState);
  ui.providerCatalog = asArray(providerCatalog);
  setClipLibrary(clipLibrary);
  setProjects(projects);
  setAdvisorHistory(advisorHistory);
}

export function setAppState(nextState) {
  ui.appState = normalizeAppState(nextState);
  if (!getBusiness(ui.selectedBusinessId)) ui.selectedBusinessId = ui.appState.selectedBusinessId || ui.appState.businesses[0]?.id || null;
  if (!getSelectedConversation()) ui.selectedConversationId = getConversations()[0]?.id || null;
}

export function setAnalyticsReport(report) {
  ui.analyticsReport = report && typeof report === "object" && !Array.isArray(report) ? report : null;
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

export function setProjects(value) {
  const projects = value && typeof value === "object" ? value : {};
  ui.projects = {
    projects: asArray(projects.projects),
    collections: asArray(projects.collections),
    total: Number(projects.total) || 0,
    notices: asArray(projects.notices)
  };
  if (!ui.projects.projects.some((project) => project.id === ui.selectedProjectId)) {
    ui.selectedProjectId = ui.projects.projects[0]?.id || null;
    if (ui.activeProject?.id !== ui.selectedProjectId) ui.activeProject = null;
  }
}

export function setActiveProject(value, { resetHistory = true } = {}) {
  ui.activeProject = value && typeof value === "object" ? value : null;
  ui.selectedProjectId = ui.activeProject?.id || ui.selectedProjectId;
  if (!ui.activeProject?.draft?.segments?.some((segment) => segment.id === ui.selectedProjectSegmentId)) {
    ui.selectedProjectSegmentId = ui.activeProject?.draft?.segments?.[0]?.id || null;
  }
  if (resetHistory) {
    ui.projectUndo = [];
    ui.projectRedo = [];
  }
}

export function setAdvisorHistory(value) {
  const history = value && typeof value === "object" ? value : {};
  ui.advisorHistory = {
    turns: asArray(history.turns),
    status:
      history.status && typeof history.status === "object"
        ? history.status
        : { ready: false, providerId: null, modelId: null, consentedCategories: [] }
  };
}

export function credentialStored(integrationId) {
  return ui.appState.credentialSettings.some((setting) => setting?.id === integrationId && setting.status === "stored");
}

export function isPending(key) {
  return ui.pending.has(key);
}
