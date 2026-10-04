const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__BUDDO_DESKTOP__', true);
contextBridge.exposeInMainWorld('buddoDesktop', {
  pickFolder: () => ipcRenderer.invoke('buddo:pick-folder'),
  platform: process.platform,
  version: () => ipcRenderer.invoke('buddo:version'),
  checkUpdate: () => ipcRenderer.invoke('buddo:update-check'),
  installUpdate: () => ipcRenderer.invoke('buddo:update-install'),
  onUpdate: (fn) => {
    const h = (_e, msg) => fn(msg);
    ipcRenderer.on('buddo:update', h);
    return () => ipcRenderer.removeListener('buddo:update', h);
  },
});
