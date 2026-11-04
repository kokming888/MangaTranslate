importScripts('config.js');

const FETCH_TIMEOUT_MS = 25000;
let offscreenOperation = Promise.resolve();

function updateOffscreen(operation) {
  const pending = offscreenOperation.then(operation);
  offscreenOperation = pending.catch((error) => {
    console.error('[Background] Offscreen operation failed:', error);
  });
  return pending;
}

function ensureOffscreen() {
  return updateOffscreen(async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run packaged Tesseract OCR workers outside the visited page.'
      });
    }
  });
}

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }
  return url.href;
}

async function fetchWithTimeout(url, options, readBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(httpUrl(url), { ...options, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error('HTTP ' + response.status + ': ' + text.slice(0, 200));
    }
    return await readBody(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Request timed out after 25 seconds. Check the image server or LibreTranslate.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') throw new Error('No active tab.');
  return tab;
}

async function sendToTab(message) {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    throw new Error('Cannot reach this page. Refresh a normal HTTP/HTTPS webpage after loading the extension. ' + error.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    const stored = await chrome.storage.local.get(null);
    const config = { ...DEFAULT_CONFIG, ...stored };
    if (/^http:\/\/(?:127\.0\.0\.1|localhost):5000\/?$/.test(config.libretranslateUrl)) {
      config.libretranslateUrl = DEFAULT_CONFIG.libretranslateUrl;
    }
    await chrome.storage.local.set(config);
  })().catch((error) => console.error('[Background] Configuration initialization failed:', error));
});

async function handleMessage(request, sender) {
  switch (request.action) {
    case 'start_translation':
    case 'remove_overlays':
      return sendToTab({ action: request.action });
    case 'get_config':
      return chrome.storage.local.get(DEFAULT_CONFIG);
    case 'update_config': {
      const config = request.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Invalid settings.');
      }
      const allowed = Object.fromEntries(
        Object.keys(DEFAULT_CONFIG).filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]])
      );
      if (Object.hasOwn(allowed, 'libretranslateUrl')) httpUrl(allowed.libretranslateUrl);
      if (Object.hasOwn(allowed, 'ocrLanguage') && !OCR_LANGUAGES.includes(allowed.ocrLanguage)) {
        throw new Error('Unsupported OCR language.');
      }
      for (const key of ['minImageWidth', 'minImageHeight']) {
        if (Object.hasOwn(allowed, key) && (!Number.isInteger(allowed[key]) || allowed[key] < 50 || allowed[key] > 2048)) {
          throw new Error('Image dimensions must be whole numbers between 50 and 2048.');
        }
      }
      await chrome.storage.local.set(allowed);
      return { status: 'ok' };
    }
    case 'ensure_ocr_host':
      await ensureOffscreen();
      return { ok: true };
    case 'reset_ocr_host':
      if (sender.url !== chrome.runtime.getURL('offscreen.html')) {
        throw new Error('Only the OCR host can request a reset.');
      }
      await updateOffscreen(() => chrome.offscreen.closeDocument());
      return { ok: true };
    case 'translate_proxy':
      return fetchWithTimeout(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body)
      }, async (response) => {
        const data = await response.json();
        const translated = data.translatedText || data.translation || data.result || data.translated;
        if (typeof translated !== 'string' || !translated.trim()) {
          throw new Error('LibreTranslate returned no translated text.');
        }
        return { ok: true, translated: translated.trim() };
      });
    case 'fetch_image':
      return fetchWithTimeout(request.url, {}, async (response) => {
        const mime = (response.headers.get('content-type') || 'image/png').split(';')[0];
        if (!mime.startsWith('image/')) throw new Error('The image server did not return an image.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return { ok: true, dataUrl: 'data:' + mime + ';base64,' + btoa(binary) };
      });
    case 'pipeline_progress':
    case 'pipeline_result':
      if (!sender.tab || typeof sender.tab.id !== 'number') throw new Error('Pipeline updates require a tab.');
      await chrome.storage.session.set({ ['pipeline:' + sender.tab.id]: request });
      return { ok: true };
    case 'get_pipeline_state': {
      const tab = await activeTab();
      const key = 'pipeline:' + tab.id;
      const stored = await chrome.storage.session.get(key);
      return { ok: true, tabId: tab.id, state: stored[key] || null };
    }
    default:
      throw new Error('Unknown background action: ' + request.action);
  }
}

const BACKGROUND_ACTIONS = new Set([
  'start_translation', 'remove_overlays', 'get_config', 'update_config',
  'ensure_ocr_host', 'reset_ocr_host', 'translate_proxy', 'fetch_image',
  'pipeline_progress', 'pipeline_result', 'get_pipeline_state'
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.target === 'offscreen' || !BACKGROUND_ACTIONS.has(request.action)) return;
  handleMessage(request, sender).then(sendResponse, (error) => {
    console.error('[Background]', request.action, error);
    sendResponse({ ok: false, status: 'error', error: error.message, message: error.message });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('pipeline:' + tabId)
    .catch((error) => console.error('[Background] Failed to clear tab progress:', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.session.remove('pipeline:' + tabId)
      .catch((error) => console.error('[Background] Failed to reset page progress:', error));
  }
});
