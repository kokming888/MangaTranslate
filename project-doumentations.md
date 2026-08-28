# Project Documentation: Manga Text Overlay
## Version 1.1 (Fixed)
**Updated:** 2026-05-28

---

## Executive Summary

**Product Goal:** Extract text from images on web pages (manga panels, signs, etc.), translate it to English, and overlay the translated text directly on the original images.

---

## Architecture Overview (v1.1)

The extension uses a **content-script-centric** architecture. All heavy lifting (OCR, image processing) happens in the content script running in the page context. The service worker is simplified to message routing and config persistence.

### Data Flow
```
Popup (UI + Config)
  -> sendMessage({ action: "start_translation" })
  -> Service Worker (routes message to active tab)
  -> Content Script (in-page)
     -> findTranslatableImages()  [filters by size/context]
     -> runOCR(canvas)            [Tesseract.js]
     -> translateText(text, url)  [Libretranslate API]
     -> createTextOverlay()       [DOM overlay positioned on image]
  -> sendMessage({ action: "pipeline_result" })
  -> Popup (status display)
```

### Component Roles

| Component | Role | Key File |
|-----------|------|----------|
| Popup UI | User input + config + progress display | `popup/popup.html` |
| Popup Script | Config management, pipeline trigger, progress reporting | `popup/popup.js` |
| Service Worker | Message routing, config persistence in storage | `service-worker.js` |
| Content Script | Image detection, OCR, translation, DOM overlay | `content.js` |
| Tesseract.js | OCR engine (loaded via content_scripts) | `lib/tesseract.min.js` |

---

## Key Fixes (v1.0 -> v1.1)

1. **Fixed manifest.json:** Removed invalid JSON comment in `permissions` array
2. **Added content_scripts entry:** Tesseract.js is now loaded via manifest, not manually
3. **Moved OCR from service worker to content script:** Avoids MV3 Blob serialization bug
4. **Fixed async timing bug:** `findImagesAndSendBlobs` no longer returns before canvas rendering completes (entire pipeline is async in content script)
5. **Real DOM overlay:** Text appears positioned over the original image, not appended as a body notification
6. **Image filtering:** Skips small images (<150px), images in `<button>`, `<a>`, `<svg>` contexts
7. **Configurable settings:** API URL, OCR language, min dimensions via popup UI
8. **Progress reporting:** Real-time progress bar in popup during pipeline execution
9. **Proper error handling:** Status messages for every failure mode (no images, API errors, etc.)

---

## Configuration

All settings persist in `chrome.storage.local`:

| Setting | Default | Description |
|---------|---------|-------------|
| libretranslateUrl | `http://127.0.0.1:5000` | Translation API endpoint |
| ocrLanguage | `eng` | Source language for OCR |
| minImageWidth | `150` | Minimum image width to consider |
| minImageHeight | `100` | Minimum image height to consider |

---

## Installation

1. Load as unpacked extension in Chrome/Edge
2. Ensure Libretranslate is running at configured URL
3. Click extension icon -> configure settings
4. Navigate to target page -> click "Translate Detected Text"

---

## Known Limitations

- Tesseract.js loads ~40MB on first OCR per language
- Cross-origin (CORS) images may not render to canvas
- Large images scaled to 2048px max dimension
- Libretranslate must be self-hosted (no cloud API option in current version)
