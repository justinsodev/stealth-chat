const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  desktopCapturer,
  clipboard,
  nativeImage,
  screen,
  systemPreferences,
  shell,
} = require('electron');

// Load .env from the most useful location, working in dev and when packaged:
// beside the .app bundle first, then resources, the dev project root, and
// finally ~/Library/Application Support/Stealth Chat.
(function loadEnv() {
  const exeDir = path.dirname(app.getPath('exe'));
  const candidates = [];
  // exe = Foo.app/Contents/MacOS/Foo  →  .env beside Foo.app
  candidates.push(path.join(exeDir, '..', '..', '..', '.env'));
  candidates.push(path.join(exeDir, '.env'));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, '.env'));
  candidates.push(path.join(__dirname, '..', '.env'));
  candidates.push(path.join(app.getPath('userData'), '.env'));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        require('dotenv').config({ path: p });
        console.log('[env] loaded', p);
        return;
      }
    } catch { /* ignore */ }
  }
  console.warn('[env] no .env found — set OPENAI_API_KEY (see README)');
})();

const OpenAI = require('openai');
const macInput = require('./mac-input');
const { convertToPanel } = require('./mac-panel');

function applyStealth(win) {
  if (!win || win.isDestroyed()) return;
  if (!STEALTH_MODE) return; // Skip if stealth mode is disabled
  // macOS: setContentProtection(true) → NSWindowSharingNone, which excludes
  // the window from every screen capture / recording / share.
  win.setContentProtection(true);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
let API_KEY = process.env.OPENAI_API_KEY || '';
// Ignore the placeholder from .env.example so a missing key shows the proper
// "no key" hint instead of failing later with a 401.
if (API_KEY.includes('your-key-here')) API_KEY = '';

// Stealth mode flag: when true, window is excluded from screen captures
const STEALTH_MODE = process.env.STEALTH_MODE !== 'false';

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

  // macOS: make it a non-activating panel so typing here never activates our
  // app over the one being shared (no app-level focus steal).
  convertToPanel(mainWindow);

  // Keep it floating above the app you are screen-sharing.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Do not steal focus from the shared app when shown.
  mainWindow.setVisibleOnAllWorkspaces(true);

  // Re-assert the capture-exclusion (+ panel style on macOS) whenever the
  // window re-appears; some state transitions can reset these.
  mainWindow.on('show', () => { applyStealth(mainWindow); convertToPanel(mainWindow); });
  mainWindow.on('restore', () => applyStealth(mainWindow));
  mainWindow.on('focus', () => applyStealth(mainWindow));

  // Keep the hook helper's idea of "inside the window" current.
  mainWindow.on('move', pushWindowRect);
  mainWindow.on('resize', pushWindowRect);
  mainWindow.on('show', pushWindowRect);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.setOpacity(opacity);
    convertToPanel(mainWindow);
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

// Report the window's on-screen rectangle (screen points) to the event tap.
// It uses this only to RELEASE the keyboard when the user clicks fully OUTSIDE
// our window; grabbing on in-window clicks is decided by the renderer's DOM.
function pushWindowRect() {
  if (!hookMode || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    macInput.setRect(mainWindow.getBounds()); // points, matches CGEventGetLocation
  } catch { /* ignore */ }
}

// ---------- capture-safe region snip ----------
let snipDisplay = null;

// macOS requires the user to grant Screen Recording permission before
// desktopCapturer returns real pixels. Returns true if we may proceed.
function ensureScreenPermission() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snip:copied', { error:
      'Grant Screen Recording to Stealth Chat in System Settings → Privacy & Security → Screen Recording, then reopen the app.' });
  }
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  ).catch(() => {});
  return false;
}

function startSnip() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;
  if (!ensureScreenPermission()) return;

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
  convertToPanel(overlayWindow);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.once('ready-to-show', () => {
    applyStealth(overlayWindow);
    convertToPanel(overlayWindow);
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
    if (hookMode) macInput.setCapture(true);
    mainWindow.webContents.send('snip:copied', { dataUrl: cropped.toDataURL() });
  }
  return { ok: true };
});

app.whenReady().then(() => {
  // macOS: run as an accessory (no Dock icon, never becomes the active app),
  // reinforcing the non-activating panel so the shared app stays foreground.
  if (process.platform === 'darwin' && app.setActivationPolicy) {
    app.setActivationPolicy('accessory');
  }

  createWindow();

  // Start the CGEventTap keyboard capture. When it's ready, typing flows
  // through the tap (keys swallowed from the underlying app) into the
  // fake-caret input, so the app being shared keeps its own focus.
  const started = macInput.start({
    onReady: () => {
      hookMode = true;
      console.log('[mac-input] tap ready — typing via CGEventTap');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFocusable(false); // window never becomes key → no blur
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
    onNeedPermission: () => {
      // Not trusted for Accessibility yet: open the pane and fall back to a
      // normal focusable text box until the user grants + relaunches.
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      ).catch(() => {});
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('input:mode', { mode: 'native' });
        mainWindow.webContents.send('input:needAccessibility');
      }
    },
  });
  if (!started) {
    // Tap unavailable (permission not granted, or non-macOS dev run):
    // fall back to a normal focusable text box.
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
  macInput.stop();
});

app.on('window-all-closed', () => {
  // Single-window utility (accessory app on macOS): closing the window quits.
  app.quit();
});

// --- Renderer asks whether a key is configured ---
ipcMain.handle('app:status', () => ({
  hasKey: Boolean(openai),
  model: MODEL,
  mode: hookMode ? 'hook' : 'native',
}));

// --- Renderer toggles keyboard capture (grab/release the keyboard) ---
ipcMain.on('input:capture', (_e, on) => {
  if (hookMode) macInput.setCapture(Boolean(on));
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
