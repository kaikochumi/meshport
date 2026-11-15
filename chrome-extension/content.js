const reported = new Set();
const liveUrls = new Set();

const STUDIO_API = "https://api.tripo3d.ai";
const LIBRARY_SCOPES = ["mine", "collected"];
const LIBRARY_PAGE_SIZE = 20;
const LIBRARY_MAX_MODELS = 120;

function meshportDeviceId() {
  const key = "meshport/device-id";
  try {
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return crypto.randomUUID();
  }
}

async function studioRequest(path, { headers, method = "GET", body, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`${STUDIO_API}${path}`, {
      credentials: "include",
      signal: controller.signal,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Tripo took too long to answer.");
    }
    const network = new Error("Could not reach Tripo. Reload the page and try again.");
    network.meshportNetwork = true;
    throw network;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Tripo returned HTTP ${response.status}.`);
  }
  if (response.status === 401 || response.status === 403 || payload?.code === 1002) {
    throw new Error("Tripo login not found. Reload the page and sign in again.");
  }
  if (!response.ok || payload?.code !== 0) {
    throw new Error(
      payload?.message || payload?.msg || `Tripo returned HTTP ${response.status}.`,
    );
  }
  return payload.data;
}

async function studioApi(path, { method = "GET", body, timeout = 15000 } = {}) {
  const headers = {
    accept: "application/json",
    "x-tripo-device-id": meshportDeviceId(),
    "x-tripo-region": "rg1",
    "x-tripo-start": String(Math.round(performance.now())),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await studioRequest(path, { headers, method, body, timeout });
  } catch (error) {
    if (!error.meshportNetwork) throw error;
    // A strict CORS preflight can reject the custom headers. Cookies are enough.
    const fallback = { accept: "application/json" };
    if (body !== undefined) fallback["content-type"] = "application/json";
    return studioRequest(path, { headers: fallback, method, body, timeout });
  }
}

async function fetchLibraryProjects() {
  const byId = new Map();
  for (const scope of LIBRARY_SCOPES) {
    try {
      let offset = 0;
      for (let page = 0; page < 6 && byId.size < LIBRARY_MAX_MODELS; page++) {
        const data = await studioApi(
          `/v2/studio/assets/v2?asset_type=${scope}&offset=${offset}&size=${LIBRARY_PAGE_SIZE}&type=all`,
        );
        const batch = Array.isArray(data?.projects) ? data.projects : [];
        for (const project of batch) {
          const card = tripoLibraryProject(project, scope);
          if (!card || byId.has(card.id)) continue;
          byId.set(card.id, card);
        }
        offset += batch.length;
        const total = Number(data?.total);
        if (!batch.length || (Number.isFinite(total) && offset >= total)) break;
      }
    } catch (error) {
      if (scope === "mine") throw error;
      // Collected models are optional; My Assets is the main list.
    }
  }
  return [...byId.values()];
}

async function projectDetail(projectId) {
  return studioApi(`/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`);
}

async function resolveProjectModel(projectId) {
  const data = await projectDetail(projectId);
  const value = typeof data?.model_url === "string" ? data.model_url : "";
  if (!value) throw new Error("Tripo has no model file for this model yet.");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Tripo returned an invalid model link.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Tripo returned an insecure model link.");
  }
  return {
    url: url.href,
    name: tripoLibraryProject(data, "mine")?.name || "",
  };
}

const EXPORT_POLL_MS = 1500;
const EXPORT_TIMEOUT_MS = 90000;
const EXPORT_RUNNING = new Set(["prepare", "queued", "running", "unknown"]);

function exportName(value, projectId) {
  const clean = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || `model-${projectId}`;
}

function exportTextureSize(operator) {
  if (operator?.is_ultra_textured) return 8192;
  if (operator?.is_hd_textured) return 4096;
  return 2048;
}

function exportBody(projectId, detail, name, textureSize) {
  return {
    project_id: projectId,
    name,
    texture_size: textureSize,
    texture_packaging: "embedded",
    fbx_preset: "blender",
    with_animation: false,
    animations: [],
    pack_uv: false,
    animate_in_place: false,
    enable_bake_animation: false,
    bake_animation_frame: 0,
    export_vertex_colors: false,
    export_orientation: "-y",
    format: "gltf",
    model_version: "default",
  };
}

async function waitForExport(receipt, name) {
  if (typeof receipt?.model_url === "string" && receipt.model_url) {
    return receipt.model_url;
  }
  const operatorId = receipt?.operator_id;
  if (!operatorId) throw new Error("Tripo did not start the GLB export.");

  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
    const items = await studioApi("/v2/studio/progress", {
      method: "POST",
      body: { ids: [operatorId] },
    });
    const item = Array.isArray(items)
      ? items.find((entry) => entry?.operator_id === operatorId) || items[0]
      : null;
    const status = item?.status;
    if (status === "success") {
      const download = await studioApi("/v2/studio/operation/download_with_name", {
        method: "POST",
        body: { file_name: name, operator_id: operatorId },
      });
      if (typeof download?.model_url === "string" && download.model_url) {
        return download.model_url;
      }
      throw new Error("Tripo finished the export without a file.");
    }
    if (status && !EXPORT_RUNNING.has(status)) {
      const reason = typeof item.reason === "string" && item.reason.trim()
        ? `: ${item.reason.trim()}`
        : "";
      throw new Error(`Tripo could not export this model${reason}.`);
    }
  }
  throw new Error("Tripo is taking too long to export this model. Try again in a minute.");
}

async function exportProjectGlb(projectId) {
  const detail = await projectDetail(projectId);
  const name = exportName(detail?.project_name, projectId);
  const sizes = [...new Set([exportTextureSize(detail?.operator), 1024, 512])];
  let lastError = null;

  for (const textureSize of sizes) {
    try {
      const receipt = await studioApi("/v2/studio/operation/export", {
        method: "POST",
        body: exportBody(projectId, detail, name, textureSize),
        timeout: 60000,
      });
      return await waitForExport(receipt, name);
    } catch (error) {
      lastError = error;
      // A resolution mismatch is the only reason to retry smaller.
      if (!/texture|resolution|size/i.test(error.message || "")) break;
    }
  }
  throw lastError || new Error("Tripo did not export this model as GLB.");
}

function collectTripoLinks() {
  const urls = new Set(liveUrls);
  const add = (value) => {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(value, location.href);
      const clean = url.href.split("#")[0];
      if (isTripoGlbUrl(clean)) urls.add(clean);
    } catch {
      // Ignore invalid or script-only URLs.
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

function report(urls) {
  for (const url of urls) {
    if (reported.has(url)) continue;
    reported.add(url);
    chrome.runtime.sendMessage({ type: "remember-tripo-url", url }).catch(() => {});
  }
}

function reportCollected() {
  const links = collectTripoLinks();
  report(links);
  return links;
}

reportCollected();

if (typeof PerformanceObserver === "function") {
  try {
    const observer = new PerformanceObserver((entries) => {
      const links = [];
      for (const entry of entries.getEntries()) {
        if (isTripoGlbUrl(entry.name)) links.push(entry.name);
      }
      report(links);
    });
    observer.observe({ entryTypes: ["resource"] });
  } catch {
    // The popup still scans the page on demand.
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "meshport" || data.type !== "model-url") return;
  if (typeof data.url !== "string") return;
  const url = data.url.split("#")[0];
  if (!isTripoGlbUrl(url)) return;
  liveUrls.add(url);
  report([url]);
});

window.postMessage({ source: "meshport-content", type: "ready" }, "*");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "scan-tripo-links") {
    sendResponse({ links: reportCollected() });
    return;
  }

  if (message?.type === "get-tripo-library") {
    fetchLibraryProjects()
      .then((projects) => sendResponse({ ok: true, projects }))
      .catch((error) => sendResponse({ ok: false, error: error.message, projects: [] }));
    return true;
  }

  if (message?.type === "resolve-tripo-project" && typeof message.projectId === "string") {
    resolveProjectModel(message.projectId)
      .then((model) => sendResponse({ ok: true, ...model }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "export-tripo-project" && typeof message.projectId === "string") {
    exportProjectGlb(message.projectId)
      .then((url) => sendResponse({ ok: true, url }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
