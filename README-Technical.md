# Manga Text Overlay - Extension

A Manifest V3 browser extension that extracts text from images on web pages (manga panels, signs, etc.), runs OCR + translation, and overlays the translated text on the page.

## Architecture

```
Popup (UI + Config)
    |
    v
Service Worker (config persistence, message routing)
    |
    v
Content Script (in-page)
    ├── Tesseract.js (OCR, loaded via content_scripts)
    ├── Libretranslate API (translation, user-configurable URL)
    └── DOM Overlay (translates text appears on original image)
```

## Key Design Decisions

- **OCR runs in the content script, not the service worker.** This avoids the MV3 limitation where Blobs cannot be serialized across service worker boundaries.
- **Tesseract.js loaded as a content script** via manifest `"content_scripts"` field — no manual loading needed.
- **Text overlay appears directly on the image** (positioned via `position: fixed` over the original image rect), not appended to `<body>` as a separate notification. Hover to toggle between translated/original text.
- **Image filtering** skips images smaller than configurable thresholds and images inside `<button>`, `<a>`, or `<svg>` elements.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest with content_scripts for Tesseract |
| `service-worker.js` | Message routing, config persistence |
| `content.js` | Image detection, OCR, translation, DOM overlay |
| `popup/popup.html` | Popup UI with config panel |
| `popup/popup.js` | Popup logic, progress reporting |
| `lib/tesseract.min.js` | Tesseract.js v5 library (loaded via CDN, included locally) |
| `icon/` | Extension icons (16, 48, 128) |

## Installation (Local Dev)

1. Open Chrome/Edge and go to `chrome://extensions/` (or `edge://extensions/`)
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `MangaTranslate` folder
4. The extension should appear with its icon

## Configuration

Click the extension icon to open the popup. At the bottom is a "⚙ Settings" section:

- **API URL**: Libretranslate endpoint (default: `http://127.0.0.1:5000`)
- **OCR Language**: Source language for OCR (Japanese, Korean, Chinese, English, etc.)
- **Min Width/Height**: Minimum image dimensions to consider translatable

Settings persist in `chrome.storage.local`.

## Usage

1. Navigate to a page with images containing text (manga reader, sign photos, etc.)
2. Click the extension icon
3. Click "Translate Detected Text"
4. Watch progress in the popup status area
5. Translated text appears as an overlay on each image
6. Hover over the overlay to see the original text

## Libretranslate Setup

The extension expects a Libretranslate instance running at `http://127.0.0.1:5000` by default. To set up:

```bash
docker run -p 5000:5000 ghcr.io/libretranslate/libretranslate
```

Or any other Libretranslate-compatible API endpoint.

## Known Limitations

- Images with heavy stylized text, watermarks, or complex layouts may have lower OCR accuracy
- Cross-origin images (CORS-restricted) may not render to canvas properly
- Very large images are scaled down to 2048px to prevent memory issues
- Tesseract.js loads ~40MB of data on first use per language
