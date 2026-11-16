importScripts("shared.js");

const tabTripoRequests = new Map();
const tabDetailProjects = new Map();
const recentModels = [];
const STORAGE_PREFIX = "tripo-tab-";
const RECENT_KEY = "tripo-recent";
const MAX_ENTRIES = 20;
const RECENT_LIMIT = 30;
const RECENT_TTL = 30 * 60 * 1000;
const DETAIL_BIND_TTL = 2 * 60 * 1000;

function storageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

function pruneRecent(list) {
  const cutoff = Date.now() - RECENT_TTL;
  return list.filter((entry) => entry?.url && (entry.capturedAt || 0) >= cutoff);
}

function rememberRecent(url, projectId = "") {
  if (!isTripoGlbUrl(url)) return;
  const index = recentModels.findIndex((entry) => entry.url === url);
  if (index >= 0) {
    const previous = recentModels[index];
    if (!projectId && previous.projectId) projectId = previous.projectId;
    recentModels.splice(index, 1);
  }
  recentModels.unshift({ url, capturedAt: Date.now(), projectId });
  while (recentModels.length > RECENT_LIMIT) recentModels.pop();
  chrome.storage.session.set({ [RECENT_KEY]: recentModels }).catch(() => {});
}

function remember(tabId, url, projectId = "") {
  if (!isTripoGlbUrl(url)) return;
  rememberRecent(url, projectId);
  if (tabId < 0) return;

  const entries = tabTripoRequests.get(tabId) || [];
  const existing = entries.find((entry) => entry.url === url);
  if (existing) {
    if (!existing.projectId && projectId) existing.projectId = projectId;
    return;
  }

  entries.unshift({ url, capturedAt: Date.now(), projectId });
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
      if (isTripoGlbUrl(details.url)) remember(details.tabId, details.url, "");
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
      return;
    }

    const documentProjectId = tripoProjectIdFromUrl(documentUrl);
    if (documentProjectId) {
      remember(details.tabId, details.url, documentProjectId);
      return;
    }
    if (!isTripoGlbUrl(details.url)) return;

    const detail = tabDetailProjects.get(details.tabId);
    const fresh = detail
      && Date.now() - detail.at < DETAIL_BIND_TTL
      && (!documentUrl || !detail.documentUrl || detail.documentUrl === documentUrl);
    remember(details.tabId, details.url, fresh ? detail.projectId : "");
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
    remember(sender.tab.id, message.url, "");
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "get-tripo-requests" && Number.isInteger(message.tabId)) {
    Promise.all([getEntries(message.tabId), getRecent()])
      .then(([entries, recent]) => sendResponse({ entries, recent }))
      .catch(() => sendResponse({ entries: [], recent: [] }));
    return true;
  }
});
