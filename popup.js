/**
 * Image Text Translate - Popup Script
 * Handles UI, config management, and pipeline orchestration
 */

const DEFAULT_CONFIG = {
  libretranslateUrl: "http://127.0.0.1:5000/translate",
  ocrLanguage: "eng",
  targetLanguage: "en",
  minImageWidth: 150,
  minImageHeight: 100,
  overlayOpacity: 0.85,
  textColor: "#ffffff",
  bgColor: "rgba(0, 0, 0, 0.7)",
  fontStack: "Noto Sans JP, Arial, sans-serif"
};

let config = { ...DEFAULT_CONFIG };

const translateBtn = document.getElementById("translateBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const toggleConfig = document.getElementById("toggleConfig");
const configPanel = document.getElementById("configPanel");
const saveConfigBtn = document.getElementById("saveConfigBtn");

// Config form fields
const configUrl = document.getElementById("configUrl");
const configLang = document.getElementById("configLang");
const configMinW = document.getElementById("configMinW");
const configMinH = document.getElementById("configMinH");
const configTargetLang = document.getElementById("configTargetLang");

// ===== UI Helpers =====

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
}

function setProgress(done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  progressFill.style.width = pct + "%";
  if (done > 0 && done <= total) {
    progressBar.classList.add("active");
  }
}

function clearProgress() {
  progressFill.style.width = "0%";
  progressBar.classList.remove("active");
}

// ===== Config =====

function loadConfig() {
  chrome.storage.local.get(DEFAULT_CONFIG, (items) => {
    config = { ...DEFAULT_CONFIG, ...items };
    configUrl.value = config.libretranslateUrl;
    configLang.value = config.ocrLanguage;
    configMinW.value = config.minImageWidth;
    configMinH.value = config.minImageHeight;
  configTargetLang.value = config.targetLanguage;
  });
}

function saveConfigUI() {
  const newConfig = {
    libretranslateUrl: configUrl.value || DEFAULT_CONFIG.libretranslateUrl,
    ocrLanguage: configLang.value,
    minImageWidth: parseInt(configMinW.value) || DEFAULT_CONFIG.minImageWidth,
    minImageHeight: parseInt(configMinH.value) || DEFAULT_CONFIG.minImageHeight,
    targetLanguage: configTargetLang.value || DEFAULT_CONFIG.targetLanguage
  };

  chrome.storage.local.set(newConfig, () => {
    config = newConfig;
    setStatus("Settings saved.", "success");
    setTimeout(() => setStatus("Ready.", ""), 1500);
  });
}

// ===== Translation =====

function startTranslation() {
  translateBtn.disabled = true;
  setStatus("Initializing... (loading Tesseract)", "progress");
  clearProgress();

  chrome.runtime.sendMessage({ action: "start_translation" }, (response) => {
    if (chrome.runtime.lastError) {
      translateBtn.disabled = false;
      setStatus("Error: " + chrome.runtime.lastError.message, "error");
      return;
    }
    if (response && response.status === "error") {
      translateBtn.disabled = false;
      setStatus("Error: " + response.message, "error");
      return;
    }
  });
}

function showResult(result) {
  const r = result;
  if (r.status === "complete") {
    clearProgress();
    translateBtn.disabled = false;
    setStatus(
      `Done! ${r.overlays} overlay(s) on ${r.withText}/${r.total} image(s). Hover overlay to see original text.`,
      "success"
    );
  } else if (r.status === "no_images") {
    clearProgress();
    translateBtn.disabled = false;
    setStatus("No translatable images found. Try a page with manga panels or text images.", "error");
  }
}

function showProgress(p) {
  const typeLabels = {
    ocr_done: "OCR",
    ocr_empty: "OCR (no text)",
    translate_done: "Translate",
    translate_failed: "Translate (failed)"
  };
  clearProgress();
  setStatus(
    `${typeLabels[p.type] || "Processing"} ${p.done}/${p.total}...`,
    "progress"
  );
  setProgress(p.done, p.total);
}

// ===== Event Listeners =====

translateBtn.addEventListener("click", startTranslation);
saveConfigBtn.addEventListener("click", saveConfigUI);

toggleConfig.addEventListener("click", () => {
  configPanel.classList.toggle("open");
  toggleConfig.textContent = configPanel.classList.contains("open")
    ? "⚙ Settings [hide]"
    : "⚙ Settings";
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "pipeline_result") showResult(request);
  if (request.action === "pipeline_progress") showProgress(request);
});

// ===== Init =====

loadConfig();
