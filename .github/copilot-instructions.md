# MangaTranslate Agent Instructions

## Project at a Glance

This repository is an unpacked browser extension for OCR and translation overlays on image-heavy web pages. It has no package manager, bundler, test runner, or build step. Edit the source files directly and validate by loading the extension in a browser.

`manifest.json` is the source of truth: the current extension is **Manifest V2**, despite older documentation referring to Manifest V3. Do not migrate manifest versions as part of unrelated work.

## Runtime Architecture

- `popup/popup.html` and `popup.js`: popup UI, persisted settings, and progress display.
- `service-worker.js`: background script that owns `chrome.storage.local`, routes popup requests to the active tab, and proxies translation and cross-origin image fetches.
- `content.js`: discovers eligible images, renders canvases, runs Tesseract OCR, calls the background translation proxy, and manages positioned page overlays.
- `lib/tesseract.min.js`: vendored browser dependency. Do not edit it manually.

The main message flow is:

```text
popup -> service-worker -> content script -> service-worker proxy -> LibreTranslate
content script -> popup (pipeline progress and result)
```

Keep request action names and payload shapes aligned across both senders and receivers. Existing actions include `start_translation`, `get_config`, `update_config`, `remove_overlays`, `translate_proxy`, `fetch_image`, `pipeline_progress`, and `pipeline_result`.

## Implementation Rules

- Keep OCR, canvas work, DOM inspection, and overlay placement in `content.js`; they require page-level image and layout access.
- Keep privileged cross-origin fetches and storage access in `service-worker.js`. Content-script translation and image fetches deliberately use the background proxy to avoid page CORS and mixed-content restrictions.
- Preserve asynchronous message handling: a listener that responds after asynchronous work must return `true`.
- Treat every user setting as a shared contract. When adding a setting, update defaults in `popup.js` and `content.js`, popup controls, persistence, and any background install defaults or migrations.
- Overlays register scroll and resize handlers. Any overlay removal path must also remove its handlers through `removeAllOverlays()`.
- Favor narrow fixes. Do not reformat vendored code or introduce a build system unless the task specifically requires it.

## Local Development and Validation

1. Start LibreTranslate, for example:
   ```powershell
   docker run -p 5000:5000 ghcr.io/libretranslate/libretranslate
   ```
2. Load this repository directory as an unpacked extension in Firefox. The manifest currently includes Firefox-specific settings. Chrome/Edge compatibility must be verified separately.
3. After changing scripts or the manifest, reload the extension and refresh the target webpage so its content script is reinjected.
4. Test a same-origin and a cross-origin image at or above the configured dimensions. Confirm OCR progress, a translation overlay, hover-to-show-original behavior, and overlay cleanup.
5. Inspect the popup, background, and page consoles for errors. For JavaScript-only changes, run `node --check <changed-file>` when Node.js is available. For manifest changes, parse `manifest.json` before browser testing.

## External Dependencies and Constraints

- LibreTranslate defaults to `http://127.0.0.1:5000/translate` and accepts a `POST` body with `q`, `source`, and `target`.
- Tesseract language data may download on first use and can be blocked by restrictive page CSPs.
- Images may be rejected because of dimensions, unsupported context (`button`, `a`, or `svg`), oversized natural dimensions, CORS, or canvas tainting.
- The host permissions are intentionally broad to support page images and the configured local translation service. Review permission changes carefully.

## Documentation Maintenance

If behavior changes, update the closest relevant README or handover section. Correct the MV2/MV3 inconsistency when touching those documents: `README.md` reflects the current manifest more accurately than `README-Technical.md` and `handover.md`.