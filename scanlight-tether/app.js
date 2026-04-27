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

let activeSeq   = 'rgb';
let captureMode = 'segregated'; // 'segregated' | 'combined'
let seqRunning  = false;
let seqAbort    = false;

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
  voltageCheckDone = false;
  voltageHistory.length = 0;
  $('alert-power').hidden = true;
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
function seqStart(steps) {
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
}

function seqEnd(steps, aborted) {
  seqRunning = false;
  $('btn-run-seq').disabled  = false;
  $('btn-stop-seq').disabled = true;
  $('seq-status-text').textContent = aborted ? 'Stopped' : 'Complete ✓';
  steps.forEach((_, i) => {
    const d = $(`dot-${i}`);
    if (d) d.className = aborted ? 'step-dot' : 'step-dot done';
  });
}

function setDot(i, steps, activeCls) {
  for (let j = 0; j < i; j++) $(`dot-${j}`).className = 'step-dot done';
  $(`dot-${i}`).className = `step-dot ${activeCls}`;
}

async function runSequence() {
  if (!connected || seqRunning) return;
  if (captureMode === 'combined') { await runCombinedSequence(); return; }

  const steps    = SEQUENCES[activeSeq];
  const settleMs = parseInt($('timing-settle').value) || 100;
  const delayMs  = parseInt($('timing-delay').value)  || 1000;

  seqStart(steps);

  for (let i = 0; i < steps.length && !seqAbort; i++) {
    const mask   = steps[i];
    const chIdx  = mask.findIndex(v => v > 0);
    setDot(i, steps, SEQ_STEP_CLASSES[chIdx] ?? 'active-r');
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
  seqEnd(steps, seqAbort);
}

async function runCombinedSequence() {
  const steps     = SEQUENCES[activeSeq];
  const settleMs  = parseInt($('timing-settle').value) || 100;
  const flashMs   = parseInt($('timing-flash').value)  || 200;
  // Total exposure needed: settle + (channels × flash) + small buffer
  const totalMs   = settleMs + steps.length * flashMs + 100;
  // Firmware pulse value: clamp to 255. If total > 255ms, user must use Bulb.
  const pulseVal  = Math.min(255, totalMs);

  seqStart(steps);
  $('seq-status-text').textContent = 'Opening shutter…';

  // Fire shutter open (don't await — the pulse runs in firmware while we cycle lights)
  sendPacket(PKT_H2D_SHUTTER, [pulseVal]);

  await sleep(settleMs);

  for (let i = 0; i < steps.length && !seqAbort; i++) {
    const mask  = steps[i];
    const chIdx = mask.findIndex(v => v > 0);
    setDot(i, steps, SEQ_STEP_CLASSES[chIdx] ?? 'active-r');
    $('seq-status-text').textContent = `Flashing ${SEQ_STEP_NAMES[chIdx] ?? '?'} (${i + 1}/${steps.length})`;

    await sendPacket(PKT_H2D_SET_COLOR, [
      Math.round(channels[0] * mask[0]),
      Math.round(channels[1] * mask[1]),
      Math.round(channels[2] * mask[2]),
      Math.round(255 * mask[3]),
      Math.round(255 * mask[4]),
      0,
    ]);
    await sleep(flashMs);
  }

  // Lights off — stay off after a combined exposure (single image, nothing to restore)
  await sendPacket(PKT_H2D_SET_COLOR, [0, 0, 0, 0, 0, 0]);
  $('seq-status-text').textContent = seqAbort ? 'Stopped' : 'Exposure complete ✓';
  seqEnd(steps, seqAbort);
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

let voltageCheckDone = false;
const voltageHistory = [];

const SHUTTER_SPEEDS_MS  = [4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4, 2];
const SHUTTER_SPEED_LBLS = ['4"', '2"', '1"', '1/2', '1/4', '1/8', '1/15', '1/30', '1/60', '1/125', '1/250', '1/500'];

function updateShutterRec() {
  const el = $('shutter-rec');
  if (captureMode === 'combined') {
    const settleMs = parseInt($('timing-settle').value) || 100;
    const flashMs  = parseInt($('timing-flash').value)  || 200;
    const steps    = SEQUENCES[activeSeq].length;
    const totalMs  = settleMs + steps * flashMs + 100;
    el.textContent = `Set camera to Bulb mode. Total exposure ≈ ${totalMs}ms (${(totalMs/1000).toFixed(2)}s)`;
    el.className = 'shutter-rec ok';
  } else {
    const delayMs = parseInt($('timing-delay').value) || 1000;
    const budget  = delayMs * 0.75;
    const idx = SHUTTER_SPEEDS_MS.findIndex(ms => ms <= budget);
    if (idx >= 0) {
      el.textContent = `Recommended camera shutter: ${SHUTTER_SPEED_LBLS[idx]}s or faster`;
      el.className = 'shutter-rec ok';
    } else {
      el.textContent = 'Post-shutter delay is very short — increase it or use Bulb mode';
      el.className = 'shutter-rec warn';
    }
  }
}

function setCaptureMode(mode) {
  captureMode = mode;
  document.querySelectorAll('.capture-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  document.querySelectorAll('.segregated-only').forEach(el => { el.hidden = mode !== 'segregated'; });
  document.querySelectorAll('.combined-only').forEach(el => { el.hidden = mode !== 'combined'; });
  updateShutterRec();
}

function updateVoltage(mv) {
  const label = $('voltage-display');
  label.textContent = (mv / 1000).toFixed(2) + 'V';
  label.className = 'info-card-value ' +
    (mv >= USB_VBUS_9V ? 'ok' : mv >= USB_VBUS_5V ? 'warn' : 'err');

  // Check power once at connect time using the first 3 readings, then never again
  if (voltageCheckDone) return;
  voltageHistory.push(mv);
  if (voltageHistory.length < 3) return;
  voltageCheckDone = true;

  const avg = voltageHistory.reduce((a, b) => a + b, 0) / voltageHistory.length;
  if (avg < USB_VBUS_9V) {
    const v = (avg / 1000).toFixed(2) + 'V';
    $('alert-power').innerHTML = `Power supply reads ${v} at connect time — full brightness requires 9V / 2A USB-C PD.`;
    $('alert-power').hidden = false;
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
    updateShutterRec();
  });
});

// Sequence run/stop/test
$('btn-run-seq').addEventListener('click', runSequence);
$('btn-stop-seq').addEventListener('click', () => { seqAbort = true; });
$('btn-test-shutter').addEventListener('click', sendShutter);
$('timing-delay').addEventListener('input', updateShutterRec);
$('timing-flash').addEventListener('input', updateShutterRec);
$('timing-settle').addEventListener('input', updateShutterRec);
document.querySelectorAll('.capture-mode-btn').forEach(btn =>
  btn.addEventListener('click', () => setCaptureMode(btn.dataset.mode))
);


// ── Init ──────────────────────────────────────────────────────────────────────
if (!('serial' in navigator)) {
  showError('Web Serial API not supported. Please open this page in Chrome or Edge on a desktop computer.');
}

renderPresets();
setLightConnected(false);
updateShutterRec();
