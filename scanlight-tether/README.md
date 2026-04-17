# Scanlight Tether

Big Scanlight controller + Capture One tethering in one browser tab.  
No install, no build step — just open `index.html` in Chrome or Edge.

---

## Requirements

| Item | Notes |
|---|---|
| Chrome or Edge (desktop) | Must be Chromium-based — Safari and Firefox don't support Web Serial |
| jackw01 Big Scanlight | Connected via USB-C to your computer |
| Canon EOS R | Connected via USB-C to your computer (separate port from the scanlight) |
| Capture One | Running with a session open and tethering enabled |
| 3.5mm → 2.5mm TRS cable | Connects the scanlight's shutter sync jack to the EOS R's remote port (same pinout as the Canon RS-60E3) |

---

## Setup (one time)

### 1 — Open the app
Double-click `index.html`, or drag it into a Chrome/Edge window.  
Bookmark it so you can find it again easily.

### 2 — Connect the Big Scanlight
1. Plug the scanlight into your Mac via USB-C.
2. Click **Connect USB Device** in the top-left of the app.
3. Chrome shows a port picker — select the scanlight (usually labelled something like "USB Serial").
4. The voltage reading and firmware version appear when it's connected.  
   If voltage shows orange/red, use a USB-C charger that supplies **9V / 2A** (the light's power brick, or a PD charger).

### 3 — Connect the shutter cable
Plug the 3.5mm → 2.5mm TRS cable between:
- The **3.5mm sync jack** on the Big Scanlight
- The **2.5mm remote port** on the Canon EOS R (left side of the camera body)

This lets the app trigger your shutter automatically during sequences.

### 4 — Set up Capture One tethering
1. Open Capture One and open (or create) a session: **File → New Session**.
2. Connect the Canon EOS R to your Mac via USB-C.
3. In Capture One go to **Camera → Enable Tethering** (or click the tether icon in the toolbar).
4. Shoot a test frame — it should appear in Capture One's viewer automatically.

### 5 — Open your session folder in the app
1. Click **Open Session Folder** in the app's right panel.
2. Navigate to your `.cosession` folder — typically at  
   `~/Pictures/YourSessionName.cosession`
3. You can select the session root **or** the `Captures/` subfolder inside it — the app detects it either way.
4. The app polls every 3 seconds. New photos appear as thumbnails as Capture One imports them.

---

## Day-to-day workflow

1. Open `index.html` in Chrome.
2. Click **Connect USB Device** → select the scanlight.
3. Open your Capture One session folder in the app.
4. Shoot manually using the sliders, or run an automated sequence:

| Sequence | What it does |
|---|---|
| **RGB** | Cycles Red → Green → Blue, triggering a shutter shot at each step |
| **RGBIR** | Same as RGB plus an infrared step |
| **NWIR** | Narrowband white → IR |
| **BWIR** | Broadband white → IR |

Adjust **Shutter Pulse**, **Post-Shutter Delay**, and **Pre-Capture Settle** timing if the camera misses frames (the EOS R needs ~100 ms to wake from sleep; 300 ms pulse + 1000 ms delay is a safe starting point).

---

## Tips

- **Presets** — dial in your favourite R/G/B levels and click **+ Save Current** to name and store them. They survive page reloads.
- **Trim** — use the L/R trim sliders to even out any brightness difference between the left and right halves of the light panel.
- **Set as Default** — stores the current channel levels into the scanlight's firmware so it powers on at those values even without the app.
- **Auto-poll** — uncheck the Auto-poll box if you want to scan the session folder manually (useful on slower drives).
- **RAW files** — CR3 files can't be previewed in the browser, but they're counted in the stats and shown as placeholder cards. The thumbnails are generated from any JPEGs Capture One writes alongside them.
