// Drives a real browser through both platforms: the Tripo library, the
// Meshy scan, the platform round trip, and a full Meshy download from the
// converter sandbox to a saved file.
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../chrome-extension/", import.meta.url));
const FIXTURE_GLB = readFileSync(new URL("../test/fixtures/cube-meshopt.glb", import.meta.url));
const EDGE = process.env.MESHPORT_EDGE_PATH
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const MODELS = [
  { id: "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111", name: "Street Van", created: "2026-11-15T10:00:00Z" },
  { id: "5c1e9a72-8f43-4d61-b2a0-7e9c3f18d644", name: "Avocado", created: "2026-11-14T09:00:00Z" },
];

const server = createServer((request, response) => {
  if (request.url?.match(/^\/(cover\/[\w-]+|meshy-preview)\.png$/)) {
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      // The popup fetches the Meshy preview from its own origin, so the
      // image answers CORS instead of relying on an <img> tag.
      "access-control-allow-origin": "*",
    });
    response.end(IMAGE_PNG);
    return;
  }
  response.writeHead(404).end("missing");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const coverBase = `http://127.0.0.1:${server.address().port}`;

function projectFor(model) {
  return {
    id: model.id,
    project_name: model.name,
    create_time: model.created,
    cover_image_object: [
      { sizes: [{ width: 512, height: 512, url: `${coverBase}/cover/${model.id}.png` }] },
    ],
    type: "model",
  };
}

function apiBody(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/v2/studio/assets/v2") {
    return { code: 0, data: { projects: MODELS.map(projectFor), total: MODELS.length } };
  }
  const detail = parsed.pathname.match(/^\/v2\/studio\/project\/detail\/v3\/(.+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[1]);
    return {
      code: 0,
      data: {
        id,
        project_name: MODELS.find((model) => model.id === id)?.name,
        model_url: `https://tripo-data.rg1.data.tripo3d.com/2026/11/15/tripo-studio/tripo_pbr_model_${id}_meshopt.glb?X-Amz-Signature=test`,
      },
    };
  }
  return { code: 404, message: "Unknown endpoint" };
}

// A fake Meshy workspace. The page fetches the same two endpoints the real
// app hits when you open a model, which is how the extension's content
// script learns which task is open.
const MESHY_TASK_ID = "01a1e2b0-1463-7714-9a83-ffb4421ba372";
const MESHY_GLB_URL = `https://assets.meshy.ai/3783bcf3/tasks/${MESHY_TASK_ID}/output/model.glb?Expires=1893456789&Signature=e2e`;
const MESHY_PREVIEW_URL = `${coverBase}/meshy-preview.png`;
// The real status answer wraps the model info twice; keep the mock honest
// about that depth.
const MESHY_STATUS_BODY = {
  code: "OK",
  requestId: "status",
  result: {
    status: "SUCCEEDED",
    retryCount: 0,
    result: { modelUrl: MESHY_GLB_URL, previewUrl: MESHY_PREVIEW_URL },
  },
};
const MESHY_LIST_BODY = {
  code: "OK",
  requestId: "list",
  result: [
    {
      id: MESHY_TASK_ID,
      name: "Desolate Urban Road",
      status: "SUCCEEDED",
      triangleCount: 123238,
      vertexCount: 61619,
      createdAt: 1794804552997,
      result: { previewUrl: MESHY_PREVIEW_URL },
    },
  ],
};
const MESHY_HTML = `<!doctype html><html><head><title>Meshy</title></head><body><h1>Workspace</h1><script>
(async () => {
  const id = "${MESHY_TASK_ID}";
  const device = "e2e0f6c8-5d5d-4a11-9c1d-000000000001";
  localStorage.setItem("meshy_device_id", device);
  const headers = { "X-Device-Id": device };
  try { await fetch("/meshyd-api/web/v2/tasks/" + id + "/open", { headers }); } catch {}
  try { await fetch("/meshyd-api/web/v1/tasks/" + id + "/status", { headers }); } catch {}
  try { await fetch("/meshyd-api/web/v2/tasks?excludeWorkspace=true&pageNum=1&pageSize=50", { headers }); } catch {}
  window.__meshportMockReady = true;
})();
</script></body></html>`;

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  protocolTimeout: 300000,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "edge-meshport-platform-"))}`,
  ],
});

const target = await browser.waitForTarget(
  (item) => item.type() === "service_worker" && item.url().includes("background.js"),
  { timeout: 20000 },
);
const extensionId = new URL(target.url()).host;

const tripoPage = await browser.newPage();
await tripoPage.setRequestInterception(true);
tripoPage.on("request", (request) => {
  const url = request.url();
  try {
    if (request.method() === "OPTIONS" && url.startsWith("https://api.tripo3d.ai/")) {
      request.respond({
        status: 204,
        headers: {
          "access-control-allow-origin": "https://studio.tripo3d.ai",
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
      return;
    }
    if (url.startsWith("https://api.tripo3d.ai/")) {
      request.respond({
        status: 200,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": "https://studio.tripo3d.ai",
          "access-control-allow-credentials": "true",
        },
        body: JSON.stringify(apiBody(url)),
      });
      return;
    }
    if (url === MESHY_GLB_URL) {
      request.respond({
        status: 200,
        contentType: "model/gltf-binary",
        body: FIXTURE_GLB,
      });
      return;
    }
    if (request.resourceType() === "document") {
      request.respond({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><head><title>Tripo Studio</title></head><body><h1>Studio</h1></body></html>",
      });
      return;
    }
    request.continue();
  } catch (error) {
    console.log("intercept error:", error.message);
  }
});
await tripoPage.goto("https://studio.tripo3d.ai/workspace", { waitUntil: "load" });
await new Promise((resolve) => setTimeout(resolve, 800));

const meshyPage = await browser.newPage();
await meshyPage.setRequestInterception(true);
meshyPage.on("request", (request) => {
  const url = request.url();
  try {
    const parsed = new URL(url);
    if (request.resourceType() === "document") {
      request.respond({ status: 200, contentType: "text/html", body: MESHY_HTML });
      return;
    }
    if (parsed.host === "www.meshy.ai" && parsed.pathname.startsWith("/meshyd-api/")) {
      // The real API answers 401 without the device id the app stamps on
      // every call, so the mock does too. This is what keeps the extension
      // honest about sending it.
      if (!(request.headers()["x-device-id"] || "").trim()) {
        request.respond({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ code: "FAIL", message: "missing device id" }),
        });
        return;
      }
      let body;
      if (/\/v1\/tasks\/[0-9a-f-]+\/status$/.test(parsed.pathname)) body = MESHY_STATUS_BODY;
      else if (/\/v2\/tasks\/[0-9a-f-]+\/open$/.test(parsed.pathname)) body = { code: "OK", requestId: "open", result: {} };
      else if (parsed.pathname === "/meshyd-api/web/v2/tasks") body = MESHY_LIST_BODY;
      else body = { code: "FAIL", message: "Unknown endpoint" };
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    if (url === MESHY_GLB_URL) {
      request.respond({ status: 200, contentType: "model/gltf-binary", body: FIXTURE_GLB });
      return;
    }
    request.continue();
  } catch (error) {
    console.log("meshy intercept error:", error.message);
  }
});
await meshyPage.goto("https://www.meshy.ai/pt-BR/workspace", { waitUntil: "load" });
await meshyPage.waitForFunction(() => window.__meshportMockReady === true, { timeout: 15000 });

const page = await browser.newPage();
// The popup downloads the model itself, so the fake Meshy GLB link has to
// answer on this page too.
await page.setRequestInterception(true);
page.on("request", (request) => {
  if (request.url() === MESHY_GLB_URL) {
    request.respond({ status: 200, contentType: "model/gltf-binary", body: FIXTURE_GLB });
    return;
  }
  request.continue();
});
page.on("pageerror", (error) => console.log("popup error:", error.message));
await page.setViewport({ width: 380, height: 700, deviceScaleFactor: 2 });
await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });

const problems = [];
const waitCards = () =>
  page.waitForFunction(() => document.querySelectorAll(".model").length >= 2, { timeout: 30000 });
const waitMeshyCard = () =>
  page.waitForFunction(
    () => document.querySelector(".model")?.textContent.includes("Desolate Urban Road"),
    { timeout: 30000 },
  );
const state = () =>
  page.evaluate(() => ({
    cards: document.querySelectorAll(".model").length,
    placeholder: document.querySelector("#links .empty")?.textContent || "",
    count: document.getElementById("model-count").textContent,
    status: document.getElementById("status").textContent,
    platform: localStorage.getItem("meshport/platform"),
  }));

// Tripo renders as before the platform switch existed.
await waitCards();
let now = await state();
console.log("tripo scan:", now);
if (now.cards < 2) problems.push("tripo cards missing");
if (now.platform !== "tripo" && now.platform !== null) problems.push(`platform ${now.platform}`);

// Picking a model must survive a platform round trip.
await page.evaluate(() => document.querySelector(".model").click());
const pickedName = await page.evaluate(() => document.getElementById("base-name").value);
if (!pickedName) problems.push("picked model did not set the file name");

// Switching to Meshy scans the open model on its own: one card, real name,
// triangle count in the meta line, and the theme melts to violet.
await page.click("#platform-meshy");
await new Promise((resolve) => setTimeout(resolve, 600)); // the theme melt takes 350ms
await waitMeshyCard();
now = await state();
console.log("meshy scan:", now);
if (now.cards !== 1) problems.push(`meshy cards ${now.cards}`);
if (now.count !== "1") problems.push(`meshy count ${now.count}`);
if (!now.status.includes("Desolate Urban Road is ready")) problems.push(`meshy status: ${now.status}`);
if (now.platform !== "meshy") problems.push("platform not persisted");
const cardText = await page.evaluate(() => document.querySelector(".model")?.textContent || "");
if (!cardText.includes("Desolate Urban Road")) problems.push("meshy card name missing");
if (!cardText.includes("Open in Meshy · 123.2k tris")) problems.push(`meshy meta: ${cardText}`);
const meshyThumb = await page.waitForFunction(
  () => document.querySelector(".model .model-thumb img")?.src.startsWith("data:image/"),
  { timeout: 15000 },
);
if (!meshyThumb) problems.push("meshy preview thumbnail missing");
if ((await page.evaluate(() => document.body.dataset.platform)) !== "meshy") {
  problems.push("body dataset not meshy");
}
const meshyPill = await page.evaluate(
  () => getComputedStyle(document.getElementById("platform-meshy")).color,
);
const tripoPillIdle = await page.evaluate(
  () => getComputedStyle(document.getElementById("platform-tripo")).color,
);
if (meshyPill !== "rgb(177, 140, 255)") problems.push(`meshy pill color ${meshyPill}`);
if (tripoPillIdle !== "rgb(105, 113, 124)") problems.push(`idle tripo pill color ${tripoPillIdle}`);
const convertOnMeshy = await page.evaluate(
  () => getComputedStyle(document.getElementById("convert")).backgroundColor,
);
if (convertOnMeshy !== "rgb(177, 140, 255)") problems.push(`convert button on meshy ${convertOnMeshy}`);

// FBX needs the file Tripo stores natively, so Meshy says so instead of
// trying and failing.
await page.evaluate(() => document.querySelector('input[name="format"][value="fbx"]').closest("label").click());
await page.click("#convert");
await new Promise((resolve) => setTimeout(resolve, 100));
now = await state();
if (!now.status.includes("FBX is Tripo-only")) problems.push(`fbx gate: ${now.status}`);

// Back to Tripo: same cards, same selection, and the theme melts back to lime.
await page.click("#platform-tripo");
await waitCards();
await new Promise((resolve) => setTimeout(resolve, 600)); // the theme melt takes 350ms
now = await state();
console.log("back to tripo:", now);
const stillPicked = await page.evaluate(
  () => document.querySelector('.model[aria-selected="true"]') !== null,
);
if (now.cards < 2) problems.push("cards did not return");
if (!stillPicked) problems.push("selection not restored");
const tripoPillActive = await page.evaluate(
  () => getComputedStyle(document.getElementById("platform-tripo")).color,
);
if (tripoPillActive !== "rgb(201, 247, 90)") problems.push(`active tripo pill color ${tripoPillActive}`);
const convertOnTripo = await page.evaluate(
  () => getComputedStyle(document.getElementById("convert")).backgroundColor,
);
if (convertOnTripo !== "rgb(201, 247, 90)") problems.push(`convert button on tripo ${convertOnTripo}`);
if ((await page.evaluate(() => document.body.dataset.platform)) !== "tripo") {
  problems.push("body dataset not tripo");
}
if (!pickedName || (await page.evaluate(() => document.getElementById("base-name").value)) !== pickedName) {
  problems.push("file name did not survive the round trip");
}

// Reload while on Meshy: the popup rescans the open model on its own, no
// manual step needed.
await page.click("#platform-meshy");
await waitMeshyCard();
await page.reload({ waitUntil: "load" });
await waitMeshyCard();
now = await state();
console.log("reload on meshy:", now);
if (now.cards !== 1) problems.push("meshy card after reload");
if (now.platform !== "meshy") problems.push("platform lost after reload");
if ((await page.evaluate(() => document.body.dataset.platform)) !== "meshy") {
  problems.push("body dataset lost after reload");
}

// Export the open Meshy model end to end. The GLB bytes ride to the
// converter sandbox as a postMessage transfer, so only a real ArrayBuffer
// survives the trip; a typed array dies right here.
await page.evaluate(() => document.querySelector(".model").click());
await page.evaluate(() => {
  document.querySelector('input[name="format"][value="stl"]').closest("label").click();
});
await page.click("#convert");
let exported = "";
for (let i = 0; i < 60; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  exported = (await state()).status;
  if (exported.includes("saved") || /^Error:/.test(exported)) break;
}
console.log("meshy export:", exported);
if (!exported.includes("saved")) problems.push(`meshy export did not save: ${exported}`);

// And Tripo needs one manual rescan to come back.
await page.click("#platform-tripo");
await page.click("#scan");
await waitCards();
now = await state();
if (now.cards < 2) problems.push("manual rescan on tripo did not restore cards");

// The header gear opens settings and brings you back.
await page.click("#view-toggle");
const settingsShown = await page.evaluate(() => !document.getElementById("view-settings").hidden);
const gearLabel = await page.evaluate(() => document.getElementById("view-toggle").title);
await page.click("#view-toggle");
const exportShown = await page.evaluate(() => !document.getElementById("view-export").hidden);
if (!settingsShown) problems.push("gear did not open settings");
if (!exportShown) problems.push("gear did return to export");
if (settingsShown && gearLabel !== "Back to export") problems.push(`gear label in settings: ${gearLabel}`);

if (problems.length) {
  console.log("FAIL:", problems);
  process.exitCode = 1;
} else {
  console.log("PASS: platform switch keeps Tripo whole and Meshy delivers the open model");
}

await browser.close();
server.close();
