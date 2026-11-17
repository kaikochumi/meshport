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

// Meshy. The workspace already fetches everything Meshport needs: opening
// a model triggers /v1/tasks/{id}/status, which answers with the signed
// GLB link, and the sidebar fetches /v2/tasks, which answers with names
// and triangle counts. meshy-world.js, running in the page, hands both
// answers over, so this script reads instead of asking. A direct API call
// stays as a fallback, stamped with the device id the app itself sends.
const MESHY_HOST = /(^|\.)meshy\.ai$/i.test(location.hostname);
const MESHY_TASK_RE = /meshyd-api\/web\/v\d\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MESHY_TASKS_QUERY = "?excludeWorkspace=true&pageNum=1&pageSize=50"
  + "&phases=draft&phases=generate&phases=texture&phases=image-to-3d-texture&phases=stylize"
  + "&phases=animate&phases=auto-uv&phases=part-segmentation&phases=model-edit&phases=relief"
  + "&sortBy=-created_at";

// Every workspace API call carries the device id the app keeps in
// localStorage, with a cookie of the same name as fallback. Without it the
// API answers 401 even with the session cookies on board.
const MESHY_DEVICE_ID_KEY = "meshy_device_id";

function meshyDeviceId() {
  try {
    const stored = localStorage.getItem(MESHY_DEVICE_ID_KEY);
    if (stored) return stored;
  } catch {
    // Storage can be blocked; fall through to the cookie.
  }
  const match = /(?:^|;\s*)meshy_device_id=([^;]+)/.exec(document.cookie || "");
  return match ? decodeURIComponent(match[1]) : "";
}

// Answers the workspace already received, relayed by meshy-world.js.
const meshyStatusByTask = new Map();
let meshyTaskList = [];
let meshyLibraryAt = 0;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (data?.source !== "meshport" || data.type !== "meshy-capture") return;
  if (data.status?.id && data.status.modelUrl) {
    meshyStatusByTask.set(data.status.id, data.status);
  }
  if (Array.isArray(data.statuses)) {
    for (const status of data.statuses) {
      if (status?.id && status.modelUrl) meshyStatusByTask.set(status.id, status);
    }
  }
  if (Array.isArray(data.list) && data.list.length) {
    const merged = new Map(meshyTaskList.map((task) => [task.id, task]));
    for (const task of data.list) {
      if (!task?.id) continue;
      merged.set(task.id, mergeMeshyTask(merged.get(task.id), task));
    }
    meshyTaskList = [...merged.values()];
  }
});

// The page may have loaded its list before this script started listening.
// Ask meshy-world.js for the answers it kept.
window.postMessage({ source: "meshport", type: "meshy-sync" }, "*");

function meshyOpenTaskId() {
  // Calls that mean "this model is open": PUT .../open, GET .../status, and
  // the bare task detail. Quota pings for every gallery item only prove the
  // task exists, so they lose to any open signal.
  let strong = null;
  let weak = null;
  for (const entry of performance.getEntriesByType("resource")) {
    const match = MESHY_TASK_RE.exec(entry.name || "");
    if (!match) continue;
    const tail = entry.name.slice(match.index + match[0].length).split("?")[0];
    const meansOpen = tail === "" || tail === "/" || /^\/(open|status)\b/i.test(tail);
    const found = { id: match[1], at: entry.startTime };
    if (meansOpen) {
      if (!strong || found.at >= strong.at) strong = found;
    } else if (!weak || found.at >= weak.at) {
      weak = found;
    }
  }
  return strong?.id || weak?.id || "";
}

async function meshyJson(path, step, { method = "GET" } = {}) {
  const deviceId = meshyDeviceId();
  if (!deviceId) {
    throw new Error("Meshport could not read the Meshy session. Reload the Meshy tab, then rescan.");
  }
  let response;
  try {
    response = await fetch(`https://${location.host}/meshyd-api/web${path}`, {
      credentials: "include",
      method,
      headers: { "X-Device-Id": deviceId },
    });
  } catch {
    throw new Error(`Could not reach Meshy to ${step}. Reload the Meshy tab and try again.`);
  }
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.code !== "OK") {
    // The Meshport tag tells a stale injected script from the current one:
    // without it, an old tab and a real failure look identical.
    const detail = typeof payload?.message === "string" && payload.message
      ? ` ${payload.message}`
      : "";
    throw new Error(
      `Meshy answered HTTP ${response.status} when trying to ${step}${detail}`
        + ` (Meshport ${chrome.runtime.getManifest().version}). Reload the Meshy tab, then rescan.`,
    );
  }
  return payload.result;
}

// The list answer stays close to what the workspace rendered: one task per
// library card, with the render and the triangle count. The signed GLB is
// handed out per task, so it is resolved when the user exports.
function meshyAssetUrl(value) {
  return typeof value === "string" && /^https:\/\/assets\.meshy\.ai\//i.test(value)
    ? value
    : "";
}

function meshyTaskUrl(task) {
  // The library answer keeps each finished result under the phase that made
  // it. The workspace reads the same paths, so a model needs no extra status
  // call when its link is already here.
  const phase = String(task?.phase || "").toLowerCase();
  const byPhase = {
    "auto-uv": task?.result?.autoUv?.modelUrl,
    texture: task?.result?.texture?.modelUrl,
    "image-to-3d-texture": task?.result?.texture?.modelUrl,
    stylize: task?.result?.stylize?.modelUrl,
    generate: task?.result?.generate?.modelUrl,
    draft: task?.result?.generate?.modelUrl || task?.result?.draft?.modelUrl,
    upload: task?.result?.generate?.modelUrl || task?.result?.autoUv?.modelUrl,
    "model-edit": task?.result?.modelEdit?.modelUrl,
    "part-segmentation": task?.result?.partSegmentation?.modelUrl,
    relief: task?.result?.relief?.modelUrl,
    animate: task?.result?.animate?.actions?.[0]?.animationGlbUrl,
  };
  const candidates = [
    byPhase[phase],
    task?.result?.autoUv?.modelUrl,
    task?.result?.texture?.modelUrl,
    task?.result?.stylize?.modelUrl,
    task?.result?.generate?.modelUrl,
    task?.result?.face?.modelUrl,
    task?.result?.modelEdit?.modelUrl,
    task?.result?.partSegmentation?.modelUrl,
    task?.result?.relief?.modelUrl,
    task?.result?.animate?.actions?.[0]?.animationGlbUrl,
    task?.result?.modelUrl,
    task?.modelUrl,
    task?.result?.modelUrls?.glb,
    task?.result?.model_urls?.glb,
    task?.modelUrls?.glb,
    task?.model_urls?.glb,
  ];
  for (const value of candidates) {
    const url = meshyAssetUrl(value);
    if (url) return url;
  }
  return "";
}

function meshyTaskPreview(task) {
  const candidates = [
    task?.result?.previewUrl,
    task?.previewUrl,
    task?.result?.thumbnailUrl,
    task?.thumbnailUrl,
    task?.result?.thumbnail_url,
    task?.thumbnail_url,
    task?.result?.imageUrl,
    task?.imageUrl,
  ];
  return candidates.find((value) => typeof value === "string" && value) || "";
}

// The workspace list and the extension's direct list can describe the same
// task. The direct call runs without Meshy's bearer token, so its answer may
// omit the signed links the page already received. Merge field by field and
// keep whichever side still has a usable URL.
function mergeMeshyTask(captured, fetched) {
  if (!captured) return fetched;
  if (!fetched) return captured;
  const merged = { ...captured, ...fetched };
  for (const key of ["name", "status", "phase", "previewUrl", "modelUrl",
    "triangleCount", "vertexCount", "createdAt"]) {
    if ((merged[key] === "" || merged[key] == null || merged[key] === 0) && captured[key]) {
      merged[key] = captured[key];
    }
  }
  if (!meshyTaskUrl(fetched) && meshyTaskUrl(captured)) {
    merged.modelUrl = meshyTaskUrl(captured);
  }
  if (!meshyTaskPreview(fetched) && meshyTaskPreview(captured)) {
    merged.previewUrl = meshyTaskPreview(captured);
  }
  if ((!fetched.result || !Object.keys(fetched.result).length) && captured.result) {
    merged.result = captured.result;
  }
  return merged;
}

function meshyTaskCreatedAt(task) {
  const value = task?.createdAt ?? task?.created_at ?? task?.createdTime ?? "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function meshyTaskCounts(task) {
  return {
    triangles: Number(
      task?.triangleCount
        ?? task?.triangle_count
        ?? task?.faceCount
        ?? task?.face_count
        ?? task?.result?.triangleCount
        ?? task?.result?.faceCount
        ?? task?.result?.generate?.faceCount,
    ) || 0,
    vertices: Number(
      task?.vertexCount
        ?? task?.vertex_count
        ?? task?.result?.vertexCount
        ?? task?.result?.generate?.vertexCount,
    ) || 0,
  };
}

function meshyTaskStatus(task) {
  return String(task?.status ?? task?.result?.status ?? "").toUpperCase();
}

function meshyTaskModel(task) {
  const id = typeof task?.id === "string" ? task.id : "";
  if (!id) return null;
  const status = meshyTaskStatus(task);
  // A task without a finished GLB is not a library model yet. Leaving it out
  // keeps the popup from offering an export that cannot succeed.
  if (status && status !== "SUCCEEDED") return null;
  const cached = meshyStatusByTask.get(id);
  return {
    kind: "meshy",
    projectId: id,
    url: meshyTaskUrl(task) || cached?.modelUrl || "",
    name: typeof task?.name === "string" ? task.name : "",
    createdAt: meshyTaskCreatedAt(task),
    previewUrl: meshyTaskPreview(task) || cached?.previewUrl || "",
    textures: [],
    counts: meshyTaskCounts(task),
  };
}

function meshyStatusResult(answer) {
  const outer = answer?.result;
  const inner = outer && typeof outer === "object" ? outer : answer;
  if (inner?.result && typeof inner.result === "object") return inner.result;
  return inner && typeof inner === "object" ? inner : {};
}

async function meshyOpenTask(taskId) {
  await meshyJson(`/v2/tasks/${taskId}/open`, "open the model", { method: "PUT" })
    .catch(() => {});
}

async function meshyReadTask(taskId) {
  try {
    return await meshyJson(`/v1/tasks/${taskId}/status`, "read the model");
  } catch (error) {
    // The workspace opens a model before reading its status. Retry that way
    // when a direct status call refuses a task the page has not opened.
    await meshyOpenTask(taskId);
    try {
      return await meshyJson(`/v1/tasks/${taskId}/status`, "read the model");
    } catch {
      throw error;
    }
  }
}

// Resolves one task's signed GLB link. The library answer usually carries it
// already; the status endpoint is a fallback because it needs the workspace's
// bearer token, which the extension deliberately does not read.
async function meshyResolveTask(taskId, { fresh = false } = {}) {
  const cached = meshyStatusByTask.get(taskId);
  if (!fresh && cached?.modelUrl) return cached;

  const fromList = async () => {
    const listed = meshyTaskList.find((item) => item?.id === taskId);
    const url = listed ? meshyTaskUrl(listed) : "";
    if (!url) return null;
    const resolved = {
      id: taskId,
      modelUrl: url,
      previewUrl: meshyTaskPreview(listed),
      at: Date.now(),
    };
    meshyStatusByTask.set(taskId, resolved);
    return resolved;
  };

  if (!fresh) {
    const listed = await fromList();
    if (listed) return listed;
    // A list captured before the page had the link is useless. Re-read the
    // library once so a Retry works without forcing a rescan, but throttle it
    // so a batch of linkless models does not hammer the workspace.
    if (Date.now() - meshyLibraryAt > 15000) {
      try {
        await meshyLibrary();
        const refreshed = await fromList();
        if (refreshed) return refreshed;
      } catch {
        // Fall through to the status call.
      }
    }
  } else {
    // An expired link needs a fresh signature. Ask the library first, since
    // that is the same answer the workspace uses without a token.
    try {
      await meshyLibrary();
      const listed = await fromList();
      if (listed && listed.modelUrl !== cached?.modelUrl) return listed;
    } catch {
      // Fall through to the status call.
    }
  }

  let answer;
  try {
    answer = await meshyReadTask(taskId);
  } catch (error) {
    if (/HTTP 401/.test(error.message)) {
      throw new Error(
        "Meshy did not include a download link for this model. Open it once in the Meshy workspace, then rescan.",
      );
    }
    throw error;
  }
  let info = meshyStatusResult(answer);
  let modelUrl = meshyAssetUrl(info.modelUrl);

  if (!modelUrl) {
    // The status can answer without a link until the task is marked open.
    await meshyOpenTask(taskId);
    answer = await meshyJson(`/v1/tasks/${taskId}/status`, "read the model");
    info = meshyStatusResult(answer);
    modelUrl = meshyAssetUrl(info.modelUrl);
  }

  if (!modelUrl) throw new Error("Meshy has no GLB ready for this model yet.");
  const resolved = {
    id: taskId,
    modelUrl,
    previewUrl: typeof info.previewUrl === "string" ? info.previewUrl : "",
    at: Date.now(),
  };
  meshyStatusByTask.set(taskId, resolved);
  return resolved;
}

async function meshyLibrary() {
  if (!meshyDeviceId()) {
    throw new Error("Meshport could not read the Meshy session. Reload the Meshy tab, then rescan.");
  }
  // The page list is the only source the extension has for signed links
  // without the workspace bearer token. Give a replay a moment to arrive when
  // this scan started before meshy-world.js had anything to hand over.
  if (!meshyTaskList.length) {
    window.postMessage({ source: "meshport", type: "meshy-sync" }, "*");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // Stamp the attempt, not only the success, so a failing library call cannot
  // be retried on every queued model.
  meshyLibraryAt = Date.now();
  let fetched = [];
  let captured = false;
  try {
    // Pages hold 50 tasks each; stop at the first partial page. The cap keeps
    // a huge library from turning one scan into a long request chain.
    for (let page = 1; page <= 10; page += 1) {
      const query = MESHY_TASKS_QUERY.replace("pageNum=1", `pageNum=${page}`);
      const batch = await meshyJson(`/v2/tasks${query}`, "read the library");
      if (!Array.isArray(batch) || !batch.length) break;
      fetched.push(...batch);
      if (batch.length < 50) break;
    }
  } catch (error) {
    if (!meshyTaskList.length) throw error;
    captured = true;
  }

  // The sidebar may already have loaded a list with different filters, so
  // union both sources. The direct fetch wins on metadata, but never on a
  // signed link only the page answer carries.
  const merged = new Map();
  for (const task of meshyTaskList) {
    if (task?.id) merged.set(task.id, task);
  }
  for (const task of fetched) {
    if (!task?.id) continue;
    merged.set(task.id, mergeMeshyTask(merged.get(task.id), task));
  }
  const tasks = [...merged.values()];
  meshyTaskList = tasks;

  const models = [];
  const seen = new Set();
  for (const task of tasks) {
    const model = meshyTaskModel(task);
    if (!model || seen.has(model.projectId)) continue;
    seen.add(model.projectId);
    models.push(model);
  }
  // A status answer the page already captured can describe a model the list
  // call missed. Keep it instead of dropping a model the user just opened.
  for (const [id, info] of meshyStatusByTask) {
    if (seen.has(id) || !info?.modelUrl) continue;
    const task = tasks.find((item) => item?.id === id) || { id, status: "SUCCEEDED" };
    const model = meshyTaskModel(task);
    if (!model) continue;
    seen.add(id);
    models.push(model);
  }

  models.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  meshyLibraryAt = Date.now();
  return { ok: true, models, captured };
}

async function meshyModel() {
  const taskId = meshyOpenTaskId();
  if (!taskId) {
    return { ok: false, error: "Open a model in your Meshy workspace, then rescan." };
  }
  let info;
  try {
    info = await meshyResolveTask(taskId);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const task = meshyTaskList.find((item) => item.id === taskId)
    || { id: taskId, status: "SUCCEEDED" };
  const model = meshyTaskModel(task);
  if (!model) {
    return { ok: false, error: "Meshy has no GLB ready for this model yet." };
  }
  return {
    ok: true,
    model: {
      ...model,
      url: info.modelUrl,
      previewUrl: info.previewUrl || model.previewUrl,
    },
  };
}

if (MESHY_HOST) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "get-meshy-library") {
      meshyLibrary()
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "get-meshy-url" && typeof message.taskId === "string") {
      meshyResolveTask(message.taskId, { fresh: Boolean(message.fresh) })
        .then((info) => sendResponse({
          ok: true,
          url: info.modelUrl,
          previewUrl: info.previewUrl,
        }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type !== "get-meshy-model") return;
    meshyModel()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
}
