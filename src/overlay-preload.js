const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snip', {
  // rect: { x, y, width, height } in CSS px relative to the display.
  capture: (rect) => ipcRenderer.invoke('snip:capture', rect),
  cancel: () => ipcRenderer.send('snip:cancel'),
});
