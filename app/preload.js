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
  setContentProtection: (on) => ipcRenderer.send('set-content-protection', on),
});
