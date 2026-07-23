const { app, BrowserWindow, dialog, Menu, protocol, safeStorage, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createConnectors } = require("./connectors.cjs");
const { ConnectionService } = require("./connections.cjs");
const { CredentialVault, createSafeStorageAdapter } = require("./credential-vault.cjs");
const { AppError } = require("./errors.cjs");
const { registerIpc } = require("./ipc.cjs");
const { ProduDashStore } = require("./store.cjs");
const { GeminiProviderAdapter } = require("./ai/adapters/gemini.cjs");
const { ProviderRegistry } = require("./ai/provider-registry.cjs");
const { ProviderService } = require("./ai/provider-service.cjs");
const { MediaLibrary } = require("./media/media-library.cjs");
const { createMediaProtocolHandler } = require("./media/media-protocol.cjs");

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
      const store = new ProduDashStore(app.getPath("userData"), { credentialVault });
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
      const connectors = createConnectors();
      const providerRegistry = new ProviderRegistry([new GeminiProviderAdapter({ connector: connectors.gemini })]);
      const providers = new ProviderService({ store, registry: providerRegistry });
      await providers.initialize();
      const mediaLibrary = new MediaLibrary(app.getPath("userData"), {
        credentialVault: store.credentialVault,
        startAccessingBookmark: (bookmark) => app.startAccessingSecurityScopedResource(bookmark)
      });
      store.notices.push(...mediaLibrary.getNotices());
      const connections = new ConnectionService({ store, shopify: connectors.shopify, providerService: providers });
      protocol.handle("produdash-media", createMediaProtocolHandler(mediaLibrary));
      registerIpc({ store, connections, providers, mediaLibrary, appUrl, shell });
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
