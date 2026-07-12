# Stealth Chat (macOS)

A ChatGPT/Claude-style desktop AI assistant for **macOS** that is **invisible to screen sharing and screen recording**. Built with Electron + the OpenAI API.

## Features

- **Stealth window** — rendered normally on your Mac's display but black/absent in Zoom, Teams, Meet, QuickTime, OBS, and macOS screen recording, via Electron's `setContentProtection(true)` → `NSWindowSharingNone`.
- **Non-activating panel** — the window is turned into a macOS *non-activating panel* and the app runs as an **accessory** (no Dock icon, not in ⌘-Tab), so clicking it never activates our app: the app you're sharing/using stays the foreground application.
- **Stealth typing (CGEventTap)** — a global event tap captures your keystrokes into the chat and **swallows them** so they never reach the app underneath, which keeps *its* focus/caret. Requires the **Accessibility** permission (see below).
- **Always-on-top**, floating over the app you're sharing (including full-screen spaces).
- **Panic hotkey** — `⌘ + Shift + \` instantly hides/shows the window.
- **Sidebar** with a **New chat** button on top and your **chat history** below; each item has a **⋯ menu** to rename or delete.
- Multi-chat: each chat keeps its own conversation context.
- **Streaming** responses, token by token.
- **Translucent window** so you can see what's underneath. Adjust with `⌘+Shift+↑/↓`.
- **Capture-safe region snip** (`⌘+Shift+S` or the 📷 button): drag to select an area; the selection overlay is itself invisible to capture, and the snip is copied to your clipboard. Press **⌘V** in the chat input to attach it.
- **Vision**: pasted/attached images are sent to `gpt-4o`, so you can ask about a screenshot.
- **No login, no settings screen.** Just your API key in a local `.env` file.

## How typing works

The window never takes focus, so you type like this:

1. **Click anywhere inside the window** — a blinking caret appears; the event tap now routes keys to the chat.
2. **Type / ⌘V to paste / Enter to send.** Those keys are swallowed — the app underneath never receives them and keeps its own focus.
3. **Click outside the window, or press Esc, to release** the keyboard back to the other app.

If Accessibility isn't granted yet, the app falls back to a normal focusable text box (typing still works, but the app underneath will lose key focus while you type).

## Shortcuts

| Shortcut | Action |
|---|---|
| `⌘+Shift+\` | Hide / show the window |
| `⌘+Shift+S` | Snip a region (capture-safe) |
| `⌘V` | Attach the snipped/copied image to the input |
| `⌘+Shift+↑` / `↓` | More / less opaque |
| `Enter` / `Shift+Enter` | Send / newline |

## Requirements

- **A Mac to build and run on.** A macOS `.app`/`.dmg` can only be produced on macOS — it cannot be cross-compiled from Windows/Linux.
- **Node.js 18+** and **Xcode Command Line Tools** (`xcode-select --install`) for `npm install` to build native deps.
- macOS 11+ recommended.

## Setup & run (on your Mac)

```bash
npm install          # installs deps (koffi ships prebuilt macOS binaries)
cp .env.example .env # then edit .env and paste your key
npm start
```

`.env`:
```
OPENAI_API_KEY=sk-...your key...
OPENAI_MODEL=gpt-4o
```

## Build a macOS app

```bash
npm run dist
```
Produces, in `dist/`:
- `Stealth Chat-1.0.0.dmg` — drag-to-Applications installer
- `Stealth Chat-1.0.0-mac.zip` — zipped `.app`

### Where to put your API key in the built app
Place a `.env` file **next to `Stealth Chat.app`** (e.g. in the same folder, or in `/Applications`). The app searches, in order: beside the `.app` → resources → dev project → `~/Library/Application Support/Stealth Chat/.env`.

## Required macOS permissions

Grant both under **System Settings → Privacy & Security**, then reopen the app:

- **Accessibility** — lets the CGEventTap capture/swallow keystrokes (the stealth-typing feature). If not granted, the app opens this pane automatically and falls back to a normal text box until you enable it.
- **Screen Recording** — needed for the snip/screenshot feature. On first snip the app opens the Screen Recording pane; enable *Stealth Chat*, then reopen.

(The screen-share *invisibility* itself needs no permission.)

## Notes & honest caveats

- **Unsigned build** — the app isn't code-signed/notarized, so Gatekeeper will block the first launch. Right-click the app → **Open** (or `xattr -dr com.apple.quarantine "Stealth Chat.app"`). Signing/notarizing needs a paid Apple Developer account.
- **Permissions & unsigned apps** — macOS may reset Accessibility/Screen-Recording grants for unsigned apps between rebuilds; you may need to remove and re-add *Stealth Chat* in the list after a new build.
- **Screen-share invisibility** relies on the OS compositor; a **camera pointed at the screen** or some hardware capture devices can still see it.
- Chat history is stored locally in the app's storage; nothing is uploaded except your prompts to OpenAI.
- Default model is `gpt-4o`; change `OPENAI_MODEL` in `.env`.
