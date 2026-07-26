import { bindHandlers } from "./renderer/handlers.js";
import { api } from "./renderer/api.js";
import { renderApp, renderFatalError } from "./renderer/render.js";
import { loadInitialState, setActiveProject, setAppState, setProjects, ui } from "./renderer/state.js";
import { applyAdvisorEvent } from "./renderer/advisor.js";
import { reactToMediaJobUpdates } from "./renderer/advisor-reactions.js";
import { captureCandidateDrafts } from "./renderer/views/candidate-review.js";

let mediaEventRefresh = Promise.resolve();

async function bootstrap() {
  try {
    await loadInitialState();
    renderApp();
    bindHandlers();
    api.onMediaJobEvent(() => {
      mediaEventRefresh = mediaEventRefresh.then(async () => {
        try {
          const previousJobs = ui.appState.mediaJobs;
          const nextState = await api.getAppState();
          if (JSON.stringify(previousJobs) === JSON.stringify(nextState.mediaJobs)) return;
          captureCandidateDrafts();
          setAppState(nextState);
          if (ui.studioTab === "projects") {
            setProjects(await api.getProjects(ui.projectFilters));
            if (ui.selectedProjectId) {
              try {
                setActiveProject(await api.getProject(ui.selectedProjectId), { resetHistory: false });
              } catch {
                setActiveProject(null);
              }
            }
          }
          renderApp();
          reactToMediaJobUpdates(previousJobs, nextState.mediaJobs);
        } catch {
          // A request/response action will surface any persistent job error.
        }
      });
    });
    api.onAdvisorEvent(applyAdvisorEvent);
  } catch (error) {
    renderFatalError(error);
  }
}

bootstrap();
