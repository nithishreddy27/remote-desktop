const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rd', {
  platform: process.platform,
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectDisplay: (displayId) => ipcRenderer.invoke('select-display', displayId),
  stopSharing: () => ipcRenderer.invoke('stop-sharing'),
  inputStatus: () => ipcRenderer.invoke('input-status'),
  confirmViewer: (name) => ipcRenderer.invoke('confirm-viewer', name),
  sendInput: (evt) => ipcRenderer.send('input-event', evt),
  setRemotePlatform: (platform) => ipcRenderer.send('remote-platform', platform),
  releaseInput: () => ipcRenderer.send('release-input'),
  setFullscreen: (on) => ipcRenderer.send('set-fullscreen', on),
  isElevated: () => ipcRenderer.invoke('is-elevated'),
  relaunchAsAdmin: () => ipcRenderer.invoke('relaunch-admin'),
  onInputBlocked: (fn) => ipcRenderer.on('input-blocked', (_e, blocked) => fn(blocked)),
});
