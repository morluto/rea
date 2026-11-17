const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reaHub', {
  openLink: (key) => ipcRenderer.invoke('rea-hub:open-link', key),
});
