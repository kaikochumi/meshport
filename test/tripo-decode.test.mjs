import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildGltfPackage,
  buildObj,
  decodeTripo,
  describeModel,
  extractTextures,
  handleSandboxMessage,
  makeOutputs,
  readGlb,
} from "../chrome-extension/sandbox.js";
import { decodeTripoGlb } from "../chrome-extension/vendor/tripo_loader.js";

const fixtureBytes = await readFile(new URL("./fixtures/cube-meshopt.glb", import.meta.url));
const FIXTURE = fixtureBytes.buffer.slice(
  fixtureBytes.byteOffset,
  fixtureBytes.byteOffset + fixtureBytes.byteLength
);

function objBounds(obj) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const line of obj.split("\n")) {
    if (!line.startsWith("v ")) continue;
    const [x, y, z] = line.slice(2).split(" ").map(Number);
    [x, y, z].forEach((value, axis) => {
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    });
    count += 1;
  }
  return { count, min, max };
}

test("fixture uses meshopt compression and quantization", () => {
  const { json } = readGlb(FIXTURE);
  assert.ok(json.extensionsUsed.includes("EXT_meshopt_compression"));
  assert.ok(json.extensionsUsed.includes("KHR_mesh_quantization"));
  assert.ok(json.extensionsRequired.includes("EXT_meshopt_compression"));
  assert.ok(json.extensionsRequired.includes("KHR_mesh_quantization"));
});

test("decodeTripoGlb removes compression and quantization", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const { json } = readGlb(clean);
  assert.equal(json.extensionsUsed?.includes("EXT_meshopt_compression"), false);
  assert.equal(json.extensionsUsed?.includes("KHR_mesh_quantization"), false);
  assert.equal(json.extensionsRequired, undefined);
  assert.ok(json.meshes.length > 0);
});

test("decoded cube keeps its geometry and texture", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const { json, bin } = readGlb(clean);
  const stats = describeModel(json);
  assert.equal(stats.triangles, 12);
  assert.equal(stats.vertices, 24);
  assert.equal(stats.images, 1);

  const textures = extractTextures(json, bin, "cube");
  assert.equal(textures.length, 1);
  assert.equal(textures[0].mimeType, "image/png");
  assert.deepEqual([...textures[0].bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("decoded geometry matches the uncompressed cube", async () => {
  const sourceBytes = await readFile(new URL("./fixtures/cube.glb", import.meta.url));
  const source = sourceBytes.buffer.slice(
    sourceBytes.byteOffset,
    sourceBytes.byteOffset + sourceBytes.byteLength
  );
  const clean = await decodeTripoGlb(FIXTURE);
  const sourceGlb = readGlb(source);
  const cleanGlb = readGlb(clean);
  const expected = objBounds(buildObj(sourceGlb.json, sourceGlb.bin, { baseName: "cube" }));
  const actual = objBounds(buildObj(cleanGlb.json, cleanGlb.bin, { baseName: "cube" }));

  assert.equal(actual.count, expected.count);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(actual.min[axis] - expected.min[axis]) < 1e-3);
    assert.ok(Math.abs(actual.max[axis] - expected.max[axis]) < 1e-3);
  }
});

test("sandbox cache returns the cleaned GLB without a new buffer", async () => {
  const first = await decodeTripo(FIXTURE);
  const second = await decodeTripo(null);
  assert.equal(second, first);
  const { json } = readGlb(second);
  assert.equal(describeModel(json).triangles, 12);
});

test("STL export writes 12 triangles", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const result = await makeOutputs(clean, "stl", { baseName: "cube" });
  assert.equal(result.fileName, "cube.stl");
  assert.equal(result.bytes.length, 84 + 50 * 12);

  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
  assert.equal(view.getUint32(80, true), 12);
  assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 5)), "Conve");
});

test("OBJ export keeps UVs and the material library", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const { json, bin } = readGlb(clean);
  const obj = buildObj(json, bin, { baseName: "cube" });
  assert.match(obj, /^mtllib cube\.mtl$/m);
  assert.match(obj, /^usemtl /m);
  assert.ok(obj.split("\n").some((line) => line.startsWith("vt ")));
  assert.equal(obj.split("\n").filter((line) => line.startsWith("v ")).length, 24);
});

test("glTF package references the decoded PNG texture", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const { json, bin } = readGlb(clean);
  const textures = extractTextures(json, bin, "cube");
  const result = buildGltfPackage(json, bin, "cube", textures);
  const output = JSON.parse(result.json);
  assert.ok(output.images.some((image) => image.uri?.endsWith(".png")));
  assert.equal(output.buffers[0].byteLength, bin.byteLength);
});

test("texture archive contains the decoded PNG", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const result = await makeOutputs(clean, "textures", { baseName: "cube" });
  const names = new TextDecoder("latin1").decode(result.bytes);
  assert.match(names, /cube_baseColor\.png/);
});

test("GLB export writes the cleaned model", async () => {
  const clean = await decodeTripoGlb(FIXTURE);
  const result = await makeOutputs(clean, "glb", { baseName: "cube" });
  assert.equal(result.fileName, "cube.glb");
  const { json } = readGlb(result.bytes.buffer.slice(
    result.bytes.byteOffset,
    result.bytes.byteOffset + result.bytes.byteLength
  ));
  assert.equal(json.extensionsUsed?.includes("EXT_meshopt_compression"), false);
  assert.equal(describeModel(json).triangles, 12);
});

function makeChannel() {
  const replies = [];
  const source = {
    postMessage: (message, origin) => replies.push({ message, origin }),
  };
  return { replies, source };
}

test("sandbox answers the ready ping", async () => {
  const { replies, source } = makeChannel();
  await handleSandboxMessage({
    data: { type: "ping", id: "p1" },
    source,
    origin: "chrome-extension://abc",
  });
  assert.deepEqual(replies, [{
    message: { type: "pong", id: "p1" },
    origin: "chrome-extension://abc",
  }]);
});

test("sandbox converts a request from the popup", async () => {
  const { replies, source } = makeChannel();
  await handleSandboxMessage({
    data: {
      type: "convert",
      id: 7,
      key: "protocol",
      buffer: FIXTURE,
      format: "obj",
      options: { png: true, baseName: "cube" },
      baseName: "cube",
    },
    source,
    origin: "chrome-extension://abc",
  });

  const reply = replies[0].message;
  assert.equal(reply.id, 7);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.fileName, "cube-obj.zip");
  assert.deepEqual([...new Uint8Array(reply.result.bytes).subarray(0, 2)], [0x50, 0x4b]);
});
