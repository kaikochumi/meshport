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
      .replace(/\.glb$/i, "")
      .replace(/_meshopt$/i, "")
      .replace(/^tripo_pbr_model_/i, "");
  } catch {
    return "";
  }
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
globalThis.tripoLibraryProject = tripoLibraryProject;
