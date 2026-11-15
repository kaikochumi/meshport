const linksSelect = document.getElementById("links");
const baseNameInput = document.getElementById("base-name");
const formatSelect = document.getElementById("format");
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

const PREFS_KEY = "tripo-to-stl/preferences";

let jobId = 0;
let inspectedKey = "";
let previewUrls = [];
let lastPreviews = [];
let sandboxReadyPromise = null;

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

function setBusy(isBusy, text) {
  scanButton.disabled = isBusy;
  baseNameInput.disabled = isBusy;
  inspectButton.disabled = isBusy;
  convertButton.disabled = isBusy;
  progress.hidden = !isBusy;
  if (text !== undefined) statusEl.textContent = text;
}

function sanitizeBaseName(value, fallback = "tripo-model") {
  const clean = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return clean || fallback;
}

function baseNameFromUrl(value) {
  return sanitizeBaseName(tripoFileStem(value), "tripo-model");
}

function currentBaseName(url) {
  return sanitizeBaseName(baseNameInput.value, baseNameFromUrl(url));
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
      format: formatSelect.value,
      png: pngCheckbox.checked,
    }));
  } catch {
    // Preferences are optional.
  }
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
      return /\.glb$/i.test(url.pathname);
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
  for (const match of document.documentElement.innerHTML.matchAll(/https?:\/\/[^"'<>\\\s]+\.glb[^"'<>\\\s]*/gi)) {
    add(match[0]);
  }

  return [...urls].slice(0, 50);
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

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "scan-tripo-links" });
    for (const link of response?.links || []) add(link);
  } catch {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForTripoLinks,
    });
    for (const link of result?.result || []) add(link);
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

function fillLinks(entries) {
  linksSelect.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.url;
    const stem = tripoFileStem(entry.url) || "tripo-model";
    option.textContent = entry.capturedAt
      ? `${stem} (${formatAge(Date.now() - entry.capturedAt)})`
      : stem;
    linksSelect.append(option);
  }
  if (entries.length) {
    linksSelect.selectedIndex = 0;
    baseNameInput.value = baseNameFromUrl(entries[0].url);
  }
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const timer = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("The download did not start. Try again."));
    }, 30000);
    chrome.downloads.download({ url: objectUrl, filename, conflictAction: "uniquify", saveAs: false }, (downloadId) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

async function askSandbox({ type, key, buffer, format, options, baseName }) {
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
    }, 120000);
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
  const format = formatSelect.value;
  convertButton.textContent = FORMAT_LABELS[format] || "Download";
  const pngApplies = format === "obj" || format === "gltf";
  pngCheckbox.disabled = !pngApplies;
  pngRow.classList.toggle("disabled", !pngApplies);
}

async function scan() {
  try {
    setBusy(true, "Searching for Tripo GLB files in the current tab...");
    const links = await getLinksFromActiveTab();
    fillLinks(links);
    statusEl.textContent = links.length
      ? `${links.length} Tripo GLB file(s) found.`
      : "No Tripo GLB found. Open a model in Tripo Studio and try again.";
  } catch (error) {
    statusEl.textContent = `Scan error: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

scanButton.addEventListener("click", scan);

formatSelect.addEventListener("change", () => {
  updateFormatUi();
  savePreferences();
});

pngCheckbox.addEventListener("change", savePreferences);

linksSelect.addEventListener("change", () => {
  inspectedKey = "";
  lastPreviews = [];
  baseNameInput.value = baseNameFromUrl(linksSelect.value);
  clearTextures();
});

inspectButton.addEventListener("click", async () => {
  const url = linksSelect.value;
  if (!url) {
    statusEl.textContent = "No Tripo GLB file selected.";
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
    statusEl.textContent = summary
      ? `${summary}.`
      : "No embedded textures found in this model.";
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    setBusy(false);
  }
});

convertButton.addEventListener("click", async () => {
  const url = linksSelect.value;
  if (!url) {
    statusEl.textContent = "No Tripo GLB file selected.";
    return;
  }

  try {
    const format = formatSelect.value;
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
    statusEl.textContent = `${result.fileName} saved${summary ? ` · ${summary}` : ""}.`;
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    setBusy(false);
  }
});

const preferences = loadPreferences();
if (preferences.format && FORMAT_LABELS[preferences.format]) formatSelect.value = preferences.format;
if (typeof preferences.png === "boolean") pngCheckbox.checked = preferences.png;
updateFormatUi();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scan);
} else {
  scan();
}
