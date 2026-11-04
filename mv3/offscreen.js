let busy = false;
let needsReset = false;

async function recognizeImage(request) {
  if (!OCR_LANGUAGES.includes(request.language)) throw new Error('Unsupported OCR language.');
  if (typeof request.image !== 'string' || !request.image.startsWith('data:image/png;base64,')) {
    throw new Error('OCR requires a PNG data URL.');
  }

  let worker;
  let timer;
  let rejectWorker;
  const failed = new Promise((resolve, reject) => { rejectWorker = reject; });
  const operation = async () => {
    worker = await Tesseract.createWorker(request.language, 1, {
      workerPath: chrome.runtime.getURL('lib/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/tesseract-core'),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      workerBlobURL: false,
      logger: () => {},
      errorHandler: (error) => rejectWorker(new Error(String(error)))
    });
    const { data } = await worker.recognize(request.image, {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          const text = (line.text || '').trim();
          if (text && line.bbox) lines.push({ text, bbox: line.bbox });
        }
      }
    }
    return { text: (data.text || '').trim(), lines };
  };

  try {
    timer = setTimeout(() => rejectWorker(new Error('OCR timed out after 3 minutes. Check the language-model download and try again.')), 180000);
    return await Promise.race([operation(), failed]);
  } finally {
    clearTimeout(timer);
    if (worker) {
      await worker.terminate();
    } else {
      // Tesseract 5 may leave initialization pending after a model-load failure.
      needsReset = true;
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.target !== 'offscreen' || request.action !== 'run_ocr') return;
  if (busy || needsReset) {
    sendResponse({ ok: false, error: 'OCR is busy in another tab or resetting. Try again shortly.' });
    return;
  }
  busy = true;
  recognizeImage(request)
    .then((result) => sendResponse({ ok: true, ...result }), (error) => {
      console.error('[OCR]', error);
      sendResponse({ ok: false, error: 'OCR failed: ' + error.message });
    })
    .finally(() => {
      busy = false;
      if (needsReset) {
        chrome.runtime.sendMessage({ action: 'reset_ocr_host' }).then((response) => {
          if (!response || !response.ok) throw new Error(response && response.error || 'OCR host reset failed.');
        }).catch((error) => console.error('[OCR] Host reset failed:', error));
      }
    });
  return true;
});
