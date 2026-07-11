'use strict';

const dim = document.getElementById('dim');
const sel = document.getElementById('sel');
const sizeTag = document.getElementById('size');
const hint = document.getElementById('hint');

let startX = 0, startY = 0;
let dragging = false;

function rectFrom(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function draw(r) {
  sel.style.display = 'block';
  sel.style.left = r.x + 'px';
  sel.style.top = r.y + 'px';
  sel.style.width = r.width + 'px';
  sel.style.height = r.height + 'px';

  sizeTag.style.display = 'block';
  sizeTag.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
  const tagY = r.y > 24 ? r.y - 22 : r.y + r.height + 6;
  sizeTag.style.left = r.x + 'px';
  sizeTag.style.top = tagY + 'px';
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  dim.style.display = 'none'; // selection box provides the dimming from here
  hint.style.display = 'none';
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  draw(rectFrom(startX, startY, e.clientX, e.clientY));
});

window.addEventListener('mouseup', async (e) => {
  if (!dragging) return;
  dragging = false;
  const r = rectFrom(startX, startY, e.clientX, e.clientY);
  if (r.width < 3 || r.height < 3) {
    window.snip.cancel();
    return;
  }
  // Hide selection chrome so it can't tint the captured pixels.
  sel.style.display = 'none';
  sizeTag.style.display = 'none';
  await window.snip.capture(r);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.snip.cancel();
});
