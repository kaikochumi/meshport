import test from "node:test";
import assert from "node:assert/strict";
import "../chrome-extension/shared.js";

const {
  isTripoGlbUrl,
  tripoFileStem,
  tripoLibraryProject,
  tripoModelMatchesStem,
  tripoProjectIdFromDetailUrl,
  tripoProjectIdFromUrl,
} = globalThis;

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

test("tripoFileStem reads FBX and archive links too", () => {
  assert.equal(
    tripoFileStem("https://tripo-data.rg1.data.tripo3d.com/a/tripo_pbr_model_23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d_meshopt.fbx"),
    "23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d",
  );
  assert.equal(
    tripoFileStem("https://tripo-data.rg1.data.tripo3d.com/a/tripo_pbr_model_23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d.zip"),
    "23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d",
  );
});

test("tripoModelMatchesStem keeps captures of another model out", () => {
  const survivor = "https://tripo-data.rg1.data.tripo3d.com/a/tripo_pbr_model_23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d_meshopt.glb";
  const street = "https://tripo-data.rg1.data.tripo3d.com/a/tripo_pbr_model_9d2c71b3-6e54-4f20-8a19-3c5d7e6f8091_meshopt.glb";
  assert.equal(tripoModelMatchesStem(survivor, "23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d"), true);
  assert.equal(tripoModelMatchesStem(street, "23ff3b1e-7ba5-4977-a492-9d9f2a1c5b3d"), false);
  assert.equal(tripoModelMatchesStem(street, ""), true);
});

test("tripoProjectIdFromDetailUrl reads the project detail request", () => {
  assert.equal(
    tripoProjectIdFromDetailUrl("https://api.tripo3d.ai/v2/studio/project/detail/v3/ad7cfcb4-92d8-4be0-a90f-2f8d64afa111?operator_id=x"),
    "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111",
  );
  assert.equal(tripoProjectIdFromDetailUrl("https://api.tripo3d.ai/v2/studio/assets/v2"), "");
  assert.equal(tripoProjectIdFromDetailUrl("nope"), "");
});

test("tripoProjectIdFromUrl reads the workspace route", () => {
  assert.equal(
    tripoProjectIdFromUrl("https://studio.tripo3d.ai/workspace/generate/ad7cfcb4-92d8-4be0-a90f-2f8d64afa111?tab=model"),
    "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111",
  );
  assert.equal(
    tripoProjectIdFromUrl("https://studio.tripo3d.ai/workspace/generate/ad7cfcb4-92d8-4be0-a90f-2f8d64afa111/"),
    "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111",
  );
});

test("tripoProjectIdFromUrl ignores other pages", () => {
  assert.equal(tripoProjectIdFromUrl("https://studio.tripo3d.ai/workspace"), "");
  assert.equal(tripoProjectIdFromUrl("https://studio.tripo3d.ai/workspace/generate"), "");
  assert.equal(tripoProjectIdFromUrl("not a url"), "");
  assert.equal(tripoProjectIdFromUrl(null), "");
});

test("tripoLibraryProject reads the name, best cover and timestamp", () => {
  const card = tripoLibraryProject({
    id: "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111",
    project_name: "  Street Van  ",
    create_time: "2026-11-15T10:00:00Z",
    cover_image_object: [{
      sizes: [
        { width: 128, url: "https://tripo-data.rg1.data.tripo3d.com/cover-small.png" },
        { width: 512, url: "https://tripo-data.rg1.data.tripo3d.com/cover-large.png" },
      ],
    }],
  }, "collected");

  assert.deepEqual(card, {
    id: "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111",
    name: "Street Van",
    cover: "https://tripo-data.rg1.data.tripo3d.com/cover-large.png",
    createdAt: "2026-11-15T10:00:00.000Z",
    scope: "collected",
  });
});

test("tripoLibraryProject falls back to the short description and cover_image", () => {
  const card = tripoLibraryProject({
    id: "5c1e9a72-8f43-4d61-b2a0-7e9c3f18d644",
    biz_info: { short_description: "Avocado" },
    create_time: 1763200000,
    cover_image: ["https://tripo-data.rg1.data.tripo3d.com/cover.png"],
  });

  assert.equal(card.name, "Avocado");
  assert.equal(card.cover, "https://tripo-data.rg1.data.tripo3d.com/cover.png");
  assert.equal(card.createdAt, new Date(1763200000 * 1000).toISOString());
  assert.equal(card.scope, "mine");
});

test("tripoLibraryProject drops unsafe covers and empty projects", () => {
  assert.equal(tripoLibraryProject({ project_name: "No id" }), null);
  const card = tripoLibraryProject({
    id: "9d2c71b3-6e54-4f20-8a19-3c5d7e6f8091",
    cover_image: ["data:image/png;base64,AAAA", "javascript:alert(1)"],
  });
  assert.equal(card.cover, "");
  assert.equal(card.name, "");
});

