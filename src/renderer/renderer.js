'use strict';

const SYSTEM_PROMPT =
  'You are a helpful, concise assistant. Use markdown and fenced code blocks when useful.';

// ---------- state ----------
let chats = [];        // [{ id, title, messages:[{role,content}], createdAt }]
let currentId = null;
let generating = false;
let activeRequestId = null;
let stopStream = null;  // unsubscribe fn for the current stream
let pendingImages = []; // data URLs staged for the next message

let inputMode = 'native'; // 'hook' (faux caret) | 'native' (real textarea)
let inputText = '';        // hook-mode input buffer
let capturing = false;     // hook-mode: keyboard currently grabbed?

const MAX_IMG_DIM = 1400; // downscale cap (keeps text readable, size sane)

const STORE_KEY = 'stealth.chats.v1';

// ---------- dom ----------
const $ = (sel) => document.querySelector(sel);
const chatListEl = $('#chatList');
const messagesEl = $('#messages');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const emptyEl = $('#empty');
const ctxMenu = $('#ctxMenu');
const composerHint = $('#composerHint');
const attachmentsEl = $('#attachments');
const snipBtn = $('#snipBtn');
const fauxEl = $('#fauxInput');
const composerInner = document.querySelector('.composer-inner');

// ---------- persistence ----------
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    chats = raw ? JSON.parse(raw) : [];
  } catch {
    chats = [];
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(chats));
  } catch (e) {
    // Most likely storage quota (large pasted images). Keep the session
    // working; just warn that history persistence was skipped this time.
    composerHint.textContent =
      '⚠ Chat too large to save locally (images). It stays for this session.';
  }
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function currentChat() {
  return chats.find((c) => c.id === currentId) || null;
}

// ---------- images ----------
// Downscale large images so vision cost + localStorage stay reasonable,
// while keeping UI text readable.
function normalizeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, MAX_IMG_DIM / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = src;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function addImage(src) {
  try {
    const dataUrl = await normalizeImage(src);
    pendingImages.push(dataUrl);
    renderAttachments();
  } catch {
    composerHint.textContent = '⚠ Could not read image.';
  }
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  pendingImages.forEach((url, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.src = url;
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    thumb.appendChild(img);
    thumb.appendChild(rm);
    attachmentsEl.appendChild(thumb);
  });
}

// ---------- chat operations ----------
function newChat() {
  // Reuse an existing empty chat instead of piling up blanks.
  const blank = chats.find((c) => c.messages.length === 0);
  if (blank) {
    currentId = blank.id;
  } else {
    const chat = { id: uid(), title: 'New chat', messages: [], createdAt: Date.now() };
    chats.unshift(chat);
    currentId = chat.id;
    save();
  }
  renderSidebar();
  renderMessages();
  inputEl.focus();
}

function selectChat(id) {
  currentId = id;
  renderSidebar();
  renderMessages();
  inputEl.focus();
}

function deleteChat(id) {
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return;
  chats.splice(idx, 1);
  if (currentId === id) {
    currentId = chats[0] ? chats[0].id : null;
  }
  save();
  renderSidebar();
  renderMessages();
}

function renameChat(id, title) {
  const chat = chats.find((c) => c.id === id);
  if (!chat) return;
  chat.title = title.trim() || chat.title;
  save();
  renderSidebar();
}

function titleFrom(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

// ---------- rendering: sidebar ----------
function renderSidebar() {
  chatListEl.innerHTML = '';
  chats.forEach((chat) => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === currentId ? ' active' : '');
    item.dataset.id = chat.id;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = chat.title;

    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.textContent = '⋯';
    dots.title = 'Options';
    dots.addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(e, chat.id);
    });

    item.appendChild(title);
    item.appendChild(dots);
    item.addEventListener('click', () => selectChat(chat.id));
    chatListEl.appendChild(item);
  });
}

// ---------- rendering: messages ----------
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Minimal, safe markdown: fenced code blocks + inline code. Everything
// else stays as text (the container uses white-space: pre-wrap).
function renderMarkdown(text) {
  const parts = text.split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // inside a fenced block; drop an optional language line
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      html += '<pre><code>' + escapeHtml(body) + '</code></pre>';
    } else {
      let seg = escapeHtml(part).replace(/`([^`]+)`/g, '<code>$1</code>');
      html += seg;
    }
  });
  return html;
}

// content may be a plain string or an OpenAI multimodal array
// ([{type:'text',text}, {type:'image_url',image_url:{url}}]).
function contentToHtml(content) {
  if (typeof content === 'string') return renderMarkdown(content);
  let html = '';
  content.forEach((part) => {
    if (part.type === 'text' && part.text) {
      html += renderMarkdown(part.text);
    } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {
      html += '<img class="chat-img" src="' + part.image_url.url + '" />';
    }
  });
  return html;
}

function messageRow(role, content, { streaming = false } = {}) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + role;

  const inner = document.createElement('div');
  inner.className = 'msg-inner';

  const avatar = document.createElement('div');
  avatar.className = 'avatar ' + role;
  avatar.textContent = role === 'user' ? 'You' : '◈';

  const contentEl = document.createElement('div');
  contentEl.className = 'msg-content';
  if (streaming) contentEl.classList.add('cursor-blink');
  contentEl.innerHTML = contentToHtml(content);

  inner.appendChild(avatar);
  inner.appendChild(contentEl);
  row.appendChild(inner);
  return { row, contentEl };
}

function renderMessages() {
  const chat = currentChat();
  messagesEl.innerHTML = '';
  if (!chat || chat.messages.length === 0) {
    messagesEl.appendChild(emptyEl);
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';
  chat.messages.forEach((m) => {
    const { row } = messageRow(m.role, m.content);
    messagesEl.appendChild(row);
  });
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- sending ----------
function setGenerating(on) {
  generating = on;
  sendBtn.classList.toggle('stop', on);
  sendBtn.textContent = on ? '■' : '▲';
  sendBtn.title = on ? 'Stop' : 'Send';
}

async function send() {
  if (generating) {
    // acts as Stop
    if (activeRequestId) window.api.abortChat(activeRequestId);
    if (stopStream) stopStream();
    finishAssistant();
    return;
  }

  const text = getInputText().trim();
  const images = pendingImages.slice();
  if (!text && images.length === 0) return;

  if (!currentChat()) newChat();
  const chat = currentChat();

  // Build message content: string when text-only, multimodal array when
  // images are attached (OpenAI vision format).
  let content;
  if (images.length > 0) {
    content = [];
    if (text) content.push({ type: 'text', text });
    images.forEach((url) =>
      content.push({ type: 'image_url', image_url: { url } })
    );
  } else {
    content = text;
  }

  // append user message
  chat.messages.push({ role: 'user', content });
  if (chat.messages.length === 1) chat.title = titleFrom(text || 'Image');
  save();
  renderSidebar();

  // clear input + attachments
  clearInput();
  pendingImages = [];
  renderAttachments();

  // render user row
  emptyEl.style.display = 'none';
  const { row: userRow } = messageRow('user', content);
  messagesEl.appendChild(userRow);

  // assistant placeholder
  const { row: aRow, contentEl } = messageRow('assistant', '', { streaming: true });
  messagesEl.appendChild(aRow);
  scrollToBottom();

  // build request context (system + full chat history)
  const payload = [{ role: 'system', content: SYSTEM_PROMPT }, ...chat.messages.map(
    (m) => ({ role: m.role, content: m.content })
  )];

  let acc = '';
  activeRequestId = uid();
  setGenerating(true);
  composerHint.textContent = '';

  stopStream = window.api.streamChat(activeRequestId, payload, {
    onChunk: (delta) => {
      acc += delta;
      contentEl.innerHTML = renderMarkdown(acc);
      scrollToBottom();
    },
    onDone: () => {
      contentEl.classList.remove('cursor-blink');
      contentEl.innerHTML = renderMarkdown(acc || '');
      chat.messages.push({ role: 'assistant', content: acc });
      save();
      finishAssistant();
    },
    onError: (msg) => {
      contentEl.classList.remove('cursor-blink');
      contentEl.innerHTML = renderMarkdown(acc);
      composerHint.textContent = '⚠ ' + msg;
      // still store whatever we got
      if (acc) chat.messages.push({ role: 'assistant', content: acc });
      save();
      finishAssistant();
    },
  });
}

function finishAssistant() {
  setGenerating(false);
  activeRequestId = null;
  stopStream = null;
  focusInput();
}

// ---------- context menu ----------
let ctxTargetId = null;
function openCtxMenu(e, id) {
  ctxTargetId = id;
  ctxMenu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 90);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
}
function closeCtxMenu() {
  ctxMenu.classList.add('hidden');
  ctxTargetId = null;
}
ctxMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !ctxTargetId) return;
  const id = ctxTargetId;
  closeCtxMenu();
  if (action === 'delete') deleteChat(id);
  if (action === 'rename') startRename(id);
});
document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) closeCtxMenu();
});

function startRename(id) {
  const item = chatListEl.querySelector(`.chat-item[data-id="${id}"]`);
  if (!item) return;
  const chat = chats.find((c) => c.id === id);
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = chat.title;
  const titleEl = item.querySelector('.title');
  item.replaceChild(input, titleEl);
  input.focus();
  input.select();
  const commit = () => { renameChat(id, input.value); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') renderSidebar();
  });
  input.addEventListener('blur', commit);
}

// ---------- input handling (mode-aware) ----------
function getInputText() {
  return inputMode === 'hook' ? inputText : inputEl.value;
}
function clearInput() {
  if (inputMode === 'hook') {
    inputText = '';
    renderFaux();
  } else {
    inputEl.value = '';
    autoGrow();
  }
}
function focusInput() {
  if (inputMode === 'hook') {
    window.api.setCapture(true); // grab the keyboard again
  } else {
    inputEl.focus();
  }
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

// --- native mode (real textarea) ---
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let handled = false;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) {
        e.preventDefault();
        handled = true;
        const dataUrl = await blobToDataUrl(blob);
        await addImage(dataUrl);
      }
    }
  }
  if (handled) composerHint.textContent = '';
});

// --- hook mode (fake-focus editor) ---
function renderFaux() {
  if (!inputText && !capturing) {
    fauxEl.innerHTML = '<span class="ph">Click here to type (keeps the other window focused)…</span>';
    return;
  }
  const safe = escapeHtml(inputText).replace(/\n/g, '<br>');
  fauxEl.innerHTML = safe + (capturing ? '<span class="caret"></span>' : '');
  fauxEl.scrollTop = fauxEl.scrollHeight;
}

async function hookPaste() {
  const clip = await window.api.readClipboard();
  if (clip.type === 'image' && clip.dataUrl) {
    await addImage(clip.dataUrl);
    composerHint.textContent = '';
  } else if (clip.text) {
    inputText += clip.text;
    renderFaux();
  }
}

// Ctrl+C while the input holds the keyboard: copy the current transcript
// selection to the clipboard. If nothing is selected, do nothing.
function hookCopy() {
  const sel = window.getSelection ? String(window.getSelection()) : '';
  if (sel && sel.trim()) window.api.writeClipboard(sel);
}

// Any click inside the window shows the caret (grabs the keyboard). Clicking
// outside the window hides it (handled by the hook helper). Native window
// controls (min/max/close, resize, title-bar drag) are non-client areas, so
// they keep working regardless of capture state.
document.addEventListener('mousedown', () => {
  if (inputMode !== 'hook') return;
  window.api.setCapture(true);
});

function applyMode(mode) {
  inputMode = mode;
  if (mode === 'hook') {
    inputEl.style.display = 'none';
    fauxEl.style.display = 'block';
    renderFaux();
  } else {
    fauxEl.style.display = 'none';
    inputEl.style.display = 'block';
    inputEl.focus();
  }
}

window.api.onInputMode(applyMode);

window.api.onCaptureState((cap) => {
  capturing = cap;
  composerInner.classList.toggle('capturing', cap);
  renderFaux();
});

window.api.onInputKey((evt) => {
  if (inputMode !== 'hook') return;
  switch (evt.kind) {
    case 'char':
      inputText += evt.value;
      renderFaux();
      break;
    case 'backspace':
      inputText = inputText.slice(0, -1);
      renderFaux();
      break;
    case 'shiftenter':
      inputText += '\n';
      renderFaux();
      break;
    case 'enter':
      send();
      break;
    case 'paste':
      hookPaste();
      break;
    case 'copy':
      hookCopy();
      break;
    case 'escape':
      // helper already released capture; state event will hide the caret
      break;
    default:
      break;
  }
});

sendBtn.addEventListener('click', send);
snipBtn.addEventListener('click', () => window.api.startSnip());
$('#newChatBtn').addEventListener('click', newChat);

// After a capture-safe snip, the image is on the clipboard.
window.api.onSnipCopied(() => {
  composerHint.textContent = '📸 Snip copied — press Ctrl+V to attach it.';
  focusInput();
});

// ---------- custom title bar: controls + manual move/resize ----------
$('#winMin').addEventListener('click', () => window.api.win('minimize'));
$('#winMax').addEventListener('click', () => window.api.win('maximize'));
$('#winClose').addEventListener('click', () => window.api.win('close'));

const MIN_W = 720, MIN_H = 480;
let dragState = null;
let pendingBounds = null, rafQueued = false;

function queueBounds(b) {
  pendingBounds = b;
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (pendingBounds) {
      window.api.setBounds(pendingBounds);
      pendingBounds = null;
    }
  });
}

async function startDrag(e, mode) {
  if (e.button !== 0) return;
  e.preventDefault();
  const b = await window.api.getBounds();
  if (!b) return;
  dragState = { mode, sx: e.screenX, sy: e.screenY, b };
  try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
}

function onDragMove(e) {
  if (!dragState) return;
  const dx = e.screenX - dragState.sx;
  const dy = e.screenY - dragState.sy;
  const { mode, b } = dragState;
  let { x, y, width, height } = b;

  if (mode === 'move') {
    x = b.x + dx;
    y = b.y + dy;
  } else {
    if (mode.includes('e')) width = Math.max(MIN_W, b.width + dx);
    if (mode.includes('s')) height = Math.max(MIN_H, b.height + dy);
    if (mode.includes('w')) {
      width = Math.max(MIN_W, b.width - dx);
      x = b.x + (b.width - width);
    }
    if (mode.includes('n')) {
      height = Math.max(MIN_H, b.height - dy);
      y = b.y + (b.height - height);
    }
  }
  queueBounds({
    x: Math.round(x), y: Math.round(y),
    width: Math.round(width), height: Math.round(height),
  });
}

function endDrag(e) {
  if (!dragState) return;
  try { e.target.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  dragState = null;
}

document.getElementById('titlebarDrag')
  .addEventListener('pointerdown', (e) => startDrag(e, 'move'));
document.querySelectorAll('.rz').forEach((h) => {
  h.addEventListener('pointerdown', (e) => startDrag(e, h.dataset.dir));
});
document.addEventListener('pointermove', onDragMove);
document.addEventListener('pointerup', endDrag);

// ---------- boot ----------
async function boot() {
  load();
  if (chats.length === 0) {
    newChat();
  } else {
    currentId = chats[0].id;
    renderSidebar();
    renderMessages();
  }

  try {
    const status = await window.api.getStatus();
    $('#modelBadge').textContent = status.model;
    if (status.mode) applyMode(status.mode);
    if (!status.hasKey) {
      composerHint.textContent =
        '⚠ No API key. Add OPENAI_API_KEY to your .env file and restart the app.';
    }
  } catch {
    /* ignore */
  }
}

boot();
