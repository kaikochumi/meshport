(() => {
  const PATTERN = /https?:\/\/[^"'\\\s<>]+\.glb[^"'\\\s<>]*/gi;
  const seen = new Set();
  const seenRequests = new Set();

  function requestUrl(value) {
    try {
      const raw = typeof value === "string" ? value : value?.url;
      if (typeof raw !== "string" || !raw) return "";
      const url = new URL(raw, location.href);
      url.hash = "";
      return url.href;
    } catch {
      return "";
    }
  }

  function reportRequest(value) {
    const url = requestUrl(value);
    if (!url || !/\.glb(?:[?#]|$)/i.test(url)) return;
    if (seenRequests.has(url)) return;
    seenRequests.add(url);
    window.postMessage({ source: "meshport", type: "model-request", url }, "*");
  }

  function report(text) {
    if (typeof text !== "string") return;
    const normalized = text.replaceAll("\\/", "/").replace(/\\u002f/gi, "/");
    if (!normalized.includes("tripo_")) return;
    PATTERN.lastIndex = 0;
    let match;
    while ((match = PATTERN.exec(normalized))) {
      const url = match[0].split("#")[0];
      if (seen.has(url)) continue;
      seen.add(url);
      window.postMessage({ source: "meshport", type: "model-url", url }, "*");
    }
  }

  function flush() {
    for (const url of seen) {
      window.postMessage({ source: "meshport", type: "model-url", url }, "*");
    }
  }

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      reportRequest(args[0]);
      const promise = originalFetch.apply(this, args);
      promise.then((response) => {
        try {
          const type = response.headers.get("content-type") || "";
          if (/json|javascript|text\/plain/i.test(type) && !/event-stream/i.test(type)) {
            response.clone().text().then(report).catch(() => {});
          }
        } catch {
          // Ignore unreadable responses.
        }
      }).catch(() => {});
      return promise;
    };
  }

  if (typeof window.XMLHttpRequest === "function") {
    const open = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      reportRequest(url);
      this.addEventListener("load", () => {
        try {
          if (typeof this.responseText === "string") report(this.responseText);
        } catch {
          // Binary responses have no responseText.
        }
      });
      return open.call(this, method, url, ...rest);
    };
  }

  function wrapChannel(Original, eventName) {
    if (typeof Original !== "function") return Original;
    function Wrapped(...args) {
      const channel = new Original(...args);
      channel.addEventListener(eventName, (event) => {
        if (typeof event.data === "string") report(event.data);
      });
      return channel;
    }
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    return Wrapped;
  }

  window.WebSocket = wrapChannel(window.WebSocket, "message");
  window.EventSource = wrapChannel(window.EventSource, "message");

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source === "meshport-content" && event.data.type === "ready") flush();
  });

  document.addEventListener("DOMContentLoaded", () => {
    for (const script of document.scripts) {
      if (!script.src && script.textContent) report(script.textContent);
    }
  });
})();
