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

  // The workspace often fetches its first list before the content script is
  // ready to listen. Keep the answers here and replay them when asked, so a
  // late listener still gets the signed links the page already received.
  const taskList = new Map();
  const statusById = new Map();

  function send(payload) {
    try {
      window.postMessage({ source: "meshport", type: "meshy-capture", ...payload }, "*");
    } catch {
      // Navigation can kill the page mid-capture.
    }
  }

  function listSnapshot() {
    return [...taskList.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function rememberList(slim) {
    for (const item of slim) {
      const previous = taskList.get(item.id);
      // A later list request may come from a filtered view with less data.
      // Never let a missing field erase a name, date, count, or signed link
      // captured earlier; only a real value replaces the previous one.
      const next = { ...previous, ...item };
      for (const key of ["name", "status", "phase", "previewUrl", "modelUrl",
        "triangleCount", "vertexCount", "createdAt"]) {
        const value = item[key];
        if ((value === "" || value == null || value === 0) && previous?.[key]) {
          next[key] = previous[key];
        }
      }
      taskList.set(item.id, next);
    }
  }

  function fromStatus(id, body) {
    // The status answer wraps the model info twice: result.result carries
    // the model link and preview. An older single-wrap shape still works.
    const outer = body?.result;
    const result = outer?.result && typeof outer.result === "object" ? outer.result : outer;
    if (!result || typeof result !== "object") return;
    const modelUrl = typeof result.modelUrl === "string" ? result.modelUrl : "";
    if (!/^https:\/\/assets\.meshy\.ai\//i.test(modelUrl)) return;
    const status = {
      id,
      modelUrl,
      previewUrl: typeof result.previewUrl === "string" ? result.previewUrl : "",
      at: Date.now(),
    };
    statusById.set(id, status);
    send({ status });
  }

  function fromList(body) {
    const tasks = Array.isArray(body?.result) ? body.result : [];
    const slim = [];
    for (const task of tasks) {
      if (typeof task?.id !== "string" || !task.id) continue;
      // The list nests finished results by phase. A texture task can carry
      // both the base auto-UV mesh and the textured mesh, so follow the task's
      // phase first; otherwise the batch would export the untextured mesh.
      const phase = String(task.phase || "").toLowerCase();
      const phaseUrl = {
        "auto-uv": task.result?.autoUv?.modelUrl,
        autouv: task.result?.autoUv?.modelUrl,
        texture: task.result?.texture?.modelUrl,
        "image-to-3d-texture": task.result?.texture?.modelUrl,
        stylize: task.result?.stylize?.modelUrl,
        generate: task.result?.generate?.modelUrl,
        draft: task.result?.generate?.modelUrl || task.result?.draft?.modelUrl,
        upload: task.result?.generate?.modelUrl || task.result?.autoUv?.modelUrl,
        face: task.result?.face?.modelUrl,
        "model-edit": task.result?.modelEdit?.modelUrl,
        modeledited: task.result?.modelEdit?.modelUrl,
        "part-segmentation": task.result?.partSegmentation?.modelUrl,
        relief: task.result?.relief?.modelUrl,
        animate: task.result?.animate?.actions?.[0]?.animationGlbUrl,
      }[phase];
      const modelUrl = [
        phaseUrl,
        task.result?.autoUv?.modelUrl,
        task.result?.texture?.modelUrl,
        task.result?.stylize?.modelUrl,
        task.result?.generate?.modelUrl,
        task.result?.face?.modelUrl,
        task.result?.modelEdit?.modelUrl,
        task.result?.partSegmentation?.modelUrl,
        task.result?.relief?.modelUrl,
        task.result?.animate?.actions?.[0]?.animationGlbUrl,
        task.result?.modelUrl,
        task.modelUrl,
        task.result?.modelUrls?.glb,
        task.result?.model_urls?.glb,
        task.modelUrls?.glb,
        task.model_urls?.glb,
      ].find((value) => typeof value === "string" && /^https:\/\/assets\.meshy\.ai\//i.test(value)) || "";
      const createdAt = task.createdAt ?? task.created_at ?? 0;
      slim.push({
        id: task.id,
        name: typeof task.name === "string" ? task.name : "",
        status: typeof task.status === "string" ? task.status : "",
        phase: typeof task.phase === "string" ? task.phase : "",
        previewUrl: [
          task.result?.previewUrl,
          task.previewUrl,
          task.result?.thumbnailUrl,
          task.thumbnailUrl,
        ].find((value) => typeof value === "string" && value) || "",
        triangleCount: Number(task.triangleCount ?? task.faceCount ?? task.face_count) || 0,
        vertexCount: Number(task.vertexCount ?? task.vertex_count) || 0,
        createdAt: typeof createdAt === "number" ? createdAt : Date.parse(createdAt) || 0,
        modelUrl,
      });
    }
    if (!slim.length) return;
    rememberList(slim);
    send({ list: listSnapshot() });
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

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== "meshport" || data.type !== "meshy-sync") return;
    if (taskList.size) send({ list: listSnapshot() });
    for (const status of statusById.values()) send({ status });
  });

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
