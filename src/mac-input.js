// macOS keyboard capture via a CGEventTap (in-process, through koffi).
//
// When "capturing" is on, key events are SWALLOWED (never reach the app the
// user is sharing/using) and reported to the renderer's fake-caret input, so
// the underlying window keeps its own key focus / blinking caret. A mouse tap
// releases capture when the user clicks fully outside our window.
//
// Requires the Accessibility permission (System Settings → Privacy &
// Security → Accessibility). Attempting to create the tap registers the app
// in that list; until granted, the tap can't be created and we report that.
//
// Interface:
//   start(handlers) -> boolean         handlers: {onReady,onState,onKey,onNeedPermission}
//   setCapture(bool)   setRect({x,y,width,height})   stop()

function makeStub() {
  return { start: () => false, setCapture() {}, setRect() {}, stop() {} };
}

if (process.platform !== 'darwin') {
  module.exports = makeStub();
} else {
  try {
    const koffi = require('koffi');

    const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const SYS = koffi.load('/usr/lib/libSystem.B.dylib');

    // ---- CoreGraphics event functions ----
    const CGEventTapCreate = CG.func(
      'void* CGEventTapCreate(uint32 tap, uint32 place, uint32 options, uint64 mask, void* cb, void* userInfo)'
    );
    const CGEventTapEnable = CG.func('void CGEventTapEnable(void* tap, bool enable)');
    const CGEventGetIntegerValueField = CG.func('int64 CGEventGetIntegerValueField(void* ev, uint32 field)');
    const CGEventGetFlags = CG.func('uint64 CGEventGetFlags(void* ev)');
    const CGEventKeyboardGetUnicodeString = CG.func(
      'void CGEventKeyboardGetUnicodeString(void* ev, uint64 maxLen, void* actualLen, void* buf)'
    );
    const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
    const CGEventGetLocation = CG.func('CGPoint CGEventGetLocation(void* ev)');

    // ---- CoreFoundation run-loop plumbing ----
    const CFMachPortCreateRunLoopSource = CF.func(
      'void* CFMachPortCreateRunLoopSource(void* allocator, void* port, long order)'
    );
    const CFRunLoopGetMain = CF.func('void* CFRunLoopGetMain(void)');
    const CFRunLoopAddSource = CF.func('void CFRunLoopAddSource(void* rl, void* source, void* mode)');

    // ---- resolve the kCFRunLoopCommonModes CFString constant via dlsym ----
    const dlopen = SYS.func('void* dlopen(const char* path, int mode)');
    const dlsym = SYS.func('void* dlsym(void* handle, const char* name)');
    const cfHandle = dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', 2);
    const commonModesAddr = dlsym(cfHandle, 'kCFRunLoopCommonModes');
    const kCFRunLoopCommonModes = koffi.decode(commonModesAddr, 'void*');

    // ---- constants ----
    const kCGSessionEventTap = 1;
    const kCGHeadInsertEventTap = 0;
    const kCGEventTapOptionDefault = 0;
    const kCGKeyboardEventKeycode = 9;

    const EV_LMOUSEDOWN = 1, EV_RMOUSEDOWN = 3, EV_KEYDOWN = 10, EV_KEYUP = 11, EV_FLAGS = 12;
    const EV_TAP_DISABLED_TIMEOUT = 0xFFFFFFFE, EV_TAP_DISABLED_USER = 0xFFFFFFFF;
    const MASK =
      (1 << EV_LMOUSEDOWN) | (1 << EV_RMOUSEDOWN) |
      (1 << EV_KEYDOWN) | (1 << EV_KEYUP) | (1 << EV_FLAGS);

    const FLAG_SHIFT = 0x20000, FLAG_CTRL = 0x40000, FLAG_ALT = 0x80000, FLAG_CMD = 0x100000;

    const KEY_RETURN = 0x24, KEY_DELETE = 0x33, KEY_ESCAPE = 0x35, KEY_TAB = 0x30, KEY_V = 0x09;

    // reusable buffers for unicode extraction
    const actualLenBuf = Buffer.alloc(8);   // UniCharCount (unsigned long)
    const uniBuf = Buffer.alloc(8);         // up to 4 UniChars

    let handlers = {};
    let capturing = false;
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    let tap = null;
    let tapCb = null; // keep the registered callback alive

    function emitKey(evt) { if (handlers.onKey) handlers.onKey(evt); }
    function setState(v) { capturing = v; if (handlers.onState) handlers.onState(v); }

    const TapProto = koffi.proto('void* CGTapCB(void* proxy, uint32 type, void* event, void* userInfo)');

    function callback(proxy, type, event /*, userInfo */) {
      try {
        if (type === EV_TAP_DISABLED_TIMEOUT || type === EV_TAP_DISABLED_USER) {
          if (tap) CGEventTapEnable(tap, true);
          return event;
        }

        if (type === EV_LMOUSEDOWN || type === EV_RMOUSEDOWN) {
          if (capturing) {
            const p = CGEventGetLocation(event);
            const inside = p.x >= rect.x && p.x < rect.x + rect.width &&
                           p.y >= rect.y && p.y < rect.y + rect.height;
            if (!inside) setState(false);
          }
          return event; // never swallow mouse
        }

        if (!capturing) return event;

        if (type === EV_KEYUP || type === EV_FLAGS) return null; // swallow silently

        if (type === EV_KEYDOWN) {
          const keycode = Number(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
          const flags = Number(CGEventGetFlags(event));
          const shift = (flags & FLAG_SHIFT) !== 0;
          const cmd = (flags & FLAG_CMD) !== 0;
          const ctrl = (flags & FLAG_CTRL) !== 0;

          if (cmd || ctrl) {
            if (keycode === KEY_V) emitKey({ kind: 'paste' });
            return null; // swallow all cmd/ctrl combos
          }
          if (keycode === KEY_DELETE) { emitKey({ kind: 'backspace' }); return null; }
          if (keycode === KEY_RETURN) { emitKey({ kind: shift ? 'shiftenter' : 'enter' }); return null; }
          if (keycode === KEY_ESCAPE) { emitKey({ kind: 'escape' }); setState(false); return null; }
          if (keycode === KEY_TAB) return null;

          CGEventKeyboardGetUnicodeString(event, 4, actualLenBuf, uniBuf);
          const n = Number(actualLenBuf.readBigUInt64LE(0));
          if (n > 0) {
            const text = uniBuf.toString('utf16le', 0, Math.min(n, 4) * 2);
            if (text) emitKey({ kind: 'char', value: text });
          }
          return null;
        }
      } catch (e) {
        console.error('[mac-input] callback error:', e.message);
      }
      return event;
    }

    module.exports = {
      start(h) {
        handlers = h || {};
        try {
          tapCb = koffi.register(callback, koffi.pointer(TapProto));
          tap = CGEventTapCreate(
            kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
            BigInt(MASK), tapCb, null
          );
          if (!tap) {
            console.warn('[mac-input] CGEventTapCreate returned NULL — Accessibility not granted');
            if (handlers.onNeedPermission) handlers.onNeedPermission();
            return false;
          }
          const source = CFMachPortCreateRunLoopSource(null, tap, 0);
          CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
          CGEventTapEnable(tap, true);
          console.log('[mac-input] CGEventTap installed');
          if (handlers.onReady) handlers.onReady();
          return true;
        } catch (e) {
          console.error('[mac-input] start failed:', e.message);
          return false;
        }
      },
      setCapture(on) {
        on = Boolean(on);
        if (on !== capturing) setState(on);
      },
      setRect(r) { if (r) rect = r; },
      stop() { try { if (tap) CGEventTapEnable(tap, false); } catch { /* ignore */ } },
    };
  } catch (e) {
    console.error('[mac-input] init failed:', e.message);
    module.exports = makeStub();
  }
}
