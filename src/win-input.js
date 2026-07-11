const path = require('path');
const { spawn } = require('child_process');

// Manages the PowerShell/C# low-level-hook helper process.
// Exposes: start(handlers) -> boolean, setCapture(bool), setRect(rect), stop().
class WinInput {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.handlers = {};
    this._buf = '';
  }

  start(handlers) {
    if (process.platform !== 'win32') return false;
    this.handlers = handlers || {};
    const script = path.join(__dirname, 'win-input-helper.ps1');
    try {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (e) {
      console.error('[win-input] spawn failed:', e.message);
      return false;
    }

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => console.error('[win-input] stderr:', d.trim()));
    this.proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      if (this.handlers.onExit) this.handlers.onExit(code);
    });
    return true;
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    const sp = line.indexOf(' ');
    const cmd = sp === -1 ? line : line.slice(0, sp);
    const arg = sp === -1 ? '' : line.slice(sp + 1);
    switch (cmd) {
      case 'READY':
        this.ready = true;
        if (this.handlers.onReady) this.handlers.onReady();
        break;
      case 'STATE':
        if (this.handlers.onState) this.handlers.onState(arg === '1');
        break;
      case 'CHAR': {
        // arg = space-separated UTF-16 code units in hex
        const text = arg
          .split(' ')
          .filter(Boolean)
          .map((h) => String.fromCharCode(parseInt(h, 16)))
          .join('');
        if (text && this.handlers.onKey) this.handlers.onKey({ kind: 'char', value: text });
        break;
      }
      case 'KEY':
        if (this.handlers.onKey) this.handlers.onKey({ kind: arg.toLowerCase() });
        break;
      case 'ERR':
        console.error('[win-input] helper error:', arg);
        break;
      default:
        break;
    }
  }

  _write(line) {
    if (this.proc && this.proc.stdin.writable) {
      try { this.proc.stdin.write(line + '\n'); } catch { /* ignore */ }
    }
  }

  setCapture(on) { this._write('CAP ' + (on ? '1' : '0')); }
  setRect(r) { this._write(`RECT ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}`); }

  stop() {
    if (this.proc) {
      this._write('QUIT');
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch {} }, 300);
      this.proc = null;
    }
  }
}

module.exports = new WinInput();
