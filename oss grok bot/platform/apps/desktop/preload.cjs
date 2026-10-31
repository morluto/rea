const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'workshopDesktop',
  Object.freeze({
    info: () => ipcRenderer.invoke('workshop:info'),
    copyText: (text) => ipcRenderer.invoke('workshop:copy-text', text),
    setAppearance: (theme) => ipcRenderer.invoke('workshop:appearance', theme),
    setHardwareAcceleration: (enabled) => ipcRenderer.invoke('workshop:graphics', enabled),
    notificationStatus: () => ipcRenderer.invoke('workshop:notification-status'),
    setNotifications: (enabled) => ipcRenderer.invoke('workshop:notification-settings', enabled),
    notify: (title, body, tag) => ipcRenderer.invoke('workshop:notify', { title, body, tag }),
    startPrimary: () => ipcRenderer.invoke('workshop:local'),
    connectPrimary: (url) => ipcRenderer.invoke('workshop:remote', url),
    chooseHost: () => ipcRenderer.invoke('workshop:selector'),
  }),
);
