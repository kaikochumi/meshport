const reported = new Set();
const liveUrls = new Set();

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
  if (message?.type !== "scan-tripo-links") return;
  sendResponse({ links: reportCollected() });
});
