# Stealth Chat

A ChatGPT/Claude-style desktop AI assistant that is **invisible to screen sharing and screen recording**. Built with Electron + the OpenAI API.

## Features

- **Stealth window** — rendered normally on your monitor but black/absent in Zoom, Teams, Meet, OBS, Snipping Tool, and OS screen recording (`setContentProtection` → `WDA_EXCLUDEFROMCAPTURE` on Windows).
- **Always-on-top**, so it floats over the app you are sharing.
- **Panic hotkey** — `Ctrl + Shift + \` instantly hides/shows the window (works even when the app isn't focused).
- **Sidebar** with a **New chat** button on top and your **chat history** below.
- Each history item has a **⋯ menu** to **rename** or **delete** it.
- Multi-chat: every chat keeps its own conversation context (full history is sent to the model, so replies stay on topic).
- **Streaming** responses, token by token.
- **Translucent window** so you can see the app underneath. Adjust with `Ctrl+Shift+↑/↓`.
- **Capture-safe region snip** (`Ctrl+Shift+S` or the ▢ button): drag to select an area. The selection overlay is itself invisible to screen capture, and the snip is copied to your clipboard. Press **Ctrl+V** in the chat input to attach it.
- **Vision**: attached/pasted images are sent to the model (`gpt-4o`) so you can ask about screenshots.
- **Non-activating window** — the window never takes focus, so the app you were using (call, editor, exam, game) **never fires a "focus lost" / blur event**. You type into the chat via a low-level keyboard hook that routes and *swallows* keys, so those keystrokes never reach the other app.
- **No login, no settings screen.** Just your API key in a local `.env` file.

## How typing works (important)

Because the window is non-activating, you don't focus it the normal way:

1. **Click anywhere inside the window.** A blinking caret appears — the app has "grabbed" the keyboard. The other window stays active the whole time (it never blurs).
2. **Type / paste (Ctrl+V) / press Enter to send.** Those keys go *only* to the chat; the underlying app receives nothing.
3. **Click anywhere outside the window, or press Esc, to release** the keyboard back to the real active window.

To keep the underlying window from ever blurring, this window is **non-focusable** (`setFocusable(false)`). Because that disables the OS caption buttons on Windows, the app uses a **custom title bar**: minimize / maximize / close are driven over IPC, and drag-to-move + edge/corner resize are done manually (pointer capture → `setBounds`). All of it works while the window never takes focus.

While the keyboard is grabbed (caret blinking), global shortcuts like `Ctrl+Shift+S` are suppressed — press **Esc** first to release, then use them. On non-Windows systems (or if the hook helper can't start) the app falls back to a normal focusable text box.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+\` | Hide / show the window |
| `Ctrl+Shift+S` | Snip a region (capture-safe) |
| `Ctrl+V` | Attach the snipped/copied image to the input |
| `Ctrl+Shift+↑` / `↓` | More / less opaque |
| `Enter` / `Shift+Enter` | Send / newline |

## Setup

1. Install dependencies (already done if you see `node_modules/`):
   ```
   npm install
   ```

2. Add your OpenAI key. Copy the example and paste your key:
   ```
   copy .env.example .env
   ```
   Then open `.env` and set:
   ```
   OPENAI_API_KEY=sk-...your key...
   OPENAI_MODEL=gpt-4o
   STEALTH_MODE=TRUE
   ```
   The `.env` file is git-ignored and never leaves your machine.

3. Run:
   ```
   npm start
   ```

## Build a standalone Windows .exe (optional)

```
npm run dist
```
The installer/executable is written to `dist/`.

## Notes

- Default model is `gpt-4o`. Change `OPENAI_MODEL` in `.env` to switch (e.g. `gpt-4o-mini`).
- **`STEALTH_MODE`** in `.env` toggles screen-share visibility: `TRUE` (default) hides the window from screen sharing/recording; `FALSE` makes it visible like a normal app. Takes effect on app restart.
- Chat history is stored locally in the app's browser storage — nothing is uploaded anywhere except your prompts to OpenAI.
- Screen-share invisibility depends on the OS compositor. It is reliable on Windows 10 2004+ / Windows 11 for standard capture (the whole point of `WDA_EXCLUDEFROMCAPTURE`). Hardware capture cards / photographing the screen obviously still see it.
