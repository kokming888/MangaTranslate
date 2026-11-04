/**
 * Image Text Translate - Popup Script
 * Handles UI, config management, and pipeline orchestration
 */

let activeTabId;
let receivedLiveState = false;

const translateBtn = document.getElementById("translateBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressFill = document.getElementById("progressFill");
const toggleConfig = document.getElementById("toggleConfig");
const configPanel = document.getElementById("configPanel");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const removeBtn = document.getElementById("removeBtn");

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

async function requestBackground(request) {
  const response = await chrome.runtime.sendMessage(request);
  if (!response || response.ok === false || response.status === "error") {
    throw new Error(response && (response.error || response.message) || "The extension did not respond.");
  }
  return response;
}

async function loadConfig() {
  const config = await requestBackground({ action: "get_config" });
  configUrl.value = config.libretranslateUrl;
  configLang.value = config.ocrLanguage;
  configMinW.value = config.minImageWidth;
  configMinH.value = config.minImageHeight;
  configTargetLang.value = config.targetLanguage;
}

async function saveConfigUI() {
  const newConfig = {
    libretranslateUrl: configUrl.value || DEFAULT_CONFIG.libretranslateUrl,
    ocrLanguage: configLang.value,
    minImageWidth: Number(configMinW.value),
    minImageHeight: Number(configMinH.value),
    targetLanguage: configTargetLang.value || DEFAULT_CONFIG.targetLanguage
  };

  try {
    await requestBackground({ action: "update_config", config: newConfig });
    setStatus("Settings saved.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

// ===== Translation =====

async function startTranslation() {
  receivedLiveState = true;
  translateBtn.disabled = true;
  removeBtn.disabled = true;
  setStatus("Initializing local OCR...", "progress");
  clearProgress();

  try {
    await requestBackground({ action: "start_translation" });
  } catch (error) {
    translateBtn.disabled = false;
    removeBtn.disabled = false;
    setStatus("Error: " + error.message, "error");
  }
}

function showResult(result) {
  const r = result;
  clearProgress();
  translateBtn.disabled = false;
  removeBtn.disabled = false;
  if (r.status === "complete") {
    setStatus(
      `Done! ${r.overlays} overlay(s) on ${r.withText}/${r.total} image(s). Hover overlay to see original text.`,
      "success"
    );
  } else if (r.status === "no_images") {
    setStatus("No translatable images found. Try a page with manga panels or text images.", "error");
  } else if (r.status === "removed") {
    setStatus("Overlays removed.", "success");
  } else {
    setStatus("Error: " + (r.message || "Translation failed."), "error");
  }
}

function showProgress(p) {
  const typeLabels = {
    initializing: "Initializing",
    ocr: "OCR",
    ocr_done: "OCR",
    ocr_empty: "OCR (no text)",
    translate: "Translate",
    translate_done: "Translate",
    translate_failed: "Translate (failed)"
  };
  clearProgress();
  translateBtn.disabled = true;
  removeBtn.disabled = true;
  setStatus(
    `${typeLabels[p.type] || "Processing"} ${p.done}/${p.total}...`,
    "progress"
  );
  setProgress(p.done, p.total);
}

// ===== Event Listeners =====

translateBtn.addEventListener("click", startTranslation);
saveConfigBtn.addEventListener("click", saveConfigUI);
removeBtn.addEventListener("click", async () => {
  try {
    await requestBackground({ action: "remove_overlays" });
    setStatus("Overlays removed.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

toggleConfig.addEventListener("click", () => {
  configPanel.classList.toggle("open");
  toggleConfig.textContent = configPanel.classList.contains("open")
    ? "⚙ Settings [hide]"
    : "⚙ Settings";
});

chrome.runtime.onMessage.addListener((request, sender) => {
  if (!sender.tab || sender.tab.id !== activeTabId) return;
  if (request.action === "pipeline_result" || request.action === "pipeline_progress") receivedLiveState = true;
  if (request.action === "pipeline_result") showResult(request);
  if (request.action === "pipeline_progress") showProgress(request);
});

// ===== Init =====

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab && tab.id;
  await loadConfig();
  const response = await requestBackground({ action: "get_pipeline_state" });
  if (!receivedLiveState && response.tabId === activeTabId && response.state) {
    if (response.state.action === "pipeline_progress") showProgress(response.state);
    if (response.state.action === "pipeline_result") showResult(response.state);
  }
}

initialize().catch((error) => setStatus("Error: " + error.message, "error"));
