import { version } from '../../packages/host/src/version.mjs';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  nativeImage,
  Notification,
  clipboard,
} from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inspectCertificate } from './certificate.mjs';
import { artifactPlaybackURL } from './artifact-permissions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const launcher = pathToFileURL(join(here, 'launcher.html')).href;
// Keep the existing workspace and pairing profile across the display-name change.
const nativeProfile = resolve(
  process.env.WORKSHOP_DESKTOP_PROFILE ?? join(app.getPath('appData'), 'Bot Workshop'),
);
mkdirSync(nativeProfile, { recursive: true, mode: 0o700 });
app.setPath('userData', nativeProfile);
const graphicsFile = join(nativeProfile, 'graphics.json');
try {
  if (JSON.parse(readFileSync(graphicsFile, 'utf8')).hardwareAcceleration === false)
    app.disableHardwareAcceleration();
} catch {
  // Missing or unreadable graphics preference keeps Electron's default acceleration.
}
app.setName('Orbit');
if (process.platform === 'win32') app.setAppUserModelId('local.botworkshop.desktop');
const hasLock = app.requestSingleInstanceLock();
let window,
  host,
  hostURL = null,
  tray,
  quitting = false,
  stopped = false,
  startPromise,
  hostExit;
let choice = { mode: null, url: null };
const choiceFile = join(app.getPath('userData'), 'host-choice.json');
function saveChoice(next) {
  choice = { ...choice, ...next };
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  writeFileSync(choiceFile, JSON.stringify(choice), { mode: 0o600 });
}
function trusted(event, onlyLauncher = false) {
  const url = event.senderFrame?.url;
  return (
    event.sender === window?.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    (url === launcher ||
      (!onlyLauncher && hostURL && new URL(url).origin === new URL(hostURL).origin))
  );
}
function external(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
async function openExternal(url) {
  if (!external(url)) return;
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    message: 'Open this link in your browser?',
    detail: url,
    buttons: ['Cancel', 'Open link'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) await shell.openExternal(url);
}
async function stopHost() {
  if (!host) return;
  const owned = host;
  owned.postMessage({ type: 'shutdown' });
  const clean = await Promise.race([
    hostExit.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 20000)),
  ]);
  if (!clean) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: 'The host is still finishing work.',
      detail:
        'Wait to preserve normal cleanup, or stop this app-owned host now. Interrupted tasks will be marked on next startup.',
      buttons: ['Keep waiting', 'Stop host now'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 0) {
      await hostExit;
      return;
    }
    owned.kill();
    await hostExit;
  }
}
async function startLocal() {
  if (hostURL && host) return hostURL;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const data = resolve(
      process.env.WORKSHOP_DESKTOP_DATA ?? join(app.getPath('userData'), 'workspace'),
    );
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const user = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
      execFileSync('icacls.exe', [data, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
        windowsHide: true,
        stdio: 'ignore',
      });
    }
    // No provider keys, agent variables or unrelated login stores flow into the host.
    const env = Object.fromEntries(
      [
        'PATH',
        'SystemRoot',
        'WINDIR',
        'COMSPEC',
        'PATHEXT',
        'HOME',
        'USERPROFILE',
        'LOCALAPPDATA',
        'APPDATA',
        'TEMP',
        'TMP',
      ]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    Object.assign(env, {
      WORKSHOP_DATA: data,
      WORKSHOP_PORT: process.env.WORKSHOP_DESKTOP_PORT ?? '4317',
    });
    if (process.env.WORKSHOP_DOCKER_BIN) env.WORKSHOP_DOCKER_BIN = process.env.WORKSHOP_DOCKER_BIN;
    // An ASAR is a virtual source directory, never an operating-system cwd.
    const child = utilityProcess.fork(join(root, 'packages/host/src/server.mjs'), [], {
      cwd: app.isPackaged ? app.getPath('userData') : root,
      env,
      stdio: 'pipe',
      serviceName: 'Orbit Host',
    });
    host = child;
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-5000);
      });
    hostExit = new Promise((r) =>
      child.once('exit', (code) => {
        if (host === child) {
          host = null;
          hostURL = null;
        }
        r(code);
        if (!quitting && code !== 0)
          void dialog.showMessageBox(window, {
            type: 'error',
            message: 'The Bot host stopped.',
            detail: 'Your saved workspace remains on disk. Open the host selector to restart it.',
          });
      }),
    );
    return await new Promise((yes, no) => {
      const timer = setTimeout(() => {
        child.kill();
        no(Error('Host startup exceeded 30 seconds. Your workspace remains on disk.'));
      }, 30000);
      child.on('message', (message) => {
        if (message?.type !== 'ready') return;
        try {
          const u = new URL(message.url);
          if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') throw Error();
          hostURL = u.origin;
          clearTimeout(timer);
          yes(hostURL);
        } catch {
          clearTimeout(timer);
          no(Error('Host returned an invalid local address.'));
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        no(Error('Host could not start. ' + output.replace(/\s+/g, ' ').slice(-1800)));
      });
    });
  })().finally(() => (startPromise = null));
  return startPromise;
}
async function loadLocal() {
  const url = await startLocal();
  saveChoice({ mode: 'primary', url: null });
  await window.loadURL(url);
  window.show();
}
async function loadRemote(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash
  )
    throw Error('Enter only the trusted HTTPS address of your primary host.');
  if (host) await stopHost();
  hostURL = u.origin;
  saveChoice({ mode: 'remote', url: u.origin });
  await window.loadURL(u.origin);
  window.show();
}
async function selector() {
  await window.loadURL(launcher);
  window.show();
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 800,
    minHeight: 620,
    title: 'Orbit',
    backgroundColor: '#121212',
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#121212', symbolColor: '#eeeeee', height: 50 },
        }
      : {}),
    show: false,
    autoHideMenuBar: true,
    icon: join(here, 'icon.png'),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  const ses = window.webContents.session;
  const primaryFrame = (contents, details) =>
    contents === window.webContents &&
    !!hostURL &&
    details.isMainFrame &&
    details.requestingUrl === contents.getURL() &&
    new URL(contents.getURL()).origin === hostURL;
  ses.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      (permission === 'notifications' && !!hostURL && origin === hostURL) ||
      (contents === window.webContents &&
        (permission === 'pointerLock' || permission === 'fullscreen') &&
        (artifactPlaybackURL(details.requestingUrl, hostURL) ||
          (permission === 'fullscreen' && primaryFrame(contents, details)))),
  );
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (
      contents === window.webContents &&
      (permission === 'pointerLock' || permission === 'fullscreen') &&
      (artifactPlaybackURL(details.requestingUrl, hostURL) ||
        (permission === 'fullscreen' && primaryFrame(contents, details)))
    )
      return callback(true);
    if (
      contents !== window.webContents ||
      !hostURL ||
      (details.requestingUrl && new URL(details.requestingUrl).origin !== hostURL) ||
      !['notifications', 'media'].includes(permission)
    )
      return callback(false);
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message:
        permission === 'media'
          ? 'Allow microphone access for dictation?'
          : 'Allow Bot notifications?',
      buttons: ['Deny', 'Allow'],
      defaultId: 0,
      cancelId: 0,
    });
    callback(response === 1);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (hostURL && external(url) && new URL(url).origin === hostURL) {
      const viewer = new BrowserWindow({
        width: 1200,
        height: 850,
        parent: window,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      viewer.webContents.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== hostURL) event.preventDefault();
      });
      void viewer.loadURL(url);
    } else void openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === launcher || (hostURL && external(url) && new URL(url).origin === hostURL)) return;
    event.preventDefault();
    void openExternal(url);
  });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => (window = null));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Orbit',
        submenu: [
          { label: 'Choose primary host…', click: () => void selector() },
          { label: 'Show workspace', accelerator: 'CmdOrCtrl+Shift+W', click: () => window.show() },
          { type: 'separator' },
          { label: 'Quit Orbit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
          ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
        ],
      },
    ]),
  );
  const image = nativeImage.createFromPath(join(here, 'icon.png'));
  tray = new Tray(image.resize({ width: 20, height: 20 }));
  tray.setToolTip('Orbit · host keeps working when the window closes');
  tray.on('click', () => window.show());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Orbit', click: () => window.show() },
      { label: 'Choose primary host…', click: () => void selector() },
      { type: 'separator' },
      { label: 'Quit & stop host', click: () => app.quit() },
    ]),
  );
}
if (!hasLock) app.quit();
else {
  app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
    if (
      contents !== window?.webContents ||
      choice.mode !== 'remote' ||
      !hostURL ||
      new URL(url).origin !== hostURL ||
      error !== 'net::ERR_CERT_AUTHORITY_INVALID'
    )
      return callback(false);
    const cert = inspectCertificate(certificate.data, url);
    if (!cert.valid) return callback(false);
    event.preventDefault();
    if (choice.pins?.[hostURL] === cert.fingerprint) return callback(true);
    void dialog
      .showMessageBox(window, {
        type: 'question',
        message: 'Verify your primary host',
        detail: `Compare this fingerprint with Primary host settings on your Windows app. Only trust it if every character matches.\n\n${hostURL}\n\n${cert.fingerprint}${choice.pins?.[hostURL] ? '\n\nThis host’s saved certificate has changed. Verify it again on the primary host.' : ''}`,
        buttons: ['Cancel', 'Fingerprint matches · trust host'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1) {
          saveChoice({ pins: { ...choice.pins, [hostURL]: cert.fingerprint } });
          callback(true);
        } else callback(false);
      });
  });
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopHost()
      .then(() => {
        stopped = true;
        tray?.destroy();
        app.quit();
      })
      .catch(() => {
        quitting = false;
        window?.show();
      });
  });
  void app
    .whenReady()
    .then(async () => {
      try {
        choice = JSON.parse(readFileSync(choiceFile, 'utf8'));
      } catch {}
      createWindow();
      ipcMain.handle('workshop:info', (event) => {
        if (!trusted(event)) throw Error('Untrusted frame');
        return {
          platform: process.platform,
          version,
          mode: choice.mode,
          host: hostURL,
          background: !!host,
          windowControlsOverlay: process.platform === 'win32',
        };
      });
      ipcMain.handle('workshop:notification-status', (event) => {
        if (!trusted(event)) throw Error('Untrusted frame');
        return { supported: Notification.isSupported(), enabled: !!choice.notificationsEnabled };
      });
      ipcMain.handle('workshop:copy-text', (event, text) => {
        if (!trusted(event) || typeof text !== 'string') throw Error('Invalid clipboard write');
        clipboard.writeText(text);
      });
      ipcMain.handle('workshop:graphics', (event, enabled) => {
        if (!trusted(event) || typeof enabled !== 'boolean')
          throw Error('Invalid graphics setting');
        mkdirSync(dirname(graphicsFile), { recursive: true, mode: 0o700 });
        writeFileSync(graphicsFile, JSON.stringify({ hardwareAcceleration: enabled }), {
          mode: 0o600,
        });
        return { hardwareAcceleration: enabled, applies: 'next-start' };
      });
      ipcMain.handle('workshop:appearance', (event, theme) => {
        if (!trusted(event) || !['dark', 'light'].includes(theme))
          throw Error('Invalid appearance');
        if (process.platform === 'win32')
          window.setTitleBarOverlay({
            color: theme === 'light' ? '#ffffff' : '#121212',
            symbolColor: theme === 'light' ? '#1f1f1f' : '#eeeeee',
            height: 50,
          });
        return { theme };
      });
      ipcMain.handle('workshop:notification-settings', (event, enabled) => {
        if (!trusted(event) || typeof enabled !== 'boolean')
          throw Error('Untrusted notification setting');
        saveChoice({ notificationsEnabled: enabled });
        return { supported: Notification.isSupported(), enabled };
      });
      ipcMain.handle('workshop:notify', (event, value) => {
        if (!trusted(event) || !choice.notificationsEnabled || !Notification.isSupported())
          return false;
        if (
          !value ||
          typeof value.title !== 'string' ||
          typeof value.body !== 'string' ||
          typeof value.tag !== 'string'
        )
          throw Error('Invalid notification');
        const notice = new Notification({
          title: value.title.slice(0, 200),
          body: value.body.slice(0, 4000),
        });
        notice.on('click', () => {
          window?.show();
          window?.focus();
        });
        notice.show();
        return true;
      });
      ipcMain.handle('workshop:local', async (event) => {
        if (!trusted(event, true)) throw Error('Untrusted frame');
        await loadLocal();
        return true;
      });
      ipcMain.handle('workshop:remote', async (event, url) => {
        if (!trusted(event, true) || typeof url !== 'string') throw Error('Untrusted frame');
        await loadRemote(url);
        return true;
      });
      ipcMain.handle('workshop:selector', (event) => {
        if (!trusted(event)) throw Error('Untrusted frame');
        void selector();
      });
      try {
        if (choice.mode === 'primary') await loadLocal();
        else if (choice.mode === 'remote') await loadRemote(choice.url);
        else await selector();
      } catch (error) {
        await selector();
        void dialog.showMessageBox(window, {
          type: 'error',
          message: 'Could not open this workspace.',
          detail: error.message,
        });
      }
      app.on('activate', () => window?.show());
    })
    .catch((error) => {
      dialog.showErrorBox('Orbit could not start', error.message);
      stopped = true;
      app.quit();
    });
}
