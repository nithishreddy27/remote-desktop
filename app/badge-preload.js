const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('badge', {
  onStatus: (fn) => ipcRenderer.on('badge-status', (_e, info) => fn(info)),
  stop: () => ipcRenderer.send('badge-stop'),
  show: () => ipcRenderer.send('badge-show'),
});
