const linksList = document.getElementById("links");
const modelCount = document.getElementById("model-count");
const baseNameInput = document.getElementById("base-name");
const formatInputs = [...document.querySelectorAll('input[name="format"]')];
const pngCheckbox = document.getElementById("png");
const pngRow = document.getElementById("png-row");
const scanButton = document.getElementById("scan");
const inspectButton = document.getElementById("inspect");
const convertButton = document.getElementById("convert");
const statusEl = document.getElementById("status");
const progress = document.getElementById("progress");
const sandboxFrame = document.getElementById("sandbox");
const textureBox = document.getElementById("texture-box");
const textureSummary = document.getElementById("texture-summary");
const textureList = document.getElementById("texture-list");
const tabExport = document.getElementById("tab-export");
const tabSettings = document.getElementById("tab-settings");
const viewExport = document.getElementById("view-export");
const viewSettings = document.getElementById("view-settings");
const askSaveCheckbox = document.getElementById("ask-save");
const folderField = document.getElementById("folder-field");
const subfolderInput = document.getElementById("subfolder");
const pathPreview = document.getElementById("path-preview");
const openDownloadsButton = document.getElementById("open-downloads");
const clearPreviewsButton = document.getElementById("clear-previews");
const resetSettingsButton = document.getElementById("reset-settings");
const previewCount = document.getElementById("preview-count");
const defaultFormatInputs = [...document.querySelectorAll('input[name="default-format"]')];
const versionEl = document.getElementById("version");

const FORMAT_LABELS = {
  stl: "Download STL",
  obj: "Download OBJ + textures",
  gltf: "Download glTF + textures",
  glb: "Download GLB",
  textures: "Download textures",
};

const FORMAT_PROGRESS = {
  stl: "Converting to STL...",
  obj: "Building OBJ + textures...",
  gltf: "Building glTF + textures...",
  glb: "Cleaning GLB...",
  textures: "Extracting textures...",
};

const FORMAT_SAVE = {
  stl: "Saving STL...",
  obj: "Saving OBJ + textures...",
  gltf: "Saving glTF + textures...",
  glb: "Saving GLB...",
  textures: "Saving textures...",
};

const MODEL_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 7.5 12 12 4 7.5Z" fill="currentColor"/><path d="M4 9 11 13v8L4 17Z" fill="currentColor" opacity=".55"/><path d="M20 9 13 13v8l7-4Z" fill="currentColor" opacity=".8"/></svg>';

const PREFS_KEY = "meshport/preferences";
const SETTINGS_KEY = "meshport/settings/v1";
const THUMB_KEY = "meshport/thumbnails/v1";
const THUMB_LIMIT = 24;

let jobId = 0;
let busy = false;
let selectedUrl = "";
let inspectedKey = "";
let previewUrls = [];
let lastPreviews = [];
let sandboxReadyPromise = null;
let thumbnailCache = loadThumbnailCache();
let settings = loadSettings();
let thumbnailQueue = Promise.resolve();
let thumbnailObserver = null;
let currentModelEntries = [];
let idleWaiters = [];
let scanToken = 0;

function sandboxReady() {
  if (sandboxReadyPromise) return sandboxReadyPromise;

  sandboxReadyPromise = new Promise((resolve, reject) => {
    const id = `ping-${++jobId}`;
    let attempts = 0;

    function stop(error) {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      if (error) {
        sandboxReadyPromise = null;
        reject(error);
      } else {
        resolve();
      }
    }

    function ping() {
      attempts += 1;
      if (attempts > 100) {
        stop(new Error("The converter sandbox did not load. Reload the extension on the extensions page and try again."));
        return;
      }
      sandboxFrame.contentWindow?.postMessage({ type: "ping", id }, "*");
    }

    function onMessage(event) {
      if (event.source !== sandboxFrame.contentWindow) return;
      if (event.data?.type !== "pong" || event.data.id !== id) return;
      stop();
    }

    window.addEventListener("message", onMessage);
    const timer = setInterval(ping, 150);
    ping();
  });

  return sandboxReadyPromise;
}

function loadThumbnailCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THUMB_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveThumbnailCache() {
  const keys = Object.keys(thumbnailCache);
  while (keys.length > THUMB_LIMIT) delete thumbnailCache[keys.shift()];
  try {
    localStorage.setItem(THUMB_KEY, JSON.stringify(thumbnailCache));
  } catch {
    // The cache is optional.
  }
}

function thumbnailKey(url) {
  return tripoFileStem(url) || url;
}

function modelLabel(stem) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) {
    return `Model ${stem.slice(0, 8)}`;
  }
  return stem;
}

function waitForIdle() {
  if (!busy) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function setThumbnail(card, dataUrl) {
  if (!dataUrl?.startsWith("data:image/")) return;
  const image = card.querySelector(".model-thumb img");
  if (!image) return;
  image.src = dataUrl;
  requestAnimationFrame(() => {
    card.classList.add("has-thumb");
    card.classList.remove("loading");
  });
}

async function generateThumbnail(entry, card, token, key) {
  thumbnailObserver?.unobserve(card);
  await waitForIdle();
  if (token !== scanToken || !card.isConnected) return;

  try {
    const buffer = await fetchArrayBuffer(entry.url);
    if (token !== scanToken || !card.isConnected) return;
    const response = await askSandbox({ type: "thumbnail", key: entry.url, buffer }, 30000);
    if (token !== scanToken || !card.isConnected) return;
    thumbnailCache[key] = response.thumbnail;
    saveThumbnailCache();
    updatePreviewCount();
    setThumbnail(card, response.thumbnail);
  } catch {
    // Keep the cube placeholder.
  } finally {
    card.classList.remove("loading");
  }
}

function setStatus(text, tone = "idle") {
  statusEl.textContent = text;
  document.body.dataset.tone = tone;
}

function updateActionState() {
  const hasModel = Boolean(selectedUrl);
  inspectButton.disabled = busy || !hasModel;
  convertButton.disabled = busy || !hasModel;
}

function setBusy(isBusy, text) {
  busy = isBusy;
  scanButton.disabled = isBusy;
  baseNameInput.disabled = isBusy;
  formatInputs.forEach((input) => {
    input.disabled = isBusy;
  });
  progress.hidden = !isBusy;
  if (text !== undefined) setStatus(text, isBusy ? "busy" : "ok");
  updateActionState();
  if (!isBusy) {
    const waiters = idleWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}

function sanitizeBaseName(value, fallback = "meshport-model") {
  const clean = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return clean || fallback;
}

function baseNameFromUrl(value) {
  return sanitizeBaseName(tripoFileStem(value), "meshport-model");
}

function currentBaseName(url) {
  return sanitizeBaseName(baseNameInput.value, baseNameFromUrl(url));
}

function currentFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || "stl";
}

function loadPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePreferences() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      format: currentFormat(),
      png: pngCheckbox.checked,
    }));
  } catch {
    // Preferences are optional.
  }
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    return {
      askSave: false,
      subfolder: "",
      ...(parsed && typeof parsed === "object" ? parsed : {}),
    };
  } catch {
    return { askSave: false, subfolder: "" };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings are optional.
  }
}

function cleanSubfolder(value) {
  return String(value || "")
    .split(/[\\/]+/)
    .map((part) => part.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/[. ]+$/, ""))
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .slice(0, 120);
}

function downloadPath(filename) {
  const folder = settings.askSave ? "" : cleanSubfolder(settings.subfolder);
  return folder ? `${folder}/${filename}` : filename;
}

function syncSettingsUi() {
  askSaveCheckbox.checked = Boolean(settings.askSave);
  subfolderInput.value = settings.subfolder || "";
  subfolderInput.disabled = Boolean(settings.askSave);
  folderField.classList.toggle("disabled", Boolean(settings.askSave));
  updatePathPreview();
  updatePreviewCount();
}

function updatePathPreview() {
  const folder = cleanSubfolder(settings.subfolder);
  pathPreview.textContent = settings.askSave
    ? "You pick the folder in the save dialog."
    : folder
      ? `Downloads/${folder}/model.glb`
      : "Downloads/model.glb";
}

function updatePreviewCount() {
  const count = Object.keys(thumbnailCache).length;
  previewCount.textContent = count
    ? `${count} preview${count === 1 ? "" : "s"} cached in this browser.`
    : "No cached previews.";
}

function clearPreviewCache() {
  thumbnailCache = {};
  try {
    localStorage.removeItem(THUMB_KEY);
  } catch {
    // The cache is optional.
  }
  const cards = [...linksList.querySelectorAll(".model")];
  for (const card of cards) {
    card.classList.remove("has-thumb", "loading");
    card.querySelector(".model-thumb img")?.removeAttribute("src");
  }
  updatePreviewCount();
  if (cards.length && currentModelEntries.length) {
    primeThumbnails(currentModelEntries, cards);
  } else {
    thumbnailObserver?.disconnect();
  }
}

function showView(name) {
  const isSettings = name === "settings";
  viewExport.hidden = isSettings;
  viewSettings.hidden = !isSettings;
  tabExport.setAttribute("aria-selected", String(!isSettings));
  tabSettings.setAttribute("aria-selected", String(isSettings));
  tabExport.tabIndex = isSettings ? -1 : 0;
  tabSettings.tabIndex = isSettings ? 0 : -1;
  document.body.classList.toggle("settings-open", isSettings);
  if (isSettings) {
    updatePathPreview();
    updatePreviewCount();
  }
  document.querySelector("main").scrollTop = 0;
}

function scanPageForTripoLinks() {
  const urls = new Set();
  const isGlb = (value) => {
    try {
      const url = new URL(value, location.href);
      const host = url.hostname.toLowerCase();
      if (
        host !== "tripo3d.ai" && !host.endsWith(".tripo3d.ai")
        && host !== "tripo3d.com" && !host.endsWith(".tripo3d.com")
      ) return false;
      if (!/\.glb$/i.test(url.pathname)) return false;
      const name = decodeURIComponent(url.pathname.split("/").pop() || "");
      return /^tripo_(?:[a-z0-9]+_)*model_/i.test(name);
    } catch {
      return false;
    }
  };
  const add = (value) => {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(value, location.href);
      const clean = url.href.split("#")[0];
      if (isGlb(clean)) urls.add(clean);
    } catch {
      // Ignore invalid URLs.
    }
  };

  performance.getEntriesByType("resource").forEach((entry) => add(entry.name));
  document.querySelectorAll("a[href]").forEach((el) => add(el.getAttribute("href")));
  document.querySelectorAll("[src]").forEach((el) => add(el.getAttribute("src")));
  document.querySelectorAll("[data-src],[data-url],[data-model-url]").forEach((el) => {
    add(el.getAttribute("data-src"));
    add(el.getAttribute("data-url"));
    add(el.getAttribute("data-model-url"));
  });
  const html = document.documentElement.innerHTML
    .replaceAll("\\/", "/")
    .replace(/\\u002f/gi, "/");
  for (const match of html.matchAll(/https?:\/\/[^"'<>\s]+\.glb[^"'<>\s]*/gi)) {
    add(match[0]);
  }

  return [...urls].slice(0, 50);
}

async function scanPageInTab(tabId, add) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scanPageForTripoLinks,
    });
    for (const link of result?.result || []) add(link);
  } catch {
    // The tab may not allow injection.
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Could not access the current tab.");
  return tab;
}

function formatAge(age) {
  if (age < 60_000) return "just now";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function isModelUrl(url) {
  return /tripo-studio/i.test(url) && /tripo_pbr_model_/i.test(url);
}

async function getLinksFromActiveTab() {
  const tab = await getActiveTab();
  const all = new Map();

  const add = (url, capturedAt = 0) => {
    if (!isTripoGlbUrl(url)) return;
    const clean = url.split("#")[0];
    const parsed = new URL(clean);
    const key = `${parsed.origin}${parsed.pathname}`;
    const previous = all.get(key);
    if (!previous || capturedAt > previous.capturedAt) {
      all.set(key, { url: clean, capturedAt });
    }
  };

  const remembered = await chrome.runtime.sendMessage({ type: "get-tripo-requests", tabId: tab.id }).catch(() => null);
  for (const entry of remembered?.entries || []) add(entry.url, entry.capturedAt || 0);
  for (const entry of remembered?.recent || []) add(entry.url, entry.capturedAt || 0);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "scan-tripo-links" });
    for (const link of response?.links || []) add(link);
    if (!response?.links?.length) await scanPageInTab(tab.id, add);
  } catch {
    await scanPageInTab(tab.id, add);
  }

  return [...all.values()]
    .sort((a, b) => {
      const aModel = isModelUrl(a.url) ? 1 : 0;
      const bModel = isModelUrl(b.url) ? 1 : 0;
      if (aModel !== bModel) return bModel - aModel;
      return (b.capturedAt || 0) - (a.capturedAt || 0);
    })
    .slice(0, 50);
}

function selectModel(url, focus = false) {
  if (!url) return;
  const changed = url !== selectedUrl;
  selectedUrl = url;

  for (const button of linksList.querySelectorAll(".model")) {
    const isSelected = button.dataset.url === url;
    button.setAttribute("aria-selected", String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
    if (isSelected && focus) button.focus();
  }

  baseNameInput.value = baseNameFromUrl(url);
  if (changed) {
    inspectedKey = "";
    lastPreviews = [];
    clearTextures();
  }
  updateActionState();
}

function fillLinks(entries) {
  const token = ++scanToken;
  entries = entries.filter((entry) => isTripoGlbUrl(entry.url));
  currentModelEntries = entries;
  selectedUrl = "";
  linksList.replaceChildren();
  modelCount.textContent = String(entries.length);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const text = document.createElement("p");
    text.textContent = "No model captured yet. If the model was already open, reload the tab so Meshport can see it load.";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "empty-reload";
    reload.dataset.action = "reload-tab";
    reload.textContent = "Reload tab";
    empty.append(text, reload);
    linksList.append(empty);
    updateActionState();
    return;
  }

  const cards = [];
  entries.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model";
    button.dataset.url = entry.url;
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.tabIndex = -1;
    button.style.setProperty("--i", String(Math.min(index, 8)));

    const stem = tripoFileStem(entry.url) || "tripo-model";
    button.title = stem;

    const thumb = document.createElement("span");
    thumb.className = "model-thumb";
    thumb.innerHTML = `<span class="thumb-fallback">${MODEL_GLYPH}</span><img alt="" decoding="async">`;

    const text = document.createElement("span");
    text.className = "model-text";
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = modelLabel(stem);
    const meta = document.createElement("span");
    meta.className = "model-meta";
    meta.textContent = entry.capturedAt
      ? `Seen ${formatAge(Date.now() - entry.capturedAt)}`
      : "Detected in this tab";
    text.append(name, meta);

    button.append(thumb, text);
    linksList.append(button);
    cards.push(button);
  });

  selectModel(entries[0].url);
  primeThumbnails(entries, cards);
}

function primeThumbnails(entries, cards) {
  thumbnailObserver?.disconnect();
  thumbnailObserver = new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      const card = record.target;
      const entry = entries[Number(card.dataset.index)];
      if (!entry) continue;
      const key = thumbnailKey(entry.url);
      const cached = thumbnailCache[key];
      if (cached) {
        setThumbnail(card, cached);
        thumbnailObserver.unobserve(card);
        continue;
      }
      if (card.dataset.queued === "1") continue;
      card.dataset.queued = "1";
      card.classList.add("loading");
      thumbnailQueue = thumbnailQueue
        .then(() => generateThumbnail(entry, card, scanToken, key))
        .catch(() => {});
    }
  }, { root: linksList, rootMargin: "48px 0px", threshold: 0.01 });

  cards.forEach((card) => {
    const entry = entries[Number(card.dataset.index)];
    const cached = entry ? thumbnailCache[thumbnailKey(entry.url)] : "";
    if (cached) {
      setThumbnail(card, cached);
    } else {
      card.dataset.queued = "0";
      thumbnailObserver.observe(card);
    }
  });
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const timer = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The download did not start. Try again."));
    }, 30000);
    chrome.downloads.download({
      url: objectUrl,
      filename: downloadPath(filename),
      conflictAction: "uniquify",
      saveAs: Boolean(settings.askSave),
    }, (downloadId) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

async function askSandbox({ type, key, buffer, format, options, baseName }, timeout = 120000) {
  await sandboxReady();
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const onMessage = (event) => {
      if (event.source !== sandboxFrame.contentWindow || event.data?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error || "Conversion failed"));
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("The converter did not respond. Reload the extension and try again."));
    }, timeout);
    window.addEventListener("message", onMessage);

    const payload = { type, id, key, format, options, baseName };
    const transfer = [];
    if (buffer) {
      payload.buffer = buffer;
      transfer.push(buffer);
    }
    sandboxFrame.contentWindow.postMessage(payload, "*", transfer);
  });
}

async function fetchArrayBuffer(url) {
  let response;
  try {
    response = await fetch(url, { credentials: "omit", redirect: "follow" });
  } catch (error) {
    throw new Error(`Download failed: ${error.message}. Reload the model page and try again.`);
  }
  if (response.status === 403) {
    throw new Error("The Tripo link expired. Reload the model page and try again.");
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

async function runSandboxJob(request, url) {
  try {
    return await askSandbox(request);
  } catch (error) {
    if (!request.buffer && /Decode the file first/i.test(error.message)) {
      request.buffer = await fetchArrayBuffer(url);
      return askSandbox(request);
    }
    throw error;
  }
}

function convertSelected(url, format, buffer) {
  const baseName = currentBaseName(url);
  const png = (format === "obj" || format === "gltf") && pngCheckbox.checked;
  return runSandboxJob({
    type: "convert",
    key: url,
    buffer,
    format,
    options: { png, baseName },
    baseName,
  }, url);
}

function formatBytes(size) {
  if (!size) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function describeStats(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.triangles) parts.push(`${stats.triangles.toLocaleString()} triangles`);
  if (stats.textures?.length) parts.push(`${stats.textures.length} texture(s)`);
  return parts.join(" · ");
}

function clearTextures() {
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
  textureList.replaceChildren();
  textureBox.hidden = true;
}

function renderTextures(stats, previews) {
  clearTextures();
  const textures = stats?.textures || [];
  if (!textures.length) return;

  textureBox.hidden = false;
  textureSummary.textContent = `${textures.length} texture(s) · ${formatBytes(textures.reduce((total, item) => total + item.size, 0))}`;

  for (const texture of textures) {
    const item = document.createElement("li");
    const preview = previews.find((entry) => entry.name === texture.name)
      || previews.find((entry) => entry.role === texture.role);

    if (preview) {
      const url = URL.createObjectURL(new Blob([preview.thumb], { type: "image/webp" }));
      previewUrls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = texture.role;
      item.append(image);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "thumb-empty";
      placeholder.textContent = "?";
      item.append(placeholder);
    }

    const text = document.createElement("div");
    const role = document.createElement("strong");
    role.textContent = texture.role;
    const meta = document.createElement("span");
    const size = preview ? `${preview.width}×${preview.height} · ` : "";
    meta.textContent = `${size}${formatBytes(texture.size)} · ${texture.mimeType.replace("image/", "")}`;
    text.append(role, meta);
    item.append(text);

    textureList.append(item);
  }
}

function updateFormatUi() {
  const format = currentFormat();
  convertButton.textContent = FORMAT_LABELS[format] || "Download";
  const pngApplies = format === "obj" || format === "gltf";
  pngCheckbox.disabled = !pngApplies;
  pngRow.classList.toggle("disabled", !pngApplies);
}

async function scan() {
  try {
    setBusy(true, "Searching this tab for Tripo models...");
    const links = await getLinksFromActiveTab();
    fillLinks(links);
    const count = links.length;
    setStatus(
      count
        ? `${count} model${count === 1 ? "" : "s"} found.${count === 1 ? " Open another model in Tripo to add it here." : ""}`
        : "No Tripo model found. Reload the tab, let the model load, then rescan.",
      count ? "ok" : "idle",
    );
  } catch (error) {
    setStatus(`Scan error: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function reloadActiveTab() {
  try {
    const tab = await getActiveTab();
    setStatus("Reloading the tab. The model is captured when it loads again.", "busy");
    await chrome.tabs.reload(tab.id);
    const onUpdated = (tabId, info) => {
      if (tabId !== tab.id || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(() => scanButton.click(), 1200);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => chrome.tabs.onUpdated.removeListener(onUpdated), 30000);
  } catch (error) {
    setStatus(`Reload failed: ${error.message}`, "error");
  }
}

scanButton.addEventListener("click", scan);

function setFormat(value) {
  const input = formatInputs.find((entry) => entry.value === value);
  if (!input) return;
  input.checked = true;
  const chip = defaultFormatInputs.find((entry) => entry.value === value);
  if (chip) chip.checked = true;
  updateFormatUi();
  savePreferences();
}

formatInputs.forEach((input) => {
  input.addEventListener("change", () => setFormat(input.value));
});

defaultFormatInputs.forEach((input) => {
  input.addEventListener("change", () => setFormat(input.value));
});

tabExport.addEventListener("click", () => showView("export"));
tabSettings.addEventListener("click", () => showView("settings"));
[tabExport, tabSettings].forEach((tab) => {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextTab = tab === tabExport ? tabSettings : tabExport;
    showView(nextTab === tabSettings ? "settings" : "export");
    nextTab.focus();
  });
});

askSaveCheckbox.addEventListener("change", () => {
  settings.askSave = askSaveCheckbox.checked;
  saveSettings();
  syncSettingsUi();
});

subfolderInput.addEventListener("input", () => {
  settings.subfolder = cleanSubfolder(subfolderInput.value);
  saveSettings();
  updatePathPreview();
});

subfolderInput.addEventListener("blur", () => {
  subfolderInput.value = settings.subfolder;
});

openDownloadsButton.addEventListener("click", () => {
  try {
    chrome.downloads.showDefaultFolder();
  } catch {
    setStatus("Could not open the Downloads folder.", "error");
  }
});

clearPreviewsButton.addEventListener("click", clearPreviewCache);

resetSettingsButton.addEventListener("click", () => {
  settings = { askSave: false, subfolder: "" };
  saveSettings();
  setFormat("stl");
  syncSettingsUi();
});

pngCheckbox.addEventListener("change", savePreferences);

textureBox.addEventListener("toggle", () => {
  if (textureBox.open) textureBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

linksList.addEventListener("click", (event) => {
  const button = event.target.closest(".model");
  if (button) {
    selectModel(button.dataset.url);
    return;
  }
  if (event.target.closest('[data-action="reload-tab"]')) reloadActiveTab();
});

linksList.addEventListener("keydown", (event) => {
  const buttons = [...linksList.querySelectorAll(".model")];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;

  let next = null;
  if (event.key === "ArrowDown") next = Math.min(index + 1, buttons.length - 1);
  if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = buttons.length - 1;
  if (next === null) return;

  event.preventDefault();
  selectModel(buttons[next].dataset.url, true);
});

inspectButton.addEventListener("click", async () => {
  const url = selectedUrl;
  if (!url) {
    setStatus("No Tripo model selected.", "error");
    return;
  }

  try {
    setBusy(true, inspectedKey === url ? "Reading textures..." : "Downloading Tripo GLB...");
    const buffer = inspectedKey === url ? null : await fetchArrayBuffer(url);
    setBusy(true, "Decoding meshopt...");
    const response = await runSandboxJob({
      type: "inspect",
      key: url,
      buffer,
      baseName: currentBaseName(url),
    }, url);
    inspectedKey = url;
    lastPreviews = response.previews || [];
    renderTextures(response.stats, lastPreviews);
    const summary = describeStats(response.stats);
    setStatus(
      summary ? `${summary}.` : "No embedded textures found in this model.",
      "ok",
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
});

convertButton.addEventListener("click", async () => {
  const url = selectedUrl;
  if (!url) {
    setStatus("No Tripo model selected.", "error");
    return;
  }

  try {
    const format = currentFormat();
    setBusy(true, inspectedKey === url ? "Building output..." : "Downloading Tripo GLB...");
    const buffer = inspectedKey === url ? null : await fetchArrayBuffer(url);
    setBusy(true, FORMAT_PROGRESS[format] || "Converting...");
    const response = await convertSelected(url, format, buffer);
    inspectedKey = url;

    const { result } = response;
    setBusy(true, FORMAT_SAVE[format] || "Saving file...");
    await downloadBlob(new Blob([result.bytes], { type: result.mimeType }), result.fileName);

    if (textureBox.hidden) renderTextures(response.stats, lastPreviews);
    const summary = describeStats(response.stats);
    setStatus(
      `${result.fileName} saved${summary ? ` · ${summary}` : ""}.`,
      "ok",
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
});

const preferences = loadPreferences();
setFormat(preferences.format || "stl");
if (typeof preferences.png === "boolean") pngCheckbox.checked = preferences.png;
syncSettingsUi();
versionEl.textContent = chrome.runtime.getManifest().version;
showView("export");
updateActionState();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scan);
} else {
  scan();
}
