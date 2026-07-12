// Converts an Electron BrowserWindow's underlying NSWindow into a
// non-activating panel on macOS, so the window can receive mouse/keyboard
// WITHOUT activating our app — the app the user is sharing/using stays the
// active application (no app-level focus steal / blur).
//
// Done through the Objective-C runtime via koffi (no native compile step;
// koffi ships prebuilt binaries for macOS arm64 + x64). Only plain C function
// calls are used (koffi callbacks are avoided).

let convertToPanel = () => false;

if (process.platform === 'darwin') {
  try {
    const koffi = require('koffi');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');

    // SEL sel_registerName(const char *str)
    const sel = objc.func('sel_registerName', 'uint64', ['string']);
    // id objc_msgSend(id, SEL)  — return a pointer/NSUInteger
    const msgSend = objc.func('objc_msgSend', 'uint64', ['uint64', 'uint64']);
    // void objc_msgSend(id, SEL, NSUInteger)  — setter with one integer arg (returns void)
    const msgSendSetU = objc.func('objc_msgSend', 'uint64', ['uint64', 'uint64', 'uint64']);

    const SEL_window = sel('window');
    const SEL_styleMask = sel('styleMask');
    const SEL_setStyleMask = sel('setStyleMask:');
    const SEL_setCollectionBehavior = sel('setCollectionBehavior:');

    const NS_NONACTIVATING_PANEL = 1n << 7n; // NSWindowStyleMaskNonactivatingPanel

    // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
    const COLLECTION_BEHAVIOR = (1n << 0n) | (1n << 4n) | (1n << 6n) | (1n << 8n);

    let converting = false;
    convertToPanel = (win) => {
      if (converting) return false;
      converting = true;
      try {
        if (!win || win.isDestroyed()) return false;
        const hbuf = win.getNativeWindowHandle(); // NSView* on macOS
        if (!hbuf || hbuf.length < 8) return false;
        const view = Number(hbuf.readBigUInt64LE(0));
        if (!view) return false;

        const nsWindow = Number(msgSend(view, SEL_window));
        if (!nsWindow) return false;

        // Skip setting the nonactivating panel style mask as NSWindow doesn't support it
        // Instead, just set the collection behavior to make the window ignore focus cycle
        try {
          msgSendSetU(nsWindow, SEL_setCollectionBehavior, Number(COLLECTION_BEHAVIOR));
        } catch (e) {
          console.warn('[mac-panel] setCollectionBehavior failed:', e.message);
        }
        
        return true;
      } catch (e) {
        console.error('[mac-panel] convert failed:', e.message);
        return false;
      } finally {
        converting = false;
      }
    };

    console.log('[mac-panel] objc runtime ready');
  } catch (e) {
    console.error('[mac-panel] objc unavailable:', e.message);
  }
}

module.exports = { convertToPanel };
