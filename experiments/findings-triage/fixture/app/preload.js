/* eslint-disable no-var-requires -- CommonJS Electron entry points. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notes", {
  save: (filePath, contents) =>
    ipcRenderer.invoke("notes:save", filePath, contents),
  load: () => ipcRenderer.invoke("notes:load"),
});
