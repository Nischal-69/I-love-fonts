# I Love Fonts – Font Finder

Identify any font on any website.

A lightweight Chrome extension (Manifest V3, no dependencies) to inspect typography in-place: hover for instant name, click for full details + copyable CSS.

## Features

- **Activate mode** from popup with crosshair + badge indicator
- **Instant hover tooltip:** primary family + weight / size, no click needed
- **Click for detail card:** preview, Declared vs Detected stack, Font Status
- **Accurate detection:**
  - `getComputedStyle()` for declared stack (handles inheritance)
  - Font Loading API (`document.fonts`) to verify Loaded vs Fallback
  - Never guesses — unverifiable cases labeled `Fallback` / `Not checked`
- **Full specs:** family, weight (e.g. 700 / Bold), size, style, line-height, letter-spacing, text-transform, color (+ hex swatch)
- **Copy buttons:** Copy Font, Copy CSS (8-property snippet)
- **History:** last 20 inspections in `chrome.storage.local` with hostname + timestamp, deduped, selectable, clearable
- **Non-destructive:** fixed overlays only, no layout shift, `Esc` to exit

## How it works

1. Click extension icon → **Activate Font Finder**
2. Hover over text on a webpage
3. Click to pin the detail card

Popup closes on activate — inspection happens entirely on the page.

## Install (Load unpacked)

1. Clone this repo:
   ```bash
   git clone https://github.com/Nischal-69/i-love-fonts.git
   ```
2. Go to `chrome://extensions/` → enable **Developer mode**
3. Click **Load unpacked** → select the `i-love-fonts` folder
4. Pin **I Love Fonts** to toolbar

Requires Chrome 88+.

## Usage notes

- Works on regular `http(s)` sites.
- Blocked by Chrome on restricted pages: `chrome://`, `edge://`, Chrome Web Store, `about:blank`. Popup will show `Cannot activate here`.
- If tab was open before install, popup auto-injects `content.js` / `content.css`.

## Project structure

```
manifest.json     # MV3 manifest (activeTab, scripting, storage)
popup.html/css/js # popup UI, activation, history list
content.js/css    # selection mode, hover tooltip, detail card
background.js     # service worker, init storage
icons/            # 16, 32, 48, 128
```

## Permissions

- `activeTab` – inspect current tab only when activated
- `scripting` – inject finder into pre-install tabs
- `storage` – save recent fonts locally

No network calls, no tracking. Hostname only is stored, never URLs or page contents.

## Version

v0.1.0
