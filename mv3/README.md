# Image Text Translate - Manifest V3

This directory is a standalone, unpacked **Chrome/Edge MV3 extension**.
The original Firefox/MV2 extension in the parent directory is unchanged.
Firefox is not supported by this package: it does not implement Chromium's
background service-worker/offscreen-document combination.

## Install

1. Start LibreTranslate, for example:
   ```powershell
   docker run -p 5000:5000 ghcr.io/libretranslate/libretranslate
   ```
2. Open `chrome://extensions` or `edge://extensions` and enable Developer mode.
3. Choose **Load unpacked** and select **this `mv3` directory**, not its parent.
4. Refresh the webpage to inject the extension's content script.
5. Open the extension popup, configure the API URL, OCR language, and target
   language, then click **Translate Detected Text**.

The default translation URL is `http://127.0.0.1:5000/translate`. Other
HTTP/HTTPS LibreTranslate endpoints are supported. This separately installed
extension has separate settings from the original MV2 extension.

Chrome 116+ or a corresponding Chromium-based Edge version is required.
Browser-internal pages, extension stores, and non-HTTP/HTTPS documents are not
supported. Images smaller than the configured dimensions, larger than 8000
natural pixels on either axis, or inside links, buttons, or SVG are skipped.

## Architecture

- `config.js`: shared setting defaults and supported OCR languages.
- `content.js`: image discovery, canvas downscaling, pipeline, and DOM overlays.
- `service-worker.js`: settings, bounded image/translation fetches, offscreen
  host creation, popup routing, and per-tab progress in session storage.
- `offscreen.html` / `offscreen.js`: packaged Tesseract worker execution,
  returning JSON text and line bounding boxes.
- `popup/popup.html` / `popup.js`: settings, progress, and overlay removal.
- `lib/`: pinned Tesseract.js 5.1.1 and tesseract.js-core 5.1.1, including
  SIMD/non-SIMD and legacy/LSTM core variants and their licenses.

All executable JavaScript and WebAssembly are packaged locally. OCR is not
subject to the visited page's worker CSP. The extension CSP allows
`wasm-unsafe-eval`, not JavaScript `unsafe-eval`, and workers load directly from
extension URLs without Blob wrappers. No web-accessible resources are needed:
OCR assets are only consumed by the extension-owned offscreen document.

OCR language data is downloaded from
`https://tessdata.projectnaptha.com/4.0.0` on first use and cached by Tesseract in
the extension's IndexedDB. Internet access is required for an uncached language;
language models are data, not remotely hosted executable code. First use can
take longer. Images are processed locally; only extracted text is sent to the
configured translation service. Cross-origin source images are fetched by the
background with HTTP/HTTPS host permissions.

Each image is serialized as PNG for extension messaging, with a maximum canvas
dimension of 2048 pixels. The content script requests an offscreen host, then
messages that document directly for OCR so a slow OCR job does not depend on
holding the background service worker alive. Workers are terminated after each
image. A single offscreen document is reused and can remain open until the
extension/browser is closed. Concurrent OCR requests from another tab fail with
a visible busy message; retry when the first request finishes.

Network requests time out after 25 seconds; OCR times out after three minutes.
OCR/model/translation failures are reported in the popup, and the pipeline is
unlocked for retry. A failed worker initialization resets the offscreen host.
Progress survives closing/reopening the popup and background worker restarts
within the browser session. Navigation clears stored progress for that tab.
Settings changes take effect on the next translation run. Overlays track
scroll/resize and show original text on hover. **Remove Overlays** removes both
the elements and their registered layout handlers after processing finishes.

## Validation

Run the dependency-free automated checks from the repository root:

```powershell
node --test mv3\tests\mv3.test.js
```

For browser testing, reload the unpacked extension and refresh the target page:

1. Translate a same-origin image and a cross-origin image containing clear text.
2. Repeat on a page with restrictive script/worker CSP.
3. Confirm OCR text, translation boxes, hover behavior, scroll/resize alignment,
   and overlay removal.
4. Close/reopen the popup while processing; verify the active tab's progress.
5. Stop the background worker while idle, then translate again.
6. Try an unavailable translation service and an uncached model with networking
   blocked; verify a visible error and that retry works.
7. Check extension, offscreen, popup, and webpage consoles for errors.

The automated checks do not replace browser testing or confirm translation
quality. A running LibreTranslate service is needed to test real translations.

## Vendored dependencies

Official distribution sources:

- `https://registry.npmjs.org/tesseract.js/-/tesseract.js-5.1.1.tgz`
- `https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-5.1.1.tgz`

The worker and core paths are explicitly configured in `offscreen.js`; do not
remove those overrides, which would restore the library's executable CDN
defaults. Preserve `lib/TESSERACT-LICENSE.md`, the bundled
`*.LICENSE.txt` notices, and `lib/tesseract-core/LICENSE` when distributing.
No npm install, bundler, or build step is required.
