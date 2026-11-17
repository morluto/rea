const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

app.disableHardwareAcceleration();

const links = Object.freeze({
  rea: 'https://github.com/morluto/rea',
  reaInstall: 'https://github.com/morluto/rea/blob/main/docs/getting-started/installation.md',
  reaClaude: 'https://github.com/morluto/rea/blob/main/docs/getting-started/client-configuration.md#claude-desktop',
  claude: 'https://claude.ai/new',
  claudeDownload: 'https://claude.ai/download',
  copilot: 'https://github.com/copilot',
});

let mainWindow;

function isAppPage(url) {
  return url.startsWith('file://') && url.endsWith('/index.html');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'Centro REA',
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  void mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('rea-hub:open-link', async (event, key) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('La solicitud no procede de la ventana principal.');
  }
  if (typeof key !== 'string' || !Object.hasOwn(links, key)) {
    throw new Error('El enlace solicitado no está permitido.');
  }

  await shell.openExternal(links[key]);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
