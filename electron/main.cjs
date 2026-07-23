const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");
const { createMockConnectors } = require("./connectors.cjs");
const { registerIpc } = require("./ipc.cjs");
const { ProduDashStore } = require("./store.cjs");

let store;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 760,
    title: "ProduDash",
    backgroundColor: "#0f1418",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 20 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(() => {
  store = new ProduDashStore(app.getPath("userData"));
  registerIpc({ store, connectors: createMockConnectors(store) });
  Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
