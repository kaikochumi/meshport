import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import "../chrome-extension/shared.js";

const { meshportGlbFromZip, meshportModelKind } = globalThis;

function zipEntry(name, data, method = 8) {
  const raw = Buffer.from(data);
  const body = method === 8 ? deflateRawSync(raw) : raw;
  const nameBytes = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  return { nameBytes, body, raw, method, local: Buffer.concat([local, nameBytes, body]) };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, data, method] of entries) {
    const entry = zipEntry(name, data, method);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.body.length, 20);
    central.writeUInt32LE(entry.raw.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, entry.nameBytes]));
    locals.push(entry.local);
    offset += entry.local.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function model(marker) {
  return new TextEncoder().encode(`glTF${marker}`);
}

test("meshportModelKind reads GLB, FBX and ZIP headers", () => {
  assert.equal(meshportModelKind(model("00000002")), "glb");
  assert.equal(
    meshportModelKind(Buffer.from("Kaydara FBX Binary  \u0000\u001a\u0000rest", "binary")),
    "fbx",
  );
  assert.equal(meshportModelKind(buildZip([["a.glb", model("x")]])), "zip");
  assert.equal(meshportModelKind(Buffer.from("<html>nope")), "unknown");
  assert.equal(meshportModelKind(new Uint8Array()), "unknown");
});

test("meshportGlbFromZip picks the model out of an export archive", async () => {
  const archive = buildZip([
    ["textures/albedo.png", Buffer.alloc(400, 7)],
    ["model.glb", model("archive")],
  ]);
  const glb = await meshportGlbFromZip(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength));
  assert.equal(new TextDecoder().decode(glb), "glTFarchive");
});

test("meshportGlbFromZip reads a stored entry", async () => {
  const archive = buildZip([["model.glb", model("stored"), 0]]);
  const glb = await meshportGlbFromZip(archive);
  assert.equal(new TextDecoder().decode(glb), "glTFstored");
});

test("meshportGlbFromZip returns null when the archive has no GLB", async () => {
  const archive = buildZip([["textures/albedo.png", Buffer.alloc(120, 1)]]);
  assert.equal(await meshportGlbFromZip(archive), null);
});

test("meshportGlbFromZip refuses an encrypted entry", async () => {
  const archive = buildZip([["model.glb", model("secret")]]);
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  archive.writeUInt16LE(1, archive.readUInt32LE(end + 16) + 8);
  await assert.rejects(meshportGlbFromZip(archive), /encrypted/);
});
