const { contextBridge, ipcRenderer } = require('electron');

// Secure bridge: the renderer never sees the API key or Node APIs.
contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('app:status'),

  // Start a streaming completion. Returns an unsubscribe function.
  // callbacks: { onChunk(delta), onDone({aborted}), onError(message) }
  streamChat: (requestId, messages, callbacks) => {
    const onChunk = (_e, p) => {
      if (p.requestId === requestId) callbacks.onChunk(p.delta);
    };
    const onDone = (_e, p) => {
      if (p.requestId === requestId) {
        cleanup();
        callbacks.onDone(p);
      }
    };
    const onError = (_e, p) => {
      if (p.requestId === requestId) {
        cleanup();
        callbacks.onError(p.error);
      }
    };
    const cleanup = () => {
      ipcRenderer.removeListener('chat:chunk', onChunk);
      ipcRenderer.removeListener('chat:done', onDone);
      ipcRenderer.removeListener('chat:error', onError);
    };

    ipcRenderer.on('chat:chunk', onChunk);
    ipcRenderer.on('chat:done', onDone);
    ipcRenderer.on('chat:error', onError);

    ipcRenderer.send('chat:stream', { requestId, messages });
    return cleanup;
  },

  abortChat: (requestId) => ipcRenderer.send('chat:abort', { requestId }),

  // Trigger the capture-safe region snip.
  startSnip: () => ipcRenderer.send('snip:start'),

  // Notified after a snip is captured & copied to the clipboard.
  onSnipCopied: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('snip:copied', handler);
    return () => ipcRenderer.removeListener('snip:copied', handler);
  },

  // --- non-activating keyboard capture (hook mode) ---
  setCapture: (on) => ipcRenderer.send('input:capture', on),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  // --- custom title bar: window controls + manual move/resize ---
  win: (action) => ipcRenderer.send('window:control', action),
  getBounds: () => ipcRenderer.invoke('window:getBounds'),
  setBounds: (b) => ipcRenderer.send('window:setBounds', b),

  // input mode: 'hook' (non-activating faux caret) or 'native' (real textarea)
  onInputMode: (cb) => {
    const handler = (_e, p) => cb(p.mode);
    ipcRenderer.on('input:mode', handler);
    return () => ipcRenderer.removeListener('input:mode', handler);
  },
  // capture on/off, driven by clicks inside/outside the window
  onCaptureState: (cb) => {
    const handler = (_e, p) => cb(p.capturing);
    ipcRenderer.on('input:state', handler);
    return () => ipcRenderer.removeListener('input:state', handler);
  },
  // a translated keystroke arriving from the hook
  onInputKey: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('input:key', handler);
    return () => ipcRenderer.removeListener('input:key', handler);
  },
});
