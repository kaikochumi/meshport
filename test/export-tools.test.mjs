import test from "node:test";
import assert from "node:assert/strict";
import "../chrome-extension/export-tools.js";

const {
  BUILTIN_PRESETS, HISTORY_LIMIT, history, recordExport, clearHistory,
  presets, savePreset, removePreset, diagnostics,
} = globalThis.MeshportExportTools;

function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("presets include six built-in export workflows", () => {
  const all = presets(storage());
  assert.equal(all.length, 6);
  assert.deepEqual(all, BUILTIN_PRESETS);
  assert.deepEqual(new Set(all.map((item) => item.format)),
    new Set(["stl", "obj", "gltf", "glb", "fbx", "textures"]));
});

test("custom presets preserve settings and can be deleted without changing built-ins", () => {
  const store = storage();
  const created = savePreset(store, "My Blender workflow", "obj", true);
  assert.match(created.id, /^user-/);
  assert.equal(created.png, true);
  assert.deepEqual(presets(store).at(-1), created);
  assert.equal(removePreset(store, "print"), false);
  assert.equal(removePreset(store, created.id), true);
  assert.equal(removePreset(store, created.id), false);
  assert.deepEqual(presets(store), BUILTIN_PRESETS);
});

test("custom presets reject invalid formats, blank names and excess entries", () => {
  const store = storage();
  assert.throws(() => savePreset(store, "", "glb", true), /name/i);
  assert.throws(() => savePreset(store, "bad", "exe", false), /format/i);
  for (let i = 0; i < 20; i++) savePreset(store, `Preset ${i}`, "glb", false);
  assert.equal(presets(store).length, 26);
  assert.throws(() => savePreset(store, "Extra", "glb", false), /20/);
});

test("malformed or edited preset storage is safely ignored", () => {
  const store = storage();
  store.setItem("meshport/export-presets/v1", "not JSON");
  assert.deepEqual(presets(store), BUILTIN_PRESETS);
  store.setItem("meshport/export-presets/v1", JSON.stringify([
    null, 4, { id: "print", name: "Overwrite", format: "fbx" },
    { id: "user-bad", name: "Bad", format: "script" },
    { id: "user-good", name: "Good", format: "glb", png: true },
  ]));
  assert.equal(presets(store).length, 7);
  assert.equal(presets(store).at(-1).name, "Good");
});

test("export history keeps metadata only and redacts signed URLs and tokens", () => {
  const store = storage();
  const recorded = recordExport(store, {
    name: "Chair https://example.com/model?X-Amz-Signature=secret",
    platform: "meshy",
    format: "glb",
    fileName: "chair.glb?token=secret",
    bytes: 4096.6,
    signedUrl: "https://example.com/private",
    buffer: new ArrayBuffer(100),
  });
  assert.equal(recorded.platform, "meshy");
  assert.equal(recorded.bytes, 4096);
  assert.equal(recorded.name, "Chair [link]");
  assert.doesNotMatch(JSON.stringify(history(store)), /secret|private|signedUrl|buffer/);
  assert.deepEqual(Object.keys(recorded).sort(),
    ["at", "bytes", "fileName", "format", "id", "name", "platform"].sort());
});

test("history caps at 100 newest records, persists, and can be cleared", () => {
  const store = storage();
  for (let i = 0; i < HISTORY_LIMIT + 9; i++) {
    recordExport(store, { name: `Model ${i}`, platform: "tripo", format: "stl", bytes: i });
  }
  assert.equal(history(store).length, HISTORY_LIMIT);
  assert.equal(history(store)[0].name, `Model ${HISTORY_LIMIT + 8}`);
  assert.equal(history(store).at(-1).name, "Model 9");
  clearHistory(store);
  assert.deepEqual(history(store), []);
  assert.throws(() => recordExport(store, { format: "invalid" }), /format/i);
});

test("history ignores corrupt storage and non-object entries", () => {
  const store = storage();
  store.setItem("meshport/export-history/v1", "broken");
  assert.deepEqual(history(store), []);
  store.setItem("meshport/export-history/v1", JSON.stringify([null, false, 1, "text", { name: "ok" }]));
  assert.deepEqual(history(store), [{ name: "ok" }]);
});

test("compatibility diagnostics flag unsupported formats, absent mesh and missing textures", () => {
  assert.match(diagnostics("fbx", "meshy").errors.join(" "), /Tripo/);
  assert.match(diagnostics("unknown", "tripo").errors.join(" "), /Unsupported/);
  assert.match(diagnostics("stl", "tripo", { triangles: 0, textures: [] }).errors.join(" "), /no triangle/);
  assert.match(diagnostics("textures", "tripo", { triangles: 1, textures: [] }).errors.join(" "), /no embedded textures/);
});

test("compatibility diagnostics explain format losses and large meshes", () => {
  const stats = { triangles: 1000001, textures: [{ name: "baseColor" }] };
  assert.match(diagnostics("stl", "tripo", stats).warnings.join(" "), /Colors and textures/);
  assert.match(diagnostics("obj", "tripo", stats).warnings.join(" "), /ZIP/);
  assert.match(diagnostics("glb", "tripo", stats).warnings.join(" "), /one million triangles/);
  assert.deepEqual(diagnostics("glb", "tripo", { triangles: 12, textures: [] }), { warnings: [], errors: [] });
});
