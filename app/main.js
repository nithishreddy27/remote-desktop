const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, Menu, systemPreferences,
} = require('electron');
const path = require('path');
const input = require('./input');

let win = null;
let sharedDisplayId = null;
let sharedBounds = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: '#0e1014',
    title: 'Remote Desktop',
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
  win.on('closed', () => {
    input.releaseAll();
    win = null;
  });
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
