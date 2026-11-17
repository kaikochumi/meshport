// Drives a real browser through both platforms: the Tripo library, the
// Meshy library scan, the platform round trip, a Meshy batch of models that
// were never opened, and a queued batch of Tripo models with search,
// selection, sorting and persisted queue state.
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../chrome-extension/", import.meta.url));
const FIXTURE_GLB = readFileSync(new URL("../test/fixtures/cube-meshopt.glb", import.meta.url));
const EDGE = process.env.MESHPORT_EDGE_PATH
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
// Optional visual audit: MESHPORT_SHOTS=<folder> saves one full-page capture
// per UI state the test reaches.
const SHOT_DIR = process.env.MESHPORT_SHOTS || "";
const IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const MODELS = [
  { id: "ad7cfcb4-92d8-4be0-a90f-2f8d64afa111", name: "Street Van", created: "2026-11-15T10:00:00Z" },
  { id: "5c1e9a72-8f43-4d61-b2a0-7e9c3f18d644", name: "Avocado", created: "2026-11-14T09:00:00Z" },
];

const server = createServer((request, response) => {
  if (request.url?.match(/^\/(cover\/[\w-]+|meshy-preview[\w-]*)\.png$/)) {
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

// A fake Meshy workspace with two finished models. The list carries each
// signed link under the phase that produced it, exactly like the real answer:
// one under result.autoUv and one under result.texture. The status endpoint
// answers 401 because it needs the workspace bearer token, which the extension
// must not need for models whose link is already in the library answer.
const MESHY_TASK_ID = "01a1e2b0-1463-7714-9a83-ffb4421ba372";
const MESHY_TASK_2_ID = "02b2e2b0-1463-7714-9a83-ffb4421ba998";
const MESHY_TASK_3_ID = "03c3e2b0-1463-7714-9a83-ffb4421ba771";
const MESHY_GLB_URL = `https://assets.meshy.ai/3783bcf3/tasks/${MESHY_TASK_ID}/output/model.glb?Expires=1893456789&Signature=e2e`;
const MESHY_GLB_2_URL = `https://assets.meshy.ai/3783bcf3/tasks/${MESHY_TASK_2_ID}/output/model.glb?Expires=1893456789&Signature=e2e2`;
const MESHY_PREVIEW_URL = `${coverBase}/meshy-preview.png`;
const MESHY_PREVIEW_2_URL = `${coverBase}/meshy-preview-2.png`;
const MESHY_LIST_BODY = {
  code: "OK",
  requestId: "list",
  result: [
    {
      id: MESHY_TASK_ID,
      name: "Desolate Urban Road",
      status: "SUCCEEDED",
      phase: "auto-uv",
      faceCount: 123238,
      vertexCount: 61619,
      createdAt: 1794804552997,
      result: {
        previewUrl: MESHY_PREVIEW_URL,
        autoUv: { modelUrl: MESHY_GLB_URL },
      },
    },
    {
      id: MESHY_TASK_2_ID,
      name: "Rustbound Vent",
      status: "SUCCEEDED",
      phase: "texture",
      faceCount: 15267,
      vertexCount: 13840,
      createdAt: 1794804551997,
      result: {
        previewUrl: MESHY_PREVIEW_2_URL,
        texture: { modelUrl: MESHY_GLB_2_URL },
      },
    },
    {
      id: MESHY_TASK_3_ID,
      name: "Unloaded Shard",
      status: "SUCCEEDED",
      phase: "generate",
      faceCount: 8000,
      vertexCount: 4000,
      createdAt: 1794804550997,
      // This task never appeared in an authenticated answer, so neither the
      // page nor the direct list has a signed link for it.
      result: {},
    },
  ],
};
// The extension's own /v2/tasks call carries no bearer token, so the real API
// answers without the signed asset links. Only the workspace's authenticated
// list does. The scan must keep the links from the captured page answer.
const MESHY_LIST_BODY_NO_LINKS = {
  ...MESHY_LIST_BODY,
  result: MESHY_LIST_BODY.result.map(({ result, ...task }) => ({
    ...task,
    result: result?.previewUrl ? { previewUrl: result.previewUrl } : {},
  })),
};
const MESHY_HTML = `<!doctype html><html><head><title>Meshy</title></head><body><h1>Workspace</h1><script>
(async () => {
  const id = "${MESHY_TASK_ID}";
  const device = "e2e0f6c8-5d5d-4a11-9c1d-000000000001";
  localStorage.setItem("meshy_device_id", device);
  const headers = { "X-Device-Id": device, Authorization: "Bearer e2e-page" };
  try { await fetch("/meshyd-api/web/v2/tasks/" + id + "/open", { headers }); } catch {}
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
let meshyDirectListCalls = 0;
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
      const statusMatch = parsed.pathname.match(/\/v1\/tasks\/([0-9a-f-]+)\/status$/);
      let body;
      if (statusMatch) {
        // The real status endpoint needs the workspace bearer token. Meshport
        // should never call it for a model whose link was in the list.
        request.respond({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ code: "FAIL", message: "missing bearer token" }),
        });
        return;
      }
      if (/\/v2\/tasks\/[0-9a-f-]+\/open$/.test(parsed.pathname)) body = { code: "OK", requestId: "open", result: {} };
      else if (parsed.pathname === "/meshyd-api/web/v2/tasks") {
        const authorized = (request.headers()["authorization"] || "").trim();
        if (authorized) {
          body = MESHY_LIST_BODY;
        } else {
          meshyDirectListCalls += 1;
          body = MESHY_LIST_BODY_NO_LINKS;
        }
      } else body = { code: "FAIL", message: "Unknown endpoint" };
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    if (/^https:\/\/assets\.meshy\.ai\/.*\.glb(?:[?#]|$)/i.test(url)) {
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
// The popup downloads the models itself, so the fake Meshy and Tripo GLB
// links have to answer on this page too.
const TRIPO_GLB = /^https:\/\/tripo-data\.rg1\.data\.tripo3d\.com\/.*\.glb(?:[?#]|$)/i;
await page.setRequestInterception(true);
page.on("request", (request) => {
  if (/^https:\/\/assets\.meshy\.ai\/.*\.glb(?:[?#]|$)/i.test(request.url())) {
    request.respond({ status: 200, contentType: "model/gltf-binary", body: FIXTURE_GLB });
    return;
  }
  if (TRIPO_GLB.test(request.url())) {
    request.respond({ status: 200, contentType: "model/gltf-binary", body: FIXTURE_GLB });
    return;
  }
  request.continue();
});
page.on("pageerror", (error) => console.log("popup error:", error.message));
await page.setViewport({ width: 380, height: 600, deviceScaleFactor: 2 });
await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });

const problems = [];
const shot = async (name) => {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
};
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
await shot("01-tripo-list");
await page.evaluate(() => {
  const main = document.querySelector("main");
  const previous = main.style.scrollBehavior;
  main.style.scrollBehavior = "auto";
  main.scrollTop = main.scrollHeight;
  main.style.scrollBehavior = previous;
});
await shot("01b-tripo-bottom");
await page.evaluate(() => {
  const main = document.querySelector("main");
  const previous = main.style.scrollBehavior;
  main.style.scrollBehavior = "auto";
  main.scrollTop = 0;
  main.style.scrollBehavior = previous;
});

// Picking a model must survive a platform round trip.
await page.evaluate(() => document.querySelector(".model").click());
const pickedName = await page.evaluate(() => document.getElementById("base-name").value);
if (!pickedName) problems.push("picked model did not set the file name");
await shot("02-tripo-selected");

// Switching to Meshy lists the whole library, not just the open model: two
// cards with real names, triangle counts, and the theme melts to violet.
await page.click("#platform-meshy");
await new Promise((resolve) => setTimeout(resolve, 600)); // the theme melt takes 350ms
await waitMeshyCard();
now = await state();
console.log("meshy scan:", now);
if (now.cards !== 3) problems.push(`meshy cards ${now.cards}`);
if (now.count !== "3") problems.push(`meshy count ${now.count}`);
if (!now.status.includes("3 models in your Meshy library")) problems.push(`meshy status: ${now.status}`);
if (now.platform !== "meshy") problems.push("platform not persisted");
// This scan must have exercised the linkless direct list; the export below
// only works if the captured page list kept its signed links.
if (!meshyDirectListCalls) problems.push("meshy direct list was not exercised");
const meshyCards = await page.evaluate(
  () => [...document.querySelectorAll(".model")].map((item) => item.textContent),
);
const openCard = meshyCards.find((text) => text.includes("Desolate Urban Road")) || "";
const libraryCard = meshyCards.find((text) => text.includes("Rustbound Vent")) || "";
if (!openCard) problems.push("meshy open model card missing");
if (!openCard.includes("Meshy · 123.2k tris")) problems.push(`meshy open meta: ${openCard}`);
if (!libraryCard) problems.push("meshy library model card missing");
if (!libraryCard.includes("Meshy · 15.3k tris")) problems.push(`meshy library meta: ${libraryCard}`);
const meshyThumb = await page.waitForFunction(
  () => document.querySelector(".model .model-thumb img")?.src.startsWith("data:image/"),
  { timeout: 15000 },
);
if (!meshyThumb) problems.push("meshy preview thumbnail missing");
await shot("03-meshy-list");
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

// Reload while on Meshy: the popup rescans the whole library on its own, no
// manual step needed.
await page.click("#platform-meshy");
await waitMeshyCard();
await page.reload({ waitUntil: "load" });
await waitMeshyCard();
now = await state();
console.log("reload on meshy:", now);
if (now.cards !== 3) problems.push("meshy cards after reload");
if (now.platform !== "meshy") problems.push("platform lost after reload");
if ((await page.evaluate(() => document.body.dataset.platform)) !== "meshy") {
  problems.push("body dataset lost after reload");
}

// Queue both Meshy models the workspace never opened. Their signed links are
// only in the captured page answer; the extension's direct list comes back
// without them, and the status endpoint answers 401. Multi-select must still
// deliver both files without opening them one by one. The third model, which
// no authenticated answer ever listed, has no link and must stay out of the
// selection with a visible explanation. The GLB bytes ride to the converter
// sandbox as a postMessage transfer, so only a real ArrayBuffer survives.
const linklessCard = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".model-row")]
    .find((item) => item.textContent.includes("Unloaded Shard"));
  if (!row) return null;
  return {
    disabled: row.querySelector('input[type="checkbox"]')?.disabled,
    meta: row.querySelector(".model-meta")?.textContent || "",
    title: row.querySelector(".pick")?.title || "",
    dashed: getComputedStyle(row.querySelector(".pick")).borderStyle,
  };
});
console.log("meshy linkless card:", linklessCard);
if (!linklessCard) problems.push("meshy linkless card missing");
if (linklessCard?.disabled !== true) problems.push("meshy linkless checkbox is enabled");
if (!linklessCard?.meta.includes("Open once in Meshy")) {
  problems.push(`meshy linkless meta: ${linklessCard?.meta}`);
}
if (!linklessCard?.title.includes("Open this model once in Meshy")) {
  problems.push(`meshy linkless title: ${linklessCard?.title}`);
}
if (linklessCard?.dashed !== "dashed") problems.push(`meshy linkless style: ${linklessCard?.dashed}`);

// Ticking every box selects only the two with links; the disabled box ignores
// the click. Then clear and use Select all, which must skip the linkless card
// too and leave the same two models selected.
const readSelection = () => page.evaluate(() => ({
  label: document.getElementById("select-count").textContent,
  button: document.getElementById("export-selected").textContent,
  disabled: document.getElementById("export-selected").disabled,
}));
const checkSelection = (selection, source) => {
  console.log(`meshy selection (${source}):`, selection);
  if (!selection.label.includes("2 selected")) {
    problems.push(`meshy selection label (${source}): ${selection.label}`);
  }
  if (selection.button !== "Export 2") {
    problems.push(`meshy selection button (${source}): ${selection.button}`);
  }
  if (selection.disabled) problems.push(`meshy export button disabled (${source})`);
};
await page.evaluate(() => {
  document.querySelectorAll('.model-row input[type="checkbox"]').forEach((box) => {
    if (!box.disabled && !box.checked) box.click();
  });
});
checkSelection(await readSelection(), "tick boxes");
await page.click("#select-clear");
await page.click("#select-all");
checkSelection(await readSelection(), "select all");
await page.evaluate(() => {
  document.querySelector('input[name="format"][value="stl"]').closest("label").click();
});
await page.click("#export-selected");
const queuedMessage = await page.evaluate(() => document.getElementById("status").textContent);
if (!queuedMessage.includes("Queued 2 models as STL")) {
  problems.push(`meshy queued message: ${queuedMessage}`);
}
await page.waitForFunction(() => {
  const items = [...document.querySelectorAll("#queue-list .queue-item")];
  return items.length === 2 && items.every((item) => item.dataset.status === "completed");
}, { timeout: 60000 });
const meshyBatch = await page.evaluate(() => ({
  summary: document.getElementById("queue-summary-line").textContent,
  names: [...document.querySelectorAll(".queue-name")].map((element) => element.textContent),
  details: [...document.querySelectorAll(".queue-detail")].map((element) => element.textContent),
}));
console.log("meshy batch:", meshyBatch);
if (!meshyBatch.summary.includes("2 done")) problems.push(`meshy batch summary: ${meshyBatch.summary}`);
if (meshyBatch.names.length !== 2) problems.push(`meshy batch size: ${meshyBatch.names}`);
if (meshyBatch.names.includes("Unloaded Shard")) problems.push(`meshy linkless model entered queue: ${meshyBatch.names}`);
if (!meshyBatch.names.includes("Rustbound Vent")) problems.push(`meshy batch names: ${meshyBatch.names}`);
if (!meshyBatch.names.includes("Desolate Urban Road")) problems.push(`meshy batch names: ${meshyBatch.names}`);
if (!meshyBatch.details.some((detail) => /Rustbound[_ ]Vent\.stl saved\./.test(detail))) {
  problems.push(`meshy batch detail: ${meshyBatch.details}`);
}
if (!meshyBatch.details.some((detail) => /Desolate[_ ]Urban[_ ]Road\.stl saved\./.test(detail))) {
  problems.push(`meshy batch detail: ${meshyBatch.details}`);
}
await shot("03b-meshy-batch");
await page.click("#queue-clear");
await page.waitForFunction(
  () => document.querySelectorAll("#queue-list .queue-item").length === 0,
  { timeout: 5000 },
);
await page.click("#view-queue-toggle");

// And Tripo needs one manual rescan to come back.
await page.click("#platform-tripo");
await page.click("#scan");
await waitCards();
now = await state();
if (now.cards < 2) problems.push("manual rescan on tripo did not restore cards");

// Search and selection share one list. A hidden but selected model must not
// inflate the Export button or sneak into the batch.
const setSearch = (value) => page.evaluate((query) => {
  const input = document.getElementById("search");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, value);
const firstName = () => page.evaluate(() => document.querySelector(".model-name")?.textContent || "");

const toolsVisible = await page.evaluate(() => ({
  tools: !document.getElementById("library-tools").hidden,
  bar: !document.getElementById("select-bar").hidden,
}));
if (!toolsVisible.tools) problems.push("search tools hidden with a library loaded");
if (!toolsVisible.bar) problems.push("selection bar hidden with a library loaded");
const tripoWidth = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth,
  body: document.body.clientWidth,
}));
if (tripoWidth.scroll > tripoWidth.body) {
  problems.push(`popup overflows horizontally on Tripo: ${tripoWidth.scroll}/${tripoWidth.body}`);
}

await setSearch("avocado");
await page.waitForFunction(
  () => document.querySelectorAll(".model").length === 1
    && document.querySelector(".model-name")?.textContent === "Avocado",
  { timeout: 5000 },
);
let selectionState = await page.evaluate(() => ({
  count: document.getElementById("model-count").textContent,
  label: document.getElementById("select-count").textContent,
}));
if (selectionState.count !== "1/2") problems.push(`filtered count ${selectionState.count}`);

await page.evaluate(() => document.querySelector('.model-row input[type="checkbox"]').click());
selectionState = await page.evaluate(() => ({
  label: document.getElementById("select-count").textContent,
  button: document.getElementById("export-selected").textContent,
}));
if (selectionState.label !== "1 selected") problems.push(`selection label ${selectionState.label}`);
if (selectionState.button !== "Export 1") problems.push(`selection button ${selectionState.button}`);
await shot("04-search-selected");

await setSearch("street");
await page.waitForFunction(
  () => document.querySelectorAll(".model").length === 1
    && document.querySelector(".model-name")?.textContent === "Street Van",
  { timeout: 5000 },
);
selectionState = await page.evaluate(() => ({
  label: document.getElementById("select-count").textContent,
  disabled: document.getElementById("export-selected").disabled,
  button: document.getElementById("export-selected").textContent,
}));
if (selectionState.label !== "1 selected, 0 shown") problems.push(`hidden selection label ${selectionState.label}`);
if (!selectionState.disabled) problems.push("export enabled with only hidden models selected");
if (selectionState.button !== "Export") problems.push(`hidden selection button ${selectionState.button}`);
await shot("05-hidden-selection");

await page.click("#search-clear");
await page.waitForFunction(() => document.querySelectorAll(".model").length === 2, { timeout: 5000 });
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".model-row")]
    .find((item) => item.querySelector(".model-name")?.textContent === "Street Van");
  row.querySelector('input[type="checkbox"]').click();
});
selectionState = await page.evaluate(() => ({
  label: document.getElementById("select-count").textContent,
  button: document.getElementById("export-selected").textContent,
}));
if (selectionState.label !== "2 selected") problems.push(`two-model label ${selectionState.label}`);
if (selectionState.button !== "Export 2") problems.push(`two-model button ${selectionState.button}`);

// Sorting must not disturb the selection.
await page.click("#sort-name");
await page.waitForFunction(
  () => document.querySelector(".model-name")?.textContent === "Avocado",
  { timeout: 5000 },
);
selectionState = await page.evaluate(() => ({
  label: document.getElementById("select-count").textContent,
  pressed: document.getElementById("sort-name").getAttribute("aria-pressed"),
}));
if (selectionState.label !== "2 selected") problems.push("selection lost after name sort");
if (selectionState.pressed !== "true") problems.push("name sort not pressed");
await page.click("#sort-date");
await page.waitForFunction(
  () => document.querySelector(".model-name")?.textContent === "Street Van",
  { timeout: 5000 },
);

// Queue both models as STL and watch the queue finish each item.
await page.click("#export-selected");
await page.waitForFunction(
  () => !document.getElementById("view-queue").hidden,
  { timeout: 5000 },
);
await page.waitForFunction(() => {
  const items = [...document.querySelectorAll("#queue-list .queue-item")];
  return items.length === 2 && items.every((item) => item.dataset.status === "completed");
}, { timeout: 120000 });
const queueState = await page.evaluate(() => ({
  count: document.getElementById("queue-count").textContent,
  summary: document.getElementById("queue-summary-line").textContent,
  names: [...document.querySelectorAll(".queue-name")].map((element) => element.textContent),
  statuses: [...document.querySelectorAll(".queue-status")].map((element) => element.textContent),
  details: [...document.querySelectorAll(".queue-detail")].map((element) => element.textContent),
  badgeHidden: document.getElementById("queue-badge").hidden,
  exportHidden: document.getElementById("view-export").hidden,
}));
console.log("batch queue:", queueState);
if (queueState.count !== "2") problems.push(`queue count ${queueState.count}`);
if (!queueState.summary.includes("2 done")) problems.push(`queue summary ${queueState.summary}`);
if (queueState.names.join("|") !== "Street Van|Avocado") problems.push(`queue order ${queueState.names}`);
if (!queueState.statuses.every((status) => status === "Done")) problems.push(`queue statuses ${queueState.statuses}`);
if (!queueState.details.some((detail) => /Street[_ ]Van\.stl saved\./.test(detail))) {
  problems.push(`street detail ${queueState.details}`);
}
if (!queueState.details.some((detail) => detail.includes("Avocado.stl saved."))) {
  problems.push(`avocado detail ${queueState.details}`);
}
if (!queueState.badgeHidden) problems.push("queue badge still shows finished work");
if (!queueState.exportHidden) problems.push("export view still visible behind the queue");
const queueWidth = await page.evaluate(() => ({
  scroll: document.documentElement.scrollWidth,
  body: document.body.clientWidth,
}));
if (queueWidth.scroll > queueWidth.body) {
  problems.push(`popup overflows horizontally in the queue: ${queueWidth.scroll}/${queueWidth.body}`);
}
await shot("06-queue-done");

await page.click("#view-queue-toggle");
await page.waitForFunction(() => !document.getElementById("view-export").hidden, { timeout: 5000 });
selectionState = await page.evaluate(() => ({
  picked: document.querySelectorAll(".model-row.picked").length,
  label: document.getElementById("select-count").textContent,
  button: document.getElementById("export-selected").textContent,
}));
if (selectionState.picked !== 2) problems.push(`picked rows after queue ${selectionState.picked}`);
if (selectionState.label !== "2 selected") problems.push(`selection after queue ${selectionState.label}`);
if (selectionState.button !== "Export 2") problems.push(`export button after queue ${selectionState.button}`);

// The queue lives in chrome.storage.session, so a popup reload keeps the
// finished batch instead of pretending it never happened.
await page.reload({ waitUntil: "load" });
await waitCards();
await page.waitForFunction(
  () => document.querySelectorAll("#queue-list .queue-item[data-status='completed']").length === 2,
  { timeout: 15000 },
);
await page.click("#view-queue-toggle");
const restoredSummary = await page.evaluate(
  () => document.getElementById("queue-summary-line").textContent,
);
if (!restoredSummary.includes("2 done")) problems.push(`queue lost after reload: ${restoredSummary}`);

await page.click("#queue-clear");
await page.waitForFunction(() => document.querySelectorAll("#queue-list .queue-item").length === 0, { timeout: 5000 });
const clearedState = await page.evaluate(() => ({
  summary: document.getElementById("queue-summary-line").textContent,
  summaryHidden: document.getElementById("queue-summary-line").hidden,
  emptyHidden: document.getElementById("queue-empty").hidden,
  clearHidden: document.getElementById("queue-clear").hidden,
  badgeHidden: document.getElementById("queue-badge").hidden,
}));
if (clearedState.summary) problems.push(`cleared summary ${clearedState.summary}`);
if (!clearedState.summaryHidden) problems.push("empty summary line stayed visible");
if (clearedState.emptyHidden) problems.push("empty queue message stayed hidden");
if (!clearedState.clearHidden) problems.push("clear finished stayed visible");
if (!clearedState.badgeHidden) problems.push("badge stayed visible after clear");
await shot("07-queue-empty");
await page.click("#view-queue-toggle");

// The header gear opens settings and brings you back.
await page.click("#view-toggle");
const settingsShown = await page.evaluate(() => !document.getElementById("view-settings").hidden);
const gearLabel = await page.evaluate(() => document.getElementById("view-toggle").title);
await shot("08-settings");
await page.click("#view-toggle");
const exportShown = await page.evaluate(() => !document.getElementById("view-export").hidden);
if (!settingsShown) problems.push("gear did not open settings");
if (!exportShown) problems.push("gear did return to export");
if (settingsShown && gearLabel !== "Back to export") problems.push(`gear label in settings: ${gearLabel}`);

// An export that was mid-flight when the popup closed must come back as
// failed, never completed. Seed that exact session state, reload, and read it.
await page.evaluate(async () => {
  await chrome.storage.session.set({
    "meshport/queue/v1": [
      {
        id: "interrupted",
        key: "interrupted",
        name: "Interrupted Export",
        platform: "tripo",
        format: "stl",
        status: "processing",
        detail: "Starting...",
        savedAs: "",
        createdAt: 1,
        updatedAt: 1,
        entry: null,
      },
      {
        id: "finished",
        key: "finished",
        name: "Finished Export",
        platform: "tripo",
        format: "stl",
        status: "completed",
        detail: "Finished Export.stl saved.",
        savedAs: "Finished Export.stl",
        createdAt: 2,
        updatedAt: 2,
        entry: null,
      },
    ],
  });
});
await page.reload({ waitUntil: "load" });
await waitCards();
await page.click("#view-queue-toggle");
await page.waitForFunction(
  () => document.querySelectorAll("#queue-list .queue-item").length === 2,
  { timeout: 10000 },
);
const restoredQueue = await page.evaluate(() => ({
  items: [...document.querySelectorAll("#queue-list .queue-item")].map((item) => ({
    name: item.querySelector(".queue-name")?.textContent || "",
    status: item.dataset.status,
    detail: item.querySelector(".queue-detail")?.textContent || "",
  })),
  badge: document.getElementById("queue-badge").textContent,
  badgeHidden: document.getElementById("queue-badge").hidden,
}));
console.log("restored queue:", restoredQueue);
const interrupted = restoredQueue.items.find((item) => item.name === "Interrupted Export");
const finished = restoredQueue.items.find((item) => item.name === "Finished Export");
if (interrupted?.status !== "failed") problems.push(`interrupted status ${interrupted?.status}`);
if (!interrupted?.detail.includes("popup closed")) problems.push(`interrupted detail ${interrupted?.detail}`);
if (finished?.status !== "completed") problems.push(`finished status ${finished?.status}`);
if (restoredQueue.badgeHidden) problems.push("failed item did not keep the badge visible");
if (restoredQueue.badge !== "1") problems.push(`restored badge ${restoredQueue.badge}`);
await shot("09-queue-restored");

// Empty-state capture for the visual audit; assertions are already done.
await page.evaluate(() => {
  showView("export");
  document.body.dataset.platform = "meshy";
  renderMeshyEmpty("No models in your Meshy workspace yet. Create one, then rescan.");
  setStatus("No models in your Meshy workspace yet. Create one, then rescan.", "idle");
});
await shot("10-empty-library");

if (problems.length) {
  console.log("FAIL:", problems);
  process.exitCode = 1;
} else {
  console.log("PASS: platform switch, Meshy batch, and the queued Tripo batch all behave");
}

await browser.close();
server.close();
