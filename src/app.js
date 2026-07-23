import { bindHandlers } from "./renderer/handlers.js";
import { renderApp, renderFatalError } from "./renderer/render.js";
import { loadInitialState } from "./renderer/state.js";

async function bootstrap() {
  try {
    await loadInitialState();
    renderApp();
    bindHandlers();
  } catch (error) {
    renderFatalError(error);
  }
}

bootstrap();
