import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// meshy-world.js is a page-world script, not a module. Load it in a small vm
// context so the real list parser runs, with only its two browser touchpoints
// stubbed: fetch and postMessage.
const SOURCE = readFileSync(
  new URL("../chrome-extension/meshy-world.js", import.meta.url),
  "utf8",
);

const LIST_URL = "https://www.meshy.ai/meshyd-api/web/v2/tasks?pageNum=1";
const BASE = "https://assets.meshy.ai/base.glb";
const TEXTURED = "https://assets.meshy.ai/textured.glb";

function jsonResponse(body) {
  return {
    clone: () => ({ json: async () => body }),
  };
}

function makeHarness(bodies) {
  const posted = [];
  const listeners = new Map();
  let index = 0;
  const window = {
    postMessage(message) {
      posted.push(message);
      for (const listener of listeners.get("message") || []) {
        listener({ source: window, data: message });
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fetch: () => Promise.resolve(jsonResponse(bodies[Math.min(index++, bodies.length - 1)])),
  };
  function FakeXhr() {}
  FakeXhr.prototype.open = function () {};
  vm.runInContext(SOURCE, vm.createContext({ window, XMLHttpRequest: FakeXhr }));
  return { posted, window };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function listMessages(posted) {
  return posted.filter((message) => Array.isArray(message.list));
}

async function readList(body) {
  const { posted, window } = makeHarness([body]);
  await window.fetch(LIST_URL);
  await tick();
  return listMessages(posted).at(-1)?.list || [];
}

async function readLists(bodies) {
  const { posted, window } = makeHarness(bodies);
  for (let index = 0; index < bodies.length; index += 1) {
    await window.fetch(LIST_URL);
    await tick();
  }
  return listMessages(posted).map((message) => message.list);
}

function task(phase, result, id = "01a1e2b0-1463-7714-9a83-ffb4421ba372") {
  return {
    id,
    name: "Rustbound Vent",
    status: "SUCCEEDED",
    phase,
    result,
  };
}

test("a texture task exports the textured mesh, not the auto-UV base", async () => {
  const [entry] = await readList({
    result: [task("texture", {
      autoUv: { modelUrl: BASE },
      texture: { modelUrl: TEXTURED },
    })],
  });

  assert.equal(entry.modelUrl, TEXTURED);
});

test("an auto-UV task keeps the base mesh even when a texture link is present", async () => {
  const [entry] = await readList({
    result: [task("auto-uv", {
      autoUv: { modelUrl: BASE },
      texture: { modelUrl: TEXTURED },
    })],
  });

  assert.equal(entry.modelUrl, BASE);
});

test("a task with no result link is still listed with an empty URL", async () => {
  const [entry] = await readList({
    result: [task("generate", {})],
  });

  assert.equal(entry.modelUrl, "");
  assert.equal(entry.phase, "generate");
});

test("a relief task exports the relief mesh", async () => {
  const [entry] = await readList({
    result: [task("relief", { relief: { modelUrl: TEXTURED } })],
  });

  assert.equal(entry.modelUrl, TEXTURED);
});

test("a later filtered list cannot erase a signed link from an earlier page", async () => {
  const lists = await readLists([
    { result: [task("texture", { texture: { modelUrl: TEXTURED } })] },
    { result: [task("texture", {})] },
  ]);

  assert.equal(lists.at(-1)[0].modelUrl, TEXTURED);
});

test("a filtered list cannot erase the name, date, or counts captured earlier", async () => {
  const full = {
    ...task("texture", { texture: { modelUrl: TEXTURED } }),
    createdAt: 1794804550997,
    faceCount: 15300,
    vertexCount: 8000,
  };
  const lists = await readLists([
    { result: [full] },
    { result: [{ id: full.id, phase: "texture", result: {} }] },
  ]);
  const entry = lists.at(-1)[0];

  assert.equal(entry.name, "Rustbound Vent");
  assert.equal(entry.createdAt, 1794804550997);
  assert.equal(entry.triangleCount, 15300);
  assert.equal(entry.vertexCount, 8000);
});

test("lists from different filters accumulate instead of replacing each other", async () => {
  const lists = await readLists([
    { result: [task("texture", { texture: { modelUrl: TEXTURED } })] },
    { result: [task("generate", {}, "02b2e2b0-1463-7714-9a83-ffb4421ba998")] },
  ]);

  assert.equal(lists.at(-1).length, 2);
});

test("a sync request replays the list captured before the content script listened", async () => {
  const { posted, window } = makeHarness([
    { result: [task("texture", { texture: { modelUrl: TEXTURED } })] },
  ]);
  await window.fetch(LIST_URL);
  await tick();

  window.postMessage({ source: "meshport", type: "meshy-sync" });

  const replay = listMessages(posted).at(-1)?.list || [];
  assert.equal(replay[0]?.modelUrl, TEXTURED);
});
