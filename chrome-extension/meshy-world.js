// Meshy's workspace already fetches everything Meshport needs: opening a
// model triggers /v1/tasks/{id}/status, which answers with the signed GLB
// link, and the sidebar fetches /v2/tasks, which answers with names and
// triangle counts. This script runs in the page, watches those two
// responses, and hands them to the content script. Meshport itself never
// has to call the Meshy API, so its credentials can never be rejected.
(() => {
  if (window.__meshportMeshyHook) return;
  window.__meshportMeshyHook = true;

  const STATUS_RE = /meshyd-api\/web\/v1\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/status/i;
  const LIST_RE = /meshyd-api\/web\/v2\/tasks(?:\?|$)/i;

  function send(payload) {
    try {
      window.postMessage({ source: "meshport", type: "meshy-capture", ...payload }, "*");
    } catch {
      // Navigation can kill the page mid-capture.
    }
  }

  function fromStatus(id, body) {
    const result = body?.result;
    if (!result || typeof result !== "object") return;
    const modelUrl = typeof result.modelUrl === "string" ? result.modelUrl : "";
    if (!/^https:\/\/assets\.meshy\.ai\//i.test(modelUrl)) return;
    send({
      status: {
        id,
        modelUrl,
        previewUrl: typeof result.previewUrl === "string" ? result.previewUrl : "",
        at: Date.now(),
      },
    });
  }

  function fromList(body) {
    const tasks = Array.isArray(body?.result) ? body.result : [];
    const slim = [];
    for (const task of tasks) {
      if (typeof task?.id !== "string" || !task.id) continue;
      slim.push({
        id: task.id,
        name: typeof task.name === "string" ? task.name : "",
        triangleCount: Number(task.triangleCount) || 0,
        vertexCount: Number(task.vertexCount) || 0,
      });
    }
    if (slim.length) send({ list: slim });
  }

  async function watchStatus(url, request) {
    const match = STATUS_RE.exec(url);
    try {
      const response = await request;
      const body = await response.clone().json();
      fromStatus(match[1], body);
    } catch {
      // Responses that are not JSON, or network errors, are not our business.
    }
  }

  async function watchList(request) {
    try {
      const response = await request;
      const body = await response.clone().json();
      fromList(body);
    } catch {
      // Same as above.
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const request = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (STATUS_RE.test(url)) watchStatus(url, request);
      else if (LIST_RE.test(url)) watchList(request);
    } catch {
      // Watching must never break the page.
    }
    return request;
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      const target = String(url || "");
      const statusMatch = STATUS_RE.exec(target);
      if (statusMatch || LIST_RE.test(target)) {
        this.addEventListener("load", () => {
          try {
            const body = JSON.parse(this.responseText);
            if (statusMatch) fromStatus(statusMatch[1], body);
            else fromList(body);
          } catch {
            // Not JSON, not ours.
          }
        });
      }
    } catch {
      // Watching must never break the page.
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };
})();
