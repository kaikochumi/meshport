/* Export preferences and audit history shared by the popup and Node tests. */
(function (root) {
  "use strict";

  const HISTORY_KEY = "meshport/export-history/v1";
  const PRESETS_KEY = "meshport/export-presets/v1";
  const HISTORY_LIMIT = 100;
  const FORMATS = new Set(["stl", "obj", "gltf", "glb", "fbx", "textures"]);
  const BUILTIN_PRESETS = Object.freeze([
    { id: "print", name: "3D printing · STL", format: "stl", png: false },
    { id: "blender", name: "Blender · OBJ + PNG", format: "obj", png: true },
    { id: "web", name: "Web / real-time · GLB", format: "glb", png: false },
    { id: "editable", name: "Editable glTF + PNG", format: "gltf", png: true },
    { id: "native", name: "Original Tripo · FBX", format: "fbx", png: false },
    { id: "maps", name: "Textures only", format: "textures", png: false },
  ]);

  function safeLabel(value, fallback = "") {
    return String(value || fallback).replace(/https?:\/\/\S+/gi, "[link]")
      .replace(/(?:token|signature|api[_-]?key|authorization)=\S+/gi, "[redacted]")
      .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160).trim();
  }

  function readArray(store, key) {
    try {
      const data = JSON.parse(store.getItem(key) || "[]");
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function history(store) {
    return readArray(store, HISTORY_KEY).slice(0, HISTORY_LIMIT).filter((item) => item && typeof item === "object");
  }

  /** Store metadata only. Signed download links and raw model bytes are excluded. */
  function recordExport(store, input) {
    if (!FORMATS.has(input?.format)) throw new Error("Unknown export format.");
    const item = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      at: new Date().toISOString(),
      name: safeLabel(input.name, "Model"),
      platform: input.platform === "meshy" ? "meshy" : "tripo",
      format: input.format,
      fileName: safeLabel(input.fileName, "model"),
      bytes: Math.max(0, Math.floor(Number(input.bytes) || 0)),
    };
    const updated = [item, ...history(store)].slice(0, HISTORY_LIMIT);
    store.setItem(HISTORY_KEY, JSON.stringify(updated));
    return item;
  }

  function clearHistory(store) {
    store.removeItem(HISTORY_KEY);
  }

  function presets(store) {
    const custom = readArray(store, PRESETS_KEY).filter((item) => item
      && /^user-[a-zA-Z0-9-]+$/.test(item.id)
      && FORMATS.has(item.format)
      && typeof item.name === "string");
    return [...BUILTIN_PRESETS, ...custom.slice(0, 20)];
  }

  function savePreset(store, name, format, png) {
    const label = safeLabel(name);
    if (!label || !FORMATS.has(format)) throw new Error("Enter a name and valid format.");
    const custom = presets(store).filter((item) => item.id.startsWith("user-"));
    if (custom.length >= 20) throw new Error("You can save up to 20 custom presets.");
    const preset = {
      id: `user-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      name: label.slice(0, 48),
      format,
      png: Boolean(png),
    };
    store.setItem(PRESETS_KEY, JSON.stringify([...custom, preset]));
    return preset;
  }

  function removePreset(store, id) {
    if (typeof id !== "string" || !id.startsWith("user-")) return false;
    const custom = presets(store).filter((item) => item.id.startsWith("user-"));
    store.setItem(PRESETS_KEY, JSON.stringify(custom.filter((item) => item.id !== id)));
    return custom.some((item) => item.id === id);
  }

  /** Model statistics are produced by the sandbox after decoding the GLB. */
  function diagnostics(format, platform, stats) {
    const warnings = [];
    const errors = [];
    if (!FORMATS.has(format)) errors.push("Unsupported export format.");
    if (format === "fbx" && platform === "meshy") {
      errors.push("FBX is only available for Tripo projects.");
    }
    if (format === "fbx") {
      warnings.push("Native export depends on the formats available in the Tripo project.");
      return { warnings, errors };
    }
    if (!stats) return { warnings, errors };
    if (!Number.isFinite(stats.triangles) || stats.triangles < 1) {
      errors.push("The model has no triangle geometry to export.");
    }
    const textureCount = Array.isArray(stats.textures) ? stats.textures.length : 0;
    if (format === "textures" && !textureCount) {
      errors.push("This model has no embedded textures.");
    }
    if (format === "stl" && textureCount) {
      warnings.push("STL keeps geometry only. Colors and textures will be lost.");
    }
    if (format === "obj" && textureCount) {
      warnings.push("OBJ materials and textures are packaged together in a ZIP file.");
    }
    if (stats.triangles > 1000000) {
      warnings.push("Over one million triangles. Processing and importing may be slow.");
    }
    return { warnings, errors };
  }

  root.MeshportExportTools = {
    BUILTIN_PRESETS, HISTORY_LIMIT, history, recordExport, clearHistory,
    presets, savePreset, removePreset, diagnostics,
  };
})(typeof window === "undefined" ? globalThis : window);
