const reported = new Map();
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

async function studioRequest(path, { headers, method = "GET", body, timeout = 15000, step = "reach Tripo" } = {}) {
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
      throw new Error(`Tripo took too long to ${step}.`);
    }
    const network = new Error(`Could not reach Tripo to ${step}. Reload the page and try again.`);
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
    throw new Error(`Tripo returned HTTP ${response.status} when trying to ${step}.`);
  }

  const message = String(payload?.message || payload?.msg || "").trim();
  if (response.status === 401 || payload?.code === 1002) {
    throw new Error(`Tripo did not allow reading this page. Reload the Tripo tab and try again.`);
  }
  if (!response.ok || payload?.code !== 0) {
    throw new Error(
      message || `Tripo returned HTTP ${response.status} when trying to ${step}.`,
    );
  }
  return payload.data;
}

async function studioApi(path, { method = "GET", body, timeout = 15000, step = "reach Tripo" } = {}) {
  const headers = {
    accept: "application/json",
    "x-tripo-device-id": meshportDeviceId(),
    "x-tripo-region": "rg1",
    "x-tripo-start": String(Math.round(performance.now())),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await studioRequest(path, { headers, method, body, timeout, step });
  } catch (error) {
    if (!error.meshportNetwork) throw error;
    // A strict CORS preflight can reject the custom headers. Cookies are enough.
    const fallback = { accept: "application/json" };
    if (body !== undefined) fallback["content-type"] = "application/json";
    return studioRequest(path, { headers: fallback, method, body, timeout, step });
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

function detailOperator(data) {
  const operator = data?.operator;
  const operatorId = typeof operator?.operator_id === "string"
    ? operator.operator_id.trim().slice(0, 128)
    : "";
  const artifacts = [];
  for (const key of ["Retarget", "retarget", "retarget_model"]) {
    const list = Array.isArray(operator?.[key]) ? operator[key] : [];
    for (const item of list) {
      const value = typeof item?.model_url === "string" ? item.model_url : "";
      if (!value) continue;
      let url;
      try {
        url = new URL(value);
      } catch {
        continue;
      }
      if (url.protocol !== "https:") continue;
      artifacts.push({
        url: url.href,
        stem: tripoFileStem(url.href),
        operatorId: typeof item?.operator_id === "string"
          ? item.operator_id.trim().slice(0, 128)
          : "",
      });
    }
  }
  return { operatorId, artifacts };
}

async function resolveProjectModel(projectId) {
  const data = await projectDetail(projectId);
  if (data?.id && String(data.id) !== String(projectId)) {
    throw new Error("Tripo returned a different project. Reload the page and try again.");
  }
  const value = typeof data?.model_url === "string" ? data.model_url : "";
  if (!value) throw new Error("Tripo has no file stored for this model yet.");

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
    stem: tripoFileStem(url.href),
    name: tripoLibraryProject(data, "mine")?.name || "",
    ...detailOperator(data),
  };
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

function pageProjectId() {
  return tripoProjectIdFromUrl(location.href);
}

function report(urls, bindToPage = false) {
  // Scraped links can belong to any card in the library, so they stay
  // unbound. A request the page actually made belongs to its project.
  const projectId = bindToPage ? pageProjectId() : "";
  for (const url of urls) {
    if (reported.has(url)) {
      const previous = reported.get(url);
      if (previous === projectId) continue;
      if (previous && !projectId) continue;
    }
    reported.set(url, projectId);
    chrome.runtime.sendMessage({ type: "remember-tripo-url", url, projectId }).catch(() => {});
  }
}

function reportResources() {
  if (typeof performance === "undefined") return;
  const links = performance.getEntriesByType("resource")
    .map((entry) => entry.name.split("#")[0])
    .filter((url) => isTripoGlbUrl(url));
  report(links, true);
}

function reportCollected() {
  const links = collectTripoLinks();
  report(links);
  return links;
}

reportResources();
reportCollected();

if (typeof PerformanceObserver === "function") {
  try {
    const observer = new PerformanceObserver((entries) => {
      const links = [];
      for (const entry of entries.getEntries()) {
        if (isTripoGlbUrl(entry.name)) links.push(entry.name);
      }
      report(links, true);
    });
    observer.observe({ entryTypes: ["resource"] });
  } catch {
    // The popup still scans the page on demand.
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "meshport") return;
  if (data.type !== "model-url" && data.type !== "model-request") return;
  if (typeof data.url !== "string") return;
  const url = data.url.split("#")[0];
  if (!isTripoGlbUrl(url)) return;
  liveUrls.add(url);
  report([url], data.type === "model-request");
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
});
