# Manga Text Overlay - Quick Start

## What it does
Extracts text from images on web pages (manga panels, signs, etc.) and overlays translations directly on the images.

## How it works
1. User clicks "Translate Detected Text" in the popup
2. Content script finds all large `<img>` elements (skips tiny icons, nav, etc.)
3. Each image is rendered to a canvas and passed to Tesseract.js for OCR
4. Extracted text is sent to the Libretranslate API
5. Translated text is overlaid as a positioned `<div>` over the original image
6. Hover the overlay to see the original text, leave to see the translation

## Prerequisites
- Libretranslate running (default: `http://127.0.0.1:5000`)
- Tesseract.js v5 loaded (included as `lib/tesseract.min.js`)

## Quick Install
1. Load `MangaTranslate` as an unpacked extension in Firefox (Chrome and Edge support at later time)
2. Click the extension icon → ⚙ Settings → configure API URL and OCR language
3. Navigate to a page with text images
4. Click "Translate Detected Text"

## File Summary
- `manifest.json` - MV2 manifest, content_scripts includes Tesseract
- `service-worker.js` - Message router + config persistence
- `content.js` - Image detection, OCR, translation, DOM overlay
- `popup/popup.html` - Configurable popup UI
- `popup/popup.js` - Popup logic with progress reporting
- `lib/tesseract.min.js` - Tesseract.js v5
