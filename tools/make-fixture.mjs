import {
  Document,
  NodeIO,
} from "@gltf-transform/core";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test/fixtures");
const sourcePath = path.join(fixtures, "cube.glb");
const outputPath = path.join(fixtures, "cube-meshopt.glb");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function makePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function checkerPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const light = (x + y) % 2 === 0;
      pixels[offset] = light ? 240 : 32;
      pixels[offset + 1] = light ? 92 : 72;
      pixels[offset + 2] = light ? 64 : 160;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

const FACES = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

function buildCube() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (const [faceIndex, face] of FACES.entries()) {
    const base = faceIndex * 4;
    for (const [cornerIndex, corner] of face.corners.entries()) {
      positions.push(...corner);
      normals.push(...face.normal);
      uvs.push(...[[0, 0], [1, 0], [1, 1], [0, 1]][cornerIndex]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const document = new Document();
  const buffer = document.createBuffer("geometry");
  const texture = document
    .createTexture("checker")
    .setImage(makePng(4, 4, checkerPixels(4)))
    .setMimeType("image/png");
  const material = document
    .createMaterial("cube")
    .setBaseColorTexture(texture)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.8);

  const position = document
    .createAccessor("POSITION")
    .setType("VEC3")
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const normal = document
    .createAccessor("NORMAL")
    .setType("VEC3")
    .setArray(new Float32Array(normals))
    .setBuffer(buffer);
  const uv = document
    .createAccessor("TEXCOORD_0")
    .setType("VEC2")
    .setArray(new Float32Array(uvs))
    .setBuffer(buffer);
  const index = document
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(new Uint16Array(indices))
    .setBuffer(buffer);

  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setAttribute("TEXCOORD_0", uv)
    .setIndices(index)
    .setMaterial(material);
  const mesh = document.createMesh("cube").addPrimitive(primitive);
  const node = document.createNode("cube").setMesh(mesh);
  const scene = document.createScene("Scene").addChild(node);
  document.getRoot().setDefaultScene(scene);

  return new NodeIO().writeBinary(document);
}

async function readGlbJson(file) {
  const bytes = await readFile(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${file} is not a GLB.`);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

await mkdir(fixtures, { recursive: true });
const cube = await buildCube();
await writeFile(sourcePath, cube);

const require = createRequire(import.meta.url);
const gltfpack = require.resolve("gltfpack/cli.js");
execFileSync(process.execPath, [gltfpack, "-i", sourcePath, "-o", outputPath, "-cc"], {
  stdio: "inherit",
});

const json = await readGlbJson(outputPath);
const used = json.extensionsUsed || [];
const required = json.extensionsRequired || [];
if (!used.includes("EXT_meshopt_compression") || !used.includes("KHR_mesh_quantization")) {
  throw new Error(`The fixture is missing the expected extensions: ${used.join(", ")}`);
}

const { stat } = await import("node:fs/promises");
const sourceSize = (await stat(sourcePath)).size;
const outputSize = (await stat(outputPath)).size;
console.log(`cube.glb: ${sourceSize} bytes`);
console.log(`cube-meshopt.glb: ${outputSize} bytes`);
console.log(`extensionsUsed: ${used.join(", ")}`);
console.log(`extensionsRequired: ${required.join(", ")}`);
