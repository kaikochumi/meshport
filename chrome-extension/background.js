importScripts("shared.js");

const tabTripoRequests = new Map();
const tabDetailProjects = new Map();
const recentModels = [];
const projectOperators = new Map();
const STORAGE_PREFIX = "tripo-tab-";
const RECENT_KEY = "tripo-recent";
const OPERATORS_KEY = "tripo-operators";
const MAX_ENTRIES = 20;
const RECENT_LIMIT = 30;
const RECENT_TTL = 30 * 60 * 1000;
const OPERATOR_TTL = 30 * 60 * 1000;
const OPERATOR_LIMIT = 20;
const DETAIL_BIND_TTL = 2 * 60 * 1000;

function storageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

function pruneRecent(list) {
  const cutoff = Date.now() - RECENT_TTL;
  return list.filter((entry) => entry?.url && (entry.capturedAt || 0) >= cutoff);
}

function rememberRecent(url, projectId = "", doc = "") {
  if (!isTripoGlbUrl(url)) return;
  const index = recentModels.findIndex((entry) => entry.url === url);
  if (index >= 0) {
    const previous = recentModels[index];
    if (!projectId && previous.projectId) projectId = previous.projectId;
    if (!doc && previous.doc) doc = previous.doc;
    recentModels.splice(index, 1);
  }
  recentModels.unshift({ url, capturedAt: Date.now(), projectId, doc });
  while (recentModels.length > RECENT_LIMIT) recentModels.pop();
  chrome.storage.session.set({ [RECENT_KEY]: recentModels }).catch(() => {});
}

function remember(tabId, url, projectId = "", doc = "") {
  if (!isTripoGlbUrl(url)) return;
  rememberRecent(url, projectId, doc);
  if (tabId < 0) return;

  const entries = tabTripoRequests.get(tabId) || [];
  const existing = entries.find((entry) => entry.url === url);
  if (existing) {
    if (!existing.projectId && projectId) existing.projectId = projectId;
    if (!existing.doc && doc) existing.doc = doc;
    return;
  }

  entries.unshift({ url, capturedAt: Date.now(), projectId, doc });
  const trimmed = entries.slice(0, MAX_ENTRIES);
  tabTripoRequests.set(tabId, trimmed);
  chrome.storage.session.set({ [storageKey(tabId)]: trimmed }).catch(() => {});
}

async function getEntries(tabId) {
  const cached = tabTripoRequests.get(tabId);
  if (cached?.length) return cached;

  try {
    const stored = await chrome.storage.session.get(storageKey(tabId));
    const entries = stored[storageKey(tabId)] || [];
    if (entries.length) tabTripoRequests.set(tabId, entries);
    return entries;
  } catch {
    return [];
  }
}

async function getRecent() {
  if (!recentModels.length) {
    try {
      const stored = await chrome.storage.session.get(RECENT_KEY);
      recentModels.push(...pruneRecent(stored[RECENT_KEY] || []));
    } catch {
      return [];
    }
  }
  const pruned = pruneRecent(recentModels);
  if (pruned.length !== recentModels.length) {
    recentModels.length = 0;
    recentModels.push(...pruned);
  }
  return pruned;
}

// The project page calls the detail endpoint with the current operator id in
// the query string. That id is what Tripo names GLB files after, so keep it
// per project as a trusted stem for downloads.
async function rememberOperators(projectId, operatorId) {
  if (!projectId || !operatorId) return;
  const entries = projectOperators.get(projectId) || [];
  const existing = entries.find((entry) => entry.id === operatorId);
  if (existing) {
    existing.at = Date.now();
  } else {
    entries.push({ id: operatorId, at: Date.now() });
    while (entries.length > OPERATOR_LIMIT) entries.shift();
  }
  projectOperators.set(projectId, entries);
  const snapshot = {};
  for (const [id, list] of projectOperators) snapshot[id] = list;
  chrome.storage.session.set({ [OPERATORS_KEY]: snapshot }).catch(() => {});
}

async function getOperators() {
  if (!projectOperators.size) {
    try {
      const stored = await chrome.storage.session.get(OPERATORS_KEY);
      for (const [projectId, list] of Object.entries(stored[OPERATORS_KEY] || {})) {
        if (Array.isArray(list)) projectOperators.set(projectId, list);
      }
    } catch {
      return {};
    }
  }
  const cutoff = Date.now() - OPERATOR_TTL;
  const snapshot = {};
  for (const [projectId, list] of projectOperators) {
    const fresh = list.filter((entry) => (entry.at || 0) >= cutoff).map((entry) => entry.id);
    if (fresh.length) snapshot[projectId] = fresh;
  }
  return snapshot;
}

function forget(tabId) {
  tabTripoRequests.delete(tabId);
  tabDetailProjects.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === "main_frame") {
      if (details.tabId >= 0) forget(details.tabId);
      return;
    }
    if (details.tabId < 0) {
      if (isTripoGlbUrl(details.url)) {
        remember(details.tabId, details.url, "", details.documentUrl || "");
      }
      return;
    }

    const documentUrl = details.documentUrl || "";
    const detailProjectId = tripoProjectIdFromDetailUrl(details.url);
    if (detailProjectId) {
      tabDetailProjects.set(details.tabId, {
        projectId: detailProjectId,
        documentUrl,
        at: Date.now(),
      });
      try {
        const operatorId = new URL(details.url).searchParams.get("operator_id");
        if (operatorId) rememberOperators(detailProjectId, operatorId.slice(0, 128));
      } catch {
        // The detail link stays usable without the operator id.
      }
      return;
    }

    const documentProjectId = tripoProjectIdFromUrl(documentUrl);
    if (documentProjectId) {
      remember(details.tabId, details.url, documentProjectId, documentUrl);
      return;
    }
    if (!isTripoGlbUrl(details.url)) return;

    const detail = tabDetailProjects.get(details.tabId);
    const fresh = detail
      && Date.now() - detail.at < DETAIL_BIND_TTL
      && (!documentUrl || !detail.documentUrl || detail.documentUrl === documentUrl);
    remember(details.tabId, details.url, fresh ? detail.projectId : "", documentUrl);
  },
  { urls: [
    "*://tripo3d.ai/*",
    "*://*.tripo3d.ai/*",
    "*://tripo3d.com/*",
    "*://*.tripo3d.com/*",
  ] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  forget(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "remember-tripo-url" && sender.tab?.id !== undefined) {
    const projectId = typeof message.projectId === "string"
      ? message.projectId.slice(0, 128)
      : "";
    const doc = projectId ? (sender.tab.url || "") : "";
    remember(sender.tab.id, message.url, projectId, doc);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "get-tripo-requests" && Number.isInteger(message.tabId)) {
    Promise.all([getEntries(message.tabId), getRecent(), getOperators()])
      .then(([entries, recent, operators]) => sendResponse({ entries, recent, operators }))
      .catch(() => sendResponse({ entries: [], recent: [], operators: {} }));
    return true;
  }
});
