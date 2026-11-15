importScripts("shared.js");

const tabTripoRequests = new Map();
const STORAGE_PREFIX = "tripo-tab-";
const MAX_ENTRIES = 20;

function storageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

function remember(tabId, url) {
  if (tabId < 0 || !isTripoGlbUrl(url)) return;
  const entries = tabTripoRequests.get(tabId) || [];
  if (entries.some((entry) => entry.url === url)) return;

  entries.unshift({ url, capturedAt: Date.now() });
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

function forget(tabId) {
  tabTripoRequests.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") {
      forget(details.tabId);
      return;
    }
    remember(details.tabId, details.url);
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
    remember(sender.tab.id, message.url);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "get-tripo-requests" && Number.isInteger(message.tabId)) {
    getEntries(message.tabId).then((entries) => sendResponse({ entries }));
    return true;
  }
});
