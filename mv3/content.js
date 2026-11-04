// Image Text Translate - Content Script
// Handles image detection, canvas rendering, OCR messaging, and DOM overlays.
// Runs in the content-script isolated world; OCR runs in the offscreen document.

console.log("[Content Script] Image Text Translate initialized.");

let currentConfig = { ...DEFAULT_CONFIG };
let pipelineState = null;

async function backgroundRequest(request) {
  const response = await chrome.runtime.sendMessage(request);
  if (!response || response.ok === false || response.status === 'error') {
    throw new Error(response && (response.error || response.message) || 'The extension did not respond.');
  }
  return response;
}

async function reportPipeline(state) {
  pipelineState = state;
  await backgroundRequest(state);
}

// Track all created overlay elements for cleanup
const overlayRegistry = [];

// ===== Image detection =====

function needsProxy(img) {
  const src = img.currentSrc || img.src || '';
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
  try {
    return new URL(src).origin !== location.origin;
  } catch (e) {
    return true;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Image load failed'));
    im.src = src;
  });
}

function fetchImageViaBackground(url) {
  return backgroundRequest({ action: 'fetch_image', url }).then((response) => response.dataUrl);
}

async function findTranslatableImages() {
  const images = document.querySelectorAll('img');
  const candidates = [];
  const seen = [];

  images.forEach((img, index) => {
    if (img.naturalWidth < currentConfig.minImageWidth ||
        img.naturalHeight < currentConfig.minImageHeight) {
      return;
    }

    const rect = img.getBoundingClientRect();
    if (rect.width < currentConfig.minImageWidth ||
        rect.height < currentConfig.minImageHeight) {
      return;
    }

    if (img.closest('svg') || img.closest('button') || img.closest('a')) {
      return;
    }

    if (img.naturalWidth > 8000 || img.naturalHeight > 8000) {
      return;
    }

    seen.push({ img: img, rect: rect, index: index });
  });

  for (let i = 0; i < seen.length; i++) {
    const item = seen[i];
    const img = item.img;
    let sourceImg = img;

    // Cross-origin images taint the canvas -> fetch via background proxy
    // so we can draw an untainted data-URL copy for OCR.
    if (needsProxy(img)) {
      try {
        console.log('[Content Script] Cross-origin image, fetching via proxy:',
          (img.currentSrc || img.src).substring(0, 80));
        const dataUrl = await fetchImageViaBackground(img.currentSrc || img.src);
        sourceImg = await loadImage(dataUrl);
      } catch (e) {
        console.warn('[Content Script] Proxy fetch failed, trying direct draw:', e.message);
        sourceImg = img;
      }
    }

    const canvas = renderImageToCanvas(sourceImg);
    if (!canvas) continue;

    const container = findClippingContainer(img);

    candidates.push({
      img: img,
      canvas: canvas,
      rect: item.rect,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      index: item.index,
      selector: img.id ? '#' + img.id :
                (img.className ? '.' + img.className.split(/\s+/).join('.') : null) || ('img[data-idx-' + item.index + ']'),
      container: container,
      refNode: img.nextSibling
    });
  }

  console.log('[Content Script] Found ' + candidates.length + ' translatable images.');
  return candidates;
}

function findClippingContainer(img) {
  let node = img.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
      return node;
    }
    if (style.position !== 'static' && style.position !== '') {
      return node;
    }
    node = node.parentElement;
  }
  return document.body;
}

function renderImageToCanvas(img) {
  const canvas = document.createElement('canvas');
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  if (w === 0 || h === 0) return null;

  const maxDimension = 2048;
  let scale = 1;
  if (w > maxDimension || h > maxDimension) {
    scale = Math.min(maxDimension / w, maxDimension / h);
  }
  canvas.width = Math.floor(w * scale);
  canvas.height = Math.floor(h * scale);

  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (e) {
    console.warn('[Content Script] Tainted canvas - CORS issue on image:', img.src ? img.src.substring(0, 80) : '(unknown)', e.message);
    return null;
  }
}

// ===== OCR (returns full text + per-line bounding boxes) =====

async function runOCR(canvas) {
  const image = canvas.toDataURL('image/png');
  await backgroundRequest({ action: 'ensure_ocr_host' });
  return backgroundRequest({
    target: 'offscreen',
    action: 'run_ocr',
    image,
    language: currentConfig.ocrLanguage
  });
}

// ===== Translation =====

async function translateText(text, url, target) {
  if (!text || text.trim() === '') return null;

  const response = await backgroundRequest({
    action: 'translate_proxy',
    url,
    body: { q: text, source: 'auto', target: target || 'en' }
  });
  return response.translated;
}

// ===== DOM Overlay (in-place: one box per OCR text line) =====

function createInPlaceOverlay(candidate, linePairs, canvasWidth, canvasHeight) {
  const img = candidate.img;

  const layer = document.createElement('div');
  layer.setAttribute('data-manga-translate', 'true');
  layer.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;margin:0;padding:0;';
  document.body.appendChild(layer);

  const boxes = [];

  linePairs.forEach((pair) => {
    if (!pair.translated) return;

    const bw = pair.bbox.x1 - pair.bbox.x0;
    const bh = pair.bbox.y1 - pair.bbox.y0;
    if (bw <= 0 || bh <= 0) return;

    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;' +
      'left:'   + ((pair.bbox.x0 / canvasWidth)  * 100) + '%;' +
      'top:'    + ((pair.bbox.y0 / canvasHeight) * 100) + '%;' +
      'width:'  + ((bw / canvasWidth)  * 100) + '%;' +
      'min-height:' + ((bh / canvasHeight) * 100) + '%;' +
      'background:' + currentConfig.bgColor + ';' +
      'color:' + currentConfig.textColor + ';' +
      'font-family:' + currentConfig.fontStack + ';' +
      'display:flex;align-items:center;justify-content:center;text-align:center;' +
      'white-space:normal;word-break:break-word;line-height:1.15;' +
      'overflow:hidden;border-radius:2px;pointer-events:auto;cursor:default;';

    const translatedSpan = document.createElement('span');
    translatedSpan.textContent = pair.translated;
    translatedSpan.style.cssText = 'font-weight:bold;width:100%;';

    const originalSpan = document.createElement('span');
    originalSpan.textContent = pair.original;
    originalSpan.style.cssText = 'display:none;color:#bbb;font-weight:normal;width:100%;';

    box.addEventListener('mouseenter', () => {
      translatedSpan.style.display = 'none';
      originalSpan.style.display = 'inline';
    });
    box.addEventListener('mouseleave', () => {
      originalSpan.style.display = 'none';
      translatedSpan.style.display = 'inline';
    });

    box.appendChild(translatedSpan);
    box.appendChild(originalSpan);
    layer.appendChild(box);

    boxes.push({ el: box, heightFrac: bh / canvasHeight });
  });

  if (boxes.length === 0) {
    layer.remove();
    return null;
  }

  // Position layer over the image; rescale fonts on scroll/resize
  const reposition = () => {
    if (!document.body.contains(layer)) return;
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;

    layer.style.left = r.left + 'px';
    layer.style.top = r.top + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';

    boxes.forEach((b) => {
      b.el.style.fontSize = Math.max(9, Math.round(b.heightFrac * r.height * 0.78)) + 'px';
    });
  };

  reposition(); // initial placement
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition, { passive: true });

  overlayRegistry.push({ el: layer, repositionFn: reposition });
  console.log('[Overlay] In-place boxes:', boxes.length);
  return layer;
}

// Fallback: single block below the image (used when no line boxes available)
function createTextOverlay(translatedText, originalText, candidate) {
  const img = candidate.img;
  const fontSize = Math.max(12, Math.min(20, candidate.rect.width / 40));

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-manga-translate', 'true');
  overlayRegistry.push(wrapper);

  wrapper.style.cssText = 'position:fixed;z-index:2147483646;' +
    'pointer-events:none;bottom:0;left:50%;transform:translateX(-50%);' +
    'font-size:' + fontSize + 'px;width:max-content;' +
    'max-width:' + (candidate.rect.width * 0.95) + 'px;';
  document.body.appendChild(wrapper);

  const reposition = () => {
    if (!document.body.contains(wrapper)) return;
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    wrapper.style.left = (r.left + r.width / 2) + 'px';
    wrapper.style.bottom = (window.innerHeight - r.bottom - r.height * 0.02) + 'px';
  };

  reposition();
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition, { passive: true });
  overlayRegistry[overlayRegistry.indexOf(wrapper)] = { el: wrapper, repositionFn: reposition };

  const textBlock = document.createElement('div');
  textBlock.style.cssText = 'background:' + currentConfig.bgColor + ';' +
    'color:' + currentConfig.textColor + ';' +
    'padding:4px 8px;border-radius:3px;font-family:' + currentConfig.fontStack + ';' +
    'text-align:center;white-space:pre-wrap;word-break:break-word;line-height:1.3;pointer-events:auto;';

  const translatedLine = document.createElement('div');
  translatedLine.textContent = translatedText;
  translatedLine.style.cssText = 'font-weight:bold;';

  const originalLine = document.createElement('div');
  originalLine.textContent = originalText;
  originalLine.style.cssText = 'font-size:' + (fontSize * 0.75) + 'px;color:#aaa;display:none;';

  textBlock.addEventListener('mouseenter', () => {
    originalLine.style.display = 'block';
    translatedLine.style.display = 'none';
  });
  textBlock.addEventListener('mouseleave', () => {
    originalLine.style.display = 'none';
    translatedLine.style.display = 'block';
  });

  textBlock.appendChild(translatedLine);
  textBlock.appendChild(originalLine);
  wrapper.appendChild(textBlock);

  return wrapper;
}

function removeAllOverlays() {
  const overlays = document.querySelectorAll('[data-manga-translate]');
  overlays.forEach(el => el.remove());

  for (let i = 0; i < overlayRegistry.length; i++) {
    const entry = overlayRegistry[i];
    if (entry && typeof entry === 'object' && entry.repositionFn) {
      window.removeEventListener('scroll', entry.repositionFn);
      window.removeEventListener('resize', entry.repositionFn);
    }
  }
  overlayRegistry.length = 0;
}

// ===== Main Processing Pipeline =====

let isProcessing = false;

async function startTranslation() {
  if (isProcessing) {
    console.log('[Pipeline] Already processing, ignoring duplicate request.');
    return;
  }
  isProcessing = true;

  try {
    currentConfig = await backgroundRequest({ action: 'get_config' });
    await reportPipeline({ action: 'pipeline_progress', done: 0, total: 0, type: 'initializing' });
    const candidates = await findTranslatableImages();
    if (candidates.length === 0) {
      await reportPipeline({ action: 'pipeline_result', status: 'no_images' });
      return;
    }

    const ocrResults = [];
    for (let i = 0; i < candidates.length; i++) {
      await reportPipeline({ action: 'pipeline_progress', done: i + 1, total: candidates.length, type: 'ocr' });
      const ocr = await runOCR(candidates[i].canvas);
      ocrResults.push({ candidate: candidates[i], ocr });
      await reportPipeline({
        action: 'pipeline_progress', done: i + 1, total: candidates.length,
        type: ocr.text ? 'ocr_done' : 'ocr_empty'
      });
    }

    removeAllOverlays();
    let overlayCount = 0;
    let translatedTotal = 0;

    for (let i = 0; i < ocrResults.length; i++) {
      const { candidate, ocr } = ocrResults[i];
      if (!ocr.text) continue;
      await reportPipeline({ action: 'pipeline_progress', done: i + 1, total: ocrResults.length, type: 'translate' });

      if (ocr.lines.length > 0) {
        const linePairs = [];
        for (const line of ocr.lines) {
          const translated = await translateText(line.text, currentConfig.libretranslateUrl, currentConfig.targetLanguage);
          linePairs.push({ original: line.text, translated, bbox: line.bbox });
          translatedTotal++;
        }
        const layer = createInPlaceOverlay(candidate, linePairs, candidate.canvas.width, candidate.canvas.height);
        if (layer) overlayCount++;
      } else {
        const translated = await translateText(ocr.text, currentConfig.libretranslateUrl, currentConfig.targetLanguage);
        createTextOverlay(translated, ocr.text, candidate);
        translatedTotal++;
        overlayCount++;
      }
      await reportPipeline({ action: 'pipeline_progress', status: 'progress', done: i + 1, total: ocrResults.length, type: 'translate_done' });
    }

    await reportPipeline({
      action: 'pipeline_result',
      status: 'complete',
      total: candidates.length,
      withText: ocrResults.filter((result) => result.ocr.text).length,
      withTranslation: translatedTotal,
      overlays: overlayCount
    });
  } catch (error) {
    console.error('[Pipeline] Failed:', error);
    await reportPipeline({ action: 'pipeline_result', status: 'error', message: error.message });
  } finally {
    isProcessing = false;
  }
}

// ===== Message Handlers =====

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'start_translation') {
    if (isProcessing) {
      sendResponse({ status: 'started' });
      return;
    }
    startTranslation().catch((error) => console.error('[Pipeline] Could not report failure:', error));
    sendResponse({ status: 'started' });
    return;
  }

  if (request.action === 'get_pipeline_state') {
    sendResponse({ ok: true, state: pipelineState });
    return;
  }

  if (request.action === 'remove_overlays') {
    if (isProcessing) {
      sendResponse({ status: 'error', message: 'Wait for translation to finish before removing overlays.' });
      return;
    }
    removeAllOverlays();
    reportPipeline({ action: 'pipeline_result', status: 'removed' }).then(() => {
      sendResponse({ status: 'ok' });
    }, (error) => {
      console.error('[Pipeline] Could not report overlay removal:', error);
      sendResponse({ status: 'error', message: error.message });
    });
    return true;
  }
});
