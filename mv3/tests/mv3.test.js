const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
  const events = {};
  const errors = [];
  const messages = [];
  const storage = {};
  const session = {};
  const event = (name) => ({ addListener: (listener) => { events[name] = listener; } });
  const area = (values) => ({
    async get(keys) {
      if (keys === null) return { ...values };
      if (typeof keys === 'string') return { [keys]: values[keys] };
      return { ...keys, ...values };
    },
    async set(items) { Object.assign(values, items); },
    async remove(key) { delete values[key]; }
  });
  const chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (file) => 'chrome-extension://test-extension/' + file,
      getContexts: async () => [],
      onInstalled: event('installed'),
      onMessage: event('message'),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; }
    },
    storage: { local: area(storage), session: area(session) },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async () => ({ status: 'started' }),
      onRemoved: event('removed'),
      onUpdated: event('updated')
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} }
  };
  const context = vm.createContext({
    chrome, URL, AbortController, setTimeout, clearTimeout, Uint8Array, btoa,
    fetch: async () => new Response('{"translatedText":"Hello"}'),
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    ...overrides
  });
  const run = (file) => vm.runInContext(read(file), context, { filename: file });
  context.importScripts = (...files) => files.filter((file) => file !== 'config.js').forEach(run);
  run('config.js');
  const dispatch = (request, sender = { tab: { id: 7 } }) => new Promise((resolve) => {
    const async = events.message(request, sender, resolve);
    if (async !== true) resolve(undefined);
  });
  return { context, chrome, events, errors, messages, storage, session, run, dispatch };
}

test('manifest references only packaged files and permits local WASM workers', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.ok(!manifest.background.scripts);
  assert.match(manifest.content_security_policy.extension_pages, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /'unsafe-eval'|https?:|blob:/);
  const files = [
    manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((entry) => entry.js)
  ];
  for (const html of [manifest.action.default_popup, 'offscreen.html']) {
    for (const [, src] of read(html).matchAll(/<script src="([^"]+)"/g)) {
      files.push(path.join(path.dirname(html), src));
    }
  }
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), file);
  for (const variant of ['', '-simd', '-lstm', '-simd-lstm']) {
    const prefix = 'lib/tesseract-core/tesseract-core' + variant;
    assert.ok(fs.statSync(path.join(root, prefix + '.wasm.js')).size > 10000);
    assert.equal(fs.readFileSync(path.join(root, prefix + '.wasm')).subarray(0, 4).toString('hex'), '0061736d');
  }
  for (const file of ['lib/worker.min.js', 'lib/TESSERACT-LICENSE.md', 'lib/worker.min.js.LICENSE.txt', 'lib/tesseract.min.js.LICENSE.txt', 'lib/tesseract-core/LICENSE']) {
    assert.ok(fs.statSync(path.join(root, file)).size > 0);
  }
});

test('installation merges defaults without overwriting custom settings', async () => {
  const h = harness();
  h.storage.libretranslateUrl = 'https://translate.example/custom';
  h.storage.targetLanguage = 'ja';
  h.run('service-worker.js');
  h.events.installed({ reason: 'update' });
  await tick();
  assert.equal(h.storage.libretranslateUrl, 'https://translate.example/custom');
  assert.equal(h.storage.targetLanguage, 'ja');
  assert.equal(h.storage.minImageWidth, 150);
});

test('offscreen creation is serialized and reuses an existing host after worker restart', async () => {
  const h = harness();
  let created = 0;
  h.chrome.runtime.getContexts = async () => created ? [{}] : [];
  h.chrome.offscreen.createDocument = async (options) => {
    assert.equal(options.url, 'offscreen.html');
    assert.deepEqual(plain(options.reasons), ['WORKERS']);
    await tick();
    created++;
  };
  h.run('service-worker.js');
  await Promise.all([h.dispatch({ action: 'ensure_ocr_host' }), h.dispatch({ action: 'ensure_ocr_host' })]);
  assert.equal(created, 1);
  const restarted = harness();
  restarted.chrome.runtime.getContexts = async () => [{}];
  restarted.chrome.offscreen.createDocument = async () => assert.fail('Host was duplicated');
  restarted.run('service-worker.js');
  assert.equal((await restarted.dispatch({ action: 'ensure_ocr_host' })).ok, true);
});

test('translation proxy returns text and explicitly rejects malformed responses and unsupported URLs', async () => {
  const h = harness();
  h.run('service-worker.js');
  const request = { action: 'translate_proxy', url: 'http://127.0.0.1:5000/translate', body: { q: 'hi', source: 'auto', target: 'ja' } };
  let options;
  h.context.fetch = async (url, opts) => { options = opts; return new Response('{"translatedText":"  translated  "}'); };
  assert.equal((await h.dispatch(request)).translated, 'translated');
  assert.deepEqual(JSON.parse(options.body), request.body);
  h.context.fetch = async () => new Response('{}');
  assert.match((await h.dispatch(request)).error, /no translated text/);
  h.context.fetch = async () => new Response('unsupported language', { status: 400 });
  assert.match((await h.dispatch(request)).error, /HTTP 400: unsupported language/);
  assert.match((await h.dispatch({ ...request, url: 'file:///secret' })).error, /HTTP and HTTPS/);
});

test('proxy fetch timeout aborts with a visible error', async () => {
  let abort;
  const h = harness({ setTimeout: (callback) => { abort = callback; return 1; }, clearTimeout() {} });
  h.context.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  h.run('service-worker.js');
  const result = h.dispatch({ action: 'fetch_image', url: 'https://images.example/panel.png' });
  abort();
  assert.match((await result).error, /timed out after 25 seconds/);
});

test('image proxy returns JSON-safe image bytes and rejects non-images', async () => {
  const h = harness();
  h.run('service-worker.js');
  h.context.fetch = async () => new Response(new Uint8Array([0, 127, 255]), { headers: { 'Content-Type': 'image/png' } });
  const result = await h.dispatch({ action: 'fetch_image', url: 'https://images.example/panel.png' });
  assert.equal(result.dataUrl, 'data:image/png;base64,AH//');
  h.context.fetch = async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
  assert.match((await h.dispatch({ action: 'fetch_image', url: 'https://images.example/panel.png' })).error, /did not return an image/);
});

test('settings validation and unavailable tab messaging surface errors', async () => {
  const h = harness();
  h.run('service-worker.js');
  for (const config of [{ minImageWidth: 0 }, { minImageHeight: 50.5 }, { ocrLanguage: 'bad' }, { libretranslateUrl: 'javascript:1' }]) {
    assert.equal((await h.dispatch({ action: 'update_config', config })).status, 'error');
  }
  assert.equal((await h.dispatch({ action: 'update_config', config: { targetLanguage: 'ja', arbitrary: true } })).status, 'ok');
  assert.equal(h.storage.targetLanguage, 'ja');
  assert.equal(h.storage.arbitrary, undefined);
  h.chrome.tabs.sendMessage = async () => { throw new Error('No receiver'); };
  assert.match((await h.dispatch({ action: 'start_translation' })).error, /Refresh a normal HTTP/);
});

test('progress is isolated by tab and cleared on navigation/removal', async () => {
  const h = harness();
  h.run('service-worker.js');
  await h.dispatch({ action: 'pipeline_progress', done: 1, total: 3 });
  await h.dispatch({ action: 'pipeline_result', status: 'complete' }, { tab: { id: 8 } });
  assert.equal((await h.dispatch({ action: 'get_pipeline_state' })).state.done, 1);
  assert.equal(h.session['pipeline:8'].status, 'complete');
  h.events.updated(7, { status: 'loading' });
  h.events.removed(8);
  assert.equal((await h.dispatch({ action: 'get_pipeline_state' })).state, null);
  assert.equal(h.session['pipeline:8'], undefined);
});

test('offscreen OCR uses local executable paths and returns line boxes, then terminates its worker', async () => {
  const h = harness();
  let terminated = 0;
  h.context.Tesseract = {
    async createWorker(language, engine, options) {
      assert.equal(language, 'eng');
      assert.equal(engine, 1);
      assert.equal(options.workerBlobURL, false);
      assert.equal(options.workerPath, h.chrome.runtime.getURL('lib/worker.min.js'));
      assert.equal(options.corePath, h.chrome.runtime.getURL('lib/tesseract-core'));
      return {
        recognize: async () => ({ data: { text: ' Hello ', blocks: [{ paragraphs: [{ lines: [{ text: ' Hello ', bbox: { x0: 1, y0: 2, x1: 90, y1: 30 } }] }] }] } }),
        terminate: async () => { terminated++; }
      };
    }
  };
  h.run('offscreen.js');
  const result = await h.dispatch({ target: 'offscreen', action: 'run_ocr', language: 'eng', image: 'data:image/png;base64,AA==' });
  assert.equal(result.text, 'Hello');
  assert.deepEqual(plain(result.lines), [{ text: 'Hello', bbox: { x0: 1, y0: 2, x1: 90, y1: 30 } }]);
  assert.equal(terminated, 1);
});

test('offscreen model-initialization failure returns an error and resets the document', async () => {
  const h = harness();
  h.context.Tesseract = {
    createWorker(language, engine, options) {
      queueMicrotask(() => options.errorHandler('language download failed'));
      return new Promise(() => {});
    }
  };
  h.run('offscreen.js');
  const result = await h.dispatch({ target: 'offscreen', action: 'run_ocr', language: 'jpn', image: 'data:image/png;base64,AA==' });
  assert.equal(result.ok, false);
  assert.match(result.error, /language download failed/);
  await tick();
  assert.equal(h.messages.at(-1).action, 'reset_ocr_host');
});

test('offscreen OCR timeout terminates an initialized worker and permits retry', async () => {
  let expire;
  const h = harness({ setTimeout: (callback) => { expire = callback; return 1; }, clearTimeout() {} });
  let terminated = 0;
  h.context.Tesseract = { createWorker: async () => ({
    recognize: () => new Promise(() => {}),
    terminate: async () => { terminated++; }
  }) };
  h.run('offscreen.js');
  const request = { target: 'offscreen', action: 'run_ocr', language: 'eng', image: 'data:image/png;base64,AA==' };
  const pending = h.dispatch(request);
  await tick();
  expire();
  assert.match((await pending).error, /timed out after 3 minutes/);
  assert.equal(terminated, 1);
  await tick();
  assert.equal(vm.runInContext('busy', h.context), false);
});

test('offscreen rejects concurrent work and invalid inputs explicitly', async () => {
  const h = harness();
  let finish;
  h.context.Tesseract = { createWorker: async () => ({
    recognize: () => new Promise((resolve) => { finish = resolve; }), terminate: async () => {}
  }) };
  h.run('offscreen.js');
  const request = { target: 'offscreen', action: 'run_ocr', language: 'eng', image: 'data:image/png;base64,AA==' };
  assert.match((await h.dispatch({ ...request, language: 'invalid' })).error, /Unsupported OCR/);
  await tick();
  const pending = h.dispatch(request);
  await tick();
  assert.match((await h.dispatch(request)).error, /busy/);
  finish({ data: { text: '' } });
  assert.equal((await pending).text, '');
});

test('content OCR sends a PNG directly to offscreen after ensuring the host', async () => {
  const h = harness();
  h.run('content.js');
  const canvas = { toDataURL: (type) => { assert.equal(type, 'image/png'); return 'data:image/png;base64,AA=='; } };
  h.context.canvas = canvas;
  await vm.runInContext('runOCR(canvas)', h.context);
  assert.equal(h.messages[0].action, 'ensure_ocr_host');
  assert.equal(h.messages[1].target, 'offscreen');
  assert.equal(h.messages[1].action, 'run_ocr');
  assert.equal(h.messages[1].image, 'data:image/png;base64,AA==');
});

test('pipeline reports errors and always unlocks for retry, then produces overlays', async () => {
  const h = harness();
  h.run('content.js');
  let fail = true;
  h.chrome.runtime.sendMessage = async (request) => {
    h.messages.push(request);
    if (request.action === 'get_config') return { libretranslateUrl: 'http://localhost/translate', targetLanguage: 'ja' };
    if (request.action === 'run_ocr') {
      if (fail) return { ok: false, error: 'model blocked' };
      return { ok: true, text: 'Hello', lines: [{ text: 'Hello', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } }] };
    }
    if (request.action === 'translate_proxy') return { ok: true, translated: 'Translated' };
    return { ok: true };
  };
  vm.runInContext(`
    findTranslatableImages = async () => [{ canvas: { width: 200, height: 100, toDataURL: () => 'data:image/png;base64,AA==' } }];
    removeAllOverlays = () => {};
    createInPlaceOverlay = () => ({});
  `, h.context);
  await vm.runInContext('startTranslation()', h.context);
  assert.equal(h.messages.at(-1).status, 'error');
  assert.match(h.messages.at(-1).message, /model blocked/);
  assert.equal(vm.runInContext('isProcessing', h.context), false);
  fail = false;
  await vm.runInContext('startTranslation()', h.context);
  assert.equal(h.messages.at(-1).status, 'complete');
  assert.equal(h.messages.at(-1).overlays, 1);
  assert.equal(h.messages.find((request) => request.action === 'translate_proxy').body.target, 'ja');
  assert.equal(vm.runInContext('isProcessing', h.context), false);
});

test('no-image pipeline finishes cleanly without starting OCR', async () => {
  const h = harness();
  h.run('content.js');
  vm.runInContext('findTranslatableImages = async () => []', h.context);
  await vm.runInContext('startTranslation()', h.context);
  assert.equal(h.messages.at(-1).status, 'no_images');
  assert.equal(vm.runInContext('isProcessing', h.context), false);
  assert.ok(!h.messages.some((request) => request.action === 'run_ocr'));
});

test('overlay cleanup removes elements and both registered layout listeners', () => {
  const h = harness();
  let removed = 0;
  const listeners = [];
  h.context.document = { querySelectorAll: () => [{ remove: () => removed++ }] };
  h.context.window = { removeEventListener: (type, handler) => listeners.push([type, handler]) };
  h.run('content.js');
  vm.runInContext('overlayRegistry.push({ el: {}, repositionFn: () => {} }); removeAllOverlays()', h.context);
  assert.equal(removed, 1);
  assert.deepEqual(listeners.map(([type]) => type), ['scroll', 'resize']);
  assert.equal(listeners[0][1], listeners[1][1]);
  assert.equal(vm.runInContext('overlayRegistry.length', h.context), 0);
});

test('overlay removal persists a result for popup reopening', async () => {
  const h = harness();
  h.context.document = { querySelectorAll: () => [] };
  h.run('content.js');
  assert.equal((await h.dispatch({ action: 'remove_overlays' })).status, 'ok');
  assert.equal(h.messages.at(-1).action, 'pipeline_result');
  assert.equal(h.messages.at(-1).status, 'removed');
});

test('popup restores progress, filters other tabs, and unlocks after errors', async () => {
  const h = harness();
  const elements = {};
  h.context.document = { getElementById: (id) => elements[id] ||= {
    value: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() {} }, addEventListener() {}
  } };
  h.chrome.runtime.sendMessage = async (request) => {
    if (request.action === 'get_config') return vm.runInContext('({ ...DEFAULT_CONFIG })', h.context);
    return { ok: true, tabId: 7, state: { action: 'pipeline_progress', type: 'ocr', done: 1, total: 2 } };
  };
  h.run('popup.js');
  await tick();
  assert.equal(elements.translateBtn.disabled, true);
  assert.equal(elements.progressFill.style.width, '50%');
  h.events.message({ action: 'pipeline_result', status: 'error', message: 'other tab' }, { tab: { id: 8 } });
  assert.equal(elements.translateBtn.disabled, true);
  h.events.message({ action: 'pipeline_result', status: 'error', message: 'OCR failed' }, { tab: { id: 7 } });
  assert.equal(elements.translateBtn.disabled, false);
  assert.equal(elements.removeBtn.disabled, false);
  assert.equal(elements.status.textContent, 'Error: OCR failed');
});
