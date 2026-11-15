import test from "node:test";
import assert from "node:assert/strict";
import "../chrome-extension/shared.js";

const { isTripoGlbUrl, tripoFileStem } = globalThis;

const MODEL = "https://tripo-data.rg1.data.tripo3d.com/2026/11/15/tripo-studio/tripo_pbr_model_23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d_meshopt.glb";

test("accepts a real Tripo meshopt model URL", () => {
  assert.equal(isTripoGlbUrl(MODEL), true);
});

test("rejects a URL assembled from escaped page state", () => {
  assert.equal(
    isTripoGlbUrl("https://studio.tripo3d.ai/u002Ftripo_pbr_model_23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d_meshopt.glb"),
    false,
  );
});

test("rejects GLB files on other hosts", () => {
  assert.equal(isTripoGlbUrl("https://example.com/tripo_pbr_model_23ff3b1e_meshopt.glb"), false);
});

test("rejects non-model GLB files on Tripo hosts", () => {
  assert.equal(isTripoGlbUrl("https://tripo-data.rg1.data.tripo3d.com/icons/logo.glb"), false);
});

test("tripoFileStem returns the model id", () => {
  assert.equal(
    tripoFileStem("https://tripo-data.rg1.data.tripo3d.com/a/tripo_pbr_model_23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d_meshopt.glb"),
    "23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d",
  );
});
