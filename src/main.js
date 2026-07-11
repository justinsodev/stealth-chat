const path = require('path');
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  clipboard,
  nativeImage,
  screen,
} = require('electron');

// Load .env from the project root (works in dev and when packaged).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const OpenAI = require('openai');
const winInput = require('./win-input');

// --- Win32 capture-exclusion via direct SetWindowDisplayAffinity ---
// Electron's setContentProtection can fall back to WDA_MONITOR (leaks to
// some screenshot paths). We force WDA_EXCLUDEFROMCAPTURE, which removes the
// window from ALL capture (screen share, recording, Snipping Tool, PrtScn).
const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011; // Windows 10 2004+ / Windows 11

let setDisplayAffinity = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    setDisplayAffinity = user32.func(
      'bool __stdcall SetWindowDisplayAffinity(uint64 hwnd, uint32 dwAffinity)'
    );
  } catch (e) {
    console.error('[stealth] koffi/user32 unavailable:', e.message);
  }
}

function applyStealth(win) {
  if (!win || win.isDestroyed()) return;

  // Electron's own protection (belt & suspenders / covers non-Windows).
  win.setContentProtection(true);

  if (process.platform === 'win32' && setDisplayAffinity) {
    const hbuf = win.getNativeWindowHandle(); // pointer-sized buffer
    const hwnd = hbuf.length === 8 ? hbuf.readBigUInt64LE(0)
                                   : BigInt(hbuf.readUInt32LE(0));
    let ok = setDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    if (!ok) {
      // Older Windows: fall back to the monitor-blocking mode.
      ok = setDisplayAffinity(hwnd, WDA_MONITOR);
      console.warn('[stealth] EXCLUDEFROMCAPTURE failed; WDA_MONITOR:', ok);
    } else {
      console.log('[stealth] WDA_EXCLUDEFROMCAPTURE applied (hwnd ' + hwnd + ')');
    }
  }
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const API_KEY = process.env.OPENAI_API_KEY || '';

let openai = null;
if (API_KEY) {
  openai = new OpenAI({ apiKey: API_KEY });
}

let mainWindow = null;
let overlayWindow = null;
let hookMode = false; // true once the keyboard hook helper is running

// Window translucency so the user can see the app underneath.
const OPACITY_MIN = 0.3;
const OPACITY_MAX = 1.0;
let opacity = 0.85;

// Track in-flight streams so we can abort them.
const activeStreams = new Map();

function setOpacity(value) {
  opacity = Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, value));
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setOpacity(opacity);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0e0f13',
    show: false,
    frame: false,          // custom title bar (native one breaks under no-focus)
    title: 'Stealth Chat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // === STEALTH === exclude the window from ALL screen capture.
  applyStealth(mainWindow);

  // Keep it floating above the app you are screen-sharing.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Do not steal focus from the shared app when shown.
  mainWindow.setVisibleOnAllWorkspaces(true);

  // Re-assert the capture-exclusion whenever the window re-appears; some
  // window state transitions can reset display affinity.
  mainWindow.on('show', () => applyStealth(mainWindow));
  mainWindow.on('restore', () => applyStealth(mainWindow));
  mainWindow.on('focus', () => applyStealth(mainWindow));

  // Keep the hook helper's idea of "inside the window" current.
  mainWindow.on('move', pushWindowRect);
  mainWindow.on('resize', pushWindowRect);
  mainWindow.on('show', pushWindowRect);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.setOpacity(opacity);
    // Show WITHOUT activating so the previously-active window keeps focus.
    mainWindow.showInactive();
    applyStealth(mainWindow);
    pushWindowRect();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function toggleVisibility() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
    applyStealth(mainWindow);
    pushWindowRect();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.showInactive();
    applyStealth(mainWindow);
    pushWindowRect();
  }
}

// Report the window's on-screen rectangle (physical px) to the hook helper.
// The helper uses it only to RELEASE the keyboard when the user clicks fully
// OUTSIDE our window. Enabling/disabling for in-window clicks is decided by
// the renderer's DOM (pixel-perfect: only the prompt input bar grabs keys),
// which is why clicking the title bar, window buttons, resize borders,
// sidebar, or transcript never grabs the keyboard.
function pushWindowRect() {
  if (!hookMode || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const phys = screen.dipToScreenRect(mainWindow, mainWindow.getBounds());
    winInput.setRect(phys);
  } catch { /* ignore */ }
}

// ---------- capture-safe region snip ----------
let snipDisplay = null;

function startSnip() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;

  const point = screen.getCursorScreenPoint();
  snipDisplay = screen.getDisplayNearestPoint(point);
  const { x, y, width, height } = snipDisplay.bounds;

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The selection UI itself must be invisible to system capture.
  applyStealth(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.once('ready-to-show', () => {
    applyStealth(overlayWindow);
    overlayWindow.show();
    overlayWindow.focus();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  overlayWindow = null;
}

// Renderer button can also trigger the snip.
ipcMain.on('snip:start', startSnip);
ipcMain.on('snip:cancel', closeOverlay);

// Overlay reports the selected rectangle (CSS px relative to the display).
ipcMain.handle('snip:capture', async (_e, rect) => {
  const display = snipDisplay;
  closeOverlay();

  if (!display || !rect || rect.width < 3 || rect.height < 3) {
    return { ok: false };
  }

  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) return { ok: false };

  let img = source.thumbnail;
  const full = img.getSize();
  const crop = {
    x: Math.max(0, Math.round(rect.x * scale)),
    y: Math.max(0, Math.round(rect.y * scale)),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
  crop.width = Math.min(crop.width, full.width - crop.x);
  crop.height = Math.min(crop.height, full.height - crop.y);
  if (crop.width < 1 || crop.height < 1) return { ok: false };

  const cropped = img.crop(crop);
  clipboard.writeImage(cropped); // -> pasteable with Ctrl+V

  // Bring the chat window back (without activating) and grab the keyboard
  // so the user can immediately paste with Ctrl+V.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    applyStealth(mainWindow);
    pushWindowRect();
    if (hookMode) winInput.setCapture(true);
    mainWindow.webContents.send('snip:copied', { dataUrl: cropped.toDataURL() });
  }
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  // Start the low-level keyboard/mouse hook helper. When it's ready, the
  // window becomes non-activating and all typing flows through the hook.
  const started = winInput.start({
    onReady: () => {
      hookMode = true;
      console.log('[win-input] hook ready — typing via keyboard hook');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFocusable(false); // never steal focus → no blur
        applyStealth(mainWindow);
        pushWindowRect();
        mainWindow.webContents.send('input:mode', { mode: 'hook' });
      }
    },
    onState: (capturing) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('input:state', { capturing });
      }
    },
    onKey: (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('input:key', evt);
      }
    },
    onExit: (code) => {
      hookMode = false;
      // Helper died/unavailable: make the window focusable again so it can
      // take real focus and fall back to a normal text box.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFocusable(true);
        mainWindow.webContents.send('input:mode', { mode: 'native' });
      }
      if (code) console.error('[win-input] helper exited with code', code);
    },
  });
  if (!started) {
    // Non-Windows or spawn failure: native input mode.
    if (mainWindow) mainWindow.webContents.send('input:mode', { mode: 'native' });
  }

  // Global panic/stealth hotkey: instantly hide or show the window.
  globalShortcut.register('CommandOrControl+Shift+\\', toggleVisibility);

  // Opacity control.
  globalShortcut.register('CommandOrControl+Shift+Up', () => setOpacity(opacity + 0.06));
  globalShortcut.register('CommandOrControl+Shift+Down', () => setOpacity(opacity - 0.06));

  // Region snip (capture-safe).
  globalShortcut.register('CommandOrControl+Shift+S', startSnip);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  winInput.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- Renderer asks whether a key is configured ---
ipcMain.handle('app:status', () => ({
  hasKey: Boolean(openai),
  model: MODEL,
  mode: hookMode ? 'hook' : 'native',
}));

// --- Renderer toggles keyboard capture (grab/release the keyboard) ---
ipcMain.on('input:capture', (_e, on) => {
  if (hookMode) winInput.setCapture(Boolean(on));
});


// --- Renderer reads the clipboard (used for Ctrl+V paste in hook mode) ---
ipcMain.handle('clipboard:read', () => {
  const img = clipboard.readImage();
  if (img && !img.isEmpty()) {
    return { type: 'image', dataUrl: img.toDataURL() };
  }
  return { type: 'text', text: clipboard.readText() || '' };
});

// --- Custom title-bar window controls (frameless window) ---
ipcMain.on('window:control', (_e, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (action === 'minimize') {
    mainWindow.minimize();
  } else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') {
    mainWindow.close();
  }
});

// --- Manual move / resize driven by the renderer (works while non-focusable) ---
ipcMain.handle('window:getBounds', () =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null
);
ipcMain.on('window:setBounds', (_e, b) => {
  if (mainWindow && !mainWindow.isDestroyed() && b) mainWindow.setBounds(b);
});

// --- Streaming chat completion ---
ipcMain.on('chat:stream', async (event, { requestId, messages }) => {
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };

  if (!openai) {
    send('chat:error', {
      requestId,
      error: 'No OpenAI API key found. Add OPENAI_API_KEY to your .env file and restart.',
    });
    return;
  }

  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  try {
    const stream = await openai.chat.completions.create(
      {
        model: MODEL,
        messages,
        stream: true,
      },
      { signal: controller.signal }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) send('chat:chunk', { requestId, delta });
    }
    send('chat:done', { requestId });
  } catch (err) {
    if (controller.signal.aborted) {
      send('chat:done', { requestId, aborted: true });
    } else {
      send('chat:error', {
        requestId,
        error: (err && err.message) || 'Request failed.',
      });
    }
  } finally {
    activeStreams.delete(requestId);
  }
});

// --- Abort an in-flight stream ---
ipcMain.on('chat:abort', (_event, { requestId }) => {
  const controller = activeStreams.get(requestId);
  if (controller) controller.abort();
});
