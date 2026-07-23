import { bindHandlers } from "./renderer/handlers.js";
import { api } from "./renderer/api.js";
import { renderApp, renderFatalError } from "./renderer/render.js";
import { loadInitialState, setAppState } from "./renderer/state.js";
import { applyAdvisorEvent } from "./renderer/advisor.js";

async function bootstrap() {
  try {
    await loadInitialState();
    renderApp();
    bindHandlers();
    api.onMediaJobEvent(async () => {
      try {
        setAppState(await api.getAppState());
        renderApp();
      } catch {
        // A request/response action will surface any persistent job error.
      }
    });
    api.onAdvisorEvent(applyAdvisorEvent);
  } catch (error) {
    renderFatalError(error);
  }
}

bootstrap();
