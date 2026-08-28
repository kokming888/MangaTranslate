# Project Continuation & Enhancement Handover

**Objective:** Continue development on the 'Manga Text Overlay' browser extension.

**Current Status:** v1.1 - All critical bugs fixed, architecture revised.

## Architecture

- Manifest V3, content-script-centric design
- OCR runs in content script (not service worker)
- Tesseract.js loaded via content_scripts entry in manifest
- Service worker = message router + config persistence
- Text overlays positioned on original images via DOM

## Key Decisions Made (v1.0 -> v1.1)

1. **No Blob transfer between contexts** — OCR moved to content script entirely
2. **Tesseract.js as content script** — loaded via manifest, no manual loading
3. **Real DOM overlay** — positioned `<div>` over image rect, not body notification
4. **Configurable settings** — API URL, OCR language, min dimensions
5. **Progress reporting** — real-time updates via `chrome.runtime.onMessage`

## To-Do / Enhancement Candidates

### High Priority
- [ ] Add source language auto-detection in Libretranslate (currently sends `source: "auto"`)
- [ ] Support additional output languages (not just English)
- [ ] Handle CORS images (option: fetch via service worker proxy)
- [ ] Batch translation endpoint (single API call for all texts vs. per-image)

### Medium Priority
- [ ] Undo/redo overlay removal
- [ ] Per-overlay opacity/color customization
- [ ] Save translation history (per-image) to storage
- [ ] Keyboard shortcut to trigger translation

### Low Priority
- [ ] Support additional OCR engines (Google Vision, AWS Textract)
- [ ] Dark mode for popup UI
- [ ] Export translations as text file
- [ ] Manga reader site-specific optimizations (mangadex, readmanga, etc.)

## Procedure for Continuing Work

1. **Acknowledge:** Confirm you want to continue the development cycle.
2. **Task Proposal:** State the enhancement feature or bug fix explicitly.
3. **Review:** Files have been refactored; see README.md for current architecture.

**Current files:**
- `manifest.json` — MV3 manifest (v1.1)
- `service-worker.js` — Message router
- `content.js` — Image detection, OCR, translation, DOM overlay
- `popup/popup.html` — Configurable popup UI
- `popup/popup.js` — Popup logic
- `lib/tesseract.min.js` — Tesseract.js v5

This handover document is ready for the next developer.
