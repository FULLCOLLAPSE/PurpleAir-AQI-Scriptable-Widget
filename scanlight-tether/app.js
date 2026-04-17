'use strict';

// ── Protocol constants ────────────────────────────────────────────────────────
const PACKET_START        = 0xFE;
const PKT_H2D_SET_COLOR   = 0;
const PKT_H2D_GET_DEFAULT = 1;
const PKT_H2D_GET_FW      = 2;
const PKT_H2D_SHUTTER     = 3;
const PKT_H2D_DFU         = 4;
const PKT_H2D_SET_TRIM    = 5;
const PKT_H2D_GET_TRIM    = 6;

const PKT_D2H_ACK         = 0;
const PKT_D2H_LED_TEMP    = 1;
const PKT_D2H_VBUS        = 2;
const PKT_D2H_FW_VERSION  = 3;
const PKT_D2H_DEFAULT     = 4;
const PKT_D2H_TRIM        = 5;

const USB_VBUS_5V = 4000;  // mV
const USB_VBUS_9V = 8000;  // mV

const FW_VERSIONS = { 0: 'v1.0.0' };

const SEQUENCES = {
  rgb:   [[1,0,0,0,0],[0,1,0,0,0],[0,0,1,0,0]],
  rgbir: [[1,0,0,0,0],[0,1,0,0,0],[0,0,1,0,0],[0,0,0,0,1]],
  nwir:  [[1,1,1,0,0],[0,0,0,0,1]],
  bwir:  [[0,0,0,1,0],[0,0,0,0,1]],
};

const SEQ_STEP_CLASSES = ['active-r','active-g','active-b','active-w','active-ir'];
const SEQ_STEP_NAMES   = ['Red','Green','Blue','White','IR'];

// ── App state ─────────────────────────────────────────────────────────────────
let port      = null;
let writer    = null;
let reader    = null;
let connected = false;

let channels = [128, 128, 128, 0, 0]; // R G B W IR
let enabled  = [1, 1, 1, 0, 0];
let trims    = [0, 0, 0, 0];          // R G B W (signed)

let activeSeq  = 'rgb';
let seqRunning = false;
let seqAbort   = false;

let sessionDirHandle = null;
let sessionFiles     = new Map(); // name → lastModified
let sessionNewCount  = 0;
let sessionPollTimer = null;

let presets = JSON.parse(localStorage.getItem('scanlightPresets') || '[]');

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = id => document.getElementById(id);

// ── Serial connection ─────────────────────────────────────────────────────────
async function connectSerial() {
  if (!('serial' in navigator)) {
    showError('Web Serial API not supported. Please use Chrome or Edge.');
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    connected = true;
    setLightConnected(true);
    showError(null);
    await sendPacket(PKT_H2D_GET_FW, []);
    await sendPacket(PKT_H2D_GET_DEFAULT, []);
    await sendPacket(PKT_H2D_GET_TRIM, []);
    readLoop();
  } catch (err) {
    if (err.name !== 'NotFoundError') showError('Connection failed: ' + err.message);
  }
}

async function disconnectSerial() {
  seqAbort = true;
  connected = false;
  setLightConnected(false);
  // Null out port first so readLoop's outer while loop doesn't grab a new reader
  const r = reader, w = writer, p = port;
  port = reader = writer = null;
  try { if (r) await r.cancel(); } catch {}
  await sleep(50); // let readLoop's finally block release the lock
  try { if (w) w.releaseLock(); } catch {}
  try { if (p) await p.close(); } catch {}
}

async function readLoop() {
  let idx = 0, hdr = 0, end = 0;
  const buf = new Uint8Array(128);

  while (port && port.readable) {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const byte of value) {
          if (idx === 0) {
            if (byte === PACKET_START) idx++;
          } else if (idx === 1) {
            hdr = byte; idx++;
          } else if (idx === 2) {
            end = byte + 2; idx++;
          } else if (idx >= 3 && idx < end && idx - 3 < 127) {
            buf[idx - 3] = byte; idx++;
          } else if (idx === end) {
            buf[idx - 3] = byte;
            buf[idx - 2] = 0;
            handlePacket(hdr, buf, new DataView(buf.buffer));
            idx = 0;
          } else {
            idx = 0;
          }
        }
      }
    } catch (e) {
      if (connected) console.warn('Serial read error:', e);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
  if (connected) { connected = false; setLightConnected(false); }
  try { await port.close(); } catch {}
}

function handlePacket(header, buf, dv) {
  switch (header) {
    case PKT_D2H_VBUS:
      updateVoltage(dv.getInt32(0, true));
      break;
    case PKT_D2H_FW_VERSION:
      $('fw-display').textContent = FW_VERSIONS[dv.getInt32(0, true)] ?? `ID:${dv.getInt32(0,true)}`;
      break;
    case PKT_D2H_DEFAULT:
      channels[0] = buf[0]; channels[1] = buf[1]; channels[2] = buf[2];
      syncSliders();
      sendColor();
      break;
    case PKT_D2H_TRIM:
      trims = [buf[0], buf[1], buf[2], buf[3]].map(b => (b << 24) >> 24);
      syncTrimUI();
      break;
  }
}

async function sendPacket(header, data) {
  if (!writer) return;
  const pkt = new Uint8Array(3 + data.length);
  pkt[0] = PACKET_START;
  pkt[1] = header;
  pkt[2] = data.length;
  for (let i = 0; i < data.length; i++) pkt[3 + i] = data[i] & 0xFF;
  try { await writer.write(pkt); } catch (e) { console.warn('Write error:', e); }
}

// ── Light control ─────────────────────────────────────────────────────────────
async function sendColor(save = false) {
  if (!connected) return;
  await sendPacket(PKT_H2D_SET_COLOR, [
    Math.round(channels[0] * enabled[0]),
    Math.round(channels[1] * enabled[1]),
    Math.round(channels[2] * enabled[2]),
    Math.round(255 * enabled[3]),
    Math.round(255 * enabled[4]),
    save ? 1 : 0,
  ]);
}

async function sendTrim() {
  if (!connected) return;
  await sendPacket(PKT_H2D_SET_TRIM, trims.map(v => v < 0 ? 256 + v : v));
}

async function sendShutter() {
  if (!connected) return;
  const ms = parseInt($('timing-pulse').value) || 30;
  await sendPacket(PKT_H2D_SHUTTER, [ms]);
}

// ── Sequences ─────────────────────────────────────────────────────────────────
async function runSequence() {
  if (!connected || seqRunning) return;
  const steps     = SEQUENCES[activeSeq];
  const settleMs  = parseInt($('timing-settle').value)  || 100;
  const delayMs   = parseInt($('timing-delay').value)   || 1000;

  seqRunning = true;
  seqAbort   = false;
  $('btn-run-seq').disabled  = true;
  $('btn-stop-seq').disabled = false;

  const prog = $('seq-progress');
  const dots = $('seq-step-dots');
  prog.hidden = false;
  dots.innerHTML = '';
  steps.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'step-dot';
    d.id = `dot-${i}`;
    dots.appendChild(d);
  });

  for (let i = 0; i < steps.length && !seqAbort; i++) {
    const mask   = steps[i];
    const chIdx  = mask.findIndex(v => v > 0);
    const dotCls = SEQ_STEP_CLASSES[chIdx] ?? 'active-r';

    for (let j = 0; j < i; j++) $(`dot-${j}`).className = 'step-dot done';
    $(`dot-${i}`).className = `step-dot ${dotCls}`;
    $('seq-status-text').textContent = `Step ${i + 1} / ${steps.length} — ${SEQ_STEP_NAMES[chIdx] ?? '?'}`;

    await sendPacket(PKT_H2D_SET_COLOR, [
      Math.round(channels[0] * mask[0]),
      Math.round(channels[1] * mask[1]),
      Math.round(channels[2] * mask[2]),
      Math.round(255 * mask[3]),
      Math.round(255 * mask[4]),
      0,
    ]);

    await sleep(settleMs);
    if (seqAbort) break;
    await sendShutter();
    await sleep(delayMs);
  }

  await sendColor();
  seqRunning = false;
  $('btn-run-seq').disabled  = false;
  $('btn-stop-seq').disabled = true;

  const done = !seqAbort;
  $('seq-status-text').textContent = done ? 'Complete ✓' : 'Stopped';
  for (let i = 0; i < steps.length; i++) {
    const d = $(`dot-${i}`);
    if (d) d.className = done ? 'step-dot done' : 'step-dot';
  }
}

// ── Presets ───────────────────────────────────────────────────────────────────
function savePreset() {
  const name = prompt('Preset name:', `Preset ${presets.length + 1}`);
  if (!name) return;
  presets.push({ name, channels: [...channels] });
  localStorage.setItem('scanlightPresets', JSON.stringify(presets));
  renderPresets();
}

function loadPreset(i) {
  channels = [...presets[i].channels];
  syncSliders();
  sendColor();
}

function deletePreset(i) {
  if (!confirm(`Delete preset "${presets[i].name}"?`)) return;
  presets.splice(i, 1);
  localStorage.setItem('scanlightPresets', JSON.stringify(presets));
  renderPresets();
}

function renderPresets() {
  const list = $('preset-list');
  if (!presets.length) {
    list.innerHTML = '<div class="empty-hint">No presets saved yet.</div>';
    return;
  }
  list.innerHTML = presets.map((p, i) => `
    <div class="preset-item">
      <span class="preset-name" onclick="loadPreset(${i})" title="Click to load">${p.name}</span>
      <span class="preset-rgb">R${p.channels[0]} G${p.channels[1]} B${p.channels[2]}</span>
      <button class="preset-del" onclick="deletePreset(${i})" title="Delete">✕</button>
    </div>
  `).join('');
}

// ── Capture One session ───────────────────────────────────────────────────────
const IMAGE_EXT   = /\.(cr3|cr2|raw|raf|nef|arw|dng|tif|tiff|jpg|jpeg)$/i;
const PREVIEW_EXT = /\.(jpg|jpeg)$/i;

async function openSession() {
  if (!('showDirectoryPicker' in window)) {
    alert('File System Access API not supported. Please use Chrome or Edge.');
    return;
  }
  try {
    let handle = await window.showDirectoryPicker({ mode: 'read' });
    // Auto-detect Capture One session structure — prefer the Captures subfolder
    try {
      const captures = await handle.getDirectoryHandle('Captures', { create: false });
      handle = captures;
    } catch { /* not a .cosession root, use as-is */ }

    sessionDirHandle = handle;
    sessionFiles.clear();
    sessionNewCount = 0;

    $('session-path-display').textContent = '📁 ' + handle.name;
    $('session-info').hidden       = false;
    $('session-help').hidden       = true;
    $('btn-close-session').disabled   = false;
    $('btn-refresh-session').disabled = false;
    $('session-dot').className = 'status-dot connected';
    $('session-status').textContent = `Session: ${handle.name}`;

    await scanSession();
    if ($('chk-autopoll').checked) startPolling();
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Session open error:', err);
  }
}

function closeSession() {
  stopPolling();
  sessionDirHandle = null;
  sessionFiles.clear();
  sessionNewCount = 0;
  $('session-info').hidden       = true;
  $('session-help').hidden       = false;
  $('btn-close-session').disabled   = true;
  $('btn-refresh-session').disabled = true;
  $('session-dot').className = 'status-dot';
  $('session-status').textContent = 'Session: Not Open';
  $('thumbnail-grid').innerHTML = '<div class="empty-message">No session open — connect to a Capture One session to view incoming photos.</div>';
}

async function scanSession() {
  if (!sessionDirHandle) return;

  const prevFiles = new Map(sessionFiles);
  const newScan   = new Map();
  const previews  = [];
  const rawOnly   = [];

  try {
    for await (const [name, handle] of sessionDirHandle.entries()) {
      if (handle.kind !== 'file' || !IMAGE_EXT.test(name)) continue;
      const file = await handle.getFile();
      newScan.set(name, file.lastModified);
      if (PREVIEW_EXT.test(name)) previews.push({ name, file, isNew: !prevFiles.has(name) });
      else rawOnly.push({ name, isNew: !prevFiles.has(name) });
    }
  } catch (e) {
    console.warn('Scan error:', e);
    return;
  }

  const added = [...newScan.keys()].filter(n => !prevFiles.has(n)).length;
  sessionNewCount += added;
  sessionFiles = newScan;

  const total = newScan.size;
  const jpg   = previews.length;
  const raw   = rawOnly.length;

  $('stat-total').textContent = total;
  $('stat-new').textContent   = sessionNewCount;
  $('stat-raw').textContent   = raw;
  $('stat-jpg').textContent   = jpg;

  previews.sort((a, b) => b.file.lastModified - a.file.lastModified);
  if (previews.length) {
    const { name, file } = previews[0];
    $('latest-capture').textContent =
      `Latest: ${name} — ${new Date(file.lastModified).toLocaleTimeString()}`;
  } else if (rawOnly.length) {
    $('latest-capture').textContent = `Latest: ${rawOnly[0].name} (RAW — no preview)`;
  }

  renderThumbnails(previews.slice(0, 24), rawOnly);
}

function renderThumbnails(previews, rawOnly) {
  const grid = $('thumbnail-grid');
  grid.innerHTML = '';

  if (!previews.length && !rawOnly.length) {
    grid.innerHTML = '<div class="empty-message">No image files found. Shoot a photo — it will appear here when Capture One imports it.</div>';
    return;
  }

  for (const { name, file, isNew } of previews) {
    const url = URL.createObjectURL(file);
    const div = document.createElement('div');
    div.className = 'thumbnail' + (isNew ? ' new' : '');
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    img.onload = () => URL.revokeObjectURL(url);
    const label = document.createElement('div');
    label.className = 'thumbnail-name';
    label.textContent = name;
    div.appendChild(img);
    div.appendChild(label);
    grid.appendChild(div);
  }

  // Show RAW-only cards if no JPEG previews exist
  if (!previews.length) {
    for (const { name, isNew } of rawOnly.slice(0, 12)) {
      const div = document.createElement('div');
      div.className = 'thumbnail' + (isNew ? ' new' : '');
      div.innerHTML = `<div class="thumbnail-raw"><div class="thumbnail-raw-icon">📷</div><div class="thumbnail-raw-name">${name}</div></div>`;
      grid.appendChild(div);
    }
    if (rawOnly.length > 12) {
      const more = document.createElement('div');
      more.className = 'empty-message';
      more.style.gridColumn = '1/-1';
      more.textContent = `+${rawOnly.length - 12} more RAW files`;
      grid.appendChild(more);
    }
  }
}

function startPolling() {
  stopPolling();
  sessionPollTimer = setInterval(() => scanSession(), 3000);
}

function stopPolling() {
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
}

// ── UI sync ───────────────────────────────────────────────────────────────────
function syncSliders() {
  ['r','g','b','w','ir'].forEach((id, i) => {
    $(`slider-${id}`).value = channels[i];
    $(`num-${id}`).value    = channels[i];
  });
}

function syncTrimUI() {
  ['r','g','b','w'].forEach((id, i) => {
    $(`trim-${id}`).value     = trims[i];
    $(`trim-${id}-num`).value = trims[i];
  });
}

function syncToggleBtns() {
  ['r','g','b','w','ir'].forEach((id, i) => {
    $(`tog-${id}`).classList.toggle('active', !!enabled[i]);
  });
}

let powerWarnDismissed = false;

const SHUTTER_SPEEDS_MS  = [4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4, 2];
const SHUTTER_SPEED_LBLS = ['4"', '2"', '1"', '1/2', '1/4', '1/8', '1/15', '1/30', '1/60', '1/125', '1/250', '1/500'];

function updateShutterRec() {
  const delayMs = parseInt($('timing-delay').value) || 1000;
  const budget  = delayMs * 0.75; // use 75% of delay as safe exposure budget
  const idx = SHUTTER_SPEEDS_MS.findIndex(ms => ms <= budget);
  const el  = $('shutter-rec');
  if (idx >= 0) {
    el.textContent = `Recommended camera shutter: ${SHUTTER_SPEED_LBLS[idx]}s or faster`;
    el.className = 'shutter-rec ok';
  } else {
    el.textContent = 'Post-shutter delay is very short — increase it or use Bulb mode';
    el.className = 'shutter-rec warn';
  }
}

function updateVoltage(mv) {
  const label = $('voltage-display');
  const v = (mv / 1000).toFixed(2) + 'V';
  label.textContent = v;
  label.className = 'info-card-value ' +
    (mv >= USB_VBUS_9V ? 'ok' : mv >= USB_VBUS_5V ? 'warn' : 'err');
  const alertEl = $('alert-power');
  if (mv < USB_VBUS_9V && !powerWarnDismissed) {
    alertEl.innerHTML = `Detected ${v} — full brightness requires 9V / 2A via USB-C PD. ` +
      `If your supply is 9V, try a shorter or higher-quality cable. ` +
      `<button onclick="powerWarnDismissed=true;this.closest('.alert').hidden=true" ` +
      `style="margin-left:8px;background:transparent;border:1px solid currentColor;` +
      `color:inherit;border-radius:3px;padding:1px 6px;cursor:pointer;font-size:11px">Dismiss</button>`;
    alertEl.hidden = false;
  } else if (mv >= USB_VBUS_9V) {
    alertEl.hidden = true;
    powerWarnDismissed = false;
  }
}

function setLightConnected(yes) {
  $('light-dot').className    = 'status-dot ' + (yes ? 'connected' : '');
  $('light-status').textContent = yes ? 'Light: Connected' : 'Light: Disconnected';
  $('btn-connect').disabled    = yes;
  $('btn-disconnect').disabled = !yes;
  ['btn-save-preset','btn-set-default','btn-send-trim','btn-run-seq','btn-test-shutter']
    .forEach(id => $(id).disabled = !yes);
}

function showError(msg) {
  const el = $('alert-error');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

// Channel sliders ↔ number inputs
['r','g','b','w','ir'].forEach((id, i) => {
  $(`slider-${id}`).addEventListener('input', () => {
    channels[i] = parseInt($(`slider-${id}`).value);
    $(`num-${id}`).value = channels[i];
    sendColor();
  });
  $(`num-${id}`).addEventListener('change', () => {
    channels[i] = clamp(parseInt($(`num-${id}`).value) || 0, 0, 255);
    $(`num-${id}`).value = channels[i];
    $(`slider-${id}`).value = channels[i];
    sendColor();
  });
});

// Trim sliders ↔ number inputs
['r','g','b','w'].forEach((id, i) => {
  $(`trim-${id}`).addEventListener('input', () => {
    trims[i] = parseInt($(`trim-${id}`).value);
    $(`trim-${id}-num`).value = trims[i];
  });
  $(`trim-${id}-num`).addEventListener('change', () => {
    trims[i] = clamp(parseInt($(`trim-${id}-num`).value) || 0, -127, 127);
    $(`trim-${id}-num`).value = trims[i];
    $(`trim-${id}`).value = trims[i];
  });
});

// Channel enable toggles
['r','g','b','w','ir'].forEach((id, i) => {
  $(`tog-${id}`).addEventListener('click', function () {
    enabled[i] = enabled[i] ? 0 : 1;
    this.classList.toggle('active', !!enabled[i]);
    sendColor();
  });
});

// Quick actions
$('q-rgb').addEventListener('click', () => { enabled = [1,1,1,0,0]; syncToggleBtns(); sendColor(); });
$('q-white').addEventListener('click', () => { enabled = [0,0,0,1,0]; syncToggleBtns(); sendColor(); });
$('q-off').addEventListener('click', () => { sendPacket(PKT_H2D_SET_COLOR, [0,0,0,0,0,0]); });
$('q-r').addEventListener('click', () => { enabled = [1,0,0,0,0]; syncToggleBtns(); sendColor(); });
$('q-g').addEventListener('click', () => { enabled = [0,1,0,0,0]; syncToggleBtns(); sendColor(); });
$('q-b').addEventListener('click', () => { enabled = [0,0,1,0,0]; syncToggleBtns(); sendColor(); });
$('q-ir').addEventListener('click', () => { enabled = [0,0,0,0,1]; syncToggleBtns(); sendColor(); });

// Connection
$('btn-connect').addEventListener('click', connectSerial);
$('btn-disconnect').addEventListener('click', disconnectSerial);

// Serial device disconnect event
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', () => {
    if (connected) { connected = false; setLightConnected(false); }
  });
}

// Presets
$('btn-save-preset').addEventListener('click', savePreset);
$('btn-set-default').addEventListener('click', () => sendColor(true));

// Trim
$('btn-send-trim').addEventListener('click', sendTrim);

// Sequence selection
document.querySelectorAll('.seq-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    activeSeq = this.dataset.seq;
    document.querySelectorAll('.seq-btn').forEach(b =>
      b.className = b === this ? 'btn primary seq-btn' : 'btn seq-btn'
    );
  });
});

// Sequence run/stop/test
$('btn-run-seq').addEventListener('click', runSequence);
$('btn-stop-seq').addEventListener('click', () => { seqAbort = true; });
$('btn-test-shutter').addEventListener('click', sendShutter);
$('timing-delay').addEventListener('input', updateShutterRec);

// Session
$('btn-open-session').addEventListener('click', openSession);
$('btn-close-session').addEventListener('click', closeSession);
$('btn-refresh-session').addEventListener('click', () => { sessionNewCount = 0; scanSession(); });
$('chk-autopoll').addEventListener('change', function () {
  if (this.checked && sessionDirHandle) startPolling(); else stopPolling();
});

// ── Init ──────────────────────────────────────────────────────────────────────
if (!('serial' in navigator)) {
  showError('Web Serial API not supported. Please open this page in Chrome or Edge on a desktop computer.');
}

renderPresets();
setLightConnected(false);
updateShutterRec();
