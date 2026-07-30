const { app, BrowserWindow, dialog, Menu, protocol, safeStorage, session, shell, utilityProcess } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createConnectors } = require("./connectors.cjs");
const { PublishingDispatchService } = require("./publishing/dispatch-service.cjs");
const { ConnectionService } = require("./connections.cjs");
const { CredentialVault, createSafeStorageAdapter } = require("./credential-vault.cjs");
const { AppError } = require("./errors.cjs");
const { registerIpc } = require("./ipc.cjs");
const { ProduDashStore } = require("./store.cjs");
const { GeminiProviderAdapter } = require("./ai/adapters/gemini.cjs");
const { OpenAIProviderAdapter } = require("./ai/adapters/openai.cjs");
const { AnthropicProviderAdapter } = require("./ai/adapters/anthropic.cjs");
const { OpenAICompatibleProviderAdapter } = require("./ai/adapters/openai-compatible.cjs");
const { ElevenLabsProviderAdapter } = require("./ai/adapters/elevenlabs.cjs");
const { WhisperCppProviderAdapter } = require("./ai/adapters/whisper-cpp.cjs");
const { PiperLocalProviderAdapter } = require("./ai/adapters/piper-local.cjs");
const { KokoroLocalProviderAdapter } = require("./ai/adapters/kokoro-local.cjs");
const { RvcLocalProviderAdapter } = require("./ai/adapters/rvc-local.cjs");
const { XttsLocalProviderAdapter } = require("./ai/adapters/xtts-local.cjs");
const { ChatterboxLocalProviderAdapter } = require("./ai/adapters/chatterbox-local.cjs");
const { TortoiseLocalProviderAdapter } = require("./ai/adapters/tortoise-local.cjs");
const { ProviderRegistry } = require("./ai/provider-registry.cjs");
const { ProviderService } = require("./ai/provider-service.cjs");
const { MediaLibrary } = require("./media/media-library.cjs");
const { MediaJobService } = require("./media/media-job-service.cjs");
const { createMediaProtocolHandler } = require("./media/media-protocol.cjs");
const { MediaUtilityRunner } = require("./media/utility-runner.cjs");
const { TranscriptionService } = require("./media/transcription-service.cjs");
const { MediaAnalysisService } = require("./media/media-analysis-service.cjs");
const { AdvisorHistory } = require("./advisor/advisor-history.cjs");
const { AdvisorService } = require("./advisor/advisor-service.cjs");
const { createAdvisorTools } = require("./advisor/advisor-tools.cjs");
const { ProjectStore } = require("./projects/project-store.cjs");
const { TemplateStore } = require("./projects/template-store.cjs");
const { BrandAssetStore } = require("./projects/brand-asset-store.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "produdash-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

const indexPath = path.join(__dirname, "..", "index.html");
const appUrl = pathToFileURL(indexPath).href;
let mainWindow;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.setAppUserModelId("com.kokinblip.produdash");
if (app.isPackaged) {
  process.env.PRODUDASH_PACKAGED = "1";
  process.env.PRODUDASH_RESOURCES_PATH = process.resourcesPath;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 760,
    title: "ProduDash",
    backgroundColor: "#0f1418",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl !== appUrl) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.loadFile(indexPath);
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);

      const credentialVault = new CredentialVault(app.getPath("userData"), createSafeStorageAdapter(safeStorage));
      const store = new ProduDashStore(app.getPath("userData"), { credentialVault, appVersion: app.getVersion() });
      try {
        await store.initialize();
      } catch (error) {
        if (error instanceof AppError && error.code === "SECURE_STORAGE_UNAVAILABLE") {
          store.credentialVault = null;
          store.notices.push({
            code: error.code,
            message: "Secure credential storage is unavailable. Connections are disabled, but local planning remains available."
          });
        } else {
          throw error;
        }
      }
      // Authorization opens in the user's real browser, never an embedded view.
      const connectors = createConnectors({ openExternal: (url) => shell.openExternal(url) });
      const providerRegistry = new ProviderRegistry([
        new GeminiProviderAdapter({ connector: connectors.gemini }),
        new OpenAIProviderAdapter(),
        new AnthropicProviderAdapter(),
        new ElevenLabsProviderAdapter(),
        new OpenAICompatibleProviderAdapter(),
        new WhisperCppProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        }),
        new PiperLocalProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        }),
        new KokoroLocalProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        }),
        new RvcLocalProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        }),
        new XttsLocalProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        }),
        new ChatterboxLocalProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        }),
        new TortoiseLocalProviderAdapter({
          startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
        })
      ]);
      const providers = new ProviderService({ store, registry: providerRegistry });
      await providers.initialize();
      const mediaLibrary = new MediaLibrary(app.getPath("userData"), {
        credentialVault: store.credentialVault,
        startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
      });
      const projects = new ProjectStore(app.getPath("userData"), { mediaLibrary, appStore: store });
      mediaLibrary.setTranscriptSearchProvider((mediaId) => projects.getTranscriptSearchSegments(mediaId));
      store.notices.push(...projects.getNotices());
      const templates = new TemplateStore(app.getPath("userData"));
      store.notices.push(...templates.getNotices());
      const brandAssets = new BrandAssetStore(app.getPath("userData"));
      store.notices.push(...brandAssets.getNotices());
      const transcriptionService = new TranscriptionService({ providerService: providers });
      const mediaAnalysisService = new MediaAnalysisService({
        providerService: providers,
        transcriptionService
      });
      const mediaJobs = new MediaJobService({
        store,
        mediaLibrary,
        projects,
        brandAssets,
        credentialVault: store.credentialVault,
        runner: new MediaUtilityRunner({ utilityProcess }),
        analysisService: mediaAnalysisService,
        startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark),
        onEvent: (event) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("produdash:mediaJobEvent", event);
        }
      });
      store.notices.push(...mediaLibrary.getNotices());
      const advisorHistory = new AdvisorHistory(app.getPath("userData"));
      const advisor = new AdvisorService({
        providerService: providers,
        history: advisorHistory,
        tools: createAdvisorTools({ store, mediaLibrary, projects }),
        onEvent: (event) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("produdash:advisorEvent", event);
        }
      });
      store.notices.push(...advisorHistory.getNotices());
      const connections = new ConnectionService({
        store,
        connectorRegistry: connectors.connectorRegistry,
        providerService: providers
      });
      const publishing = new PublishingDispatchService({
        store,
        connectorRegistry: connectors.connectorRegistry,
        connections,
        mediaJobs,
        credentialVault: store.credentialVault
      });
      protocol.handle("produdash-media", createMediaProtocolHandler(mediaLibrary, brandAssets, mediaJobs));
      registerIpc({
        store,
        connections,
        connectorRegistry: connectors.connectorRegistry,
        publishing,
        providers,
        mediaLibrary,
        projects,
        templates,
        brandAssets,
        mediaJobs,
        advisor,
        appUrl,
        shell
      });
      await mediaJobs.initialize();
      Menu.setApplicationMenu(null);
      createWindow();
    } catch (error) {
      dialog.showErrorBox(
        "ProduDash could not start",
        error instanceof AppError ? error.message : "Local application data could not be opened safely."
      );
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
