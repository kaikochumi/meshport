function isTripoGlbUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value, globalThis.location?.href || "https://studio.tripo3d.ai/");
    const host = url.hostname.toLowerCase();
    const onTripo = host === "tripo3d.ai" || host.endsWith(".tripo3d.ai")
      || host === "tripo3d.com" || host.endsWith(".tripo3d.com");
    if (!onTripo || !/\.glb$/i.test(url.pathname)) return false;
    const name = decodeURIComponent(url.pathname.split("/").pop() || "");
    return /^tripo_(?:[a-z0-9]+_)*model_/i.test(name);
  } catch {
    return false;
  }
}

function tripoFileStem(value) {
  try {
    const name = decodeURIComponent(new URL(value).pathname.split("/").pop() || "");
    return name
      .replace(/\.(?:glb|gltf|fbx|obj|zip)$/i, "")
      .replace(/_meshopt$/i, "")
      .replace(/^tripo_(?:[a-z0-9]+_)*model_/i, "");
  } catch {
    return "";
  }
}

function tripoModelMatchesStem(value, stem) {
  if (!stem) return true;
  return tripoFileStem(value).toLowerCase() === String(stem).toLowerCase();
}

function tripoAbsoluteUrl(value, base) {
  const raw = typeof value === "string" ? value : value?.url;
  if (typeof raw !== "string" || !raw) return "";
  try {
    const fallback = globalThis.location?.origin || "https://studio.tripo3d.ai";
    const url = new URL(raw, base || fallback);
    return /^https?:$/i.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function tripoProjectCover(project) {
  const objects = [
    ...(Array.isArray(project?.cover_image_object) ? project.cover_image_object : []),
    ...(Array.isArray(project?.cover_image) ? project.cover_image : []),
  ];
  for (const object of objects) {
    const sizes = Array.isArray(object?.sizes) ? object.sizes : [];
    const best = sizes
      .filter((size) => size?.url)
      .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
    const url = tripoAbsoluteUrl(best) || tripoAbsoluteUrl(object);
    if (url) return url;
  }
  return "";
}

function tripoProjectCreatedAt(project) {
  const value = project?.create_time ?? project?.created_at ?? project?.createTime;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (/^\d+$/.test(text)) {
      const stamp = Number(text);
      return new Date(stamp < 1e12 ? stamp * 1000 : stamp).toISOString();
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return "";
}

const FBX_MAGIC = "Kaydara FBX Binary  \u0000\u001a\u0000";

function meshportModelKind(bytes) {
  if (!bytes || bytes.length < 4) return "unknown";
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    return "glb";
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && [3, 5, 7].includes(bytes[2])) {
    return "zip";
  }
  if (bytes.length >= FBX_MAGIC.length) {
    let matches = true;
    for (let index = 0; index < FBX_MAGIC.length; index++) {
      if (bytes[index] !== FBX_MAGIC.charCodeAt(index)) {
        matches = false;
        break;
      }
    }
    if (matches) return "fbx";
  }
  return "unknown";
}

function zipEndOfCentralDirectory(view) {
  const lowest = Math.max(0, view.byteLength - 66_000);
  for (let offset = view.byteLength - 22; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

async function zipEntryBytes(bytes, view, entry) {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error("Tripo sent a ZIP file with an unsupported compression.");
  }
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error("Tripo sent a ZIP file with a broken entry.");
  }
  const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  const end = start + entry.compressed;
  if (end > bytes.length) throw new Error("Tripo sent a ZIP file that ends too early.");
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return new Uint8Array(data);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function meshportGlbFromZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = zipEndOfCentralDirectory(view);
  if (end < 0) throw new Error("Tripo sent a ZIP file that could not be read.");
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (!count || count > 1024 || offset + centralSize > end) {
    throw new Error("Tripo sent a ZIP file Meshport cannot read.");
  }

  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Tripo sent a ZIP file with a broken index.");
    }
    if (view.getUint16(offset + 8, true) & 1) {
      throw new Error("Tripo sent an encrypted ZIP file.");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({
      name,
      method: view.getUint16(offset + 10, true),
      compressed: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }

  const model = entries
    .filter((entry) => /\.glb$/i.test(entry.name))
    .sort((a, b) => b.size - a.size)[0];
  if (!model) return null;
  return zipEntryBytes(bytes, view, model);
}

function tripoProjectIdFromUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/workspace\/generate\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]).slice(0, 128) : "";
  } catch {
    return "";
  }
}

function tripoProjectIdFromDetailUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/v2\/studio\/project\/detail\/v3\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]).slice(0, 128) : "";
  } catch {
    return "";
  }
}

function tripoLibraryProject(project, scope) {
  const id = project?.id;
  if (!id) return null;
  const rawName = project?.project_name || project?.biz_info?.short_description || "";
  return {
    id: String(id),
    name: String(rawName).trim().slice(0, 120),
    cover: tripoProjectCover(project),
    createdAt: tripoProjectCreatedAt(project),
    scope: scope === "collected" ? "collected" : "mine",
  };
}

globalThis.isTripoGlbUrl = isTripoGlbUrl;
globalThis.tripoFileStem = tripoFileStem;
globalThis.tripoModelMatchesStem = tripoModelMatchesStem;
globalThis.tripoProjectIdFromUrl = tripoProjectIdFromUrl;
globalThis.tripoProjectIdFromDetailUrl = tripoProjectIdFromDetailUrl;
globalThis.tripoLibraryProject = tripoLibraryProject;
globalThis.meshportModelKind = meshportModelKind;
globalThis.meshportGlbFromZip = meshportGlbFromZip;
