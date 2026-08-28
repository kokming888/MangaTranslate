// Image Text Translate - Service Worker
// Role: Configuration persistence + message routing between popup and content scripts
// Note: All heavy lifting (OCR, image processing) is done in content.js

console.log("[Service Worker] Image Text Translate loaded.");

// On installation, set default config if none exists
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({
      libretranslateUrl: "http://127.0.0.1:5000/translate",
      ocrLanguage: "eng",
      minImageWidth: 150,
      minImageHeight: 100,
      overlayOpacity: 0.85,
      textColor: "#ffffff",
      bgColor: "rgba(0, 0, 0, 0.7)",
      fontStack: "Noto Sans JP, Arial, sans-serif"
    });
    console.log("[Service Worker] Default configuration set.");
  }
});

// Route messages between popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Pass translation requests to active tab's content script
  if (request.action === "start_translation") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "start_translation" }, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[Service Worker] Failed to reach content script:", chrome.runtime.lastError.message);
            sendResponse({ status: "error", message: "Content script not available on this page." });
          } else {
            sendResponse({ status: "started" });
          }
        });
      } else {
        sendResponse({ status: "error", message: "No active tab." });
      }
    });
    return true; // async
  }

  // Pass config requests
  if (request.action === "get_config") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "get_config" }, (response) => {
          sendResponse(response);
        });
      } else {
        chrome.storage.local.get(null, (items) => {
          sendResponse(items);
        });
      }
    });
    return true;
  }

  if (request.action === "update_config") {
    chrome.storage.local.set(request.config, () => {
      // Also notify active tab to update its config
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "update_config", config: request.config });
        }
      });
      sendResponse({ status: "ok" });
    });
    return true;
  }

  // Pass overlay removal
  if (request.action === "remove_overlays") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "remove_overlays" });
      }
      sendResponse({ status: "ok" });
    });
    return true;
  }

  // Translation proxy: background page fetch bypasses CORS/mixed-content
  // issues that block content-script fetches to http://127.0.0.1:5000
  if (request.action === "translate_proxy") {
    fetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body)
    })
      .then((r) => {
        if (!r.ok) {
          // Surface the server's own error message (LibreTranslate explains
          // e.g. "target language is not supported" inside a 500 body)
          return r.text().then((t) => {
            throw new Error("HTTP " + r.status + ": " + String(t).slice(0, 200));
          });
        }
        return r.json();
      })
      .then((data) => {
        const translated = data.translatedText || data.translation || data.result || data.translated || null;
        sendResponse({ ok: true, translated: typeof translated === "string" ? translated.trim() : null });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  // Image proxy: fetch cross-origin images with extension privileges and
  // return a data URL so the content script can draw an UNTAINTED canvas.
  if (request.action === "fetch_image") {
    fetch(request.url)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        const mime = r.headers.get("content-type") || "image/png";
        return r.arrayBuffer().then((buf) => ({ buf, mime }));
      })
      .then(({ buf, mime }) => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        sendResponse({
          ok: true,
          dataUrl: "data:" + mime + ";base64," + btoa(binary)
        });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }
});

// Migration: older installs saved the bare root URL (POST / -> HTTP 405).
// Rewrite it once to the proper LibreTranslate endpoint path.
(function migrateLibretranslateUrl() {
  const NEW_URL = "http://127.0.0.1:5000/translate";
  chrome.storage.local.get("libretranslateUrl", (items) => {
    const current = items && items.libretranslateUrl;
    if (current && !current.endsWith("/translate")) {
      chrome.storage.local.set({ libretranslateUrl: NEW_URL });
      console.log("[Service Worker] Migrated libretranslateUrl ->", NEW_URL);
    }
  });
})();
