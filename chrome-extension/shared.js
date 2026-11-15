function isTripoGlbUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value, globalThis.location?.href || "https://studio.tripo3d.ai/");
    const host = url.hostname.toLowerCase();
    const onTripo = host === "tripo3d.ai" || host.endsWith(".tripo3d.ai")
      || host === "tripo3d.com" || host.endsWith(".tripo3d.com");
    return onTripo && /\.glb$/i.test(url.pathname);
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

globalThis.isTripoGlbUrl = isTripoGlbUrl;
globalThis.tripoFileStem = tripoFileStem;
