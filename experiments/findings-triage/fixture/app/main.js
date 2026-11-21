/* eslint-disable no-var-requires -- CommonJS Electron entry points. */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const createWindow = () => {
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
    },
  });
  window.loadFile("index.html");
};

ipcMain.handle("notes:save", async (_event, filePath, contents) => {
  await fs.writeFile(filePath, contents, "utf8");
  return true;
});

ipcMain.handle("notes:load", async () =>
  fs.readFile(path.join(app.getPath("userData"), "notes.txt"), "utf8"),
);

app.whenReady().then(createWindow);
