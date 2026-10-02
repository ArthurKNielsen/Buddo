const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__BUDDO_DESKTOP__', true);
contextBridge.exposeInMainWorld('buddoDesktop', {
  pickFolder: () => ipcRenderer.invoke('buddo:pick-folder'),
  platform: process.platform,
});
