const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, Menu, systemPreferences, Tray, nativeImage,
} = require('electron');
const path = require('path');
const input = require('./input');

let win = null;
let tray = null;
let badge = null;
let sharedDisplayId = null;
let sharedBounds = null;
// True while a viewer is actively connected: the main window is hidden to a tray
// icon plus an on-screen badge. The badge stays visible on this computer (so the
// person here knows their screen is being shared and can stop it) but is excluded
// from screen capture, so it doesn't appear in the shared video or a meeting share.
let inSession = false;
let lastStatus = { status: 'your screen is being shared' };

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: '#0e1014',
    title: 'scsh',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  // Closing the window while a viewer is connected hides it to the tray instead
  // of quitting, so the session (and its visible badge) keeps running.
  win.on('close', (e) => {
    if (inSession) {
      e.preventDefault();
      hideMainWindow();
    }
  });
  win.on('closed', () => {
    input.releaseAll();
    win = null;
  });
}

// --- Sharing session: tray + on-screen badge -----------------------------------

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'tray.png'));
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function showMainWindow() {
  if (!win) return;
  win.setSkipTaskbar(false);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideMainWindow() {
  if (!win) return;
  win.hide();
  win.setSkipTaskbar(true);
}

function createBadge() {
  badge = new BrowserWindow({
    width: 340,
    height: 44,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'badge-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // The whole point of the badge: visible here, absent from screen captures.
  badge.setContentProtection(true);
  badge.setAlwaysOnTop(true, 'screen-saver');
  badge.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  badge.webContents.on('did-finish-load', () => badge.webContents.send('badge-status', lastStatus));
  badge.loadFile(path.join(__dirname, 'renderer', 'badge.html'));
  positionBadge();
}

function positionBadge() {
  if (!badge) return;
  const { workArea } = screen.getPrimaryDisplay();
  const { width, height } = badge.getBounds();
  badge.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 10,
    width,
    height,
  });
}

function requestStop() {
  if (win) win.webContents.send('stop-sharing-request');
}

function enterSession() {
  if (inSession) return;
  inSession = true;
  hideMainWindow();
  if (!tray) {
    tray = new Tray(trayImage());
    tray.setToolTip('scsh — your screen is being shared');
    tray.on('click', showMainWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Your screen is being shared', enabled: false },
      { type: 'separator' },
      { label: 'Show scsh', click: showMainWindow },
      { label: 'Stop sharing', click: requestStop },
    ]));
  }
  if (!badge) createBadge();
  positionBadge();
  badge.showInactive();
}

function exitSession() {
  if (!inSession) return;
  inSession = false;
  if (tray) { tray.destroy(); tray = null; }
  if (badge) badge.hide();
  showMainWindow();
}

// --- Shared display bookkeeping --------------------------------------------

function findDisplay(displayId) {
  const displays = screen.getAllDisplays();
  return displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
}

function refreshSharedBounds() {
  if (sharedDisplayId !== null) sharedBounds = findDisplay(sharedDisplayId).bounds;
}

// --- IPC ---------------------------------------------------------------------

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 480, height: 270 },
  });
  const displays = screen.getAllDisplays();
  return sources.map((s, i) => {
    const display = displays.find((d) => String(d.id) === s.display_id);
    return {
      id: s.id,
      name: displays.length > 1 ? `Screen ${i + 1}` : 'Entire screen',
      displayId: s.display_id || String(screen.getPrimaryDisplay().id),
      size: display ? `${display.size.width * display.scaleFactor} × ${display.size.height * display.scaleFactor}` : '',
      primary: display ? display.id === screen.getPrimaryDisplay().id : i === 0,
      thumbnail: s.thumbnail.toDataURL(),
    };
  });
});

// Called when the host starts sharing a display; returns its pixel size so the
// renderer can capture at native resolution.
ipcMain.handle('select-display', (_e, displayId) => {
  const d = findDisplay(displayId);
  sharedDisplayId = d.id;
  sharedBounds = d.bounds;
  return {
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
  };
});

ipcMain.handle('stop-sharing', () => {
  input.releaseAll();
  sharedDisplayId = null;
  sharedBounds = null;
});

ipcMain.handle('input-status', () => {
  const status = input.status();
  if (process.platform === 'darwin' && status.available
      && !systemPreferences.isTrustedAccessibilityClient(false)) {
    return { available: false, error: 'Grant Accessibility permission in System Settings → Privacy & Security, then restart the app.' };
  }
  return status;
});

ipcMain.handle('confirm-viewer', async (_e, name) => {
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.flashFrame(true);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    title: 'Incoming connection',
    message: `${name} wants to connect to this computer`,
    detail: 'They will be able to see your screen and control your mouse and keyboard. Only allow people you trust.',
    noLink: true,
  });
  win.flashFrame(false);
  return response === 0;
});

ipcMain.on('input-event', (_e, evt) => {
  if (sharedBounds) input.handle(evt, sharedBounds);
});

ipcMain.on('remote-platform', (_e, platform) => input.setRemotePlatform(platform));

ipcMain.on('release-input', () => input.releaseAll());

ipcMain.on('set-fullscreen', (_e, on) => win && win.setFullScreen(!!on));

// Excludes this window from screen captures and recordings (WDA_EXCLUDEFROMCAPTURE
// on Windows, NSWindowSharingNone on macOS). The window stays fully visible on
// this computer; it only shows up blank in anything that captures the screen,
// so the app doesn't appear when you share your screen in a meeting.
ipcMain.on('set-content-protection', (_e, on) => win && win.setContentProtection(!!on));

// The renderer reports when a viewer is connected (active) or not.
ipcMain.on('host-session', (_e, info) => {
  if (info && info.active) {
    lastStatus = { status: info.status || 'your screen is being shared' };
    enterSession();
    if (badge) badge.webContents.send('badge-status', lastStatus);
  } else {
    exitSession();
  }
});

ipcMain.on('badge-stop', requestStop);
ipcMain.on('badge-show', showMainWindow);

// --- Updates -------------------------------------------------------------------

// Downloads new releases from GitHub in the background and installs them on
// quit. macOS is skipped: unsigned Mac apps can't auto-update.
function checkForUpdates() {
  if (!app.isPackaged || process.platform === 'darwin') return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[updater]', err.message);
  });
}

// --- App lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  // No app menu: its accelerators (Ctrl+W, Ctrl+R, ...) would swallow keys
  // meant for the remote computer.
  Menu.setApplicationMenu(null);
  for (const evt of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(evt, refreshSharedBounds);
  }
  createWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
