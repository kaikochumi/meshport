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
const saveNote = document.getElementById("save-note");
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
  fbx: "Download FBX",
  textures: "Download textures",
};

const FORMAT_PROGRESS = {
  stl: "Converting to STL...",
  obj: "Building OBJ + textures...",
  gltf: "Building glTF + textures...",
  glb: "Cleaning GLB...",
  fbx: "Fetching the Tripo file...",
  textures: "Extracting textures...",
};

const FORMAT_SAVE = {
  stl: "Saving STL...",
  obj: "Saving OBJ + textures...",
  gltf: "Saving glTF + textures...",
  glb: "Saving GLB...",
  fbx: "Saving FBX...",
  textures: "Saving textures...",
};

const MODEL_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 7.5 12 12 4 7.5Z" fill="currentColor"/><path d="M4 9 11 13v8L4 17Z" fill="currentColor" opacity=".55"/><path d="M20 9 13 13v8l7-4Z" fill="currentColor" opacity=".8"/></svg>';

const PREFS_KEY = "meshport/preferences";
const SETTINGS_KEY = "meshport/settings/v1";
const THUMB_KEY = "meshport/thumbnails/v1";
const THUMB_LIMIT = 24;
const LIBRARY_KEY = "meshport/library/v1";
const MODEL_LINK_KEY = "meshport/model-links/v3";
const MODEL_LINK_TTL = 4 * 60 * 1000;
const CAPTURE_OPEN_TIMEOUT = 45000;
const CAPTURE_POLL_MS = 700;

let jobId = 0;
let busy = false;
let selectedEntry = null;
let selectionKey = "";
let inspectedKey = "";
let previewUrls = [];
let lastPreviews = [];
let sandboxReadyPromise = null;
let thumbnailCache = loadThumbnailCache();
let settings = loadSettings();
let thumbnailQueue = Promise.resolve();
let thumbnailObserver = null;
let currentModelEntries = [];
let capturedModels = [];
let learnedOperators = {};
let idleWaiters = [];
let scanToken = 0;

// Keeps the last download decisions so a wrong-model report can be traced.
// Everything also goes to the popup console with a [Meshport] prefix.
function logDownload(event, data = {}) {
  try {
    const line = { at: Date.now(), event, ...data };
    (window.__meshportLog ||= []).push(line);
    console.log("[Meshport]", event, data);
    localStorage.setItem("meshport/last-download", JSON.stringify(window.__meshportLog.slice(-80)));
  } catch {
    // Logging is best effort.
  }
}

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

function thumbnailKey(entry) {
  if (entry.projectId) return entry.projectId;
  return tripoFileStem(entry.url) || entry.url;
}

function entryKey(entry) {
  return entry.projectId || entry.url;
}

function modelLabel(stem) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) {
    return `Model ${stem.slice(0, 8)}`;
  }
  return stem;
}

function entryTitle(entry) {
  if (entry.name) return entry.name;
  if (entry.projectId) return `Model ${entry.projectId.slice(0, 8)}`;
  return modelLabel(tripoFileStem(entry.url) || "tripo-model");
}

function baseNameFromEntry(entry) {
  if (entry.name) return sanitizeBaseName(entry.name, "meshport-model");
  if (entry.projectId) return sanitizeBaseName(`model-${entry.projectId.slice(0, 8)}`);
  return baseNameFromUrl(entry.url);
}

function entryMeta(entry) {
  if (entry.kind === "library") {
    const scope = entry.scope === "collected" ? "Collected" : "My Assets";
    if (!entry.capturedAt) return scope;
    return `${scope} · ${formatAge(Date.now() - entry.capturedAt)}`;
  }
  return entry.capturedAt
    ? `Seen ${formatAge(Date.now() - entry.capturedAt)}`
    : "Detected in this tab";
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
    let thumbUrl = isTripoGlbUrl(entry.url) ? entry.url : "";
    if (!thumbUrl && entry.projectId) {
      try {
        await resolveLibraryEntry(entry);
      } catch {
        // A captured viewer link can still be used.
      }
      if (isTripoGlbUrl(entry.url)) thumbUrl = entry.url;
      if (!thumbUrl) thumbUrl = capturedLinkFor(entry.projectId, acceptedStems(entry));
    }
    if (!thumbUrl) thumbUrl = entry.url;
    if (!thumbUrl) return;
    const buffer = await fetchArrayBuffer(thumbUrl);
    if (token !== scanToken || !card.isConnected) return;
    const response = await askSandbox({ type: "thumbnail", key: thumbUrl, buffer }, 30000);
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
  const hasModel = Boolean(selectedEntry);
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

function currentBaseName(entry) {
  return sanitizeBaseName(baseNameInput.value, baseNameFromEntry(entry));
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
    const value = parsed && typeof parsed === "object" ? parsed : {};
    return {
      askSave: Boolean(value.askSave),
      subfolder: typeof value.subfolder === "string" ? value.subfolder : "Meshport",
    };
  } catch {
    return { askSave: false, subfolder: "Meshport" };
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
  const askSave = Boolean(settings.askSave);
  askSaveCheckbox.checked = askSave;
  subfolderInput.value = settings.subfolder || "";
  subfolderInput.disabled = askSave;
  folderField.hidden = askSave;
  saveNote.textContent = askSave
    ? "You pick a folder in the save dialog."
    : "Files stay inside Downloads.";
  updatePathPreview();
  updatePreviewCount();
}

function updatePathPreview() {
  const folder = cleanSubfolder(settings.subfolder);
  pathPreview.textContent = folder
    ? `Downloads/${folder}/model.glb`
    : "Downloads/model.glb";
}

function updatePreviewCount() {
  const count = Object.keys(thumbnailCache).length;
  previewCount.textContent = count
    ? `${count} preview${count === 1 ? "" : "s"} cached`
    : "No previews cached";
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

function isTripoTab(tab) {
  return /^https?:\/\/([a-z0-9-]+\.)*tripo3d\.(ai|com)\//i.test(tab?.url || "");
}

async function getTripoTab() {
  const active = await getActiveTab();
  const tabs = await chrome.tabs.query({
    url: ["*://tripo3d.ai/*", "*://*.tripo3d.ai/*", "*://*.tripo3d.com/*"],
  });
  const open = tabs.filter((entry) => entry.id);
  const studio = open.find((entry) => /^https?:\/\/studio\.tripo3d\.ai\//i.test(entry.url || ""));
  if (studio) return studio;
  if (isTripoTab(active)) return active;
  if (open[0]) return open[0];
  throw new Error("Open studio.tripo3d.ai in a tab so Meshport can read your library.");
}

function readStoredJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Cache writes are optional.
  }
}

function loadModelLinks() {
  const value = readStoredJson(MODEL_LINK_KEY);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function saveModelLinks(links) {
  const now = Date.now();
  const trimmed = {};
  for (const [id, entry] of Object.entries(links)) {
    if (entry?.url && now - (entry.at || 0) < MODEL_LINK_TTL) trimmed[id] = entry;
  }
  writeStoredJson(MODEL_LINK_KEY, trimmed);
}

async function refreshCapturedModels(tabId) {
  const response = await chrome.runtime.sendMessage({
    type: "get-tripo-requests",
    tabId: Number.isInteger(tabId) ? tabId : -1,
  }).catch(() => null);
  const cutoff = Date.now() - MODEL_LINK_TTL;
  capturedModels = [...(response?.entries || []), ...(response?.recent || [])]
    .filter((entry) => entry?.url && (entry.capturedAt || 0) >= cutoff);
  learnedOperators = response?.operators && typeof response.operators === "object"
    ? response.operators
    : {};
  return capturedModels;
}

// File ids the project detail vouches for. A capture can only be used when its
// file stem is in this list, so previews of other assets on the page never win.
function acceptedStems(entry) {
  const stems = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) stems.add(value.trim().toLowerCase());
  };
  add(entry?.stem);
  add(entry?.operatorId);
  for (const item of Array.isArray(entry?.artifacts) ? entry.artifacts : []) {
    add(item?.stem);
    add(item?.operatorId);
  }
  for (const id of learnedOperators[entry?.projectId] || []) add(id);
  return [...stems];
}

function capturedLinkFor(projectId, stems = []) {
  if (!projectId || !stems.length) return "";
  const cutoff = Date.now() - MODEL_LINK_TTL;
  const matches = capturedModels
    .filter((entry) => entry?.url
      && (entry.capturedAt || 0) >= cutoff
      && tripoModelMatchesStem(entry.url, stems)
      && (entry.projectId === projectId
        || tripoProjectIdFromUrl(entry.doc || "") === projectId));
  const confirmed = matches
    .filter((entry) => tripoProjectIdFromUrl(entry.doc || "") === projectId);
  const newest = (list) => [...list].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0];
  return (newest(confirmed) || newest(matches))?.url || "";
}

// Tripo GLBs name their nodes tripo_node_<operator id>, the same id Blender
// shows after an import. Reading it from the file proves which model the
// bytes belong to, even when the download URL was bound to another asset.
function glbContentIds(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    if (meshportModelKind(bytes) !== "glb" || bytes.length < 20) return [];
    if (bytes[16] !== 0x4a || bytes[17] !== 0x53 || bytes[18] !== 0x4f || bytes[19] !== 0x4e) {
      return [];
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(12, true);
    if (!length || 20 + length > bytes.length) return [];
    const text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
    const ids = [];
    for (const match of text.matchAll(/tripo_node_([a-z0-9][a-z0-9-]{7,127})/gi)) {
      const id = match[1].toLowerCase();
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

// Unverifiable files (no operator node name) pass; a file that carries ids
// must have one of the stems the project detail vouches for.
function glbContentVerified(buffer, stems) {
  const ids = glbContentIds(buffer);
  if (!ids.length || !stems.length) return true;
  return ids.some((id) => stems.includes(id));
}

async function openProjectAndCapture(projectId, stems = []) {
  if (!projectId) throw new Error("This model has no Tripo project id.");
  const link = `https://studio.tripo3d.ai/workspace/generate/${encodeURIComponent(projectId)}`;
  const startedAt = Date.now();
  setStatus("Opening the model in Tripo to read its GLB...", "busy");

  let tab;
  try {
    tab = await chrome.tabs.create({ url: link, active: false });
  } catch {
    throw new Error("Could not open the model in Tripo. Check that the Tripo tab is still open.");
  }

  const deadline = startedAt + CAPTURE_OPEN_TIMEOUT;
  let shownSecond = 0;
  const probed = new Set();
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_MS));
      const response = await chrome.runtime.sendMessage({
        type: "get-tripo-requests",
        tabId: tab.id,
      }).catch(() => null);
      const fresh = (value) => value?.url && (value.capturedAt || 0) >= startedAt - 1000;
      const own = (response?.entries || []).filter(fresh);
      const others = stems.length ? (response?.recent || []).filter(fresh) : [];
      const byStem = [...own, ...others]
        .filter((capture) => stems.length && tripoModelMatchesStem(capture.url, stems))
        .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0];
      if (byStem?.url) {
        logDownload("helper-stem-match", { url: byStem.url, stems });
        return { url: byStem.url };
      }

      if (!stems.length) {
        // Nothing is known about this project's file ids, so the first GLB
        // the tab loads is the best guess available.
        const firstOwn = [...own].sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0))[0];
        if (firstOwn?.url) {
          logDownload("helper-first-glb", { url: firstOwn.url });
          return { url: firstOwn.url };
        }
      } else {
        // A preload of another asset can arrive before the model. Verify the
        // files by content instead of trusting the load order.
        for (const capture of [...own].sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0))) {
          if (probed.has(capture.url) || probed.size >= 6) continue;
          probed.add(capture.url);
          setStatus("Checking the model Tripo loaded...", "busy");
          try {
            const glb = await fetchGlbFromUrl(capture.url);
            const content = glb ? glbContentIds(glb) : [];
            if (glb && glbContentVerified(glb, stems)) {
              logDownload("helper-content-match", { url: capture.url, content, stems });
              return { url: capture.url, glb };
            }
            logDownload("helper-content-rejected", { url: capture.url, content, stems });
          } catch {
            // Broken link; keep polling.
          }
        }
      }

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (elapsed >= shownSecond + 5) {
        shownSecond = elapsed;
        setStatus(`Opening the model in Tripo to read its GLB... ${elapsed}s`, "busy");
      }
    }
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }

  throw new Error(
    stems.length
      ? "Tripo only loaded previews of other assets, never the GLB of this model. Open the model in Tripo and press Download again."
      : "Tripo opened this model without loading its GLB. Open the model in Tripo and try again.",
  );
}

async function getLibraryFromTab() {
  const cachedProjects = () => {
    const cached = readStoredJson(LIBRARY_KEY);
    return Array.isArray(cached?.projects) ? cached.projects : [];
  };

  const tab = await getTripoTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "get-tripo-library" });
  } catch {
    const projects = cachedProjects();
    if (projects.length) return { projects, cached: true };
    throw new Error("Reload the Tripo tab so Meshport can read the library.");
  }
  if (!response?.ok) {
    const projects = cachedProjects();
    if (projects.length) return { projects, cached: true };
    throw new Error(response?.error || "Could not read the Tripo library.");
  }

  const projects = Array.isArray(response.projects) ? response.projects : [];
  writeStoredJson(LIBRARY_KEY, { at: Date.now(), projects });
  return { projects, cached: false };
}

async function resolveLibraryEntry(entry, force = false) {
  if (!entry?.projectId) throw new Error("This model has no Tripo project id.");

  const matchesEntry = (url) => tripoModelMatchesStem(url, entry.stem);
  if (entry.url && !matchesEntry(entry.url)) {
    entry.url = "";
    entry.resolvedAt = 0;
  }
  if (
    !force
    && entry.url
    && Date.now() - (entry.resolvedAt || 0) < MODEL_LINK_TTL
  ) {
    return entry.url;
  }

  const links = loadModelLinks();
  const cached = links[entry.projectId];
  const cachedStem = cached?.stem || tripoFileStem(cached?.url);
  const cachedMatches = !entry.stem
    || (cachedStem ? entry.stem === cachedStem : tripoModelMatchesStem(cached?.url, entry.stem));
  if (
    !force
    && cached?.url
    && Date.now() - (cached.at || 0) < MODEL_LINK_TTL
    && cachedMatches
  ) {
    entry.url = cached.url;
    entry.stem = entry.stem || cachedStem;
    entry.operatorId = entry.operatorId || cached.operatorId || "";
    entry.artifacts = entry.artifacts?.length ? entry.artifacts : cached.artifacts || [];
    entry.resolvedAt = cached.at;
    if (!entry.name && cached.name) entry.name = cached.name;
    return entry.url;
  }

  const tab = await getTripoTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "resolve-tripo-project",
      projectId: entry.projectId,
    });
  } catch {
    throw new Error("Reload the Tripo tab so Meshport can read the library.");
  }
  if (!response?.ok) {
    throw new Error(response?.error || "Tripo did not return a model link.");
  }

  entry.url = response.url;
  entry.stem = response.stem || tripoFileStem(response.url);
  entry.operatorId = response.operatorId || "";
  entry.artifacts = Array.isArray(response.artifacts) ? response.artifacts : [];
  entry.resolvedAt = Date.now();
  if (!entry.name && response.name) entry.name = response.name;
  links[entry.projectId] = {
    url: entry.url,
    at: entry.resolvedAt,
    name: entry.name || "",
    stem: entry.stem,
    operatorId: entry.operatorId,
    artifacts: entry.artifacts,
  };
  saveModelLinks(links);
  return entry.url;
}

function buildEntries(links, projects) {
  if (!projects.length) {
    return links.map((link) => ({
      kind: "captured",
      url: link.url,
      capturedAt: link.capturedAt || 0,
      name: "",
      cover: "",
      projectId: "",
      scope: "tab",
    }));
  }

  return projects.map((project) => ({
    kind: "library",
    projectId: project.id,
    url: "",
    stem: "",
    operatorId: "",
    artifacts: [],
    resolvedAt: 0,
    capturedAt: Date.parse(project.createdAt) || 0,
    name: project.name || "",
    cover: project.cover || "",
    scope: project.scope || "mine",
  }));
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

function selectEntry(entry, focus = false) {
  if (!entry) return;
  const key = entryKey(entry);
  const changed = key !== selectionKey;
  selectedEntry = entry;
  selectionKey = key;

  for (const button of linksList.querySelectorAll(".model")) {
    const isSelected = button.dataset.key === key;
    button.setAttribute("aria-selected", String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
    if (isSelected && focus) button.focus();
  }

  baseNameInput.value = baseNameFromEntry(entry);
  if (changed) {
    inspectedKey = "";
    lastPreviews = [];
    clearTextures();
  }
  updateActionState();
}

function fillLinks(entries) {
  const token = ++scanToken;
  entries = entries.filter((entry) => entry.url || entry.projectId);
  currentModelEntries = entries;
  selectedEntry = null;
  selectionKey = "";
  linksList.replaceChildren();
  modelCount.textContent = String(entries.length);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const text = document.createElement("p");
    text.textContent = "No model found. Reload the Tripo tab so Meshport can read your library.";
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
    const key = entryKey(entry);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model";
    button.dataset.key = key;
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.tabIndex = -1;
    button.style.setProperty("--i", String(Math.min(index, 8)));
    button.title = entryTitle(entry);

    const thumb = document.createElement("span");
    thumb.className = "model-thumb";
    thumb.innerHTML = `<span class="thumb-fallback">${MODEL_GLYPH}</span><img alt="" decoding="async">`;

    const text = document.createElement("span");
    text.className = "model-text";
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = entryTitle(entry);
    const meta = document.createElement("span");
    meta.className = "model-meta";
    meta.textContent = entryMeta(entry);
    text.append(name, meta);

    button.append(thumb, text);
    linksList.append(button);
    cards.push(button);
  });

  selectEntry(entries[0]);
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
      const key = thumbnailKey(entry);
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
    if (!entry) return;
    if (entry.cover) {
      const image = card.querySelector(".model-thumb img");
      if (image) {
        image.referrerPolicy = "no-referrer";
        image.src = entry.cover;
        card.classList.add("has-thumb");
      }
      return;
    }
    const cached = thumbnailCache[thumbnailKey(entry)];
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
    throw new Error("The Tripo download link expired.");
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

function isExpiredLinkError(error) {
  return /expired|\b403\b/i.test(error?.message || "");
}

function rememberModelLink(entry, url, at = Date.now()) {
  if (!entry?.projectId) return;
  const links = loadModelLinks();
  links[entry.projectId] = {
    url,
    at,
    name: entry.name || "",
    stem: entry.stem || tripoFileStem(url),
    operatorId: entry.operatorId || "",
    artifacts: Array.isArray(entry.artifacts) ? entry.artifacts : [],
  };
  saveModelLinks(links);
}

async function glbFromBytes(bytes) {
  const kind = meshportModelKind(bytes);
  if (kind === "glb") return bytes.buffer;
  if (kind === "zip") {
    const glb = await meshportGlbFromZip(bytes.buffer);
    if (glb) return glb.buffer;
  }
  return null;
}

async function fetchGlbFromUrl(url) {
  return glbFromBytes(new Uint8Array(await fetchArrayBuffer(url)));
}

// Tripo names FBX and OBJ sources directly; a GLB can only come from a .glb
// or .zip link, so skip the rest instead of downloading the whole file first.
const NON_GLB_URL = /\.(?:fbx|obj|gltf|usdz|dae|stl|ply)(?:$|[?#])/i;

async function fetchSelectedBuffer() {
  const entry = selectedEntry;
  if (!entry) throw new Error("No Tripo model selected.");

  await refreshCapturedModels();
  logDownload("download-start", {
    projectId: entry.projectId,
    name: entry.name,
    stem: entry.stem,
    operatorId: entry.operatorId,
  });
  const candidates = [];
  let lastError = null;
  const add = (url) => {
    if (!url || candidates.includes(url)) return;
    const stems = acceptedStems(entry);
    if (stems.length && !tripoModelMatchesStem(url, stems)) return;
    candidates.push(url);
  };

  if (entry.projectId) {
    // The project detail link is the one Tripo names for this project. Prefer
    // it over viewer captures, which can belong to another library card.
    try {
      const detailUrl = await resolveLibraryEntry(entry);
      logDownload("detail", {
        url: detailUrl,
        stem: entry.stem,
        operatorId: entry.operatorId,
        artifacts: entry.artifacts,
        name: entry.name,
      });
      add(detailUrl);
    } catch (error) {
      logDownload("detail-failed", { error: error.message });
      lastError = error;
    }
    add(entry.url);
    // A capture only counts when its file id is one the project detail
    // reports, so previews of other assets loaded by the page never win.
    add(capturedLinkFor(entry.projectId, acceptedStems(entry)));
  } else {
    add(entry.url);
  }
  logDownload("candidates", { candidates, stems: acceptedStems(entry) });

  for (const url of [...candidates]) {
    if (NON_GLB_URL.test(url)) continue;
    setStatus("Downloading Tripo GLB...", "busy");
    try {
      const glb = await fetchGlbFromUrl(url);
      if (glb && glbContentVerified(glb, acceptedStems(entry))) {
        logDownload("chosen", { url, content: glbContentIds(glb) });
        entry.url = url;
        entry.stem = entry.stem || tripoFileStem(url);
        entry.resolvedAt = Date.now();
        rememberModelLink(entry, url, entry.resolvedAt);
        return glb;
      }
      logDownload("rejected-content", {
        url,
        content: glb ? glbContentIds(glb) : [],
        stems: acceptedStems(entry),
      });
    } catch (error) {
      lastError = error;
      if (!entry.projectId || !isExpiredLinkError(error)) continue;
      try {
        setStatus("Refreshing the Tripo link...", "busy");
        const refreshed = await resolveLibraryEntry(entry, true);
        const glb = await fetchGlbFromUrl(refreshed);
        if (glb && glbContentVerified(glb, acceptedStems(entry))) {
          logDownload("chosen", { url: refreshed, content: glbContentIds(glb) });
          entry.resolvedAt = Date.now();
          rememberModelLink(entry, refreshed, entry.resolvedAt);
          return glb;
        }
      } catch {
        // Fall through to the next candidate.
      }
    }
  }

  if (!entry.projectId) {
    throw new Error(
      isExpiredLinkError(lastError)
        ? "The Tripo link expired. Open the model in Tripo, then scan again."
        : "This model is not a GLB file.",
    );
  }

  setStatus("Tripo keeps this model in another format. Opening it to read the GLB...", "busy");
  const captured = await openProjectAndCapture(entry.projectId, acceptedStems(entry));
  const glb = captured.glb || await fetchGlbFromUrl(captured.url);
  if (!glb) throw new Error("Tripo loaded this model without a GLB.");
  logDownload("chosen-helper", { url: captured.url, content: glbContentIds(glb) });
  entry.url = captured.url;
  entry.stem = entry.stem || tripoFileStem(captured.url);
  entry.resolvedAt = Date.now();
  rememberModelLink(entry, captured.url, entry.resolvedAt);
  return glb;
}

// Some models only exist on Tripo as an FBX (quad topology, for example). The
// FBX card downloads that native file straight from the project detail link,
// exactly as Tripo stores it, instead of converting a GLB.
async function fetchNativeModel(entry) {
  if (!entry?.projectId) {
    throw new Error("Open the model in Tripo so Meshport can find its native file.");
  }
  setBusy(true, "Reading the project file...");
  const url = await resolveLibraryEntry(entry, true);
  const bytes = new Uint8Array(await fetchArrayBuffer(url));
  const kind = meshportModelKind(bytes);
  const urlExt = /\.(fbx|zip|glb)(?:$|[?#])/i.exec(url)?.[1].toLowerCase() || "";
  const ext = kind === "fbx" || kind === "zip" || kind === "glb" ? kind : urlExt;
  if (!ext) {
    throw new Error("Tripo has no FBX or GLB file stored for this model.");
  }
  return {
    bytes,
    ext,
    note: ext === "fbx" ? "" : `Tripo keeps this model as ${ext.toUpperCase()}, saved that instead.`,
  };
}

async function runSandboxJob(request, fallbackUrl) {
  try {
    return await askSandbox(request);
  } catch (error) {
    if (!request.buffer && fallbackUrl && /Decode the file first/i.test(error.message)) {
      request.buffer = await fetchArrayBuffer(fallbackUrl);
      return askSandbox(request);
    }
    throw error;
  }
}

function convertSelected(key, format, buffer, baseName) {
  const png = (format === "obj" || format === "gltf") && pngCheckbox.checked;
  return runSandboxJob({
    type: "convert",
    key,
    buffer,
    format,
    options: { png, baseName },
    baseName,
  }, selectedEntry?.url || "");
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
    setBusy(true, "Reading your Tripo library...");
    const [linksResult, libraryResult] = await Promise.allSettled([
      getLinksFromActiveTab(),
      getLibraryFromTab(),
      refreshCapturedModels(),
    ]);
    const links = linksResult.status === "fulfilled" ? linksResult.value : [];
    const projects = libraryResult.status === "fulfilled"
      ? libraryResult.value.projects || []
      : [];
    const entries = buildEntries(links, projects);
    fillLinks(entries);

    const count = entries.length;
    const libraryError = libraryResult.status === "rejected"
      ? libraryResult.reason?.message || "Could not read the Tripo library."
      : "";
    const cachedLibrary = libraryResult.status === "fulfilled" && libraryResult.value.cached;

    if (!count) {
      setStatus(
        libraryError
          ? `No models found. ${libraryError}`
          : "Your Tripo library is empty. Create a model in Tripo, then rescan.",
        libraryError ? "error" : "idle",
      );
      return;
    }

    const fromLibrary = projects.length > 0;
    const hint = libraryError
      ? ` ${libraryError}`
      : cachedLibrary
        ? " Showing the last saved list."
        : "";
    setStatus(
      `${count} model${count === 1 ? "" : "s"} ${fromLibrary ? "in your Tripo library" : "found in this tab"}.${hint}`,
      fromLibrary && !libraryError && !cachedLibrary ? "ok" : "idle",
    );
  } catch (error) {
    setStatus(`Scan error: ${error.message}`, "error");
  } finally {
    setBusy(false);
  }
}

async function reloadActiveTab() {
  try {
    const tab = await getTripoTab();
    setStatus("Reloading the Tripo tab. The library loads when the page is ready.", "busy");
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
  settings = { askSave: false, subfolder: "Meshport" };
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
    selectEntry(currentModelEntries[Number(button.dataset.index)]);
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
  selectEntry(currentModelEntries[Number(buttons[next].dataset.index)], true);
});

inspectButton.addEventListener("click", async () => {
  const entry = selectedEntry;
  if (!entry) {
    setStatus("No Tripo model selected.", "error");
    return;
  }

  const key = selectionKey;
  try {
    setBusy(true, inspectedKey === key ? "Reading textures..." : "Downloading Tripo GLB...");
    const buffer = inspectedKey === key ? null : await fetchSelectedBuffer();
    setBusy(true, "Decoding meshopt...");
    const response = await runSandboxJob({
      type: "inspect",
      key,
      buffer,
      baseName: currentBaseName(entry),
    }, entry.url || "");
    inspectedKey = key;
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
  const entry = selectedEntry;
  if (!entry) {
    setStatus("No Tripo model selected.", "error");
    return;
  }

  const key = selectionKey;
  try {
    const format = currentFormat();
    if (format === "fbx") {
      const native = await fetchNativeModel(entry);
      const mimeType = native.ext === "zip"
        ? "application/zip"
        : native.ext === "glb"
          ? "model/gltf-binary"
          : "application/octet-stream";
      const fileName = `${currentBaseName(entry)}.${native.ext}`;
      setBusy(true, FORMAT_SAVE.fbx);
      await downloadBlob(new Blob([native.bytes], { type: mimeType }), fileName);
      logDownload("chosen-native", { ext: native.ext });
      setStatus(`${fileName} saved${native.note ? ` · ${native.note}` : ""}.`, "ok");
      return;
    }

    setBusy(true, inspectedKey === key ? "Building output..." : "Downloading Tripo GLB...");
    const buffer = inspectedKey === key ? null : await fetchSelectedBuffer();
    setBusy(true, FORMAT_PROGRESS[format] || "Converting...");
    const response = await convertSelected(key, format, buffer, currentBaseName(entry));
    inspectedKey = key;

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
    logDownload("error", { message: error.message });
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
